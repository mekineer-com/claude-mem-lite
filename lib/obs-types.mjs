// Single source of truth for the observation `type` vocabulary.
//
// Audit 2026-07-17 MED-3: this list was hardcoded verbatim in 10 JS sites + the SQL
// CHECK constraint (schema.mjs observations DDL) — the project's #1 bug class
// (fix-lands-on-one-surface) sitting latent on the core type vocabulary. Every
// validator now imports from here; the SQL CHECK stays a literal (SQLite DDL cannot
// interpolate at migration time) and is locked to this list by
// tests/obs-types-invariant.test.mjs, which also fails if a new hardcoded copy of
// the list appears anywhere else in the runtime source.
export const OBS_TYPES = Object.freeze(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

export const OBS_TYPE_SET = new Set(OBS_TYPES);
