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

// Matches a pre-tool-recall lesson line: `  #NN [type] body...`. Bounded type
// list mirrors observations.type CHECK + the events table's allowed event_type
// values pre-tool-recall.js can surface.
const INJECTED_RE = /#(\d{1,7})\s+\[(bugfix|decision|change|discovery|feature|refactor|lesson)\]/g;

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
  if (!transcriptPath || !existsSync(transcriptPath)) return ids;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return ids; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'attachment') continue;
    const att = entry.attachment;
    if (!att || att.type !== 'hook_success') continue;
    if (!(att.command || '').includes('pre-tool-recall')) continue;
    const stdout = att.stdout || '';
    if (!stdout) continue;
    // stdout is JSON wrapping additionalContext OR raw text (legacy);
    // try JSON first and fall back to raw.
    let text = stdout;
    try {
      const parsed = JSON.parse(stdout);
      text = parsed?.hookSpecificOutput?.additionalContext || stdout;
    } catch {}
    INJECTED_RE.lastIndex = 0;
    let m;
    while ((m = INJECTED_RE.exec(text))) {
      const id = Number(m[1]);
      if (Number.isInteger(id) && id > 0 && id < 1e7) ids.add(id);
    }
  }
  return ids;
}
