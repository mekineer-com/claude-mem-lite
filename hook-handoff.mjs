// claude-mem-lite: Cross-session handoff extraction, detection, and injection
// Extracted for testability — hook.mjs has module-level side effects

import { basename } from 'path';
import { truncate, extractMatchKeywords, tokenizeHandoff, isSpecificTerm } from './utils.mjs';
import {
  HANDOFF_EXPIRY_CLEAR, HANDOFF_EXPIRY_EXIT, HANDOFF_MATCH_THRESHOLD, CONTINUE_KEYWORDS,
} from './hook-shared.mjs';

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

  const workingOn = prompts.map(p => truncate(p.prompt_text, 200)).join(' → ');

  // 2. Completed — from observations (include narrative for richer handoff)
  const completed = db.prepare(`
    SELECT title, type, narrative FROM observations
    WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
    ORDER BY created_at_epoch DESC LIMIT 15
  `).all(sessionId);

  // 3. Unfinished — episode snapshot + full session edit history from narratives
  let unfinished = '';
  if (episodeSnapshot?.entries) {
    const pendingDescs = episodeSnapshot.entries
      .filter(e => e.isSignificant || e.isError)
      .map(e => e.desc);
    if (pendingDescs.length > 0) unfinished = pendingDescs.join('; ');
  }
  // Only the most recent bugfix is an "unfinished" signal (earlier ones are likely resolved)
  if (!unfinished) {
    const lastBugfix = completed.find(o => o.type === 'bugfix');
    if (lastBugfix) unfinished = lastBugfix.title;
  }
  // Enrich unfinished with full session edit history from observation narratives.
  // Since handoff is UPSERT (max 2 rows per project), storing more data is free.
  const narratives = completed
    .filter(c => c.narrative)
    .map(c => c.narrative);
  if (narratives.length > 0) {
    const editHistory = narratives.join('\n');
    unfinished = [unfinished, editHistory].filter(Boolean).join('\n---\n');
  }

  // 4. Key files — from episode snapshot + observations
  const fileSet = new Set();
  if (episodeSnapshot?.files) episodeSnapshot.files.forEach(f => fileSet.add(f));
  const obsFiles = db.prepare(`
    SELECT files_modified FROM observations
    WHERE memory_session_id = ? AND files_modified IS NOT NULL
    ORDER BY created_at_epoch DESC LIMIT 10
  `).all(sessionId);
  for (const row of obsFiles) {
    try { JSON.parse(row.files_modified).forEach(f => fileSet.add(f)); } catch {}
  }

  // 5. Key decisions — high importance observations
  const decisions = db.prepare(`
    SELECT title FROM observations
    WHERE memory_session_id = ? AND COALESCE(importance, 1) >= 2
      AND COALESCE(compressed_into, 0) = 0
    ORDER BY created_at_epoch DESC LIMIT 5
  `).all(sessionId);

  // 6. Match keywords
  const allText = [workingOn, ...completed.map(c => c.title).filter(Boolean), unfinished].join(' ');
  const keywords = extractMatchKeywords(allText, [...fileSet]);

  // UPSERT
  db.prepare(`
    INSERT INTO session_handoffs (project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, type) DO UPDATE SET
      session_id = excluded.session_id,
      working_on = excluded.working_on,
      completed = excluded.completed,
      unfinished = excluded.unfinished,
      key_files = excluded.key_files,
      key_decisions = excluded.key_decisions,
      match_keywords = excluded.match_keywords,
      created_at_epoch = excluded.created_at_epoch
  `).run(
    project, type, sessionId,
    truncate(workingOn, 1000),
    completed.map(c => `[${c.type}] ${c.title}`).join('\n'),
    truncate(unfinished, 3000),
    JSON.stringify([...fileSet].slice(0, 20)),
    decisions.map(d => d.title).join('\n'),
    keywords,
    Date.now()
  );
}

/**
 * Detect if user's prompt indicates continuation of previous work.
 * Stage 1: Explicit keyword match (zero false positives).
 * Stage 2: FTS5-style term overlap with handoff keywords.
 * @param {Database} db Opened main database
 * @param {string} promptText User's prompt text
 * @param {string} project Project identifier
 * @returns {boolean}
 */
export function detectContinuationIntent(db, promptText, project) {
  // Stage 0: Non-expired 'clear' handoff = always continue (/clear means user is resuming)
  const clearHandoff = db.prepare(`
    SELECT created_at_epoch FROM session_handoffs WHERE project = ? AND type = 'clear'
  `).get(project);
  if (clearHandoff && (Date.now() - clearHandoff.created_at_epoch <= HANDOFF_EXPIRY_CLEAR)) {
    return true;
  }

  // Stage 1: Explicit keyword match — always works, even without handoff
  if (CONTINUE_KEYWORDS.test(promptText)) return true;

  // Stage 2: FTS5-style term overlap with handoff keywords
  const handoffs = db.prepare(`
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
 * @param {Database} db Opened main database
 * @param {string} project Project identifier
 * @returns {string|null} Injection text or null if no handoff
 */
export function renderHandoffInjection(db, project) {
  const now = Date.now();
  // Fetch recent handoffs and find the most recent non-expired one.
  // A newer but expired 'clear' handoff (1h) must not shadow a still-valid 'exit' handoff (7d).
  const handoffs = db.prepare(`
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

  const lines = [`<session-handoff source="${handoff.type}" age="${ageStr}">`];

  if (handoff.working_on) {
    lines.push('## Working On', handoff.working_on, '');
  }
  if (handoff.completed) {
    lines.push('## Completed', ...handoff.completed.split('\n').map(l => `- ${l}`), '');
  }
  if (handoff.unfinished) {
    lines.push('## Unfinished', ...handoff.unfinished.split('; ').map(l => `- ${l}`), '');
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
