// Shared cross-source search core for cmdSearch (CLI) and mem_search (MCP).
//
// coreRunSearchPipeline (below) is the SINGLE orchestration body — deep /
// auto-escalation → per-source query (obs hybrid + sessions + prompts) →
// cross-source normalize+sort → context re-rank + supersede → tier filter →
// user sort → count+paginate. The two ~180-line bodies that cmdSearch and
// runSearchPipeline used to keep hand-synced via "paired-path" comments are
// gone (audit P1-2); each surface is now a thin adapter that parses/validates
// in and renders out. Cross-surface equivalence is enforced by
// tests/search-parity.test.mjs, not by comments.
//
// Surfaces legitimately differ on a few policy points; each is an explicit opt
// on coreRunSearchPipeline (obsTypeFallback / crossSourceEpochSortNoFts /
// rerankPolicy / recentListingNoFts / tolerateMissingFts / tierPosition …) so
// behavior is strictly preserved and any future convergence is a deliberate
// change, not an accident. Notable preserved asymmetries:
//   • CLI forces source=observations for --type/--tier/--importance/--branch;
//     MCP only forces it for obs_type. (effectiveSource is computed per-adapter.)
//   • CLI warns on inverted --from/--to ranges; MCP does not.
//   • CLI tolerates missing session/prompt FTS (pre-FTS legacy DBs); MCP does not.
//   • MCP lists-recent-by-type on a 0-match obs_type query; CLI does not (#8217).
//
// Result rows use one canonical `source` key; session/prompt rows carry dual
// keys (date=created_at, text=prompt_text, session=content_session_id) so each
// surface's renderer reads its own field names off a single row shape.

import { sanitizeFtsQuery, relaxFtsQueryToOr, SESS_BM25, DEFAULT_DECAY_HALF_LIFE_MS } from '../utils.mjs';
import { cjkPrecisionOk, extractCjkLikePatterns } from '../nlp.mjs';
import { computeTier } from '../tier.mjs';
import { countSearchTotal, attachBodyTokens } from '../search-engine.mjs';
import { notLowSignalTitleClause } from '../scoring-sql.mjs';

/** Sanitize a user query to FTS5 syntax; optionally force OR semantics. */
export function buildSearchFtsQuery(query, { or = false } = {}) {
  let ftsQuery = sanitizeFtsQuery(query);
  if (ftsQuery && or) ftsQuery = relaxFtsQueryToOr(ftsQuery) || ftsQuery;
  return ftsQuery;
}

// Relative-duration units for `--since`. Months/years intentionally omitted —
// they're calendar-ambiguous; absolute --from/--to cover longer windows.
const DURATION_UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/**
 * Parse a relative duration like "7d", "24h", "90m", "2w", "30s" into ms.
 * Integer magnitude + single unit only (s/m/h/d/w, case-insensitive).
 * @returns {{ ok: true, ms: number } | { ok: false }}
 */
export function parseDuration(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const m = raw.trim().match(/^(\d+)\s*([smhdw])$/i);
  if (!m) return { ok: false };
  const n = parseInt(m[1], 10);
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, ms: n * DURATION_UNIT_MS[m[2].toLowerCase()] };
}

/**
 * Parse one from/to bound to epoch ms. A bare `YYYY-MM-DD` is the user's LOCAL
 * calendar day (created_at_epoch is Date.now() = local wall-clock), so it must be
 * built in local time — `new Date('YYYY-MM-DD')` parses as UTC midnight and shifts the
 * boundary by the tz offset (8h for the UTC+8 base), silently dropping early-morning
 * rows and leaking the next day's early hours. `endOfDay` extends a date-only bound to
 * 23:59:59.999 local (the inclusive `--to` day). Full ISO 8601 (with time/offset) is
 * parsed as-is, honoring any explicit zone. Out-of-range date-only strings return NaN so
 * the caller's isNaN guard rejects them (matches the old UTC parse's strict Invalid Date).
 */
function parseCalendarBound(raw, endOfDay) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
    // new Date(2026, 12, 45) silently rolls over; reject so 2026-13-45 fails like before.
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return NaN;
    return dt.getTime();
  }
  return new Date(raw).getTime();
}

