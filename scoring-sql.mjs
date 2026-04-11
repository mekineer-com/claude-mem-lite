// scoring-sql.mjs — SQL constants for BM25 scoring and temporal decay.
// Extracted from utils.mjs for focused module boundaries.

// ─── Type-Differentiated Recency Decay ──────────────────────────────────────

/** Recency half-life per observation type (in milliseconds) */
export const DECAY_HALF_LIFE_BY_TYPE = {
  decision:  90 * 86400000,  // 90 days — architectural decisions persist
  discovery: 60 * 86400000,  // 60 days — learned patterns last
  feature:   30 * 86400000,  // 30 days — feature work is mid-range
  bugfix:    14 * 86400000,  // 14 days — bugs are usually one-off
  refactor:  14 * 86400000,  // 14 days — code cleanup
  change:     7 * 86400000,  //  7 days — routine changes decay fast
};
export const DEFAULT_DECAY_HALF_LIFE_MS = 14 * 86400000;

// ─── BM25 Weight Constants ──────────────────────────────────────────────────
// Single source of truth for FTS5 BM25 weight expressions.
// Column order must match ensureFTS() calls in schema.mjs.

/** observations_fts BM25 weights: title=10, subtitle=5, narrative=5, text=3, facts=3, concepts=2, lesson_learned=8, search_aliases=5 */
export const OBS_BM25 = 'bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8, 5)';

/** session_summaries_fts BM25 weights: request=5, investigated=3, learned=3, completed=3, next_steps=2, notes=1, remaining_items=1 */
export const SESS_BM25 = 'bm25(session_summaries_fts, 5, 3, 3, 3, 2, 1, 1)';

/** FTS5 columns for observations (must match BM25 weight order) */
export const OBS_FTS_COLUMNS = ['title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned', 'search_aliases'];

/** SQL CASE for type-differentiated recency decay half-lives (milliseconds) */
export const TYPE_DECAY_CASE = `(
  CASE o.type
    WHEN 'decision'  THEN 7776000000.0
    WHEN 'discovery' THEN 5184000000.0
    WHEN 'feature'   THEN 2592000000.0
    WHEN 'bugfix'    THEN 1209600000.0
    WHEN 'refactor'  THEN 1209600000.0
    WHEN 'change'    THEN  604800000.0
    ELSE 1209600000.0
  END
)`;

/**
 * Type quality multiplier — promotes high-signal types (decisions, discoveries).
 * Weights calibrated from empirical avg access_count per type in production data:
 *   decision 6.05, discovery 3.32, bugfix 2.24, feature 2.04, change 0.93, refactor 0.54.
 * The old (pre-R2) table had bugfix=0.75 < change=0.8, inverted vs reality.
 * Applied as: BM25 × time_decay × TYPE_QUALITY × project_boost × importance
 */
export const TYPE_QUALITY_CASE = `(
  CASE o.type
    WHEN 'decision'  THEN 1.5
    WHEN 'discovery' THEN 1.3
    WHEN 'bugfix'    THEN 1.1
    WHEN 'feature'   THEN 1.0
    WHEN 'refactor'  THEN 0.6
    WHEN 'change'    THEN 0.5
    ELSE 1.0
  END
)`;

/**
 * SQL WHERE clause fragment excluding LOW_SIGNAL degraded titles — the fallback
 * titles hook-llm.mjs writes when Haiku summarization is unavailable or skipped
 * (e.g. "Modified X", "Worked on X", "Reviewed N files:", raw "Error: ..." logs).
 *
 * Empirical data: 544 such entries in production, 18 ever accessed (3.3% rate).
 * They are capped at importance=1 on write, but that alone doesn't keep them out
 * of FTS5 injection when BM25 scores are competitive. This clause removes them
 * from the candidate pool at the SQL level so real bugfixes/discoveries dominate.
 *
 * Mirrors LOW_SIGNAL_TITLE regex in utils.mjs — keep in sync.
 *
 * @param {string} [alias='o'] Table alias for the observations row. Use '' for unqualified.
 * @returns {string} SQL boolean expression (already parenthesized; safe to combine with AND/OR)
 */
export function notLowSignalTitleClause(alias = 'o') {
  const p = alias ? `${alias}.` : '';
  return `(
    ${p}title NOT LIKE 'Modified %'
    AND ${p}title NOT LIKE 'Worked on %'
    AND ${p}title NOT LIKE 'Reviewed % files:%'
    AND ${p}title NOT LIKE 'Error while working%'
    AND ${p}title NOT LIKE 'Error in %'
    AND ${p}title NOT LIKE 'Error: %'
    AND ${p}title NOT LIKE '# %'
    AND ${p}title NOT LIKE 'node %'
    AND ${p}title NOT LIKE 'npm %'
    AND ${p}title NOT LIKE 'npx %'
    AND ${p}title NOT LIKE '(no description)%'
    AND ${p}title != '(error)'
  )`;
}
