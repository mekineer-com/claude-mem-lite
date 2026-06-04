// Citation tracker (P4): scan Claude Code transcript for `#NN` observation-id
// citations in assistant text, then bulk-increment access_count for matched rows.
//
// Closes the loop on the CLAUDE.md "cite #NN" contract — before P4, citations
// were a one-way obligation with no measurable feedback. Now each honored
// citation bumps access_count, making contract compliance observable via
// mem_stats and preventing cited lessons from decaying into dead memory.
//
// FTS5 caveat (project_non_obvious.md): observations_au trigger fires on any
// column UPDATE including access_count. Per-row UPDATEs wrapped in try-catch
// to prevent SQLITE_CORRUPT_VTAB cascades from stopping the whole scan.

import { readFileSync, existsSync } from 'fs';
import { debugCatch } from '../utils.mjs';

// `#123` / `#45678` at a word boundary — matches the CLAUDE.md cite pattern.
// Bounded to 1-7 digits to skip URL fragments, markdown anchors, etc.
const CITATION_RE = /#(\d{1,7})\b/g;

/**
 * Parse a Claude Code transcript .jsonl and extract unique observation IDs
 * cited inside assistant text blocks.
 *
 * @param {string} transcriptPath Path to transcript file (.jsonl)
 * @param {object} [opts] Options
 * @param {boolean} [opts.mainOnly=false] If true, skip transcript records where isSidechain === true
 * @returns {Set<number>} unique IDs referenced as `#NN` in assistant text
 */
export function extractCitationsFromTranscript(transcriptPath, opts = {}) {
  const { mainOnly = false } = opts;
  const ids = new Set();
  if (!transcriptPath || !existsSync(transcriptPath)) return ids;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return ids; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    // Claude Code transcript: one JSON per line with type='assistant' | 'user' | ...
    if (entry.type !== 'assistant' || !entry.message) continue;
    // Citation-decay loop scopes citation signal to main-thread text only —
    // subagent dispatches run their own session context the parent can't
    // reasonably be held accountable for. Default off preserves the broader
    // access_count-bump semantics of existing callers (P4 bumpCitationAccess).
    if (mainOnly && entry.isSidechain === true) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      CITATION_RE.lastIndex = 0;
      let m;
      while ((m = CITATION_RE.exec(block.text))) {
        const id = Number(m[1]);
        if (Number.isInteger(id) && id > 0 && id < 1e7) ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Compute cite-recall stats for one transcript: how many of the `#NN`
 * references that surfaced in non-assistant content (hook injections, system
 * reminders, tool_result blocks) the assistant actually cited back. Used to
 * power SessionStart feedback when prior-session compliance is low.
 *
 * Definition: ratio = |injected ∩ cited| / |injected|.
 * `injected` is intentionally over-inclusive — it captures any `#NN` that was
 * visible to the model in non-assistant content. User-pasted IDs leak into
 * this set; the SessionStart consumer mitigates with a min-volume floor.
 *
 * @param {string} transcriptPath
 * @returns {{injected: number, cited: number, recalled: number, ratio: number}}
 *   Returns zeros if transcript is missing or empty.
 */
export function computeCiteRecall(transcriptPath) {
  const empty = { injected: 0, cited: 0, recalled: 0, ratio: 0 };
  if (!transcriptPath || !existsSync(transcriptPath)) return empty;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return empty; }

  const injected = new Set();
  const cited = new Set();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const target = entry.type === 'assistant' ? cited : injected;
    // Walk every text-bearing surface the transcript carries: top-level content,
    // nested message content (assistant/user blocks), and tool_result-style
    // entries that hide hook injections inside system-reminders.
    const surfaces = [];
    if (typeof entry.content === 'string') surfaces.push(entry.content);
    if (Array.isArray(entry.content)) surfaces.push(...entry.content);
    if (entry.message?.content) {
      if (typeof entry.message.content === 'string') surfaces.push(entry.message.content);
      else if (Array.isArray(entry.message.content)) surfaces.push(...entry.message.content);
    }
    for (const s of surfaces) {
      let text = '';
      if (typeof s === 'string') text = s;
      else if (s && typeof s === 'object') {
        if (typeof s.text === 'string') text = s.text;
        else if (typeof s.content === 'string') text = s.content;
      }
      if (!text) continue;
      CITATION_RE.lastIndex = 0;
      let m;
      while ((m = CITATION_RE.exec(text))) {
        const id = Number(m[1]);
        if (Number.isInteger(id) && id > 0 && id < 1e7) target.add(id);
      }
    }
  }

  let recalled = 0;
  for (const id of injected) if (cited.has(id)) recalled++;
  const ratio = injected.size > 0 ? recalled / injected.size : 0;
  return { injected: injected.size, cited: cited.size, recalled, ratio };
}

