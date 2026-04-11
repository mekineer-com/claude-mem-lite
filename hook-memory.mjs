// claude-mem-lite — Semantic Memory Injection
// Search past observations for relevant memories to inject as context at user-prompt time.

import { sanitizeFtsQuery, relaxFtsQueryToOr, debugCatch, OBS_BM25, notLowSignalTitleClause } from './utils.mjs';

const MAX_MEMORY_INJECTIONS = 3;
const MEMORY_LOOKBACK_MS = 60 * 86400000; // 60 days
// Aligned with TYPE_QUALITY_CASE in scoring-sql.mjs (R2 rebalance).
// Weights calibrated to empirical avg access_count:
//   decision 6.05, discovery 3.32, bugfix 2.24, feature 2.04, change 0.93, refactor 0.54.
// lesson_learned boost (1.5×) stacks for entries with a real takeaway.
const MEMORY_TYPE_BOOST = { decision: 1.5, discovery: 1.3, bugfix: 1.1, feature: 1.0, refactor: 0.6, change: 0.5 };
// Adaptive BM25 thresholds — scale with corpus size to filter noise.
// Larger corpora produce more weak matches from common words.
const BM25_THRESHOLD = { TINY: 0, SMALL: 1.5, MEDIUM: 2.5, LARGE: 3.5 };
// OR fallback max token count — queries with 3+ tokens that fail AND are likely off-topic
const OR_FALLBACK_MAX_TOKENS = 2;

const FILE_RECALL_LOOKBACK_MS = 60 * 86400000; // 60 days
const MAX_FILE_RECALL = 2;

/**
 * Search for relevant past observations to inject as memory context.
 * Quality gates: importance>=1 (with 0.6x penalty), type-boosted, lesson-boosted, BM25-thresholded (adaptive: 0 for <5 obs, 1.5 otherwise).
 * @param {import('better-sqlite3').Database} db Memory database
 * @param {string} userPrompt User's prompt text
 * @param {string} project Current project
 * @param {number[]} excludeIds Observation IDs already in Key Context
 * @returns {object[]} Top memories (max 3) with {id, type, title, lesson_learned}
 */
