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
  const suffixed = db.prepare(
    'SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1'
  ).get(`%--${name}`);
  if (suffixed) { _cache.set(name, suffixed.project); return suffixed.project; }

  // Fallback: synthesize canonical form from current directory
  const inferred = inferProject();
  if (inferred.endsWith(`--${name}`)) { _cache.set(name, inferred); return inferred; }

  _cache.set(name, name);
  return name;
}

/** Reset cache (for tests). */
export function _resetProjectCache() { _cache.clear(); }