/**
 * Increment `access_count` (and `last_accessed_at`) for each cited observation
 * that belongs to `project`. Returns the count of successful increments.
 *
 * Per-row UPDATE in try-catch so a single FTS-corrupted row can't abort the
 * scan. Cross-project IDs are silently ignored by the WHERE clause.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Iterable<number>} ids
 * @param {string} project
 * @returns {number} count of rows incremented
 */
export function bumpCitationAccess(db, ids, project) {
  if (!db || !ids || !project) return 0;
  const idList = Array.isArray(ids) ? ids : [...ids];
  if (idList.length === 0) return 0;
  const stmt = db.prepare(`
    UPDATE observations SET access_count = access_count + 1, last_accessed_at = ?
    WHERE id = ? AND project = ?
  `);
  const now = Date.now();
  let n = 0;
  for (const id of idList) {
    try {
      const result = stmt.run(now, id, project);
      if (result.changes > 0) n++;
    } catch (e) { debugCatch(e, `bumpCitationAccess-id-${id}`); }
  }
  return n;
}

// Matches a pre-tool-recall / error-recall lesson line: `  #NN [type] body...`.
// Bounded type list mirrors observations.type CHECK + the events table's allowed
// event_type values these surfaces can emit.
const INJECTED_RE = /#(\d{1,7})\s+\[(bugfix|decision|change|discovery|feature|refactor|lesson)\]/g;

// Add a numeric obs id to `set` if it parses to a sane in-range positive int.
function addObsId(set, raw) {
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0 && id < 1e7) set.add(id);
}

// Claude Code records a registered hook command (e.g. `node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" user-prompt`)
// VERBATIM with the path quote-wrapped: `node "/abs/hook.mjs" user-prompt`. A
// naive `.includes('hook.mjs user-prompt')` then fails because the `"` sits
// between the path and the subcommand — this was the bug that made the entire
// UserPromptSubmit injection surface invisible to citation-decay in every real
// install (tests only ever used unquoted commands, so it was never caught).
// Strip shell quotes before substring-matching so command detection is robust to
// plugin-cache vs symlinked-install AND quoted vs unquoted path forms.
function normalizeHookCommand(command) {
  return (command || '').replace(/["']/g, '');
}

/**
 * Walk every `hook_success` attachment in a transcript, invoking `fn` with the
 * quote-normalized command and the injected text (JSON additionalContext
 * unwrapped when present, else raw stdout). Shared by all injection extractors
 * so command-matching + JSON-unwrap logic lives in exactly one place.
 *
 * @param {string|null|undefined} transcriptPath
 * @param {(ctx: {command: string, text: string}) => void} fn
 */
function eachHookAttachment(transcriptPath, fn) {
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'attachment') continue;
    const att = entry.attachment;
    if (!att || att.type !== 'hook_success') continue;
    const stdout = att.stdout || '';
    if (!stdout) continue;
    // stdout is JSON wrapping additionalContext OR raw text (triggerErrorRecall
    // and the <memory-context> block write raw). Try JSON first, fall back to raw.
    let text = stdout;
    try {
      const parsed = JSON.parse(stdout);
      text = parsed?.hookSpecificOutput?.additionalContext || stdout;
    } catch {}
    fn({ command: normalizeHookCommand(att.command), text });
  }
}

/**
 * Extract observation IDs injected by pre-tool-recall hook in this transcript.
 *
 * Tighter than `computeCiteRecall`'s over-inclusive "any #NN in non-assistant
 * text" — only counts IDs the agent actually saw from us, not user-pasted
 * references or unrelated #NN tokens in tool output.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>} unique injected IDs (empty set on missing path/file)
 */
export function extractInjectedFromPreToolUse(transcriptPath) {
  const ids = new Set();
  eachHookAttachment(transcriptPath, ({ command, text }) => {
    if (!command.includes('pre-tool-recall')) return;
    INJECTED_RE.lastIndex = 0;
    let m;
    while ((m = INJECTED_RE.exec(text))) addObsId(ids, m[1]);
  });
  return ids;
}