/**
 * Parse from/to date bounds to epoch ms. Date-only `to` (YYYY-MM-DD) extends
 * to end-of-day so "to 2026-06-12" includes that day's rows. An optional
 * relative `sinceRaw` ("7d") sets the lower bound when no absolute `--from`
 * is given; an explicit `--from` always wins (it's the more specific signal).
 * @returns {{ ok: true, epochFrom: number|null, epochTo: number|null }
 *         | { ok: false, bad: 'from'|'to'|'since', value: string }}
 */
export function parseDateBounds(fromRaw, toRaw, sinceRaw = null, now = Date.now()) {
  let epochFrom = fromRaw ? parseCalendarBound(fromRaw, false) : null;
  const epochTo = toRaw ? parseCalendarBound(toRaw, true) : null;
  if (epochFrom !== null && isNaN(epochFrom)) return { ok: false, bad: 'from', value: fromRaw };
  if (epochTo !== null && isNaN(epochTo)) return { ok: false, bad: 'to', value: toRaw };
  if (sinceRaw) {
    const d = parseDuration(sinceRaw);
    if (!d.ok) return { ok: false, bad: 'since', value: sinceRaw };
    if (epochFrom === null) epochFrom = now - d.ms; // explicit --from takes precedence
  }
  return { ok: true, epochFrom, epochTo };
}

/**
 * Over-fetch window: every source fetches from offset 0 and the caller slices
 * [offset, offset+limit) exactly ONCE post-merge. Pushing OFFSET into the
 * per-source SQL double-applied it and gapped/overlapped pages, because the
 * obs hybrid path (AND→OR fallback / vector / concept stages) re-adds rows the
 * SQL OFFSET already skipped (#8217/#8638).
 *
 * D#30 re-audit (reopened): perSourceLimit MUST be offset-independent. The old
 * `offset + limit + 10` term grew the pool for deeper pages, and because RRF
 * fusion of FTS + vector ranks is candidate-pool-sensitive (an item present in
 * BOTH lists outranks one in a single list), a larger pool RE-RANKS the prefix —
 * so page(offset=0) and page(offset=N) sliced DIFFERENT orderings and overlapped
 * /gapped on the real (vector-populated) DB. #8642 missed this because its guard
 * test seeds no vectors (FTS-only is prefix-stable). The fix makes the pool a
 * function of `limit` only:
 *   - MIN_FUSION_POOL floor (= default limit 20 × the 3× buffer): every limit ≤ 20
 *     fuses ONE 60-candidate pool, so same-limit --offset pages are disjoint/stable
 *     and top-N is limit-stable (top-5 ⊂ top-10 ⊂ top-20). limit=20 offset=0 stays
 *     byte-identical to before (60) → no change on the benchmarked single-page path.
 *   - limit > 20 keeps limit*3 (the over-fetch buffer the fallback stages need).
 * Trade-off: pages beyond the pool now return empty instead of the (overlapping,
 * wrong) rows the offset-scaling used to surface — stability over deep reach.
 */
