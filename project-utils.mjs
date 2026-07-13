// claude-mem-lite shared project resolution
// Extracted from server.mjs and mem-cli.mjs to eliminate duplication

import { inferProject } from './utils.mjs';

const _cache = new Map();

/**
 * Resolve short project name to canonical "parent--base" form.
 * Uses DB suffix match with in-process cache.
 * @param {import('better-sqlite3').Database} db Database instance
 * @param {string|null|undefined} name Project name to resolve
 * @returns {string|null|undefined} Canonical project name
 */
export function resolveProject(db, name) {
  if (!name) return name;
  // Defense-in-depth: a bare `--project` CLI flag parses to boolean `true` (and a
  // malformed MCP/hook caller could pass any non-string). `true.includes('--')` below
  // throws a raw TypeError that crashed search/recent/timeline/stats/export/defer-list.
  // Treat any non-string as "no project filter" (null) — the degradation every caller
  // already handles for an absent --project — instead of crashing at the root helper.
  if (typeof name !== 'string') return null;
  if (_cache.has(name)) return _cache.get(name);
  // Already a canonical name (contains "--")? Use as-is.
  if (name.includes('--')) { _cache.set(name, name); return name; }

  // Short name: prefer the canonical "parent--name" form (from inferProject())
  // which typically has far more data than manually-saved short names.
  // 1) Exact suffix match: "mem" → "projects--mem"
  const suffixed = db.prepare(
    'SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1'
  ).get(`%--${name}`);
  if (suffixed) { _cache.set(name, suffixed.project); return suffixed.project; }

  // 1.5) Exact-name match: a project literally named "p" (e.g. inferProject() at a
  // filesystem-root cwd yields no "--", or a manually-saved bare name). MUST beat the
  // fuzzy prefix/substring fallbacks below — otherwise `%p%` matches every "projects--*"
  // row and ORDER BY COUNT(*) returns the biggest UNRELATED project, making the exact
  // project permanently unreachable via --project. Ranks below step 1 only, preserving
  // the documented "prefer canonical parent--name over a stray short name" intent.
  const exact = db.prepare(
    'SELECT project FROM observations WHERE project = ? LIMIT 1'
  ).get(name);
  if (exact) { _cache.set(name, exact.project); return exact.project; }

  // 2) Prefix-in-suffix match: "code-graph" → "projects--code-graph-mcp"
  const prefixed = db.prepare(
    'SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1'
  ).get(`%--${name}%`);
  if (prefixed) { _cache.set(name, prefixed.project); return prefixed.project; }

  // 3) Whole-token match: the name is a complete hyphen-delimited component of the base
  // (e.g. "graph" → "projects--code-graph-mcp", "mcp" → "…-mcp"). Steps 1/2 already cover
  // the exact base and the base *prefix*; this adds interior/trailing whole tokens ONLY.
  // v3.42 F3: the old `%name%` substring fallback matched mid-token ("test" inside
  // "loop-testing") and returned the highest-COUNT unrelated project, so `--project test`
  // silently queried the wrong project. Require a hyphen boundary: an interior token
  // (`%-name-%`) or a trailing token (`%-name`) so "test" no longer matches "testing".
  const token = db.prepare(
    `SELECT project FROM observations
       WHERE (project LIKE '%-' || ? || '-%' OR project LIKE '%-' || ?)
       GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1`
  ).get(name, name);
  if (token) { _cache.set(name, token.project); return token.project; }

  // 4) Fallback: synthesize canonical form from current directory
  const inferred = inferProject();
  if (inferred.endsWith(`--${name}`)) { _cache.set(name, inferred); return inferred; }

  _cache.set(name, name);
  return name;
}

/** Reset cache (for tests). */
export function _resetProjectCache() { _cache.clear(); }
