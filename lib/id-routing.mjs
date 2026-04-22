// Shared probe for "ID-not-found-in-requested-source" hints.
// Used by CLI cmdGet (mem-cli.mjs) and MCP mem_get (server.mjs) so both
// produce consistent redirect hints — if the probe schema drifts, both
// paths update together.
//
// The formatter stays per-call-site because CLI and MCP surface format
// differently (stderr vs response text); only the SQL layer is shared.

/**
 * Probe the observations / session_summaries / user_prompts tables for any
 * of the given numeric IDs, excluding the sources the caller already queried.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids Numeric IDs to probe (non-negative ints).
 * @param {Set<'obs'|'session'|'prompt'>} excludeSrcs Sources to skip.
 * @returns {{obs:number[], session:number[], prompt:number[]}}
 */
export function probeOtherSources(db, ids, excludeSrcs) {
  const result = { obs: [], session: [], prompt: [] };
  if (!ids || ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(',');
  try {
    if (!excludeSrcs.has('obs')) {
      const hits = db.prepare(`SELECT id FROM observations WHERE id IN (${placeholders})`).all(...ids);
      result.obs = hits.map(r => r.id);
    }
    if (!excludeSrcs.has('session')) {
      const hits = db.prepare(`SELECT id FROM session_summaries WHERE id IN (${placeholders})`).all(...ids);
      result.session = hits.map(r => r.id);
    }
    if (!excludeSrcs.has('prompt')) {
      const hits = db.prepare(`SELECT id FROM user_prompts WHERE id IN (${placeholders})`).all(...ids);
      result.prompt = hits.map(r => r.id);
    }
  } catch { /* best-effort hint; never block the caller */ }
  return result;
}
