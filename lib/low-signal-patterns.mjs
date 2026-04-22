// Single source of truth for LOW_SIGNAL title patterns.
//
// "LOW_SIGNAL" = hook-llm fallback titles written when Haiku summarization
// is unavailable or skipped ("Modified X", "Worked on X", "Reviewed N files:",
// raw "Error: ..." logs, bare "node/npm/npx <cmd>" etc.). Empirical data:
// ~544 such entries in production, 18 ever accessed (3.3% retrieval rate).
//
// Three consumers must stay in sync (pre-β: by hand-mirrored comments);
// post-β: all three derive from this module.
//   1. utils.mjs::LOW_SIGNAL_TITLE       — regex for write-side importance cap
//   2. scoring-sql.mjs::notLowSignalTitleClause — SQL NOT LIKE chain for read-side filter
//   3. scripts/pre-tool-recall.js         — inline SQL (standalone cold-start script)
//
// This module is intentionally dependency-free so scripts/pre-tool-recall.js can
// import it without inflating the ~30ms cold-start budget.

/**
 * Each entry has:
 *   - like:  SQLite LIKE pattern (anchored; % = any chars)
 *   - regex: JS regex source fragment (MUST match the same title set as `like`)
 *
 * Adding/removing entries requires updating the sync test (tests/low-signal-sync.test.mjs).
 */
export const LOW_SIGNAL_PATTERNS = [
  { like: 'Modified %',              regex: '^Modified ' },
  { like: 'Worked on %',             regex: '^Worked on ' },
  { like: 'Reviewed % files:%',      regex: '^Reviewed \\d+ files:' },
  { like: 'Codebase exploration%',   regex: '^Codebase exploration' },
  { like: 'Error while working%',    regex: '^Error while working' },
  { like: 'Error in %',              regex: '^Error in ' },
  { like: 'Error: %',                regex: '^Error: ' },
  { like: '# %',                     regex: '^# ' },
  { like: 'node %',                  regex: '^node ' },
  { like: 'npm %',                   regex: '^npm ' },
  { like: 'npx %',                   regex: '^npx ' },
  { like: '(no description)%',       regex: '^\\(no description\\)' },
  { like: '%(error)',                regex: '\\(error\\)$' },
];

/**
 * Build the combined regex that matches ANY LOW_SIGNAL pattern.
 * Equivalent to the hand-written `LOW_SIGNAL_TITLE` before β refactor.
 */
export function buildLowSignalRegex() {
  const src = LOW_SIGNAL_PATTERNS.map(p => `(?:${p.regex})`).join('|');
  return new RegExp(src);
}

/**
 * Build the SQL NOT LIKE clause chain, optionally prefixed with a table alias.
 * Output is a single parenthesized AND-chain — safe to combine with other AND/OR.
 *
 * @param {string} [alias=''] Table alias (e.g. 'o') — empty for unqualified.
 * @returns {string} SQL boolean expression
 */
export function buildNotLowSignalSql(alias = '') {
  const p = alias ? `${alias}.` : '';
  const clauses = LOW_SIGNAL_PATTERNS.map(({ like }) => `${p}title NOT LIKE '${like}'`);
  return '(\n    ' + clauses.join('\n    AND ') + '\n  )';
}
