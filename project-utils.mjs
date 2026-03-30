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

  // 2) Prefix-in-suffix match: "code-graph" → "projects--code-graph-mcp"
  const prefixed = db.prepare(
    'SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1'
  ).get(`%--${name}%`);
  if (prefixed) { _cache.set(name, prefixed.project); return prefixed.project; }

  // 3) Substring match: broader fallback for partial names
  const substr = db.prepare(
    'SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1'
  ).get(`%${name}%`);
  if (substr) { _cache.set(name, substr.project); return substr.project; }

  // 4) Fallback: synthesize canonical form from current directory
  const inferred = inferProject();
  if (inferred.endsWith(`--${name}`)) { _cache.set(name, inferred); return inferred; }

  _cache.set(name, name);
  return name;
}

/** Reset cache (for tests). */
export function _resetProjectCache() { _cache.clear(); }
