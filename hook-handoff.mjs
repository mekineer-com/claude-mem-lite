// claude-mem-lite: Cross-session handoff extraction, detection, and injection
// Extracted for testability — hook.mjs has module-level side effects

import { basename } from 'path';
import { truncate, extractMatchKeywords, tokenizeHandoff, isSpecificTerm, LOW_SIGNAL_TITLE } from './utils.mjs';
import {
  HANDOFF_EXPIRY_CLEAR, HANDOFF_EXPIRY_EXIT, HANDOFF_MATCH_THRESHOLD, CONTINUE_KEYWORDS,
} from './hook-shared.mjs';
// T10d: import the whole module (not a named export) so tests can spy on
// gitStateModule.readGitState via vi.spyOn. Named-import bindings are
// immutable in ESM and cannot be mocked after the fact.
import * as gitStateModule from './lib/git-state.mjs';
import * as taskReaderModule from './lib/task-reader.mjs';

/**
 * Build and save a handoff snapshot to session_handoffs table.
 * Called synchronously during handleStop (/exit) or handleSessionStart (/clear).
 * @param {Database} db Opened main database
 * @param {string} sessionId Session being handed off
 * @param {string} project Project identifier
 * @param {'clear'|'exit'} type Handoff type
 * @param {object|null} episodeSnapshot Episode buffer captured before flushing
 */
