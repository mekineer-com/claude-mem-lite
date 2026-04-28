// Shared observation-search engine — the single source of truth for
// hybrid FTS5 + vector ranking, OR fallback, concept/PRF expansion, and
// RRF merge. Both server.mjs (mem_search MCP tool) and mem-cli.mjs (search CLI)
// import these helpers so identical queries return identical candidate sets
// and rankings. See #8198 / #8212 for the prior paired-path divergence this
// module exists to eliminate.

import {
  OBS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE,
  notLowSignalTitleClause, LOW_SIGNAL_TITLE,
  relaxFtsQueryToOr, debugLog, debugCatch,
} from './utils.mjs';
import { getVocabulary, computeVector, vectorSearch, rrfMerge } from './tfidf.mjs';
import { extractPRFTerms, expandQueryByConcepts } from './server-internals.mjs';

// Scoring expressions — full adds project boost + access bonus; simple is for
// expansion paths where boost would over-amplify already-loose matches.
const FULL_SCORE = `${OBS_BM25}
  * (1.0 + EXP(-0.693 * (? - MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))) / ${TYPE_DECAY_CASE}))
  * ${TYPE_QUALITY_CASE}
  * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
  * (0.5 + 0.5 * COALESCE(o.importance, 1))
  * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
  * (1.0 + 0.3 * (o.lesson_learned IS NOT NULL))`;

const SIMPLE_SCORE = `${OBS_BM25}
  * (1.0 + EXP(-0.693 * (? - MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))) / ${TYPE_DECAY_CASE}))
  * ${TYPE_QUALITY_CASE}
  * (0.5 + 0.5 * COALESCE(o.importance, 1))
  * (1.0 + 0.3 * (o.lesson_learned IS NOT NULL))`;

export function buildObsFtsQuery(scoring, { multiplier, withSnippet, withOffset, includeNoise } = {}) {
  const scoreExpr = scoring === 'full' ? FULL_SCORE : SIMPLE_SCORE;
  const mult = multiplier ? ` * ${multiplier}` : '';
  const lowSignalClause = includeNoise ? '' : `AND ${notLowSignalTitleClause('o')}`;
  return `
    SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.created_at_epoch, o.importance,
           o.files_modified, o.lesson_learned,
           ${withSnippet ? "snippet(observations_fts, 2, '»', '«', '…', 10) as match_snippet," : ''}
           ${scoreExpr}${mult} as score
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ?
      AND COALESCE(o.compressed_into, 0) = 0
      AND o.superseded_at IS NULL
      AND (? IS NULL OR o.project = ?)
      AND (? IS NULL OR o.type = ?)
      AND (? IS NULL OR o.created_at_epoch >= ?)
      AND (? IS NULL OR o.created_at_epoch <= ?)
      AND (? IS NULL OR COALESCE(o.importance, 1) >= ?)
      AND (? IS NULL OR o.branch = ?)
      ${lowSignalClause}
    ORDER BY score
    LIMIT ?${withOffset ? ' OFFSET ?' : ''}`;
}

export function buildObsFtsParams({ now, projectBoost, ftsQuery, args, epochFrom, epochTo, limit, offset }) {
  const params = [now];
  if (projectBoost !== undefined) params.push(projectBoost, projectBoost);
  params.push(
    ftsQuery,
    args.project ?? null, args.project ?? null,
    args.obs_type ?? null, args.obs_type ?? null,
    epochFrom, epochFrom,
    epochTo, epochTo,
    args.importance ?? null, args.importance ?? null,
    args.branch ?? null, args.branch ?? null,
    limit,
  );
  if (offset !== undefined) params.push(offset);
  return params;
}

export function ftsRowToResult(r, { scoreMultiplier, snippet } = {}) {
  return {
    source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle,
    project: r.project, date: r.created_at, created_at_epoch: r.created_at_epoch,
    score: scoreMultiplier ? r.score * scoreMultiplier : r.score,
    files_modified: r.files_modified, importance: r.importance, lesson_learned: r.lesson_learned,
    snippet: snippet ? (r.match_snippet || '') : '',
  };
}

