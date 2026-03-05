// claude-mem-lite — Semantic Memory Injection
// Search past observations for relevant memories to inject as context at user-prompt time.

import { sanitizeFtsQuery, debugCatch } from './utils.mjs';

const MAX_MEMORY_INJECTIONS = 2;
const MEMORY_LOOKBACK_MS = 14 * 86400000; // 14 days
const MEMORY_TYPE_BOOST = { bugfix: 1.5, decision: 1.3, discovery: 1.0, feature: 0.8, change: 0.5, refactor: 0.5 };

/**
 * Search for relevant past observations to inject as memory context.
 * Strict quality gates: importance>=2, type-boosted, BM25-thresholded.
 * @param {import('better-sqlite3').Database} db Memory database
 * @param {string} userPrompt User's prompt text
 * @param {string} project Current project
 * @param {number[]} excludeIds Observation IDs already in Key Context
 * @returns {object[]} Top memories (max 2) with {id, type, title}
 */
export function searchRelevantMemories(db, userPrompt, project, excludeIds = []) {
  if (!db || !userPrompt || userPrompt.length < 5) return [];

  try {
    const ftsQuery = sanitizeFtsQuery(userPrompt);
    if (!ftsQuery) return [];

    const cutoff = Date.now() - MEMORY_LOOKBACK_MS;
    const excludeSet = new Set(excludeIds);

    const selectStmt = db.prepare(`
      SELECT o.id, o.type, o.title, o.importance,
             bm25(observations_fts) as relevance
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project = ?
        AND o.importance >= 2
        AND o.created_at_epoch > ?
        AND COALESCE(o.compressed_into, 0) = 0
      ORDER BY bm25(observations_fts)
      LIMIT 10
    `);
    const rows = selectStmt.all(ftsQuery, project, cutoff);

    // Score: BM25 × type boost, filter by threshold, exclude Key Context IDs
    const scored = rows
      .filter(r => !excludeSet.has(r.id))
      .map(r => ({
        ...r,
        score: Math.abs(r.relevance) * (MEMORY_TYPE_BOOST[r.type] || 1.0),
      }))
      .sort((a, b) => b.score - a.score);

    // Strict threshold: only inject if best match has meaningful score
    if (scored.length === 0 || scored[0].score < 1.0) return [];

    // Update access_count for injected memories
    const result = scored.slice(0, MAX_MEMORY_INJECTIONS);
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1 WHERE id = ?');
    for (const r of result) {
      updateStmt.run(r.id);
    }

    return result;
  } catch (e) {
    debugCatch(e, 'searchRelevantMemories');
    return [];
  }
}