export const MIN_FUSION_POOL = 60;
export function computePerSourceWindow(limit, offset) { // eslint-disable-line no-unused-vars
  return { perSourceLimit: Math.max(limit * 3, MIN_FUSION_POOL), perSourceOffset: 0 };
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
             * (1.0 + EXP(-0.693 * MAX(0, ? - s.created_at_epoch) / ${DEFAULT_DECAY_HALF_LIFE_MS}.0))
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

/**
 * Finalize a merged, scored result set into one page: compute the TRUE
 * (limit/offset-invariant) population, slice the requested page, and attach the
 * ~Nt fetch-cost hint. Single source of truth for the count+paginate+enrich tail
 * of cmdSearch (CLI) and runSearchPipeline (MCP) — exactly where #8635 drifted
 * (the over-fetch cap leaked into the reported total on BOTH sides independently).
 *
 * `total`: every source over-fetched from offset 0 (computePerSourceWindow), so
 * results.length is the over-fetched candidate pool, NOT the population —
 * countSearchTotal re-derives the real MATCH+filter count. Clamp to
 * >= results.length so vector/concept-augmented obs rows are never undercounted
 * (#8217/#8638). For deep (explicit or auto-escalated) the population IS the fused
 * variant set already in `results` (deepSearch is obs-only, capped at
 * perSourceLimit); countSearchTotal would instead count the ORIGINAL query's FTS
 * matches — wrong, and ~0 on the vocabulary-mismatch queries deep exists for (F1).
 *
 * Pagination always slices: single-source results can exceed SQL LIMIT via
 * expansion (concept co-occurrence / PRF / vector), and `offset` is applied
 * exactly ONCE here (the per-source SQL always saw offset 0).
 *
 * @returns {{ total: number, page: object[] }}
 */
export function finalizeSearchPage(db, results, {
  isDeep, offset, limit, effectiveSource, ftsQuery, orFallbackFired,
  project = null, obsType = null, importance = null, branch = null,
  epochFrom = null, epochTo = null, includeNoise = false,
}) {
  const total = isDeep
    ? results.length
    : Math.max(countSearchTotal(db, {
      effectiveSource: effectiveSource || null,
      ftsQuery,
      obsFtsQuery: effectiveObsFtsQuery(ftsQuery, orFallbackFired),
      args: { project: project || null, obs_type: obsType || null, importance: importance || null, branch: branch || null },
      project: project || null,
      epochFrom, epochTo, includeNoise,
    }), results.length);
  const page = results.slice(offset, offset + limit);
  attachBodyTokens(db, page);
  return { total, page };
}

/**
 * Unified cross-source search orchestrator — single source of truth for the CLI
 * (cmdSearch) and MCP (mem_search) search bodies: deep / auto-escalation →
 * per-source query (obs hybrid + sessions + prompts) → cross-source
 * normalize+sort → context re-rank + supersede → tier post-filter → user sort →
 * count+paginate. The two surfaces legitimately differ on a handful of policy
 * points; each is a named opt so a future "fix" is a deliberate contract change,
 * not an accident (see the per-opt comments).
 *
 * The core does NO flag/schema parsing, NO stdout/stderr, NO formatting — adapters
 * validate+parse on the way in and render on the way out. Session/prompt rows
 * carry dual keys (`date`=created_at, `text`=prompt_text, `session`=content_session_id)
 * so both renderers read their own field names off one canonical row.
 *
 * #8743: `db` comes ONLY from `ctx.db` — there is no module-global fallback, so a
 * per-source leg can never silently query the wrong database.
 *
 * @returns {Promise<{ page:object[], total:number, preFinalizeCount:number, isDeep:boolean,
 *   escalated:boolean, escalatedObsCount:number, variants:object[]|null,
 *   reranked:boolean, orFallbackFired:boolean, effectiveSource:string|null, ftsQuery:string }>}
 */
export async function coreRunSearchPipeline(ctx, opts) {
  const {
    db, currentProject = null, env = process.env,
    searchObservationsHybrid, deepSearch, shouldEscalateToDeep,
    autoDeepLlmReady, reRankWithContext,
    llm = null, rerankLlm = undefined,
  } = ctx;
  const {
    query, ftsQuery, effectiveSource = null, deepMode = 'normal', rerank = false,
    limit, offset, project = null, obsType = null, importance = null, branch = null,
    includeNoise = false, epochFrom = null, epochTo = null, sort = 'relevance', tier = null,
    // ── surface policy (strict behavior-preservation; the two surfaces differ) ──
    obsTypeFallback = false,           // A5: list-recent-by-type when 0 matches — MCP true, CLI false (#8217 removed it from CLI)
    crossSourceEpochSortNoFts = false, // A3: epoch-sort the cross-source set when no ftsQuery — MCP true, CLI false
    rerankPolicy = 'mcp',              // A4: re-rank/supersede gate + re-sort condition — 'mcp' | 'cli'
    rerankProject = null,              // reRankWithContext project — MCP currentProject, CLI project||inferProject()
    recentListingNoFts = false,        // session/prompt recent-listing when no ftsQuery (explicit --source) — MCP true, CLI false
    tolerateMissingFts = false,        // wrap session/prompt FTS in try/catch for pre-FTS legacy DBs — CLI true, MCP false
    tierPosition = 'late',             // tier filter vs re-rank ordering — MCP 'late' (after re-rank), CLI 'early' (in obs block)
    tierProject = null,                // applyTierFilter project — MCP project||currentProject, CLI project||inferProject()
  } = opts;

  const { perSourceLimit, perSourceOffset } = computePerSourceWindow(limit, offset);
  const isCrossSource = !effectiveSource;
  const results = [];
  let orFallbackFired = false;
  let deepVariants = null;
  let deepReranked = false;
  let isDeep = deepMode === 'deep';
  let escalated = false;
  let escalatedObsCount = 0;

  const obsCtx = {
    db, ftsQuery,
    args: { project, obs_type: obsType, importance, branch, include_noise: includeNoise },
    epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject, limit,
    orFallbackFired: false,
  };

  const runDeep = async ({ auto = false } = {}) => {
    const ds = await deepSearch(db, {
      query, project, type: obsType, importance, branch, includeNoise,
      epochFrom, epochTo, limit: perSourceLimit, currentProject,
    }, llm ? { llm, rerank: rerank && !auto, rerankLlm } : { auto, rerank: rerank && !auto, rerankLlm });
    deepVariants = ds.variants;
    deepReranked = ds.reranked;
    return ds.results;
  };

  // ── Observations (hybrid engine; deep / auto-escalation; obs rows already carry source:'obs') ──
  if (!effectiveSource || effectiveSource === 'observations') {
    if (deepMode === 'deep') {
      results.push(...await runDeep());
    } else {
      results.push(...searchObservationsHybrid(db, obsCtx));
      if (obsCtx.orFallbackFired) orFallbackFired = true;
      const obsCountBefore = results.filter((r) => r.source === 'obs').length;
      if (deepMode === 'auto' && autoDeepLlmReady(env, llm) &&
          shouldEscalateToDeep(results.filter((r) => r.source === 'obs'), obsCtx, { db, project })) {
        const deepRows = await runDeep({ auto: true });
        results.length = 0;
        results.push(...deepRows);
        isDeep = true;
        escalated = true;
        escalatedObsCount = obsCountBefore;
      }
    }
  }

  // ── Tier post-filter, CLI position: obs-only (tier forces observations), before re-rank ──
  if (tier && tierPosition === 'early') {
    const filtered = applyTierFilter(db, results, { tier, sourceKey: 'source', currentProject: tierProject });
    results.length = 0; results.push(...filtered);
  }

  // ── Sessions (FTS via shared helper; optional recent-listing when no ftsQuery) ──
  if ((!effectiveSource || effectiveSource === 'sessions') && !isDeep) {
    const pushSessions = () => {
      if (ftsQuery) {
        const rows = searchSessionsFts(db, { ftsQuery, project, projectBoost: project ? null : currentProject, epochFrom, epochTo, perSourceLimit, perSourceOffset });
        for (const r of rows) results.push({ ...r, source: 'session', date: r.created_at });
      } else if (recentListingNoFts && effectiveSource === 'sessions') {
        const params = []; const wheres = [];
        if (project) { wheres.push('project = ?'); params.push(project); }
        if (epochFrom !== null) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo !== null) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        params.push(perSourceLimit, perSourceOffset);
        const rows = db.prepare(`
          SELECT id, request, completed, project, created_at, created_at_epoch
          FROM session_summaries ${where}
          ORDER BY created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) results.push({ ...r, source: 'session', date: r.created_at });
      }
    };
    if (tolerateMissingFts) { try { pushSessions(); } catch { /* session FTS may not exist in older DBs */ } } else pushSessions();
  }

  // ── Prompts (FTS via shared helper incl. CJK gate; optional recent-listing) ──
  if ((!effectiveSource || effectiveSource === 'prompts') && !isDeep) {
    const pushPrompts = () => {
      if (ftsQuery) {
        const rows = searchPromptsFts(db, { query, ftsQuery, project, epochFrom, epochTo, perSourceLimit, perSourceOffset });
        for (const r of rows) results.push({ ...r, source: 'prompt', date: r.created_at, text: r.prompt_text, session: r.content_session_id });
      } else if (recentListingNoFts && effectiveSource === 'prompts') {
        const params = []; const wheres = [];
        if (project) { wheres.push('s.project = ?'); params.push(project); }
        if (epochFrom !== null) { wheres.push('p.created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo !== null) { wheres.push('p.created_at_epoch <= ?'); params.push(epochTo); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        params.push(perSourceLimit, perSourceOffset);
        const rows = db.prepare(`
          SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch
          FROM user_prompts p
          JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
          ${where}
          ORDER BY p.created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) results.push({ ...r, source: 'prompt', date: r.created_at, text: r.prompt_text, session: r.content_session_id });
      }
    };
    if (tolerateMissingFts) { try { pushPrompts(); } catch { /* prompt FTS may not exist in older DBs */ } } else pushPrompts();
  }

  // ── Type-list fallback (MCP): obs_type set + 0 matches → list recent of that type ──
  if (obsTypeFallback && results.length === 0 && obsType) {
    const typeWheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL', 'type = ?'];
    // Mirror the FTS path's low-signal filter (buildObsFtsQuery): this fallback is still a
    // SEARCH surface, so degraded titles ("Modified X", "Error: …") must not lead it —
    // acute for obs_type='change', the noise band. (The no-query recent-listing in
    // searchObservationsHybrid deliberately does NOT filter — it mirrors mem_recent.)
    if (!includeNoise) typeWheres.push(notLowSignalTitleClause(''));
    const typeParams = [obsType];
    if (project) { typeWheres.push('project = ?'); typeParams.push(project); }
    if (epochFrom !== null) { typeWheres.push('created_at_epoch >= ?'); typeParams.push(epochFrom); }
    if (epochTo !== null) { typeWheres.push('created_at_epoch <= ?'); typeParams.push(epochTo); }
    if (importance) { typeWheres.push('COALESCE(importance, 1) >= ?'); typeParams.push(importance); }
    typeParams.push(limit);
    const typeRows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at, importance, files_modified
      FROM observations WHERE ${typeWheres.join(' AND ')}
      ORDER BY created_at_epoch DESC LIMIT ?
    `).all(...typeParams);
    for (const r of typeRows) results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, importance: r.importance, files_modified: r.files_modified, score: 0, snippet: '' });
  }

  // ── Cross-source normalize + sort ──
  if (isCrossSource && results.length > 0 && ftsQuery) normalizeCrossSourceScores(results, 'source');
  if (isCrossSource && results.length > 0) {
    if (ftsQuery) results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    else if (crossSourceEpochSortNoFts) results.sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  }

  // ── Context re-rank ──
  const hasObs = results.some((r) => r.source === 'obs');
  const rerankGate = rerankPolicy === 'mcp' ? ((ftsQuery || isDeep) && hasObs) : hasObs;
  if (rerankGate) {
    const doReRank = rerankPolicy === 'mcp' ? (ftsQuery && !deepReranked) : !deepReranked;
    if (doReRank) {
      // obsResults is only consumed by reRankWithContext — build it inside the gate so
      // the no-rerank path (deepReranked / MCP isDeep+!ftsQuery) skips the wasted filter.
      const obsResults = results.filter((r) => r.source === 'obs');
      reRankWithContext(db, obsResults, rerankProject);
    }
    // CLI single-source path must also re-sort when a context re-rank actually ran,
    // else reRankWithContext's score boost mutates scores but never reorders output
    // (audit #9). MCP branch unchanged. doReRank already implies a rerank happened.
    const doReSort = rerankPolicy === 'mcp' ? (ftsQuery && !deepReranked) : (isCrossSource || doReRank);
    if (doReSort) results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  }

  // ── Tier post-filter, MCP position: after re-rank, on the merged set ──
  if (tier && tierPosition === 'late') {
    const filtered = applyTierFilter(db, results, { tier, sourceKey: 'source', currentProject: tierProject });
    results.length = 0; results.push(...filtered);
  }

  // ── User-requested sort (after relevance scoring) ──
  applyUserSort(results, sort);

  // ── Count + paginate + ~Nt enrich. preFinalizeCount lets the CLI adapter
  //    distinguish "nothing matched" from "this page is empty" (its two messages). ──
  const preFinalizeCount = results.length;
  const { total, page } = finalizeSearchPage(db, results, {
    isDeep, offset, limit, effectiveSource, ftsQuery, orFallbackFired,
    project, obsType, importance, branch, epochFrom, epochTo, includeNoise,
  });

  return {
    page, total, preFinalizeCount, isDeep, escalated, escalatedObsCount,
    variants: deepVariants, reranked: deepReranked, orFallbackFired, effectiveSource, ftsQuery,
  };
}