function expandObsByConceptCo(db, ctx, now, existingIds, results, includeNoise = false) {
  const { ftsQuery, args, epochFrom, epochTo, limit } = ctx;
  if (results.length >= Math.ceil(limit / 2)) return;
  const expanded = expandQueryByConcepts(db, ftsQuery, args.project);
  if (expanded.length === 0) return;
  const expansionFts = expanded.map(c => `"${c.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const expRows = db.prepare(buildObsFtsQuery('simple', { includeNoise }))
      .all(...buildObsFtsParams({ now, ftsQuery: expansionFts, args, epochFrom, epochTo, limit }));
    for (const r of expRows) {
      if (!existingIds.has(r.id)) {
        existingIds.add(r.id);
        results.push(ftsRowToResult(r, { scoreMultiplier: 0.7 }));
      }
    }
  } catch (e) { debugLog('WARN', 'search-engine', `concept expansion error: ${e.message}`); }
}

function expandObsByPRF(db, ctx, now, primaryCount, existingIds, results, includeNoise = false) {
  const { ftsQuery, args, epochFrom, epochTo, limit } = ctx;
  if (primaryCount < 3) return;
  const topResults = db.prepare(`
    SELECT o.title, o.narrative FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
      AND (? IS NULL OR o.project = ?)
    ORDER BY ${OBS_BM25}
    LIMIT 8
  `).all(ftsQuery, args.project ?? null, args.project ?? null);
  const prfTerms = extractPRFTerms(topResults, ftsQuery);
  if (prfTerms.length === 0) return;
  const prfFts = prfTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const prfRows = db.prepare(buildObsFtsQuery('simple', { includeNoise }))
      .all(...buildObsFtsParams({ now, ftsQuery: prfFts, args, epochFrom, epochTo, limit }));
    for (const r of prfRows) {
      if (!existingIds.has(r.id)) {
        existingIds.add(r.id);
        results.push(ftsRowToResult(r, { scoreMultiplier: 0.6 }));
      }
    }
  } catch (e) { debugLog('WARN', 'search-engine', `PRF expansion error: ${e.message}`); }
}

/**
 * Hybrid observation search — single source of truth for FTS + vector + RRF.
 *
 * Pipeline (paired-path with mem-cli.mjs cmdSearch via this module):
 *   1. FTS5 BM25 query (full scoring)
 *   2. OR fallback when AND returned 0 → sets ctx.orFallbackFired
 *   3. Concept co-occurrence expansion (when results sparse)
 *   4. PRF (pseudo-relevance feedback) expansion
 *   5. Vector search + RRF merge (re-ranks all results when both modes have hits)
 *   6. Vector-only fallback (when FTS5 found nothing)
 *
 * @param {Database} db - better-sqlite3 instance
 * @param {object} ctx - { ftsQuery, args, epochFrom, epochTo, perSourceLimit,
 *                         perSourceOffset, currentProject, limit, orFallbackFired }
 * @returns {Array} list of result objects (mutated ctx may set orFallbackFired)
 */
export function searchObservationsHybrid(db, ctx) {
  const { ftsQuery, args, epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject, limit } = ctx;
  const results = [];
  const includeNoise = args.include_noise === true;

  if (!ftsQuery) {
    const params = [];
    const wheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL'];
    if (args.project) { wheres.push('project = ?'); params.push(args.project); }
    if (args.obs_type) { wheres.push('type = ?'); params.push(args.obs_type); }
    if (epochFrom !== null) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
    if (epochTo !== null) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
    if (args.importance) { wheres.push('COALESCE(importance, 1) >= ?'); params.push(args.importance); }
    if (args.branch) { wheres.push('branch = ?'); params.push(args.branch); }
    const where = `WHERE ${wheres.join(' AND ')}`;
    params.push(perSourceLimit, perSourceOffset);
    const rows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at, created_at_epoch, files_modified, importance, lesson_learned
      FROM observations ${where}
      ORDER BY created_at_epoch DESC
      LIMIT ? OFFSET ?
    `).all(...params);
    for (const r of rows) {
      results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, created_at_epoch: r.created_at_epoch, files_modified: r.files_modified, importance: r.importance, lesson_learned: r.lesson_learned });
    }
    return results;
  }

  const now = Date.now();
  const projectBoost = args.project ? null : currentProject;

  const rows = db.prepare(buildObsFtsQuery('full', { withSnippet: true, withOffset: true, includeNoise }))
    .all(...buildObsFtsParams({ now, projectBoost, ftsQuery, args, epochFrom, epochTo, limit: perSourceLimit, offset: perSourceOffset }));
  for (const r of rows) results.push(ftsRowToResult(r, { snippet: true }));

  // OR fallback — must run BEFORE vector merge so orFallbackFired reflects FTS-only state.
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      try {
        const orRows = db.prepare(buildObsFtsQuery('full', { multiplier: 0.5, withSnippet: true, withOffset: true, includeNoise }))
          .all(...buildObsFtsParams({ now, projectBoost, ftsQuery: orQuery, args, epochFrom, epochTo, limit: perSourceLimit, offset: perSourceOffset }));
        if (orRows.length > 0) ctx.orFallbackFired = true;
        for (const r of orRows) results.push(ftsRowToResult(r, { snippet: true }));
      } catch (e) { debugCatch(e, 'searchObservationsHybrid-or-fallback'); }
    }
  }

  // Two-phase query expansion (only when well below limit)
  if (rows.length > 0 && results.length < Math.ceil(limit / 2)) {
    const existingIds = new Set(results.map(r => r.id));
    expandObsByConceptCo(db, ctx, now, existingIds, results, includeNoise);
    expandObsByPRF(db, ctx, now, rows.length, existingIds, results, includeNoise);
  }

  // Vector search + RRF hybrid merge
  try {
    const vocab = getVocabulary(db);
    if (!vocab) return results;
    const queryText = ftsQuery.replace(/['"()]/g, ' ');
    const queryVec = computeVector(queryText, vocab);
    if (!queryVec) return results;
    const vecResults = vectorSearch(db, queryVec, {
      project: args.project ?? null,
      type: args.obs_type ?? null,
      vocabVersion: vocab.version,
    });
    if (vecResults.length === 0) return results;

    if (results.length > 0) {
      const rrfRanking = rrfMerge(results, vecResults);
      const resultMap = new Map(results.map(r => [r.id, r]));
      for (const vr of vecResults) {
        if (!resultMap.has(vr.id)) {
          const obs = db.prepare('SELECT id, type, title, subtitle, project, created_at, created_at_epoch, importance, files_modified, branch, lesson_learned FROM observations WHERE id = ?').get(vr.id);
          if (!obs) continue;
          if (epochFrom !== null && obs.created_at_epoch < epochFrom) continue;
          if (epochTo !== null && obs.created_at_epoch > epochTo) continue;
          if (args.importance && (obs.importance ?? 1) < args.importance) continue;
          if (args.branch && obs.branch !== args.branch) continue;
          if (!includeNoise && obs.title && LOW_SIGNAL_TITLE.test(obs.title)) continue;
          resultMap.set(vr.id, { source: 'obs', id: obs.id, type: obs.type, title: obs.title, subtitle: obs.subtitle, project: obs.project, date: obs.created_at, importance: obs.importance, files_modified: obs.files_modified, lesson_learned: obs.lesson_learned, snippet: '' });
        }
      }
      const reordered = rrfRanking
        .filter(rr => resultMap.has(rr.id))
        .map(rr => ({ ...resultMap.get(rr.id), score: -rr.rrfScore }));
      results.length = 0;
      results.push(...reordered);
    } else {
      // FTS5 found nothing but vector found results
      for (const vr of vecResults) {
        const obs = db.prepare('SELECT id, type, title, subtitle, project, created_at, created_at_epoch, importance, files_modified, branch FROM observations WHERE id = ?').get(vr.id);
        if (!obs) continue;
        if (epochFrom !== null && obs.created_at_epoch < epochFrom) continue;
        if (epochTo !== null && obs.created_at_epoch > epochTo) continue;
        if (args.importance && (obs.importance ?? 1) < args.importance) continue;
        if (args.branch && obs.branch !== args.branch) continue;
        if (!includeNoise && obs.title && LOW_SIGNAL_TITLE.test(obs.title)) continue;
        results.push({ source: 'obs', id: obs.id, type: obs.type, title: obs.title, subtitle: obs.subtitle, project: obs.project, date: obs.created_at, importance: obs.importance, files_modified: obs.files_modified, lesson_learned: obs.lesson_learned, score: -vr.similarity, snippet: '' });
      }
    }
  } catch (e) { debugCatch(e, 'searchObservationsHybrid-vector'); }

  return results;
}
