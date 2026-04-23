// Shared probe for "ID-not-found-in-requested-source" hints + shared token
// parser. Used by CLI (mem-cli.mjs, cli/common.mjs re-export) and MCP
// (server.mjs) so both paths stay aligned — parity per #8050.
//
// The formatter stays per-call-site because CLI and MCP surface format
// differently (stderr vs response text); only the SQL + token-parse layers
// are shared.

// ─── ID Token Parsing ────────────────────────────────────────────────────────

/**
 * Parse an ID token as it appears in search output or CLI positional args.
 * Accepts: `123`, `#123`, `P#123` / `p123` (prompt), `S#123` / `s123` (session).
 * @param {unknown} raw
 * @returns {{ source: 'obs'|'session'|'prompt'|null, id: number } | null}
 *   source===null means no explicit prefix — caller picks default (typically 'obs').
 */
export function parseIdToken(raw) {
  const m = /^([PpSs]?)#?(\d+)$/.exec(String(raw).trim());
  if (!m) return null;
  const p = m[1].toUpperCase();
  const id = parseInt(m[2], 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const source = p === 'P' ? 'prompt' : p === 'S' ? 'session' : null;
  return { source, id };
}

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