export function buildAndSaveHandoff(db, sessionId, project, type, episodeSnapshot) {
  // 1. Working objective — from user prompts
  const prompts = db.prepare(`
    SELECT prompt_text FROM user_prompts
    WHERE content_session_id = ?
    ORDER BY prompt_number ASC LIMIT 5
  `).all(sessionId);
  if (prompts.length === 0) return;  // Empty session — nothing to hand off

  const seen = new Set();
  const uniquePrompts = prompts.filter(p => {
    const t = truncate(p.prompt_text, 200);
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  const workingOn = uniquePrompts.map(p => truncate(p.prompt_text, 200)).join(' → ');

  // 2. Completed — from observations (include narrative for richer handoff)
  const completed = db.prepare(`
    SELECT title, type, narrative FROM observations
    WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
    ORDER BY created_at_epoch DESC LIMIT 15
  `).all(sessionId);

  // 3. Unfinished — episode snapshot + full session edit history from narratives
  let unfinished = '';
  if (episodeSnapshot?.entries) {
    const seenDescs = new Set();
    const pendingDescs = episodeSnapshot.entries
      .filter(e => e.isSignificant || e.isError)
      .map(e => e.desc)
      .filter(d => { if (seenDescs.has(d)) return false; seenDescs.add(d); return true; });
    if (pendingDescs.length > 0) unfinished = pendingDescs.join('; ');
  }

  // T10d: TaskList-sourced Unfinished. When no episode pending entries exist,
  // prefer the structured signal from ~/.claude/tasks/<list>/*.json over the
  // narrative-only fallback — a user-maintained task list is a stronger signal
  // than a session with no recent tool activity. When the episode already has
  // pending entries, those stay (they're fresher than the task file).
  if (!unfinished) {
    try {
      const tasks = taskReaderModule.readProjectTasks({ projectPath: process.cwd() });
      if (tasks.length > 0) {
        unfinished = tasks
          .slice(0, 5)
          .map(t => `[${t.status}] ${t.title}`)
          .join('\n');
      }
    } catch { /* task reader is best-effort; never block handoff */ }
  }

  // Enrich unfinished with full session edit history from observation narratives.
  // Since handoff is UPSERT (max 2 rows per project), storing more data is free.
  // Always use \n---\n separator so extractUnfinishedSummary can distinguish
  // pending work (before separator) from narrative history (after separator).
  const narratives = completed
    .filter(c => c.narrative)
    .map(c => c.narrative);
  if (narratives.length > 0) {
    const editHistory = narratives.join('\n');
    unfinished += '\n---\n' + editHistory;
  }

  // 4. Key files — from episode snapshot + observations
  const fileSet = new Set();
  const isValidFile = f => f && f.length > 2 && f.includes('/') && f.indexOf('/', 1) !== -1
    && !f.startsWith('/dev/') && !f.startsWith('/proc/') && !f.startsWith('/tmp/');
  if (episodeSnapshot?.files) episodeSnapshot.files.filter(isValidFile).forEach(f => fileSet.add(f));
  const obsFiles = db.prepare(`
    SELECT files_modified FROM observations
    WHERE memory_session_id = ? AND files_modified IS NOT NULL
    ORDER BY created_at_epoch DESC LIMIT 10
  `).all(sessionId);
  for (const row of obsFiles) {
    try { JSON.parse(row.files_modified).filter(isValidFile).forEach(f => fileSet.add(f)); } catch {}
  }

  // 5. Key decisions — high importance observations (skip low-signal degraded titles)
  const decisions = db.prepare(`
    SELECT title FROM observations
    WHERE memory_session_id = ? AND COALESCE(importance, 1) >= 2
      AND COALESCE(compressed_into, 0) = 0
    ORDER BY created_at_epoch DESC LIMIT 10
  `).all(sessionId).filter(d => d.title && !LOW_SIGNAL_TITLE.test(d.title)).slice(0, 5);

  // 6. Match keywords
  const allText = [workingOn, ...completed.map(c => c.title).filter(Boolean), unfinished].join(' ');
  const keywords = extractMatchKeywords(allText, [...fileSet]);

  // T10d: capture HEAD sha so detectContinuationIntent can anchor on it later.
  // Best-effort — failures (non-git dir, missing binary, timeout) yield null.
  let gitShaAtHandoff = null;
  try {
    gitShaAtHandoff = gitStateModule.readGitState({ cwd: process.cwd() }).headSha || null;
  } catch { /* swallow — handoff must still persist */ }

  // UPSERT keyed on (project, type, session_id) — parallel sessions coexist.
  // Same session re-writing its own handoff (e.g. repeated /clear) updates in place.
  db.prepare(`
    INSERT INTO session_handoffs (project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch, git_sha_at_handoff)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, session_id) DO UPDATE SET
      working_on = excluded.working_on,
      completed = excluded.completed,
      unfinished = excluded.unfinished,
      key_files = excluded.key_files,
      key_decisions = excluded.key_decisions,
      match_keywords = excluded.match_keywords,
      created_at_epoch = excluded.created_at_epoch,
      git_sha_at_handoff = excluded.git_sha_at_handoff
  `).run(
    project, type, sessionId,
    truncate(workingOn, 1000),
    completed.map(c => `[${c.type}] ${c.title}`).join('\n'),
    unfinished.length > 3000 ? unfinished.slice(0, 2999) + '…' : unfinished,
    JSON.stringify([...fileSet].slice(0, 20)),
    decisions.map(d => d.title).join('\n'),
    keywords,
    Date.now(),
    gitShaAtHandoff,
  );
}

/**
 * Detect if user's prompt indicates continuation of previous work.
 * Stage 0: Non-expired clear handoff + short prompt → auto-continue.
 * Stage 1: Explicit keyword match (zero false positives).
 * Stage 2: FTS5-style term overlap with handoff keywords.
 *
 * Session scoping (currentCcSessionId): when provided, clear handoffs from a
 * DIFFERENT session are excluded from Stage 0 auto-match and from the general
 * pool (prevents cross-session bleed when running parallel sessions for the
 * same project — see docs/bug.txt). When null, legacy behavior is preserved.
 *
 * @param {Database} db Opened main database
 * @param {string} promptText User's prompt text
 * @param {string} project Project identifier
 * @param {string|null} [currentCcSessionId=null] Claude Code session id for scoping
 * @returns {boolean}
 */
export function detectContinuationIntent(db, promptText, project, currentCcSessionId = null) {
  // Input guard: empty / whitespace / single-char prompts never trigger auto-injection.
  // The bug was a single-char 'a' + fresh clear handoff → Stage 0 auto-match.
  if (!promptText || typeof promptText !== 'string') return false;
  if (promptText.trim().length < 2) return false;

  // T10d Stage -1: Git-commit anchor — if ANY handoff (any age) has a
  // git_sha_at_handoff matching current HEAD, the working tree hasn't moved
  // since that handoff, so assume continuation regardless of time / prompt.
  //
  // Trade-off: after weeks of no commits this fires aggressively. Users can
  // reset by making a commit or by typing a long unrelated prompt (this
  // anchor runs BEFORE the Stage 0 long-prompt guard, so that escape hatch
  // does not apply here). This is an MVP choice — see plan 10d concern.
  try {
    const currentSha = gitStateModule.readGitState({ cwd: process.cwd() }).headSha;
    if (currentSha) {
      const anchor = db.prepare(`
        SELECT 1 FROM session_handoffs
        WHERE project = ? AND git_sha_at_handoff = ?
        ORDER BY created_at_epoch DESC LIMIT 1
      `).get(project, currentSha);
      if (anchor) return true;
    }
  } catch { /* git/DB failure must not break the rest of the pipeline */ }

  // Stage 0: Non-expired 'clear' handoff — assume continuation unless long unrelated prompt.
  // Session scoping: with currentCcSessionId, only your OWN clear handoff qualifies.
  const clearHandoff = currentCcSessionId
    ? db.prepare(`
        SELECT created_at_epoch, match_keywords FROM session_handoffs
        WHERE project = ? AND type = 'clear' AND session_id = ?
        ORDER BY created_at_epoch DESC LIMIT 1
      `).get(project, currentCcSessionId)
    : db.prepare(`
        SELECT created_at_epoch, match_keywords FROM session_handoffs
        WHERE project = ? AND type = 'clear'
        ORDER BY created_at_epoch DESC LIMIT 1
      `).get(project);

  if (clearHandoff && (Date.now() - clearHandoff.created_at_epoch <= HANDOFF_EXPIRY_CLEAR)) {
    // Short/ambiguous prompts: assume continuation (user may say "ok", "start", etc.)
    if (promptText.length < 40) return true;
    // Long prompts: check keyword overlap to confirm same-task intent
    if (!clearHandoff.match_keywords) return true; // no keywords stored, can't verify
    const clearPromptTokens = tokenizeHandoff(promptText);
    const clearHandoffTokens = new Set(tokenizeHandoff(clearHandoff.match_keywords));
    if (clearPromptTokens.some(t => clearHandoffTokens.has(t))) return true;
    // Long prompt with zero keyword overlap → likely new task, fall through
  }

  // Stage 1: Explicit keyword match — always works, even without handoff
  if (CONTINUE_KEYWORDS.test(promptText)) return true;

  // Stage 2: FTS5-style term overlap with handoff keywords.
  // Session scoping: exit handoffs from OTHER sessions are still candidates (you may
  // be resuming a previous session), but clear handoffs must be same-session.
  const handoffs = currentCcSessionId
    ? db.prepare(`
        SELECT type, match_keywords, created_at_epoch FROM session_handoffs
        WHERE project = ?
          AND ((type = 'clear' AND session_id = ?) OR type = 'exit')
        ORDER BY created_at_epoch DESC
      `).all(project, currentCcSessionId)
    : db.prepare(`
        SELECT type, match_keywords, created_at_epoch FROM session_handoffs
        WHERE project = ? ORDER BY created_at_epoch DESC
      `).all(project);
  if (handoffs.length === 0) return false;

  // Filter expired handoffs
  const now = Date.now();
  const validHandoffs = handoffs.filter(h => {
    const age = now - h.created_at_epoch;
    const maxAge = h.type === 'clear' ? HANDOFF_EXPIRY_CLEAR : HANDOFF_EXPIRY_EXIT;
    return age <= maxAge;
  });
  if (validHandoffs.length === 0) return false;

  // Use the most recent valid handoff for keyword matching
  const handoff = validHandoffs[0];
  const promptTokens = tokenizeHandoff(promptText);
  const handoffTokens = new Set(tokenizeHandoff(handoff.match_keywords));

  let score = 0;
  for (const token of promptTokens) {
    if (handoffTokens.has(token)) {
      score += isSpecificTerm(token) ? 2 : 1;
    }
  }

  return score >= HANDOFF_MATCH_THRESHOLD;
}

/**
 * Render handoff injection text for stdout.
 * Reads the most recent handoff + optional session summary.
 *
 * Session scoping (currentCcSessionId): when provided,
 *   - clear handoffs: only from the CURRENT session (you continue your own /clear)
 *   - exit handoffs:  only from OTHER sessions (you resume a previous exit)
 * When null, legacy behavior (most-recent handoff regardless of session).
 *
 * @param {Database} db Opened main database
 * @param {string} project Project identifier
 * @param {string|null} [currentCcSessionId=null] Claude Code session id for scoping
 * @returns {string|null} Injection text or null if no handoff
 */
export function renderHandoffInjection(db, project, currentCcSessionId = null) {
  const now = Date.now();
  // Fetch recent handoffs and find the most recent non-expired one.
  // A newer but expired 'clear' handoff must not shadow a still-valid 'exit' handoff.
  const handoffs = currentCcSessionId
    ? db.prepare(`
        SELECT * FROM session_handoffs
        WHERE project = ?
          AND ((type = 'clear' AND session_id = ?) OR (type = 'exit' AND session_id != ?))
        ORDER BY created_at_epoch DESC LIMIT 5
      `).all(project, currentCcSessionId, currentCcSessionId)
    : db.prepare(`
        SELECT * FROM session_handoffs
        WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 5
      `).all(project);
  const handoff = handoffs.find(h => {
    const age = now - h.created_at_epoch;
    const maxAge = h.type === 'clear' ? HANDOFF_EXPIRY_CLEAR : HANDOFF_EXPIRY_EXIT;
    return age <= maxAge;
  });
  if (!handoff) return null;

  const ageSec = Math.round((Date.now() - handoff.created_at_epoch) / 1000);
  const ageStr = ageSec < 60 ? `${ageSec}s` :
    ageSec < 3600 ? `${Math.round(ageSec / 60)}m` :
    ageSec < 86400 ? `${Math.round(ageSec / 3600)}h` :
    `${Math.round(ageSec / 86400)}d`;

  // Framing header: `UserPromptSubmit` hook writes this block to stdout, which
  // Claude Code surfaces alongside the real user prompt. Without an explicit
  // "this is not a new message" marker, models can misread `## Working On <text>`
  // as a fresh user utterance and either answer the old task or end the turn.
  // The `[mem]` prefix mirrors the SessionStart dashboard convention; `origin`
  // on the tag gives programmatic callers a stable anchor.
  const lines = [
    `[mem] Resumed context from previous session (${handoff.type}, age ${ageStr}) — system-injected, NOT a new user message:`,
    `<session-handoff source="${handoff.type}" age="${ageStr}" origin="hook-injected">`,
  ];

  if (handoff.working_on) {
    lines.push('## Working On', handoff.working_on, '');
  }
  if (handoff.completed) {
    lines.push('## Completed', ...handoff.completed.split('\n').map(l => `- ${l}`), '');
  }
  if (handoff.unfinished) {
    // Extract only the pending-work portion (before narrative history separator)
    const pending = extractUnfinishedSummary(handoff.unfinished);
    if (pending) {
      lines.push('## Unfinished', ...pending.split('; ').map(l => `- ${l}`), '');
    }
  }
  if (handoff.key_files) {
    try {
      const files = JSON.parse(handoff.key_files);
      if (files.length > 0) lines.push('## Key Files', files.map(f => basename(f)).join(', '), '');
    } catch {}
  }
  if (handoff.key_decisions) {
    lines.push('## Key Decisions', ...handoff.key_decisions.split('\n').map(l => `- ${l}`), '');
  }

  lines.push('</session-handoff>');

  // Append session summary if available (long-gap enrichment)
  try {
    const summary = db.prepare(`
      SELECT completed, next_steps, remaining_items FROM session_summaries
      WHERE memory_session_id = ? AND project = ?
      ORDER BY created_at_epoch DESC LIMIT 1
    `).get(handoff.session_id, project);
    if (summary && (summary.completed || summary.next_steps || summary.remaining_items)) {
      lines.push('');
      lines.push('<session-summary source="haiku">');
      if (summary.completed) lines.push(summary.completed);
      if (summary.remaining_items) lines.push(`Remaining: ${summary.remaining_items}`);
      if (summary.next_steps) lines.push(`Next steps: ${summary.next_steps}`);
      lines.push('</session-summary>');
    }
  } catch {}

  return lines.join('\n');
}

// Separator used by buildAndSaveHandoff to join pending entries with narrative history.
const UNFINISHED_NARRATIVE_SEP = '\n---\n';
const UNFINISHED_ENTRY_SEP = '; ';

/**
 * Extract the pending-work portion of the unfinished field (before narrative history).
 * @param {string} unfinished Raw unfinished text from session_handoffs
 * @param {number} [maxItems=3] Max number of pending entries to return
 * @returns {string} Pending work summary (empty string if none)
 */
export function extractUnfinishedSummary(unfinished, maxItems = 3) {
  if (!unfinished) return '';
  const pending = unfinished.split(UNFINISHED_NARRATIVE_SEP)[0];
  if (maxItems > 0) {
    return pending.split(UNFINISHED_ENTRY_SEP).slice(0, maxItems).join(UNFINISHED_ENTRY_SEP);
  }
  return pending;
}
