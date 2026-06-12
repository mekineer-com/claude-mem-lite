// Shared cross-source search core (query build / source queries / scoring
// normalization / sort / pagination math).
//
// Single source of truth for cmdSearch (CLI) and mem_search (MCP). The
// observation path already converged in search-engine.mjs (#8198/#8212); the
// sessions/prompts FTS queries, CJK precision + LIKE fallback, cross-source
// score normalization, user-sort, over-fetch sizing, and date-bound parsing
// were still copy-pasted and synced by "paired-path" comments — the drift
// class compress-core (ARCH-1), recall-core, and timeline-core were extracted
// to close. Call sites keep what legitimately differs: flag/schema parsing,
// result-row dialect (CLI `_source`+raw columns vs MCP `source`+mapped
// fields), error-message wording, and output rendering.
//
// Behavioral asymmetries that are PRESERVED, not converged (documented so a
// future "fix" is a deliberate contract change, not an accident):
//   • CLI forces source=observations when --type/--tier/--importance/--branch
//     is set; MCP only forces it for obs_type.
//   • CLI warns on inverted --from/--to ranges; MCP does not.
//   • CLI wraps session/prompt FTS in try/catch for pre-FTS legacy DBs.

import { sanitizeFtsQuery, relaxFtsQueryToOr, SESS_BM25, DEFAULT_DECAY_HALF_LIFE_MS } from '../utils.mjs';
import { cjkPrecisionOk, extractCjkLikePatterns } from '../nlp.mjs';
import { computeTier } from '../tier.mjs';

/** Sanitize a user query to FTS5 syntax; optionally force OR semantics. */
export function buildSearchFtsQuery(query, { or = false } = {}) {
  let ftsQuery = sanitizeFtsQuery(query);
  if (ftsQuery && or) ftsQuery = relaxFtsQueryToOr(ftsQuery) || ftsQuery;
  return ftsQuery;
}

/**
 * Parse from/to date bounds to epoch ms. Date-only `to` (YYYY-MM-DD) extends
 * to end-of-day so "to 2026-06-12" includes that day's rows.
 * @returns {{ ok: true, epochFrom: number|null, epochTo: number|null }
 *         | { ok: false, bad: 'from'|'to', value: string }}
 */
export function parseDateBounds(fromRaw, toRaw) {
  const epochFrom = fromRaw ? new Date(fromRaw).getTime() : null;
  let epochTo = toRaw ? new Date(toRaw).getTime() : null;
  if (epochTo !== null && toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
    epochTo += 86400000 - 1; // extend to 23:59:59.999
  }
  if (epochFrom !== null && isNaN(epochFrom)) return { ok: false, bad: 'from', value: fromRaw };
  if (epochTo !== null && isNaN(epochTo)) return { ok: false, bad: 'to', value: toRaw };
  return { ok: true, epochFrom, epochTo };
}

/**
 * Over-fetch window: every source fetches from offset 0 and the caller slices
 * [offset, offset+limit) exactly ONCE post-merge. Pushing OFFSET into the
 * per-source SQL double-applied it and gapped/overlapped pages, because the
 * obs hybrid path (AND→OR fallback / vector / concept stages) re-adds rows the
 * SQL OFFSET already skipped (#8217/#8638).
 */
export function computePerSourceWindow(limit, offset) {
  return { perSourceLimit: Math.max(limit * 3, offset + limit + 10), perSourceOffset: 0 };
}

/** obs-side total query: when the AND→OR fallback fired, count the OR set. */
export function effectiveObsFtsQuery(ftsQuery, orFallbackFired) {
  return orFallbackFired ? (relaxFtsQueryToOr(ftsQuery) || ftsQuery) : ftsQuery;
}

/**
 * Session FTS search with recency decay + same-project boost. Returns raw SQL
 * rows: { id, request, completed, project, created_at, created_at_epoch, score }.
 * `projectBoost` is the inferred current project, only applied when the caller
 * did NOT filter by project explicitly (pass null then).
 */
export function searchSessionsFts(db, { ftsQuery, project = null, projectBoost = null, epochFrom = null, epochTo = null, perSourceLimit, perSourceOffset = 0 }) {
  const wheres = ['session_summaries_fts MATCH ?'];
  const params = [Date.now(), projectBoost, projectBoost, ftsQuery];
  if (project) { wheres.push('s.project = ?'); params.push(project); }
  if (epochFrom !== null) { wheres.push('s.created_at_epoch >= ?'); params.push(epochFrom); }
  if (epochTo !== null) { wheres.push('s.created_at_epoch <= ?'); params.push(epochTo); }
  params.push(perSourceLimit, perSourceOffset);
  return db.prepare(`
    SELECT s.id, s.request, s.completed, s.project, s.created_at, s.created_at_epoch,
           ${SESS_BM25}
             * (1.0 + EXP(-0.693 * (? - s.created_at_epoch) / ${DEFAULT_DECAY_HALF_LIFE_MS}.0))
             * (CASE WHEN ? IS NOT NULL AND s.project = ? THEN 2.0 ELSE 1.0 END) as score
    FROM session_summaries_fts
    JOIN session_summaries s ON session_summaries_fts.rowid = s.id
    WHERE ${wheres.join(' AND ')}
    ORDER BY score
    LIMIT ? OFFSET ?
  `).all(...params);
}