export function searchRelevantMemories(db, userPrompt, project, excludeIds = []) {
  if (!db || !userPrompt || userPrompt.length < 5) return [];

  try {
    const ftsQuery = sanitizeFtsQuery(userPrompt);
    if (!ftsQuery) return [];

    const cutoff = Date.now() - MEMORY_LOOKBACK_MS;
    const excludeSet = new Set(excludeIds);

    // Phase 1: Same-project search (highest priority)
    // R1: notLowSignalTitleClause() excludes hook-llm fallback titles
    // ("Modified X", "Worked on X", "Reviewed N files:", raw error logs, etc.)
    // that almost never get referenced (3.3% access rate) but compete for BM25 rank.
    const selectStmt = db.prepare(`
      SELECT o.id, o.type, o.title, o.importance, o.lesson_learned, o.project,
             ${OBS_BM25} as relevance
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project = ?
        AND o.importance >= 1
        AND o.created_at_epoch > ?
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
        AND ${notLowSignalTitleClause('o')}
      ORDER BY ${OBS_BM25}
      LIMIT 10
    `);
    let rows = selectStmt.all(ftsQuery, project, cutoff);
    let usedOrFallback = false;

    // OR fallback when AND returns nothing — only for short queries (specific enough).
    // 3+ token queries that fail AND are likely off-topic; OR would match individual common words.
    // Count original search terms (AND-separated groups), not expanded synonym tokens.
    const queryTokenCount = ftsQuery.includes(' AND ')
      ? ftsQuery.split(' AND ').length
      : ftsQuery.split(/\s+/).filter(t => t && !t.startsWith('(') || !t.endsWith(')')).length;
    if (rows.length === 0) {
      const orQuery = relaxFtsQueryToOr(ftsQuery);
      if (orQuery && queryTokenCount <= OR_FALLBACK_MAX_TOKENS) {
        try { rows = selectStmt.all(orQuery, project, cutoff); usedOrFallback = true; } catch {}
      }
    }

    // Phase 2: Cross-project search for high-value decisions/discoveries
    // These are transferable insights (debugging patterns, architectural reasons, gotchas)
    let crossRows = [];
    let crossUsedOr = false;
    try {
      const crossStmt = db.prepare(`
        SELECT o.id, o.type, o.title, o.importance, o.lesson_learned, o.project,
               ${OBS_BM25} as relevance
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.project != ?
          AND o.type IN ('decision', 'discovery')
          AND o.importance >= 2
          AND o.created_at_epoch > ?
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND ${notLowSignalTitleClause('o')}
        ORDER BY ${OBS_BM25}
        LIMIT 5
      `);
      crossRows = crossStmt.all(ftsQuery, project, cutoff);
      if (crossRows.length === 0) {
        const orQuery = relaxFtsQueryToOr(ftsQuery);
        if (orQuery && queryTokenCount <= OR_FALLBACK_MAX_TOKENS) {
          try { crossRows = crossStmt.all(orQuery, project, cutoff); crossUsedOr = true; } catch {}
        }
      }
    } catch (e) { debugCatch(e, 'crossProjectSearch'); }

    // Merge and score: same-project full weight, cross-project 0.7x
    // OR-fallback results get 0.4x penalty — they matched individual words, not the full intent
    const allRows = [...rows.map(r => ({ ...r, _or: usedOrFallback })), ...crossRows.map(r => ({ ...r, _or: crossUsedOr }))];
    const scored = allRows
      .filter(r => !excludeSet.has(r.id))
      .map(r => {
        const crossProjectPenalty = r.project === project ? 1.0 : 0.7;
        const orFallbackPenalty = r._or ? 0.4 : 1.0;
        return {
          ...r,
          score: Math.abs(r.relevance)
            * (MEMORY_TYPE_BOOST[r.type] || 1.0)
            * (r.lesson_learned ? 1.5 : 1.0)
            * (r.importance >= 2 ? 1.0 : 0.6)
            * crossProjectPenalty
            * orFallbackPenalty,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Adaptive threshold: scales with corpus size to filter noise.
    // Each result must individually exceed the threshold (not just the top one).
    const obsCount = db.prepare(
      'SELECT COUNT(*) as c FROM observations WHERE project = ? AND COALESCE(compressed_into, 0) = 0',
    ).get(project)?.c || 0;
    const { TINY, SMALL, MEDIUM, LARGE } = BM25_THRESHOLD;
    const threshold = obsCount < 5 ? TINY : obsCount < 100 ? SMALL : obsCount < 500 ? MEDIUM : LARGE;
    const aboveThreshold = scored.filter(r => r.score >= threshold);
    if (aboveThreshold.length === 0) return [];

    // Update access_count for injected memories
    const result = aboveThreshold.slice(0, MAX_MEMORY_INJECTIONS);
    const now = Date.now();
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?');
    for (const r of result) {
      updateStmt.run(now, r.id);
    }

    return result;
  } catch (e) {
    debugCatch(e, 'searchRelevantMemories');
    return [];
  }
}

/**
 * Recall observations related to a specific file being edited.
 * Useful for surfacing past bugfixes / decisions when revisiting a file.
 * @param {import('better-sqlite3').Database} db Memory database
 * @param {string} filePath File path (absolute or relative)
 * @param {string} project Current project
 * @returns {object[]} Up to MAX_FILE_RECALL observations with {id, type, title, importance, lesson_learned}
 */
export function recallForFile(db, filePath, project) {
  if (!db || !filePath) return [];
  try {
    const basename = filePath.split('/').pop();
    const cutoff = Date.now() - FILE_RECALL_LOOKBACK_MS;
    // Escape SQL LIKE wildcards in filename to prevent injection
    const escaped = basename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.importance, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 2
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(project, cutoff, filePath, likePattern, MAX_FILE_RECALL);
    const now = Date.now();
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?');
    for (const r of rows) updateStmt.run(now, r.id);
    return rows;
  } catch (e) {
    debugCatch(e, 'recallForFile');
    return [];
  }
}
