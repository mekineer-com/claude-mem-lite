// lib/get-core.mjs — shared core for the CLI `get` / MCP `mem_get` twin (P2-12,
// audit 2026-08-14). The 23-element OBS_FIELDS array was duplicated verbatim in
// mem-cli.mjs and server.mjs (the 16-vs-24-column export data-loss incident's
// precursor shape), and the session detail field sets had ALREADY diverged
// (MCP 13 fields vs CLI 6 — a `remaining_items` FTS hit was a dead end in the
// CLI detail view). Field sets + the access-bump fetch live here; each face
// keeps its own header/label rendering conventions.

import { autoBoostIfNeeded } from '../search-scoring.mjs';

/** Every observation column `get --fields` accepts, in render order. */
export const OBS_FIELDS = ['id', 'type', 'title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned', 'search_aliases', 'files_read', 'files_modified', 'project', 'created_at', 'memory_session_id', 'prompt_number', 'importance', 'related_ids', 'access_count', 'branch', 'superseded_at', 'superseded_by', 'last_accessed_at'];

/** Session-summary detail render set — the FULL set (both faces). The CLI's old
 *  6-field subset made notes/remaining_items/files_* searchable-but-unrenderable. */
export const SESSION_DETAIL_FIELDS = ['id', 'request', 'investigated', 'learned', 'completed', 'next_steps', 'remaining_items', 'files_read', 'files_edited', 'notes', 'project', 'created_at', 'memory_session_id', 'prompt_number'];

/**
 * Fetch observation detail rows: bump access_count/last_accessed_at (reading a
 * detail IS an access signal — feeds noisePenalty's ratio guard), run the
 * auto-boost heuristic, and return rows oldest-first.
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids
 * @returns {object[]} full observation rows (SELECT *), created order
 */
export function supersededNotice(row) {
  if (!row || !row.superseded_at) return null;
  // Every LIST surface (search / recent / timeline / browse / injection) filters
  // superseded rows out, so the only way to reach one is to name its id — which is
  // exactly what a stale citation in a transcript, a note, or an old handoff does.
  // Both detail faces render fields in OBS_FIELDS order, putting `lesson_learned`
  // near the top and `superseded_at` ~15 lines below it: a reader taking the first
  // actionable line away from `mem_get(1)` takes the RETRACTED advice and never
  // reaches the marker. Hoist it to the header so the retraction is read first.
  const by = typeof row.superseded_by === 'number' ? `#${row.superseded_by}` : null;
  return by
    ? `⚠ RETRACTED — superseded by ${by}. Read ${by} instead; the fields below are the withdrawn version.`
    : '⚠ RETRACTED — superseded (auto-dedup or merge). The fields below are the withdrawn version.';
}

export function fetchObsDetail(db, ids) {
  const ph = ids.map(() => '?').join(',');
  try {
    db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${ph})`).run(Date.now(), ...ids);
    autoBoostIfNeeded(db, ids);
  } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }
  return db.prepare(`SELECT * FROM observations WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`).all(...ids);
}
