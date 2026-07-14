// Single source of truth for the (obs,file) trigger-edge match predicate.
//
// Two consumers MUST stay in byte-identical agreement or injection and
// attribution diverge (a lesson injected via an edge the resolver can't find
// never resolves, and vice versa): scripts/pre-tool-recall.js (injection
// trigger) and lib/edge-attribution.mjs (Stop-side hit/miss resolution).
// Review 2026-07-14 found the pair enforced only by comments — this module
// makes the parity mechanical.
//
// Semantics (P0 D#78, plus the review's case/backslash recall fix):
// observation_files.filename is heterogeneous (bare basename, relative path,
// absolute path, either separator, historical case variants). An edited file
// matches an edge when the stored value is:
//   1. the exact full path            (= COLLATE NOCASE — old LIKE was
//   2. the exact bare basename         ASCII-case-insensitive; '=' alone is
//                                      BINARY and silently dropped 'Utils.mjs')
//   3. a path ending in '/<basename>' (LIKE, path boundary — blocks the
//   4. a path ending in '\<basename>'  bash-utils.mjs-vs-utils.mjs suffix
//                                      collision while keeping both separators)
// LIKE wildcards in the basename are escaped (sqlite gotcha #9); LIKE itself
// is ASCII-case-insensitive, matching arm 1/2's NOCASE.
//
// Dependency-free on purpose: pre-tool-recall.js is a ~30ms cold-start script.

import { basename } from 'path';

/**
 * SQL boolean expression for the four-arm match. Placeholder order matches
 * fileMatchParams. @param {string} [alias=''] table alias (e.g. 'of2').
 */
export function fileMatchClause(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(${p}filename = ? COLLATE NOCASE OR ${p}filename = ? COLLATE NOCASE ` +
    `OR ${p}filename LIKE ? ESCAPE '\\' OR ${p}filename LIKE ? ESCAPE '\\')`;
}

/** Bind values for fileMatchClause, in placeholder order. */
export function fileMatchParams(filePath) {
  const fname = basename(filePath);
  const escaped = fname.replace(/%/g, '\\%').replace(/_/g, '\\_');
  // `%\\` before the basename: under ESCAPE '\', a literal backslash is
  // written '\\' — so the JS string carries two backslash characters.
  return [filePath, fname, `%/${escaped}`, `%\\\\${escaped}`];
}