/**
 * Prompt FTS search with CJK precision gate + CJK LIKE fallback. Returns raw
 * SQL rows: { id, prompt_text, content_session_id, created_at,
 * created_at_epoch, score } (fallback rows carry score = 0).
 *
 * The precision gate applies to BOTH paths: unicode61 degrades CJK bigram
 * queries to single-char AND, and the LIKE fallback is an OR'd substring scan
 * — without the gate each re-admits the common-char noise band the other
 * dropped (that asymmetry was the actual leak source: FTS returned 0,
 * fallback filled 20).
 */
export function searchPromptsFts(db, { query, ftsQuery, project = null, epochFrom = null, epochTo = null, perSourceLimit, perSourceOffset = 0 }) {
  const wheres = ['user_prompts_fts MATCH ?', "p.prompt_text NOT LIKE '<task-notification>%'"];
  const params = [ftsQuery];
  if (project) { wheres.push('s.project = ?'); params.push(project); }
  if (epochFrom !== null) { wheres.push('p.created_at_epoch >= ?'); params.push(epochFrom); }
  if (epochTo !== null) { wheres.push('p.created_at_epoch <= ?'); params.push(epochTo); }
  params.push(perSourceLimit, perSourceOffset);
  const rows = db.prepare(`
    SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch,
           bm25(user_prompts_fts, 1) as score
    FROM user_prompts_fts
    JOIN user_prompts p ON user_prompts_fts.rowid = p.id
    JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE ${wheres.join(' AND ')}
    ORDER BY score
    LIMIT ? OFFSET ?
  `).all(...params);
  const kept = query ? rows.filter((r) => cjkPrecisionOk(query, r.prompt_text)) : rows;
  if (kept.length > 0 || !query) return kept;

  // CJK LIKE fallback: FTS5 unicode61 can't tokenize CJK substrings in prompts
  const cjkPatterns = extractCjkLikePatterns(query);
  if (cjkPatterns.length === 0) return kept;
  const likeConds = cjkPatterns.map(() => 'p.prompt_text LIKE ?');
  const likeParams = cjkPatterns.map((p) => `%${p}%`);
  if (project) likeParams.push(project);
  if (epochFrom !== null) likeParams.push(epochFrom);
  if (epochTo !== null) likeParams.push(epochTo);
  likeParams.push(perSourceLimit, perSourceOffset);
  const fallbackRows = db.prepare(`
    SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch
    FROM user_prompts p
    JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE (${likeConds.join(' OR ')})
      AND p.prompt_text NOT LIKE '<task-notification>%'
      ${project ? 'AND s.project = ?' : ''}
      ${epochFrom !== null ? 'AND p.created_at_epoch >= ?' : ''}
      ${epochTo !== null ? 'AND p.created_at_epoch <= ?' : ''}
    ORDER BY p.created_at_epoch DESC
    LIMIT ? OFFSET ?
  `).all(...likeParams);
  return fallbackRows
    .filter((r) => cjkPrecisionOk(query, r.prompt_text))
    .map((r) => ({ ...r, score: 0 }));
}

/**
 * Normalize each source's BM25 scores to [-1, 0] before cross-source merge.
 * Prevents observations (BM25 can reach -40) from systematically outranking
 * sessions (-6) and prompts (-1) regardless of relevance. Sources with a
 * single scored row are skipped — normalizing would inflate a weak match to
 * -1.0. Mutates `results` in place; callers re-sort afterwards.
 */
export function normalizeCrossSourceScores(results, sourceKey) {
  for (const src of ['obs', 'session', 'prompt']) {
    const srcResults = results.filter((r) => r[sourceKey] === src && r.score !== null && r.score !== undefined);
    if (srcResults.length < 2) continue;
    const maxAbs = Math.max(...srcResults.map((r) => Math.abs(r.score)));
    if (maxAbs > 0) {
      for (const r of srcResults) r.score = r.score / maxAbs;
    }
  }
}

/**
 * Apply the user-requested sort AFTER relevance scoring. 'relevance' is a
 * no-op — BM25 score order is already in place from the merge sort.
 */
export function applyUserSort(results, sort) {
  if (sort === 'time') {
    results.sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  } else if (sort === 'importance') {
    results.sort((a, b) => (b.importance ?? 1) - (a.importance ?? 1) || (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  }
}

/**
 * Tier post-filter: batch-lookup full obs rows and keep only those whose
 * computed tier matches. Non-obs rows pass through untouched. Classification
 * uses the explicitly-requested project when given — CWD-inferred fallback
 * breaks computeTier's "obs.project === currentProject" rules on
 * cross-project searches and silently drops valid rows.
 * @returns filtered array (input is not mutated)
 */
export function applyTierFilter(db, results, { tier, sourceKey, currentProject }) {
  const obsIds = results.filter((r) => r[sourceKey] === 'obs').map((r) => r.id);
  if (obsIds.length === 0) return results;
  const placeholders = obsIds.map(() => '?').join(',');
  const fullRows = db.prepare(
    `SELECT id, compressed_into, superseded_at, memory_session_id, project, importance, last_accessed_at, created_at_epoch, type FROM observations WHERE id IN (${placeholders})`
  ).all(...obsIds);
  const rowMap = new Map(fullRows.map((r) => [r.id, r]));
  const tierCtx = { now: Date.now(), currentProject, currentSessionId: '' };
  return results.filter((r) => {
    if (r[sourceKey] !== 'obs') return true;
    const full = rowMap.get(r.id);
    return full && computeTier(full, tierCtx) === tier;
  });
}