// v34.x: UserPromptSubmit injection extractor. hook.mjs handleUserPrompt emits
// formatMemoryLine `- [type] title | Lesson: X (#NN)[ [verify-before-use]]`,
// which INJECTED_RE (anchored on `#NN [type]`) never matched — leaving this
// injection surface invisible to applyCitationDecay. The extractors are disjoint
// by design: PTR has `[type]` AFTER `#NN`, UPS has `(#NN)` at end-of-line.
//
// Line-scan with `- [` prefix gate so a lesson body containing a back-reference
// like "see (#999)" doesn't pollute the injected set (would streak-uncite an
// obs we never actually displayed as a top-level entry).
const UPS_LINE_PREFIX = '- [';
const UPS_ID_RE = /\(#(\d{1,7})\)/g;
// Quote-normalized (see normalizeHookCommand): real recorded command is
// `node "/abs/hook.mjs" user-prompt` → normalized to `node /abs/hook.mjs user-prompt`.
const UPS_COMMAND_SUFFIX = 'hook.mjs user-prompt';

/**
 * Extract observation IDs injected by the UserPromptSubmit `<memory-context>`
 * block (hook.mjs handleUserPrompt). Disjoint from pre-tool-recall extraction —
 * the Stop handler unions all surfaces via extractAllInjected.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractInjectedFromUserPromptSubmit(transcriptPath) {
  const ids = new Set();
  eachHookAttachment(transcriptPath, ({ command, text }) => {
    if (!command.includes(UPS_COMMAND_SUFFIX)) return;
    if (!text.includes('<memory-context')) return;
    for (const memLine of text.split('\n')) {
      if (!memLine.startsWith(UPS_LINE_PREFIX)) continue;
      // Take the LAST (#NN) on the line — formatMemoryLine puts the obs id
      // in trailing parens, possibly followed by ` [verify-before-use]`. Any
      // earlier (#NN) refs are inside title/lesson text.
      const matches = [...memLine.matchAll(UPS_ID_RE)];
      if (matches.length === 0) continue;
      addObsId(ids, matches[matches.length - 1][1]);
    }
  });
  return ids;
}

/**
 * Extract observation IDs injected by the PostToolUse error-recall hint
 * (hook.mjs triggerErrorRecall → `[claude-mem-lite] Related memories found for
 * this error:` followed by `  #NN [type] title` lines, delivered via
 * post-tool-use.sh). This is a high-volume surface that NO extractor matched
 * before — error-recall'd obs accrued injection_count but never reached
 * applyCitationDecay, so they could neither promote nor demote.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractInjectedFromErrorRecall(transcriptPath) {
  const ids = new Set();
  eachHookAttachment(transcriptPath, ({ command, text }) => {
    if (!command.includes('post-tool-use')) return;
    if (!text.includes('Related memories found for this error')) return;
    // INJECTED_RE requires `#NN [type]`, so the trailing
    // `→ Use mem_get(ids=[7933,8455])` line (bare numbers) is not matched.
    INJECTED_RE.lastIndex = 0;
    let m;
    while ((m = INJECTED_RE.exec(text))) addObsId(ids, m[1]);
  });
  return ids;
}

// user-prompt-search.js formatResults emits `[mem] FYI — Related memories ...`
// then one `#NN <icon> title` row per obs (raw stdout, line-leading id). Distinct
// from the `<memory-context>` block (hook.mjs) — the two UPS injectors dedup obs
// by id at inject time, so they carry DISJOINT obs sets; both must be extracted
// or the FYI-carried (highest-importance keyContext) obs never reach decay.
const FYI_HEADER = '[mem] FYI — Related memories';
// Anchored at line start so `P#NN` past-question rows (user_prompts, different id
// space) and any `#NN` inside lesson text are NOT matched.
const FYI_LINE_ID_RE = /^#(\d{1,7})\s/;

/**
 * Extract observation IDs injected by the user-prompt-search.js `[mem] FYI —
 * Related memories` block.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractInjectedFromFyi(transcriptPath) {
  const ids = new Set();
  eachHookAttachment(transcriptPath, ({ command, text }) => {
    if (!command.includes('user-prompt-search')) return;
    if (!text.includes(FYI_HEADER)) return;
    for (const fyiLine of text.split('\n')) {
      const m = FYI_LINE_ID_RE.exec(fyiLine);
      if (m) addObsId(ids, m[1]);
    }
  });
  return ids;
}

/**
 * Union of every injection surface's IDs for a transcript: pre-tool-recall +
 * UserPromptSubmit `<memory-context>` + PostToolUse error-recall + the
 * user-prompt-search FYI block. Single integration point the Stop handler calls.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractAllInjected(transcriptPath) {
  return new Set([
    ...extractInjectedFromPreToolUse(transcriptPath),
    ...extractInjectedFromUserPromptSubmit(transcriptPath),
    ...extractInjectedFromErrorRecall(transcriptPath),
    ...extractInjectedFromFyi(transcriptPath),
  ]);
}

/**
 * True iff the transcript contains at least one non-whitespace text block from
 * a main-thread assistant turn. Gates the citation-decay loop so a tool-only
 * Stop doesn't lock an injection as "uncited" before the model has had a
 * chance to produce user-facing text. Per CLAUDE.md the cite contract is
 * "NEXT time you produce user-facing text" — not "same turn." Without this
 * gate, a turn that ends on tool_use sees applyCitationDecay run, set
 * last_decided_session_id, and freeze the verdict at uncited even though a
 * later turn in the same session would have cited correctly.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function hasMainThreadAssistantText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return false; }
  // Reverse-iterate so a turn that just produced text returns true on the
  // FIRST line examined instead of walking the entire transcript. Common case
  // (model wrote a paragraph → Stop fires) short-circuits in O(1) line parses;
  // pathological case (no text anywhere) still walks all entries but that's
  // the degenerate state we want false for anyway. v2.80 perf polish — the
  // pre-v2.80 forward scan held the full transcript in memory and walked
  // every line on the common case too.
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message) continue;
    if (entry.isSidechain === true) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      if (block.text.trim().length > 0) return true;
    }
  }
  return false;
}

const IMPORTANCE_CAP = 3;
const IMPORTANCE_FLOOR = 0;
const UNCITED_STREAK_THRESHOLD = 3;

// Adoption-rate gate (P5 ②). A project's cite-rate is SUM(cited_count) /
// SUM(decay_seen_count) over its non-superseded observations: of every decay
// resolution this project has ever produced, what fraction were citations.
// Below ADOPTION_THRESHOLD with at least ADOPTION_MIN_SEEN resolutions on record,
// the project has demonstrably not adopted the #NN convention, so we suppress
// DEMOTION (never promotion) — see the construct-validity note on
// applyCitationDecay. MIN_SEEN keeps the gate dormant for low-data projects so
// the established behavior is preserved until there's enough signal to judge.
const ADOPTION_THRESHOLD = 0.02;
const ADOPTION_MIN_SEEN = 8;

/**
 * Compute a project's citation-adoption snapshot: total citations vs total decay
 * resolutions on record, and their ratio. Read-only; safe to call before the
 * decay transaction (the gate decision is made on the pre-mutation snapshot).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {{cited: number, seen: number, rate: number}}
 */
export function computeCitationAdoption(db, project) {
  const empty = { cited: 0, seen: 0, rate: 0 };
  if (!db || !project) return empty;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(cited_count), 0)       AS cited,
             COALESCE(SUM(decay_seen_count), 0)  AS seen
        FROM observations
       WHERE project = ? AND superseded_at IS NULL
    `).get(project);
    const cited = row?.cited || 0;
    const seen = row?.seen || 0;
    return { cited, seen, rate: seen > 0 ? cited / seen : 0 };
  } catch (e) { debugCatch(e, 'computeCitationAdoption'); return empty; }
}

/**
 * Apply the citation-feedback loop for one session: for each injected obs id,
 * decide cited vs uncited and mutate importance/streak/cited_count per spec.
 *
 * - cited: importance += 1 (cap 3), cited_count += 1, streak = 0.
 * - uncited: streak += 1; if it reaches 3, importance -= 1 (floor 0), streak = 0.
 * - per-(session, obs) idempotent via last_decided_session_id; re-running for
 *   the same session is a no-op (Stop hook may fire more than once).
 * - cross-project IDs are silently ignored by the WHERE clause.
 * - MEM_DISABLE_CITATION_DECAY=1 disables all writes; returns zeros.
 *
 * CONSTRUCT-VALIDITY ASSUMPTION (P5): a "citation" is operationally two signals,
 * neither of which is ground-truth behavioral impact:
 *   1. the literal `#NN` token appears in main-thread assistant text (citedIds), and
 *   2. (cite-back) the agent edited a file a prior lesson #NN had warned about —
 *      unioned into citedIds by the Stop handler before this call.
 * Signal 2 was added because signal 1 alone penalizes projects that act on a
 * lesson without typing its id. Even so, both are proxies. For a project that has
 * never cited anything (cite-rate below ADOPTION_THRESHOLD over ≥ADOPTION_MIN_SEEN
 * resolutions), demotion is suppressed: absent any positive signal we cannot
 * distinguish "useless lesson" from "useful lesson in a project that doesn't use
 * the #NN convention," and a false demotion is the costlier error. The gate trades
 * missed demotions (stale lessons linger) for avoided false demotions. Promotion
 * is never gated — a single citation lifts the project's rate and re-enables decay.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Set<number>|Iterable<number>} injectedIds
 * @param {Set<number>|Iterable<number>} citedIds
 * @param {string} sessionId — memory_session_id of the session being resolved
 * @returns {{promoted: number, demoted: number, touched: number}}
 */
export function applyCitationDecay(db, project, injectedIds, citedIds, sessionId) {
  const empty = { promoted: 0, demoted: 0, touched: 0 };
  if (process.env.MEM_DISABLE_CITATION_DECAY === '1') return empty;
  if (!db || !project || !sessionId) return empty;
  const injected = injectedIds instanceof Set ? injectedIds : new Set(injectedIds || []);
  if (injected.size === 0) return empty;
  const cited = citedIds instanceof Set ? citedIds : new Set(citedIds || []);

  // Adoption gate (snapshot taken before any mutation this run). Suppress only
  // demotion; promotion always proceeds. Threshold overridable via env.
  const adoption = computeCitationAdoption(db, project);
  const envThreshold = Number.parseFloat(process.env.CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD);
  const adoptionThreshold = Number.isFinite(envThreshold) && envThreshold >= 0 ? envThreshold : ADOPTION_THRESHOLD;
  const suppressDemotion = adoption.seen >= ADOPTION_MIN_SEEN && adoption.rate < adoptionThreshold;

  const selectStmt = db.prepare(
    'SELECT id, importance, uncited_streak, last_decided_session_id FROM observations WHERE id = ? AND project = ?'
  );
  // decay_seen_count (v34) bumps on every resolution branch — gives
  // citation-stats a denominator that's same-source as cited_count, so the
  // ratio actually means "cite-rate" instead of mixing decay + UserPromptSubmit.
  const updatePromote = db.prepare(`
    UPDATE observations
       SET importance = MIN(?, importance + 1),
           cited_count = cited_count + 1,
           uncited_streak = 0,
           last_decided_session_id = ?,
           decay_seen_count = decay_seen_count + 1
     WHERE id = ?
  `);
  const updateStreakOnly = db.prepare(`
    UPDATE observations
       SET uncited_streak = uncited_streak + 1,
           last_decided_session_id = ?,
           decay_seen_count = decay_seen_count + 1
     WHERE id = ?
  `);
  // Suppressed (non-adopting) projects never demote, so uncited_streak would grow
  // UNBOUNDED — and citeFactorClause penalizes -0.25*streak (floor 0.4), pinning every
  // memory at the ranking floor with no recovery path. Cap at UNCITED_STREAK_THRESHOLD-1
  // to hold the [0, threshold-1] steady state the scoring header asserts (in an adopting
  // project the streak resets to 0 on demote, so the STORED value never exceeds 2).
  const updateStreakCapped = db.prepare(`
    UPDATE observations
       SET uncited_streak = MIN(uncited_streak + 1, ?),
           last_decided_session_id = ?,
           decay_seen_count = decay_seen_count + 1
     WHERE id = ?
  `);
  const updateDemote = db.prepare(`
    UPDATE observations
       SET importance = MAX(?, importance - 1),
           uncited_streak = 0,
           last_decided_session_id = ?,
           demoted_at = ?,
           decay_seen_count = decay_seen_count + 1
     WHERE id = ?
  `);

  let promoted = 0, demoted = 0, touched = 0;
  const txn = db.transaction(() => {
    for (const id of injected) {
      const row = selectStmt.get(id, project);
      if (!row) continue; // cross-project or deleted
      if (row.last_decided_session_id === sessionId) continue; // idempotent skip
      touched++;
      if (cited.has(id)) {
        updatePromote.run(IMPORTANCE_CAP, sessionId, id);
        promoted++;
      } else {
        const nextStreak = (row.uncited_streak || 0) + 1;
        // Demote only when the streak is up AND the project has demonstrably
        // adopted citations. A non-adopting project advances the streak (idempotent
        // bookkeeping) but never loses importance — see construct-validity note.
        if (nextStreak >= UNCITED_STREAK_THRESHOLD && !suppressDemotion) {
          updateDemote.run(IMPORTANCE_FLOOR, sessionId, Date.now(), id);
          demoted++;
        } else if (suppressDemotion) {
          // Never-demoting project: cap the streak so cite_factor can't sink to floor.
          updateStreakCapped.run(UNCITED_STREAK_THRESHOLD - 1, sessionId, id);
        } else {
          updateStreakOnly.run(sessionId, id);
        }
      }
    }
  });
  try { txn(); } catch (e) { debugCatch(e, 'applyCitationDecay-txn'); return empty; }
  return { promoted, demoted, touched };
}
