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

/** observations_fts BM25 weights: title=10, subtitle=5, narrative=5, text=3, facts=3, concepts=2, lesson_learned=8 */
export const OBS_BM25 = 'bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)';

/** session_summaries_fts BM25 weights: request=5, investigated=3, learned=3, completed=3, next_steps=2, notes=1, remaining_items=1 */
export const SESS_BM25 = 'bm25(session_summaries_fts, 5, 3, 3, 3, 2, 1, 1)';

/** FTS5 columns for observations (must match BM25 weight order) */
export const OBS_FTS_COLUMNS = ['title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned'];

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
