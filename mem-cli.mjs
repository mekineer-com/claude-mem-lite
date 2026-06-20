#!/usr/bin/env node
// claude-mem-lite CLI — lightweight command layer for direct memory access
// No MCP SDK or heavy deps — only imports schema.mjs and utils.mjs

import { homedir } from 'os';
import { ensureDb, DB_PATH, DB_DIR, REGISTRY_DB_PATH } from './schema.mjs';
import { truncate, typeIcon, inferProject, scrubSecrets } from './utils.mjs';
import { resolveProject } from './project-utils.mjs';
import { TIER_CASE_SQL, tierSqlParams } from './tier.mjs';
import { _resetVocabCache } from './tfidf.mjs';
import { autoBoostIfNeeded, reRankWithContext, markSuperseded } from './server-internals.mjs';
import { searchObservationsHybrid, countSearchTotal } from './search-engine.mjs';
import { deepSearch, resolveDeepMode, shouldEscalateToDeep, autoDeepLlmReady } from './deep-search.mjs';
import { ensureRegistryDb, upsertResource } from './registry.mjs';
import { searchResources } from './registry-retriever.mjs';
import { selectCompressionCandidates, groupByProjectWeek, compressGroup } from './lib/compress-core.mjs';
import {
  cleanupBroken, decayAndMarkIdle, boostAccessed, demotePinned, mergeDuplicates,
  purgeStale, purgeStalePreview, findDuplicates, maintenanceStats, rebuildVectors, vacuum,
  recoverChildrenOf,
  OP_CAP, STALE_AGE_MS, PINNED_INJ_THRESHOLD,
} from './lib/maintain-core.mjs';
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
import { buildSessionContextLines } from './hook-context.mjs';
import { cmdAdopt, cmdUnadopt } from './adopt-cli.mjs';
import { parseIntFlag, isNumericToken } from './lib/cli-flags.mjs';
import { auditMemdir, memdirPath } from './memdir.mjs';
import { probeOtherSources as probeIdSources, bucketIdTokens } from './lib/id-routing.mjs';
import { join, sep } from 'path';
import { readFileSync, existsSync, readdirSync } from 'fs';

// v2.41: shared CLI helpers extracted to cli/common.mjs. Keep this file as the
// router + remaining-command bodies during the incremental split. Future work:
// move each cmdXxx into its own cli/<cmd>.mjs; mem-cli.mjs becomes pure dispatch.
import { parseArgs, out, fail, relativeTime, fmtDateShort, parseIdToken, formatProbeHints, rejectBareStringFlags, OBS_TIME_FIELDS, formatObsFieldValue } from './cli/common.mjs';
import { saveObservation } from './lib/save-observation.mjs';
import { rebuildObservationDerived } from './lib/observation-write.mjs';
import { recallByFile } from './lib/recall-core.mjs';
import { resolveAnchorToken, formatAnchorError, resolveQueryAnchor, fetchRecentTimeline, fetchTimelineWindow } from './lib/timeline-core.mjs';
import { buildSearchFtsQuery, parseDateBounds, computePerSourceWindow, effectiveObsFtsQuery, searchSessionsFts, searchPromptsFts, normalizeCrossSourceScores, applyUserSort, applyTierFilter } from './lib/search-core.mjs';
import { AUTO_MERGE_THRESHOLD } from './lib/dedup-constants.mjs';
import { countRecentHookErrors } from './lib/hook-telemetry.mjs';
import { aggregateMetrics } from './lib/metrics.mjs';
import {
  insertDeferred, listOpenWithOrdinal, dropDeferred,
  resolveDeferredIds, closeDeferredItems,
} from './lib/deferred-work.mjs';

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdSearch(db, args, { llm } = {}) {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ');
  if (!query) {
    fail('[mem] Usage: claude-mem-lite search <query> [--type TYPE] [--source SOURCE] [--limit N] [--project P] [--from DATE] [--to DATE] [--importance N] [--branch B] [--offset N] [--sort relevance|time|importance] [--include-noise] [--deep] [--no-deep]');
    return;
  }

  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 20, max: 1000 });
  const type = flags.type || null;
  const validObsTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  if (type && !validObsTypes.has(type)) {
    fail(`[mem] Invalid --type "${type}". Valid: ${[...validObsTypes].join(', ')}`);
    return;
  }
  const source = flags.source || null; // observations|sessions|prompts (null = all)
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const bounds = parseDateBounds(flags.from, flags.to);
  if (!bounds.ok) { fail(`[mem] Invalid --${bounds.bad} date: "${bounds.value}". Use YYYY-MM-DD or ISO 8601.`); return; }
  const { epochFrom: dateFrom, epochTo: dateTo } = bounds;
  // Inverted range silently returns 0 rows; warn so users see the cause, don't error
  // (a deliberate "search for nothing in this window" is not malformed input).
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    process.stderr.write(`[mem] Note: --from "${flags.from}" is after --to "${flags.to}"; this range is empty\n`);
  }
  const minImportance = flags.importance !== undefined ? parseInt(flags.importance, 10) : null;
  // isNumericToken first: "2abc"→2 / "1e2"→1 would pass the range check and silently
  // filter at a value the user never typed. Reject garbage like out-of-range does.
  if (minImportance !== null && (!isNumericToken(flags.importance) || isNaN(minImportance) || minImportance < 1 || minImportance > 3)) {
    fail(`[mem] Invalid --importance "${flags.importance}". Must be 1, 2, or 3.`);
    return;
  }
  const branch = flags.branch || null;
  // parseIntFlag (min=0) rejects garbage ("2abc"→2, "1e2"→1) the old isInteger check let
  // through, warns once, and falls back to 0 — same WARN-style contract, now garbage-proof.
  const offset = parseIntFlag(flags.offset, { name: '--offset', defaultValue: 0, min: 0 });
  const tier = flags.tier || null;
  if (tier && !['working', 'active', 'archive'].includes(tier)) {
    fail(`[mem] Invalid --tier "${tier}". Use: working, active, archive`);
    return;
  }
  const sort = flags.sort || 'relevance';
  if (!['relevance', 'time', 'importance'].includes(sort)) {
    fail(`[mem] Invalid --sort "${sort}". Use: relevance, time, importance`);
    return;
  }
  const useOr = flags.or === true || flags.or === 'true';
  // R-1: opt-in flag to surface hook-llm fallback titles ("Modified X", "Worked on X", raw
  // error logs, etc.) which are otherwise filtered from default search. Use for auditing or
  // when explicitly searching for a file/command that produced a degraded title.
  const includeNoise = flags['include-noise'] === true || flags['include-noise'] === 'true';
  const jsonOutput = flags.json === true || flags.json === 'true';
  // --deep: opt-in LLM multi-query / HyDE deep search (deep-search.mjs). Costs one
  // Haiku call + N hybrid searches; observations-only. NOT the passive path — this
  // is the explicit "search harder" lever for vocabulary-mismatch recall misses.
  // --deep forces deep; --no-deep forces normal; neither = unset (env/default decide).
  const explicitDeep = (flags.deep === true || flags.deep === 'true')
    ? true
    : ((flags['no-deep'] === true || flags['no-deep'] === 'true') ? false : undefined);
  const deepMode = resolveDeepMode(explicitDeep, { surface: 'cli' });

  if (source && !['observations', 'sessions', 'prompts'].includes(source)) {
    fail(`[mem] Invalid --source "${source}". Use: observations, sessions, prompts`);
    return;
  }

  const ftsQuery = buildSearchFtsQuery(query, { or: useOr });
  // --deep proceeds even when the literal query sanitizes to nothing — its LLM
  // rewrite may still produce searchable variants (F3, parity with server.mjs).
  if (!ftsQuery && deepMode === 'normal') {
    fail(`[mem] No valid search terms in "${query}"`);
    return;
  }
  // --deep ignores --or: each variant runs AND + the engine's built-in
  // OR-fallback, so --or has no effect on the deep path — say so (F8).
  if (deepMode === 'deep' && useOr) {
    process.stderr.write('[mem] Note: --or has no effect with --deep (variants use AND + engine OR-fallback)\n');
  }

  // Warn if obs-only filters used with non-observation source
  if (source && source !== 'observations' && (type || tier || minImportance || branch)) {
    const ignored = [type && '--type', tier && '--tier', minImportance && '--importance', branch && '--branch'].filter(Boolean);
    process.stderr.write(`[mem] Note: ${ignored.join(', ')} only apply to observations, ignored for --source ${source}\n`);
  }

  // When --type/--tier/--importance/--branch (obs-only fields) is specified, implicitly restrict to observations.
  // --branch was previously cross-source: sessions/prompts have no branch column, so a query like
  // `search "cache" --branch main` would include unrelated session/prompt rows, surprising users
  // who passed --branch expecting a branch-scoped result.
  // --deep is observations-only (deepSearch fuses searchObservationsHybrid lists);
  // it overrides --source and the obs-only filter inference.
  if (deepMode === 'deep' && source && source !== 'observations') {
    process.stderr.write(`[mem] Note: --deep searches observations only; ignoring --source ${source}\n`);
  }
  const effectiveSource = deepMode === 'deep'
    ? 'observations'
    : (source || ((type || tier || minImportance || branch) ? 'observations' : null));

  // Cross-source mode: each source needs more candidates than the final limit
  // so the post-merge sort has room to pick the best from each (shared sizing
  // with mem_search — without this, obs gets systematically squeezed out by
  // sessions). Over-fetch from offset 0; --offset applies ONCE at the final
  // slice below (see computePerSourceWindow for the #8217/#8638 rationale).
  const isCrossSourceMode = !effectiveSource;
  const { perSourceLimit, perSourceOffset } = computePerSourceWindow(limit, offset);

  const results = [];
  // Tracks whether AND returned 0 and OR recovered non-empty. Mirrors server.mjs
  // ctx.orFallbackFired so the header can surface a "(relaxed AND→OR)" hint.
  let orFallbackFired = false;

  let deepVariants = null;
  let isDeep = deepMode === 'deep';

  // Search observations — shared engine with server.mjs (#8198/#8212 paired-path fix)
  if (!effectiveSource || effectiveSource === 'observations') {
    const obsCtx = {
      ftsQuery,
      args: {
        project: project || null,
        obs_type: type || null,
        importance: minImportance || null,
        branch: branch || null,
        include_noise: includeNoise,
      },
      epochFrom: dateFrom,
      epochTo: dateTo,
      perSourceLimit,
      perSourceOffset,
      currentProject: project ? null : inferProject(),
      limit,
      orFallbackFired: false,
    };

    const runDeep = async () => {
      const ds = await deepSearch(db, {
        query,
        project: project || null,
        type: type || null,
        importance: minImportance || null,
        branch: branch || null,
        includeNoise,
        epochFrom: dateFrom,
        epochTo: dateTo,
        limit: perSourceLimit,
        currentProject: project ? null : inferProject(),
      }, llm ? { llm } : undefined);
      deepVariants = ds.variants;
      if (deepVariants.length > 1) {
        process.stderr.write(`[mem] Deep search: rewrote into ${deepVariants.length} query variants, RRF-fused\n`);
      } else {
        process.stderr.write('[mem] Deep search: rewrite returned no usable variants; used original query only\n');
      }
      return ds.results;
    };

    let obsResults;
    if (deepMode === 'deep') {
      obsResults = await runDeep();
    } else {
      obsResults = searchObservationsHybrid(db, obsCtx);
      if (obsCtx.orFallbackFired) orFallbackFired = true;
      if (deepMode === 'auto' && autoDeepLlmReady(process.env, llm) && shouldEscalateToDeep(obsResults, obsCtx)) {
        process.stderr.write(`[mem] auto-escalated to deep search (weak results: ${obsResults.length} hits)\n`);
        obsResults = await runDeep();
        isDeep = true;
      }
    }
    for (const r of obsResults) results.push({ ...r, _source: 'obs', score: r.score ?? 0 });

    // Tier post-filter — applied to ALL obs results from the engine.
    if (tier) {
      const filtered = applyTierFilter(db, results, { tier, sourceKey: '_source', currentProject: project || inferProject() });
      results.length = 0;
      results.push(...filtered);
    }
  }

  // Search sessions (shared engine with MCP mem_search — lib/search-core.mjs)
  if ((!effectiveSource || effectiveSource === 'sessions') && !isDeep) {
    try {
      const sessRows = searchSessionsFts(db, {
        ftsQuery, project, projectBoost: project ? null : inferProject(),
        epochFrom: dateFrom, epochTo: dateTo, perSourceLimit, perSourceOffset,
      });
      for (const r of sessRows) results.push({ ...r, _source: 'session' });
    } catch { /* session FTS may not exist in older DBs */ }
  }

  // Search prompts (shared engine incl. CJK precision gate + LIKE fallback)
  if ((!effectiveSource || effectiveSource === 'prompts') && !isDeep) {
    try {
      const promptRows = searchPromptsFts(db, {
        query, ftsQuery, project,
        epochFrom: dateFrom, epochTo: dateTo, perSourceLimit, perSourceOffset,
      });
      for (const r of promptRows) results.push({ ...r, _source: 'prompt' });
    } catch { /* prompt FTS may not exist in older DBs */ }
  }

  if (results.length === 0) {
    if (jsonOutput) {
      out(JSON.stringify({ query, total: 0, returned: 0, offset, limit, deep: isDeep, variants: isDeep ? deepVariants : undefined, results: [] }));
    } else {
      out(`[mem] No results for "${query}"`);
    }
    return;
  }

  // Cross-source score normalization (shared with mem_search).
  // ftsQuery gate prevents normalization when scores are all 0 (no-FTS path).
  const isCrossSource = isCrossSourceMode;
  if (isCrossSource && results.length > 0 && ftsQuery) {
    normalizeCrossSourceScores(results, '_source');
    results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  }

  // Context re-ranking + superseded marking (aligned with MCP mem_search)
  const obsResults = results.filter(r => r._source === 'obs');
  if (obsResults.length > 0) {
    // reRankWithContext/markSuperseded expect source='obs' — alias _source for compatibility
    for (const r of obsResults) r.source = 'obs';
    reRankWithContext(db, obsResults, project || inferProject());
    markSuperseded(obsResults);
    if (isCrossSource) results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  }

  // Apply user-requested sort (after relevance scoring; shared with mem_search)
  applyUserSort(results, sort);

  // Trim to limit with offset. The engine always received perSourceOffset=0 and
  // over-fetched (see above), so the merged+reranked `results` start at row 0 and
  // the offset is applied exactly ONCE here — for every mode.
  //
  // `total` must be the TRUE population, independent of --limit/--offset (else the
  // over-fetched candidate count grew with the page and broke the "N of M" /
  // pagination contract). countSearchTotal mirrors each source's MATCH+filters;
  // clamp to >= results.length so it never understates the rows actually shown
  // (vector/concept augmentation can add obs rows beyond the FTS count).
  // For --deep the population is the fused variant result set: deepSearch already
  // returned all fused rows (capped at perSourceLimit) and they are the only rows
  // in `results` (deep is obs-only). countSearchTotal would instead count the
  // ORIGINAL query's FTS matches — wrong, and ~0 on the vocabulary-mismatch
  // queries deep exists for, which falsely shrinks the "N of M" total (F1).
  const total = isDeep
    ? results.length
    : Math.max(countSearchTotal(db, {
      effectiveSource,
      ftsQuery,
      obsFtsQuery: effectiveObsFtsQuery(ftsQuery, orFallbackFired),
      args: { project: project || null, obs_type: type || null, importance: minImportance || null, branch: branch || null },
      project: project || null,
      epochFrom: dateFrom,
      epochTo: dateTo,
      includeNoise,
    }), results.length);
  const paged = results.slice(offset, offset + limit);

  if (paged.length === 0) {
    if (jsonOutput) {
      out(JSON.stringify({ query, total, returned: 0, offset, limit, deep: isDeep, variants: isDeep ? deepVariants : undefined, results: [] }));
    } else {
      out(`[mem] No results for "${query}" at offset ${offset}`);
    }
    return;
  }

  // paired-path with server.mjs formatSearchOutput (#8198): "N of M" total when paged < total.
  const showTime = sort === 'time';
  const hasMixed = paged.some(r => r._source === 'session' || r._source === 'prompt');
  // Suppressed when --or was explicit — user already asked for OR, no "fallback" there.
  const fallbackHint = orFallbackFired && !useOr ? ' (relaxed AND→OR)' : '';

  if (jsonOutput) {
    const items = paged.map(r => {
      const base = {
        source: r._source,
        id: r.id,
        created_at: r.created_at,
        score: r.score ?? null,
      };
      if (r._source === 'session') {
        return { ...base, request: r.request || null, completed: r.completed || null, project: r.project || null };
      }
      if (r._source === 'prompt') {
        return { ...base, prompt_text: r.prompt_text || null };
      }
      return {
        ...base,
        type: r.type,
        title: r.title || r.subtitle || null,
        lesson_learned: r.lesson_learned || null,
        importance: r.importance ?? null,
        superseded: Boolean(r.superseded),
        files_modified: r.files_modified || null,
      };
    });
    out(JSON.stringify({
      query,
      total,
      returned: paged.length,
      offset,
      limit,
      deep: isDeep,
      variants: isDeep ? deepVariants : undefined,
      relaxed_and_to_or: orFallbackFired && !useOr,
      mixed_sources: hasMixed,
      results: items,
    }));
    return;
  }

  const countLabel = total > paged.length ? `${paged.length} of ${total}` : `${paged.length}`;
  // Pluralize on total — "Found 1 of 44 result" reads wrong; the population (44) drives
  // grammatical number, not the page slice (1).
  out(`[mem] Found ${countLabel} result${total !== 1 ? 's' : ''} for "${query}"${fallbackHint}:${hasMixed ? ' (# observation, S# session, P# prompt)' : ''}`);
  for (const r of paged) {
    const timeStr = showTime && r.created_at_epoch ? ` (${relativeTime(r.created_at_epoch)})` : '';
    if (r._source === 'session') {
      const date = fmtDateShort(r.created_at);
      out(`S#${r.id} 📋 ${date}${timeStr} ${truncate(r.request || r.completed || '(no summary)', 80)}`);
    } else if (r._source === 'prompt') {
      const date = fmtDateShort(r.created_at);
      out(`P#${r.id} 💬 ${date}${timeStr} ${truncate(r.prompt_text || '(empty)', 80)}`);
    } else {
      const date = fmtDateShort(r.created_at);
      const title = truncate(r.title || r.subtitle || '(untitled)', 80);
      const supersededTag = r.superseded ? ' [SUPERSEDED]' : '';
      out(`#${r.id} ${typeIcon(r.type)} ${date}${timeStr} ${title}${supersededTag}`);
      if (r.lesson_learned) {
        out(`  -> ${truncate(r.lesson_learned, 80)}`);
      }
    }
  }
}

function cmdRecent(db, args) {
  const { positional, flags } = parseArgs(args);
  const rawArg = positional[0];
  const rawLimit = parseInt(rawArg, 10);
  // isNumericToken first: "2abc"→2 / "1e2"→1 are positive integers that the bare check
  // accepted silently; the positional path must reject garbage like the --limit flag does.
  const isValid = rawArg !== undefined && isNumericToken(rawArg) && Number.isInteger(rawLimit) && rawLimit > 0;
  if (rawArg !== undefined && !isValid) {
    process.stderr.write(`[mem] Invalid count "${rawArg}" (must be a positive integer); using default 10\n`);
  }
  // Positional [N] wins for backward-compat; --limit is sibling-parity alias
  // (search/recall/browse/stats all accept --limit). Pre-2.69 `recent --limit N`
  // was silently ignored — surprising users extrapolating from siblings.
  const limit = isValid
    ? rawLimit
    : parseIntFlag(flags.limit, { name: '--limit', defaultValue: 10, max: 1000 });
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const jsonOutput = flags.json === true || flags.json === 'true';

  // `recent --type bugfix` previously parsed as a silent no-op — users naturally
  // try this for "show recent bugfixes". Mirror cmdSearch's enum validation.
  const type = flags.type || null;
  if (type) {
    const validObsTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
    if (!validObsTypes.has(type)) {
      fail(`[mem] Invalid --type "${type}". Valid: ${[...validObsTypes].join(', ')}`);
      return;
    }
  }

  const params = [];
  const wheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL'];
  if (project) { wheres.push('project = ?'); params.push(project); }
  if (type) { wheres.push('type = ?'); params.push(type); }
  params.push(limit);

  const rows = db.prepare(`
    SELECT id, type, title, subtitle, importance, created_at_epoch, created_at
    FROM observations
    WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...params);

  if (jsonOutput) {
    out(JSON.stringify({
      project: project || null,
      limit,
      type: type || null,
      total: rows.length,
      results: rows.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title || r.subtitle || null,
        importance: r.importance ?? null,
        created_at: r.created_at,
        created_at_epoch: r.created_at_epoch,
      })),
    }));
    return;
  }

  if (rows.length === 0) {
    out(`[mem] No recent observations${project ? ` (${project})` : ''}`);
    return;
  }

  out(`[mem] Recent (${project || 'all'}):`);
  for (const r of rows) {
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 80);
    out(`${('#' + r.id).padEnd(6)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
  }
}

function cmdRecall(db, args) {
  const { positional, flags } = parseArgs(args);
  const file = positional.join(' ');
  if (!file) {
    fail('[mem] Usage: claude-mem-lite recall <file> [--limit N] [--include-noise] [--json]');
    return;
  }

  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 10, max: 1000 });
  const includeNoise = flags['include-noise'] === true || flags['include-noise'] === 'true';
  const jsonOutput = flags.json === true || flags.json === 'true';

  // Shared core with MCP mem_recall: query + escaping + access bump (lib/recall-core.mjs)
  const { filename, rows } = recallByFile(db, file, { limit, includeNoise });

  if (jsonOutput) {
    out(JSON.stringify({
      file: filename,
      limit,
      include_noise: includeNoise,
      total: rows.length,
      results: rows.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title || null,
        lesson_learned: r.lesson_learned || null,
        importance: r.importance ?? null,
        project: r.project,
        created_at: r.created_at,
        created_at_epoch: r.created_at_epoch,
      })),
    }));
    return;
  }

  if (rows.length === 0) {
    out(`[mem] No history for "${filename}"`);
    return;
  }

  out(`[mem] History for ${filename} (${rows.length}):`);
  for (const r of rows) {
    const title = truncate(r.title || '(untitled)', 80);
    const lesson = r.lesson_learned ? `\n     Lesson: ${truncate(r.lesson_learned, 80)}` : '';
    const date = fmtDateShort(r.created_at);
    out(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${title} | ${r.project} | ${date}${lesson}`);
  }
}

const OBS_FIELDS = ['id', 'type', 'title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned', 'search_aliases', 'files_read', 'files_modified', 'project', 'created_at', 'memory_session_id', 'prompt_number', 'importance', 'related_ids', 'access_count', 'branch', 'superseded_at', 'superseded_by', 'last_accessed_at'];

// Time-field formatting moved to cli/common.mjs so the CLI `get` and the MCP
// `mem_get` (server.mjs) share one source and can't drift (the drift bug:
// MCP printed bare ms while CLI showed `<ms> (<relative>)`). Imported at the
// top; re-exported here for back-compat with existing importers
// (tests/get-time-format.test.mjs).
export { OBS_TIME_FIELDS, formatObsFieldValue };
// Test seam: exposes cmdSearch with the llm injection slot without going through
// ensureDb — lets hermetic tests pass a seeded :memory: db and a stub llm.
export async function cmdSearchForTest(db, args, opts) { return cmdSearch(db, args, opts); }

function renderObsRows(db, ids, requestedFields) {
  const placeholders = ids.map(() => '?').join(',');
  try {
    db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${placeholders})`).run(Date.now(), ...ids);
    autoBoostIfNeeded(db, ids);
  } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }

  const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...ids);
  if (rows.length === 0) return null;
  const fields = requestedFields || OBS_FIELDS;
  const parts = [];
  for (const r of rows) {
    const lines = [`#${r.id} [${r.type}] ${fmtDateShort(r.created_at)}`];
    for (const f of fields) {
      if (f === 'id' || f === 'type' || f === 'created_at') continue;
      const val = r[f];
      if (val === null || val === undefined || val === '') continue;
      if (f === 'text' && r.narrative && typeof val === 'string' && val.startsWith(r.narrative)) continue;
      const formatted = formatObsFieldValue(f, val);
      const maxLen = f === 'narrative' ? 1000 : f === 'lesson_learned' ? 500 : f === 'text' ? 500 : 200;
      const display = typeof formatted === 'string' && formatted.length > maxLen ? formatted.slice(0, maxLen) + '…' : formatted;
      lines.push(`${f}: ${display}`);
    }
    parts.push(lines.join('\n'));
  }
  return { text: parts.join('\n\n'), count: rows.length };
}

function renderSessionRows(db, ids) {
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM session_summaries WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...ids);
  if (rows.length === 0) return null;
  const parts = [];
  for (const r of rows) {
    const lines = [`S#${r.id} ${fmtDateShort(r.created_at)}`];
    if (r.request) lines.push(`Request: ${r.request}`);
    if (r.completed) lines.push(`Completed: ${r.completed}`);
    if (r.investigated) lines.push(`Investigated: ${r.investigated}`);
    if (r.learned) lines.push(`Learned: ${r.learned}`);
    if (r.next_steps) lines.push(`Next steps: ${r.next_steps}`);
    if (r.project) lines.push(`Project: ${r.project}`);
    parts.push(lines.join('\n'));
  }
  return { text: parts.join('\n\n'), count: rows.length };
}

function renderPromptRows(db, ids) {
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM user_prompts WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...ids);
  if (rows.length === 0) return null;
  const parts = [];
  for (const r of rows) {
    const lines = [`P#${r.id} ${fmtDateShort(r.created_at)}`];
    if (r.prompt_text) lines.push(`Text: ${r.prompt_text}`);
    if (r.content_session_id) lines.push(`Session: ${r.content_session_id}`);
    parts.push(lines.join('\n'));
  }
  return { text: parts.join('\n\n'), count: rows.length };
}

function cmdGet(db, args) {
  const { positional, flags } = parseArgs(args);
  const idStr = positional.join(',');
  if (!idStr) {
    fail('[mem] Usage: claude-mem-lite get <id1,id2,...> [--source obs|session|prompt] [--fields f1,f2,...]\n' +
         '        IDs accept prefix from search output: #123 (obs), P#123 (prompt), S#123 (session).');
    return;
  }

  const tokens = idStr.split(',').map(s => s.trim()).filter(Boolean);

  // Explicit --source overrides any prefix; otherwise each token's prefix routes individually.
  const explicit = flags.source;
  const validSources = new Set(['obs', 'session', 'prompt']);
  if (explicit && !validSources.has(explicit)) {
    fail(`[mem] Invalid --source "${explicit}". Use: obs, session, prompt`);
    return;
  }

  // Shared bucketing with MCP mem_get — single source of truth for P#/S#/# routing (#8050).
  const { bySrc, invalid: unparseable } = bucketIdTokens(tokens, { explicit, defaultSource: 'obs' });
  if (unparseable.length > 0) {
    process.stderr.write(`[mem] Ignoring unparseable ID token(s): ${unparseable.join(', ')}\n`);
  }
  if (bySrc.obs.length + bySrc.session.length + bySrc.prompt.length === 0) {
    fail('[mem] No valid IDs provided');
    return;
  }

  // Validate --fields against obs schema (only meaningful for obs rows).
  if (rejectBareStringFlags(flags, ['fields', 'source'])) return;
  let requestedFields = null;
  if (flags.fields) {
    const allRequested = flags.fields.split(',').map(s => s.trim());
    const invalid = allRequested.filter(f => !OBS_FIELDS.includes(f));
    if (invalid.length > 0) {
      process.stderr.write(`[mem] Unknown field(s): ${invalid.join(', ')}. Valid: ${OBS_FIELDS.join(', ')}\n`);
    }
    requestedFields = allRequested.filter(f => OBS_FIELDS.includes(f));
    if (requestedFields.length === 0) {
      fail('[mem] No valid fields specified');
      return;
    }
  }

  const sections = [];
  let totalFound = 0;
  if (bySrc.obs.length > 0) {
    const s = renderObsRows(db, bySrc.obs, requestedFields);
    if (s) { sections.push(s.text); totalFound += s.count; }
  }
  if (bySrc.session.length > 0) {
    const s = renderSessionRows(db, bySrc.session);
    if (s) { sections.push(s.text); totalFound += s.count; }
  }
  if (bySrc.prompt.length > 0) {
    const s = renderPromptRows(db, bySrc.prompt);
    if (s) { sections.push(s.text); totalFound += s.count; }
  }

  if (totalFound === 0) {
    // Probe the OTHER sources so the caller can retry with the right prefix.
    const queried = new Set(Object.entries(bySrc).filter(([, v]) => v.length > 0).map(([k]) => k));
    const allIds = [...bySrc.obs, ...bySrc.session, ...bySrc.prompt];
    const probe = probeIdSources(db, allIds, queried);
    const hits = formatProbeHints(probe);
    const hint = hits.length > 0 ? ` Try: ${hits.join('; ')}.` : '';
    const queriedList = [...queried].join(', ');
    fail(`[mem] No records found in source(s) [${queriedList}] for the given ID(s).${hint}`);
    return;
  }

  out(sections.join('\n\n'));
}

function cmdTimeline(db, args) {
  const { positional, flags } = parseArgs(args);
  // Bare `--query` parses to boolean true and crashed downstream in sanitizeFtsQuery
  // (nlp.mjs string ops on a boolean). No sensible default for a search anchor — reject
  // cleanly (#8470). (`--project` bare is absorbed by resolveProject's non-string guard.)
  if (rejectBareStringFlags(flags, ['query'])) return;
  // parseInt('-5') === -5 is truthy, so `|| 5` doesn't rescue negative input.
  // Match cmdSearch's warn-then-default pattern for consistency across CLI flags.
  const parseWindow = (label, raw) => {
    if (raw === undefined) return 5;
    const n = parseInt(raw, 10);
    // isNumericToken first: "2abc"→2 / "1e2"→1 are non-negative integers the bare check
    // accepted silently; reject garbage tokens like the negative path already does.
    if (!isNumericToken(raw) || !Number.isInteger(n) || n < 0) {
      process.stderr.write(`[mem] Invalid --${label} "${raw}" (must be a non-negative integer); using default 5\n`);
      return 5;
    }
    return n;
  };
  const before = parseWindow('before', flags.before);
  const after = parseWindow('after', flags.after);
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const jsonOutput = flags.json === true || flags.json === 'true';

  const toRow = r => ({
    id: r.id,
    type: r.type,
    title: r.title || r.subtitle || null,
    created_at: r.created_at,
    created_at_epoch: r.created_at_epoch,
  });

  // Parse --anchor, accepting P#/S#/# prefix so callers can paste search-result IDs verbatim.
  // Resolution ladder (prompt/session → nearest obs, compressed re-anchor, bare-int
  // fallback) is shared with MCP mem_timeline via lib/timeline-core.mjs.
  let anchorId = null;
  let anchorNote = null; // hint line for output when anchor was resolved via conversion
  if (flags.anchor !== undefined && flags.anchor !== true) {
    const resolved = resolveAnchorToken(db, flags.anchor, { project });
    if (!resolved.ok) {
      fail(formatAnchorError(resolved.error, 'cli'));
      return;
    }
    anchorId = resolved.anchorId;
    anchorNote = resolved.anchorNote;
  }

  // Support query-based anchor: `timeline --query "search terms"` or positional.
  // Shared with MCP so AND→OR fallback semantics match `search` — without this,
  // queries like "ep-flush leak" miss rows whose title is "ep-flush ... leaked"
  // that search would otherwise find via OR relaxation.
  const queryStr = flags.query || positional.join(' ');
  if ((!anchorId || isNaN(anchorId)) && queryStr) {
    const found = resolveQueryAnchor(db, queryStr, { project: project ?? null });
    if (found) {
      anchorId = found.anchorId;
      if (found.anchorNote && !anchorNote) anchorNote = found.anchorNote;
    }
  }

  // No anchor: show most recent observations (shared fallback with MCP mem_timeline)
  if (!anchorId || isNaN(anchorId)) {
    if (queryStr) {
      process.stderr.write(`[mem] No anchor found for "${queryStr}", showing recent timeline\n`);
    }
    const rows = fetchRecentTimeline(db, { project, limit: before + after + 1 });

    if (jsonOutput) {
      out(JSON.stringify({
        anchor: null,
        anchor_note: queryStr ? `no anchor matched query "${queryStr}"` : null,
        before: [],
        after: [],
        fallback: 'recent',
        results: rows.map(toRow),
      }));
      return;
    }

    if (rows.length === 0) {
      out('[mem] No observations found.');
      return;
    }

    out(`[mem] Timeline (most recent ${rows.length}):`);
    for (const r of rows.reverse()) {
      const time = relativeTime(r.created_at_epoch);
      const title = truncate(r.title || r.subtitle || '(untitled)', 80);
      out(`${('#' + r.id).padEnd(6)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
    }
    return;
  }

  // Window fetch (access-count bump + project auto-scope) shared with MCP.
  const win = fetchTimelineWindow(db, anchorId, { before, after, project });
  if (!win) {
    fail(`[mem] Observation #${anchorId} not found`);
    return;
  }
  const { anchor, beforeRows, afterRows } = win;

  if (jsonOutput) {
    out(JSON.stringify({
      anchor: toRow(anchor),
      anchor_note: anchorNote,
      before: beforeRows.map(toRow),
      after: afterRows.map(toRow),
    }));
    return;
  }

  const all = [...beforeRows, anchor, ...afterRows];

  out(`[mem] Timeline around #${anchorId}${anchorNote ? ' ' + anchorNote : ''}:`);
  for (const r of all) {
    const marker = r.id === anchorId ? ' <--' : '';
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 80);
    out(`${('#' + r.id).padEnd(6)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}${marker}`);
  }
}

function cmdSave(db, args) {
  const { positional, flags } = parseArgs(args);
  const text = positional.join(' ');
  if (!text.trim()) {
    fail('[mem] Usage: claude-mem-lite save "<text>" [--type T] [--title T] [--importance N] [--project P] [--files f1,f2] [--lesson T] [--closes-deferred 1,D#42]');
    return;
  }

  // Reject value-less string flags before they reach .split()/saveObservation as a
  // boolean `true` (#8470): bare --files/--title/--lesson crashed with a raw stacktrace.
  if (rejectBareStringFlags(flags, ['title', 'files', 'lesson', 'lesson-learned', 'project', 'type'])) return;

  const type = flags.type || 'discovery';
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  if (!validTypes.has(type)) {
    fail(`[mem] Invalid type "${type}". Valid: ${[...validTypes].join(', ')}`);
    return;
  }

  // Explicit saves default to importance=2 (notable) — user chose to save
  const rawImp = flags.importance !== undefined ? parseInt(flags.importance, 10) : 2;
  // isNumericToken first: bare parseInt would coerce "2abc"→2 / "1e2"→1 and persist a
  // wrong importance that silently skews ranking/decay. Float literals still truncate (#8277).
  if (flags.importance !== undefined && (!isNumericToken(flags.importance) || isNaN(rawImp) || rawImp < 1 || rawImp > 3)) {
    fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
    return;
  }
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const saveFiles = flags.files ? flags.files.split(',').map(f => f.trim()).filter(Boolean) : [];

  // Optional lesson_learned — accepts --lesson or --lesson-learned (alias)
  // Mirrors MCP memSaveSchema.lesson_learned (≤500 chars) and cmdUpdate's flag handling.
  const rawLesson = flags.lesson !== undefined ? flags.lesson
    : flags['lesson-learned'] !== undefined ? flags['lesson-learned']
    : null;
  if (rawLesson !== null && typeof rawLesson === 'string' && rawLesson.length > 500) {
    fail(`[mem] --lesson too long (${rawLesson.length} chars, max 500).`);
    return;
  }

  // --closes-deferred parsing: accepts comma-separated mixed tokens
  // ("1,D#42,3") with bare integers treated as ordinals and "D#N" as raw ids.
  // We pre-parse tokens here (cheap, syntax-only) but defer resolveDeferredIds
  // INTO the transaction, AFTER the dedup check. Resolving outside the
  // transaction would throw on the duplicate-replay path: the previously-
  // closed deferred row is no longer 'open', so ordinal/id resolution would
  // crash even though the duplicate short-circuit makes closure a no-op.
  // Resolving inside the dedup-gated branch keeps "save the same content
  // twice" idempotent (mirrors server.mjs:934 dedup-skip-closure intent).
  let closesTokens = null;
  if (flags['closes-deferred'] !== undefined && flags['closes-deferred'] !== false) {
    const raw = String(flags['closes-deferred']);
    closesTokens = raw.split(',').map(t => t.trim()).filter(Boolean).map(t => {
      return /^\d+$/.test(t) ? parseInt(t, 10) : t;
    });
    if (closesTokens.length === 0) {
      fail('[mem] --closes-deferred requires at least one token (integer ordinal or D#N)');
      return;
    }
  }

  let result;
  let closesIds = null;
  try {
    result = db.transaction(() => {
      const r = saveObservation(db, {
        content: text,
        title: flags.title,
        type,
        importance: rawImp,
        project,
        files: saveFiles,
        lesson_learned: rawLesson,
      });
      // Skip closure on dedup short-circuit — the obs row already exists, so
      // the deferred item should NOT be re-closed by a duplicate save call.
      // Resolving deferred ids only on the non-duplicate path keeps repeated
      // save commands (with the same --closes-deferred) idempotent even after
      // the deferred row has transitioned out of 'open'.
      if (r.kind === 'duplicate') return r;
      if (closesTokens) {
        closesIds = resolveDeferredIds(db, project, closesTokens);
        closeDeferredItems(db, closesIds, r.id);
      }
      return r;
    })();
  } catch (e) {
    if (closesTokens) {
      fail(`[mem] save with --closes-deferred failed: ${e.message}`);
    } else {
      fail(`[mem] save failed: ${e.message}`);
    }
    return;
  }

  if (result.kind === 'duplicate') {
    out(`[mem] Skipped: similar to existing #${result.existingId}. Use "claude-mem-lite get ${result.existingId}" to review.`);
    return;
  }

  const lessonNote = result.lessonCaptured ? ' 💡lesson captured' : '';
  const closedNote = closesIds && closesIds.length > 0
    ? ` Closed: ${closesIds.map(i => `D#${i}`).join(', ')}.`
    : '';
  out(`[mem] Saved #${result.id} [${result.type}] "${truncate(result.title, 80)}" (project: ${result.project})${lessonNote}${closedNote}`);
}

// ─── cmdDefer (sub-dispatch: add | list | drop) ──────────────────────────────

function cmdDefer(db, args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'add':  cmdDeferAdd(db, rest); break;
    case 'list': cmdDeferList(db, rest); break;
    case 'drop': cmdDeferDrop(db, rest); break;
    default:
      fail('[mem] Usage: claude-mem-lite defer <add|list|drop> ...');
      fail('[mem]   defer add "<title>" [--priority 1|2|3] [--detail T] [--files f1,f2] [--project P]');
      fail('[mem]   defer list [--project P] [--limit N]');
      fail('[mem]   defer drop <id-or-D#N> --reason "<reason>" [--project P]');
  }
}

function cmdDeferAdd(db, args) {
  const { positional, flags } = parseArgs(args);
  const title = positional.join(' ').trim();
  if (!title) {
    fail('[mem] Usage: claude-mem-lite defer add "<title>" [--priority 1|2|3] [--detail T] [--files f1,f2] [--project P]');
    return;
  }
  // Mirror MCP memDeferSchema.title (z.string().min(1).max(200)). CLI used to
  // accept multi-line / 1000-char titles, then `defer list` would render them
  // as one wrapped row that pushed every other item off-screen.
  if (title.length > 200) {
    fail(`[mem] defer add: title too long (${title.length} chars, max 200). Move detail to --detail "<text>".`);
    return;
  }
  // Reject bare --files/--detail/--project before .split()/bind sees a boolean true (#8470).
  if (rejectBareStringFlags(flags, ['files', 'detail', 'project'])) return;
  const priority = flags.priority !== undefined ? parseInt(flags.priority, 10) : 2;
  // isNumericToken first: bare parseInt would coerce "3xyz"→3 and silently escalate a
  // deferred item's urgency. Float literals still truncate (#8277).
  if (flags.priority !== undefined && !isNumericToken(flags.priority)) {
    fail(`[mem] Invalid --priority "${flags.priority}". Must be 1 (low), 2 (normal), or 3 (urgent).`);
    return;
  }
  if (![1, 2, 3].includes(priority)) {
    fail(`[mem] Invalid --priority "${flags.priority}". Must be 1 (low), 2 (normal), or 3 (urgent).`);
    return;
  }
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const detail = typeof flags.detail === 'string' ? flags.detail : null;
  const files = flags.files
    ? flags.files.split(',').map(f => f.trim()).filter(Boolean)
    : null;

  let r;
  try {
    r = insertDeferred(db, { project, title, priority, detail, files });
  } catch (e) {
    fail(`[mem] defer add failed: ${e.message}`);
    return;
  }
  // Compute the freshly-inserted row's ordinal for an immediately-actionable
  // response ("ok, deferred this as item N"). Mirrors server.mjs:980.
  const open = listOpenWithOrdinal(db, project, 50);
  const ord = open.find(o => o.id === r.id)?.ordinal ?? '?';
  out(`[mem] Deferred as D#${r.id} (item ${ord}) in project "${project}".`);
}

function cmdDeferList(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 10, max: 100 });
  const list = listOpenWithOrdinal(db, project, limit);
  if (list.length === 0) {
    out(`[mem] No open deferred items in project "${project}".`);
    return;
  }
  out(`[mem] Open deferred items (project "${project}"):`);
  for (const r of list) {
    const pTag = r.priority === 3 ? '🔴' : r.priority === 1 ? '⚪' : '🟡';
    out(`  ${r.ordinal}. ${pTag} [P${r.priority}] ${r.title} (D#${r.id})`);
  }
}

function cmdDeferDrop(db, args) {
  const { positional, flags } = parseArgs(args);
  if (positional.length === 0) {
    fail('[mem] Usage: claude-mem-lite defer drop <id-or-D#N>[,id2,...] --reason "<reason>" [--project P]');
    return;
  }
  const reason = flags.reason;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    fail('[mem] defer drop requires --reason "<non-empty string>"');
    return;
  }
  // Accept either a single token or a comma-separated batch. `save --closes-deferred`
  // already accepts the batch form (cmdSave uses resolveDeferredIds on a split list);
  // drop now mirrors that ergonomic so users can prune multiple items in one call
  // without N shell invocations.
  const rawTokens = positional.join(' ').split(',').map(s => s.trim()).filter(Boolean);
  const tokens = rawTokens.map(t => /^\d+$/.test(t) ? parseInt(t, 10) : t);
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();

  let realIds;
  try {
    realIds = resolveDeferredIds(db, project, tokens);
  } catch (e) {
    fail(`[mem] defer drop: ${e.message}`);
    return;
  }
  const dropped = [];
  const noop = [];
  for (const realId of realIds) {
    const r = dropDeferred(db, realId, reason);
    if (r.changed === 0) noop.push(realId);
    else dropped.push(realId);
  }
  if (dropped.length > 0) {
    out(`[mem] Dropped ${dropped.map(id => `D#${id}`).join(', ')} in project "${project}". Reason: ${reason.trim()}`);
  }
  if (noop.length > 0) {
    out(`[mem] No-op (not in 'open' status): ${noop.map(id => `D#${id}`).join(', ')}`);
  }
}

// N-1: Quality-focused stats for R-2 A/B baseline.
//
// Shows the five numbers that will tell us whether the Haiku prompt change is
// working: lesson_learned rate, LOW_SIGNAL title rate, per-type hit% and lesson%,
// and current-vs-target deltas. Designed to be eyeballed once a day during the
// A/B rollout. All metrics respect --project and --days filters.
//
// Targets (aspirational, not enforced):
//   - Lesson rate ≥ 15%      (current baseline ~4.4%)
//   - LOW_SIGNAL rate ≤ 30%  (current baseline ~49.4%)
// Batch A CLI↔MCP alignment: CLI `stats --quality` and MCP `mem_stats({quality:true})`
// share the same computation + formatting via lib/stats-quality.mjs. This wrapper
// keeps the cmdStats call-site unchanged (stays sync-compatible) by delegating
// to a dynamic import + sync function chain inside an async caller.
async function renderQualityReport(db, { project, days }) {
  const { computeQualityStats, formatQualityReport } = await import('./lib/stats-quality.mjs');
  out(formatQualityReport(computeQualityStats(db, { project, days })));
}


async function cmdStats(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const days = parseIntFlag(flags.days, { name: '--days', defaultValue: 30, max: 3650 });
  const jsonOutput = flags.json === true || flags.json === 'true';
  // N-1: --quality routes to a separate quality-focused report (lesson rate,
  // LOW_SIGNAL rate, per-type hit+lesson %, R-2 watchdog targets). Intended as
  // the baseline metric dashboard for the future Haiku prompt A/B test.
  const quality = flags.quality === true || flags.quality === 'true';
  if (quality) {
    if (jsonOutput) {
      const { computeQualityStats } = await import('./lib/stats-quality.mjs');
      out(JSON.stringify(computeQualityStats(db, { project, days })));
      return;
    }
    await renderQualityReport(db, { project, days });
    return;
  }
  // v2.57.x B2: --retry shows the lesson_retry_stats aggregate. Answers
  // "is the bugfix/decision retry path (1 extra Haiku call per attempt)
  // paying off?". If recovered/attempts < 0.10 over a long window, the
  // path is dead weight and should be deleted.
  const retry = flags.retry === true || flags.retry === 'true';
  if (retry) {
    const { readRetryStats } = await import('./hook-llm.mjs');
    const rows = readRetryStats(db, days);
    const totalAttempts = rows.reduce((a, r) => a + r.attempts, 0);
    const totalRecovered = rows.reduce((a, r) => a + r.recovered, 0);
    const recoveryRate = totalAttempts > 0 ? totalRecovered / totalAttempts : 0;
    if (flags.json === true || flags.json === 'true') {
      out(JSON.stringify({
        days, total_attempts: totalAttempts, total_recovered: totalRecovered,
        recovery_rate: Number(recoveryRate.toFixed(4)),
        per_day: rows,
      }, null, 2));
      return;
    }
    out(`[mem] lesson-retry stats — last ${days}d (UTC date buckets)`);
    out(`  attempts:  ${totalAttempts}`);
    out(`  recovered: ${totalRecovered}`);
    out(`  rate:      ${(recoveryRate * 100).toFixed(1)}% ${totalAttempts === 0 ? '(no data — retry path may be unused this window)' : ''}`);
    if (totalAttempts >= 50 && recoveryRate < 0.10) {
      out('  ⚠ recovery rate <10% over ≥50 attempts — retry path likely dead weight, consider deleting');
    } else if (totalAttempts >= 50 && recoveryRate >= 0.30) {
      out('  ✓ recovery rate ≥30% — retry path actively saving lessons');
    }
    if (rows.length > 0) {
      out('\n  date         attempts  recovered  rate');
      for (const r of rows.slice(0, 14)) {
        const rate = r.attempts > 0 ? (r.recovered / r.attempts * 100).toFixed(1) + '%' : '—';
        out(`  ${r.date_bucket}  ${String(r.attempts).padStart(8)}  ${String(r.recovered).padStart(9)}  ${rate.padStart(5)}`);
      }
    }
    return;
  }

  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  const now = Date.now();
  const cutoff = now - days * 86400000;

  // Total counts (aligned with MCP mem_stats: use session_summaries, not sdk_sessions)
  const obsTotal = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE 1=1 ${projectFilter}`
  ).get(...baseParams);
  const sessTotal = db.prepare(
    `SELECT COUNT(*) as c FROM session_summaries WHERE 1=1 ${projectFilter}`
  ).get(...baseParams);
  const promptTotal = project
    ? db.prepare('SELECT COUNT(*) as c FROM user_prompts p JOIN sdk_sessions s ON p.content_session_id = s.content_session_id WHERE s.project = ?').get(project)
    : db.prepare('SELECT COUNT(*) as c FROM user_prompts').get();

  // Recent counts
  const obsRecent = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`
  ).get(cutoff, ...baseParams);
  const sessRecent = db.prepare(
    `SELECT COUNT(*) as c FROM session_summaries WHERE created_at_epoch >= ? ${projectFilter}`
  ).get(cutoff, ...baseParams);

  // Type distribution (recent)
  const types = db.prepare(`
    SELECT type, COUNT(*) as c FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
    GROUP BY type ORDER BY c DESC
  `).all(cutoff, ...baseParams);

  // Top projects (global view — skipped when filtering by single project; aligned with MCP)
  const projects = project ? [] : db.prepare(`
    SELECT project, COUNT(*) as c FROM observations
    GROUP BY project ORDER BY c DESC LIMIT 20
  `).all();

  // Daily activity (last 7 days; aligned with MCP mem_stats)
  const daily = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as c FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
    GROUP BY day ORDER BY day DESC LIMIT 7
  `).all(now - 7 * 86400000, ...baseParams);

  // Data health (aligned with MCP mem_stats)
  const tokenEst = db.prepare(`
    SELECT SUM(LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(narrative,'')) + LENGTH(COALESCE(text,''))) / 4 as t
    FROM observations WHERE 1=1 ${projectFilter}
  `).get(...baseParams);
  const avgImp = db.prepare(
    `SELECT AVG(COALESCE(importance,1)) as v FROM observations WHERE 1=1 ${projectFilter}`
  ).get(...baseParams);
  const thirtyDaysAgo = now - 30 * 86400000;
  const lowVal = db.prepare(`
    SELECT COUNT(*) as c FROM observations
    WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
      AND COALESCE(compressed_into, 0) = 0
      AND created_at_epoch < ? ${projectFilter}
  `).get(thirtyDaysAgo, ...baseParams);
  const noiseRatio = obsTotal.c > 0 ? lowVal.c / obsTotal.c : 0;
  const compressedCount = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE compressed_into IS NOT NULL ${projectFilter}`
  ).get(...baseParams);
  const supersededOnlyCount = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE superseded_at IS NOT NULL AND compressed_into IS NULL ${projectFilter}`
  ).get(...baseParams);

  // Hook self-observation: count PreToolUse / Skill-bridge script failures
  // recorded in the last 24h. Surfaces silent breakage (DB corruption,
  // CC upstream field rename) that would otherwise stay invisible — the
  // failure mode that left code-graph's matcher bug undetected for 10 sessions.
  const hookErrors24h = countRecentHookErrors(join(DB_DIR, 'runtime'), now - 86400000);

  // Tier distribution (aligned with MCP mem_stats)
  const tierCtx = { now, currentProject: project || inferProject(), currentSessionId: '' };
  const tdParams = tierSqlParams(tierCtx);
  const tierDist = db.prepare(`
    SELECT tier, COUNT(*) as c FROM (
      SELECT ${TIER_CASE_SQL} as tier FROM observations
      WHERE COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
    ) GROUP BY tier ORDER BY tier
  `).all(...tdParams, ...baseParams);
  const tierMap = Object.fromEntries(tierDist.map(r => [r.tier, r.c]));

  if (jsonOutput) {
    out(JSON.stringify({
      project,
      days,
      totals: {
        observations: obsTotal.c,
        sessions: sessTotal.c,
        prompts: promptTotal.c,
      },
      recent: {
        observations: obsRecent.c,
        sessions: sessRecent.c,
      },
      type_distribution: types.map(t => ({ type: t.type, count: t.c })),
      top_projects: projects.map(p => ({ project: p.project, count: p.c })),
      daily_activity: daily.map(d => ({ day: d.day, count: d.c })),
      data_health: {
        estimated_tokens: tokenEst.t ?? 0,
        avg_importance: Number((avgImp.v ?? 1).toFixed(2)),
        low_value_count: lowVal.c,
        noise_ratio: Number(noiseRatio.toFixed(4)),
        compressed: compressedCount.c,
        superseded_only: supersededOnlyCount.c,
        hook_errors_24h: hookErrors24h,
      },
      tier_distribution: {
        working: tierMap.working ?? 0,
        active: tierMap.active ?? 0,
        archive: tierMap.archive ?? 0,
      },
    }));
    return;
  }

  out(`[mem] Stats${project ? ` (${project})` : ''}:`);
  out(`Total: ${obsTotal.c.toLocaleString()} observations | ${sessTotal.c} sessions | ${promptTotal.c} prompts`);
  out(`Last ${days}d: ${obsRecent.c} observations | ${sessRecent.c} sessions`);
  out('');
  if (types.length) {
    out('Type distribution (recent):');
    for (const t of types) out(`  ${t.type}: ${t.c}`);
    out('');
  }
  if (projects.length) {
    out('Top projects:');
    for (const p of projects) out(`  ${p.project}: ${p.c}`);
    out('');
  }
  if (daily.length) {
    out('Daily activity (last 7d):');
    for (const d of daily) out(`  ${d.day}: ${d.c} observations`);
    out('');
  }
  out('Data Health:');
  out(`  Est. tokens: ${tokenEst.t ?? 0}`);
  out(`  Avg importance: ${(avgImp.v ?? 1).toFixed(2)}`);
  out(`  Low-value (imp=1, never accessed, >30d): ${lowVal.c} (${(noiseRatio * 100).toFixed(1)}% noise)`);
  out(`  Compressed: ${compressedCount.c}`);
  out(`  Hook errors (last 24h): ${hookErrors24h}${hookErrors24h > 0 ? `  ← tail ${join(DB_DIR, 'runtime/hook-errors')}` : ''}`);
  // Tier-1 firing counters for ① file-intel + ② reread-guard (recorded by
  // pre-tool-recall.js via lib/metrics.mjs; CLAUDE_MEM_METRICS=1 to enable).
  const featAgg = aggregateMetrics(DB_DIR, 7);
  const fiN = featAgg.file_intel?.count ?? 0;
  const rrN = featAgg.reread_warn?.count ?? 0;
  const metricsOn = process.env.CLAUDE_MEM_METRICS === '1';
  out(`  Feature injections (7d): 📄 file-intel ${fiN} · 🔁 reread-warn ${rrN}${(!metricsOn && fiN + rrN === 0) ? '  (set CLAUDE_MEM_METRICS=1 to record)' : ''}`);
  if (noiseRatio > 0.6) out('  ⚠️ High noise ratio — consider running mem compress');
  out('');
  // Tier counts only live (uncompressed, non-superseded) observations — surface the
  // full decomposition so live + compressed + superseded = Total adds up cleanly.
  const tierTotal = (tierMap.working ?? 0) + (tierMap.active ?? 0) + (tierMap.archive ?? 0);
  const supersededLabel = supersededOnlyCount.c > 0 ? ` + ${supersededOnlyCount.c} superseded` : '';
  out(`Tier distribution (live ${tierTotal}, excludes ${compressedCount.c} compressed${supersededLabel}):`);
  out(`  🔴 Working: ${tierMap.working ?? 0} | 🟡 Active: ${tierMap.active ?? 0} | 🔵 Archive: ${tierMap.archive ?? 0}`);
}

function cmdContext(db, args) {
  const { flags } = parseArgs(args);
  const jsonOutput = flags.json === true || flags.json === 'true' || flags.format === 'json';

  // Generate context live from DB — same builder the SessionStart hook uses.
  // Pre-v2.30 this command parsed a snapshot out of CLAUDE.md, but the hook no
  // longer writes there; DB is now the single source of truth.
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const block = buildSessionContextLines(db, project).trim();

  if (!block) {
    if (jsonOutput) { out(JSON.stringify({ raw: '', sections: {} })); }
    else { out(`[mem] No context yet for project "${project}"`); }
    return;
  }

  if (jsonOutput) {
    // Parse markdown sections into structured JSON
    const result = { raw: block, sections: {} };
    const sectionRegex = /^###?\s+(.+)$/gm;
    let match;
    const sectionStarts = [];
    while ((match = sectionRegex.exec(block)) !== null) {
      sectionStarts.push({ name: match[1].trim(), index: match.index, headerEnd: match.index + match[0].length });
    }
    for (let i = 0; i < sectionStarts.length; i++) {
      const start = sectionStarts[i].headerEnd;
      const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : block.length;
      const key = sectionStarts[i].name.replace(/\s+/g, '_').toLowerCase();
      result.sections[key] = block.slice(start, end).trim();
    }
    out(JSON.stringify(result, null, 2));
  } else {
    out(`<claude-mem-context>\n${block}\n</claude-mem-context>`);
  }
}

// ─── Browse (tier-grouped dashboard) ────────────────────────────────────────

function cmdBrowse(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const tierFilter = flags.tier || null;
  if (tierFilter && !['working', 'active', 'archive'].includes(tierFilter)) {
    fail(`[mem] Invalid tier: "${tierFilter}". Use: working, active, or archive`);
    return;
  }
  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: tierFilter ? 20 : 5, max: 1000 });
  const jsonOutput = flags.json === true || flags.json === 'true';
  const now = Date.now();

  const ctx = {
    now,
    currentProject: project,
    currentSessionId: getActiveSessionId(db, project),
  };
  const params = tierSqlParams(ctx);

  const tiers = ['working', 'active', 'archive'];
  const tierLabels = { working: '🔴 Working Memory', active: '🟡 Active Memory', archive: '🔵 Archive' };
  const showTiers = tierFilter ? [tierFilter] : tiers;

  // Collect data first (for JSON), then format. The text path also prints
  // tier headers as it walks; refactored to two passes so the JSON shape can
  // include row arrays alongside totals.
  const tierData = {};
  const tierCounts = {};
  let grandTotal = 0;

  for (const tier of showTiers) {
    const countRow = db.prepare(`
      SELECT COUNT(*) as c FROM (
        SELECT ${TIER_CASE_SQL} as tier FROM observations
        WHERE project = ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
      ) WHERE tier = ?
    `).get(...params, project, tier);
    const count = countRow?.c ?? 0;
    tierCounts[tier] = count;
    grandTotal += count;

    // Archive in unfiltered view: keep count but skip row fetch (matches text path).
    const skipRows = tier === 'archive' && !tierFilter;
    if (count === 0 || skipRows) {
      tierData[tier] = { count, rows: [] };
      continue;
    }

    const rows = db.prepare(`
      SELECT * FROM (
        SELECT id, type, title, importance, created_at_epoch, created_at, ${TIER_CASE_SQL} as tier
        FROM observations
        WHERE project = ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
      ) WHERE tier = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(...params, project, tier, limit);
    tierData[tier] = { count, rows };
  }

  if (jsonOutput) {
    const tiersOut = {};
    for (const tier of showTiers) {
      tiersOut[tier] = {
        count: tierData[tier].count,
        results: tierData[tier].rows.map(r => ({
          id: r.id,
          type: r.type,
          title: r.title || null,
          importance: r.importance ?? null,
          created_at: r.created_at,
          created_at_epoch: r.created_at_epoch,
        })),
      };
    }
    out(JSON.stringify({
      project,
      limit,
      tier_filter: tierFilter,
      totals: { ...tierCounts, grand_total: grandTotal },
      tiers: tiersOut,
    }));
    return;
  }

  out(`📊 Memory Dashboard (${project})\n`);

  for (const tier of showTiers) {
    const { count, rows } = tierData[tier];
    out(`${tierLabels[tier]} (${count})`);

    if (tier === 'archive' && !tierFilter) {
      if (count > 0) out('');
      continue;
    }

    if (count === 0) { out(''); continue; }

    for (const r of rows) {
      out(`  #${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${relativeTime(r.created_at_epoch)}`);
    }
    if (count > rows.length) out(`  ... and ${count - rows.length} more`);
    out('');
  }

  if (grandTotal === 0) {
    out('No observations found. Start a coding session to build memory.');
    return;
  }

  if (!tierFilter) {
    const parts = tiers.map(t => `${t[0].toUpperCase() + t.slice(1)}: ${tierCounts[t] ?? 0}`);
    out(`Totals: ${grandTotal} observations | ${parts.join(' | ')}`);
  }
}

function getActiveSessionId(db, project) {
  const row = db.prepare(
    "SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND status = 'active' ORDER BY started_at_epoch DESC LIMIT 1"
  ).get(project);
  return row?.memory_session_id ?? '';
}

// ─── Delete ──────────────────────────────────────────────────────────────────

function cmdDelete(db, args) {
  const { positional, flags } = parseArgs(args);
  const idStr = positional.join(',');
  if (!idStr) {
    fail('[mem] Usage: claude-mem-lite delete <id1,id2,...> [--confirm]');
    return;
  }

  // delete operates on observations only. Reject P#/S# explicitly so callers aren't
  // surprised by silent NaN filtering when they paste search-output IDs.
  const tokens = idStr.split(',').map(s => s.trim()).filter(Boolean);
  const nonObs = tokens.filter(t => /^[PpSs]#?\d+$/.test(t));
  if (nonObs.length > 0) {
    fail(`[mem] delete only works on observations. Rejected: ${nonObs.join(', ')}. ` +
         `Prompts and sessions are append-only — inspect with \`claude-mem-lite get P#N --source prompt\` / \`--source session\`.`);
    return;
  }
  const ids = tokens.map(t => {
    const p = parseIdToken(t);
    return p && p.source === null ? p.id : NaN;
  }).filter(n => !isNaN(n));
  if (ids.length === 0) {
    fail('[mem] No valid IDs provided');
    return;
  }

  const confirm = flags.confirm === true || flags.confirm === 'true';
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, type, title, project FROM observations WHERE id IN (${placeholders})`).all(...ids);

  if (rows.length === 0) {
    fail('[mem] No observations found for given IDs');
    return;
  }

  if (!confirm) {
    out(`[mem] Preview: ${rows.length} observation(s) will be deleted:`);
    for (const r of rows) {
      out(`  #${r.id} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${r.project}`);
    }
    out('[mem] Run with --confirm to execute deletion.');
    return;
  }

  // Transaction: clean up related_ids references + delete (aligned with MCP mem_delete)
  const deletedIds = new Set(ids);
  const deleteTx = db.transaction(() => {
    const likeConditions = ids.map(() => `related_ids LIKE ?`).join(' OR ');
    const likeParams = ids.map(id => `%${id}%`);
    const referencing = db.prepare(`
      SELECT id, related_ids FROM observations
      WHERE related_ids IS NOT NULL AND related_ids != '[]' AND (${likeConditions})
    `).all(...likeParams);
    for (const r of referencing) {
      let refIds;
      try { refIds = JSON.parse(r.related_ids); } catch { continue; }
      if (!Array.isArray(refIds)) continue;
      const filtered = refIds.filter(id => !deletedIds.has(id));
      if (filtered.length !== refIds.length) {
        db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(filtered), r.id);
      }
    }
    // Resurface any rows merged/compressed INTO the doomed keepers before deleting,
    // else they dangle behind a missing parent (compressed_into has no FK) — invisible
    // to every COALESCE(compressed_into,0)=0 view and unrecoverable. Same guard the
    // maintain hard-delete paths use (recoverChildrenOf); the interactive delete path
    // was missing it. Returned in the result so the user sees the recovery count.
    const recovered = recoverChildrenOf(db, ids);
    const deleted = db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);
    return { changes: deleted.changes, recovered };
  });
  const result = deleteTx();
  const missing = ids.filter(id => !rows.some(r => r.id === id));
  const recoveredNote = result.recovered > 0 ? ` Recovered ${result.recovered} merged/compressed child observation(s) to live.` : '';
  out(`[mem] Deleted ${result.changes} observation(s).${recoveredNote}${missing.length > 0 ? ` Note: ID(s) ${missing.join(', ')} not found.` : ''}`);
}

// ─── Update ──────────────────────────────────────────────────────────────────

function cmdUpdate(db, args) {
  const { positional, flags } = parseArgs(args);
  const raw = positional[0];
  if (raw && /^[PpSs]#?\d+$/.test(String(raw).trim())) {
    fail(`[mem] update only works on observations. Rejected: ${raw}. ` +
         `Prompts and sessions are append-only.`);
    return;
  }
  const parsed = raw ? parseIdToken(raw) : null;
  const id = parsed && parsed.source === null ? parsed.id : parseInt(raw, 10);
  if (!id || isNaN(id)) {
    fail('[mem] Usage: claude-mem-lite update <id> [--title T] [--type T] [--importance N] [--lesson T] [--narrative T] [--concepts T]');
    return;
  }

  const obs = db.prepare('SELECT id, title FROM observations WHERE id = ?').get(id);
  if (!obs) {
    fail(`[mem] Observation #${id} not found`);
    return;
  }

  // A value-less `--flag` parses to boolean `true` (cli/common.mjs parseArgs); for string
  // fields that would reach the SQLite bind as a raw "TypeError: SQLite3 can only bind ..."
  // (#8470). Reject cleanly via the shared guard — single source with the other commands.
  if (rejectBareStringFlags(flags, ['title', 'narrative', 'lesson', 'lesson-learned', 'concepts'])) return;

  const updates = [];
  const params = [];
  if (flags.title !== undefined) {
    // Reject empty title — clears the observation's identifier and would render it
    // as `(untitled)` in every listing. Almost always an accidental shell-stripped arg.
    if (typeof flags.title === 'string' && flags.title.trim() === '') {
      fail('[mem] --title cannot be empty. Pass a non-empty string or omit the flag to leave the title unchanged.');
      return;
    }
    updates.push('title = ?'); params.push(scrubSecrets(flags.title));
  }
  if (flags.narrative !== undefined) { updates.push('narrative = ?'); params.push(scrubSecrets(flags.narrative)); }
  if (flags.type) {
    const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
    if (!validTypes.has(flags.type)) {
      fail(`[mem] Invalid type "${flags.type}". Valid: ${[...validTypes].join(', ')}`);
      return;
    }
    updates.push('type = ?'); params.push(flags.type);
  }
  if (flags.importance) {
    const imp = parseInt(flags.importance, 10);
    // isNumericToken first: bare parseInt would coerce "2abc"→2 and UPDATE the row to a
    // wrong importance. Float literals still truncate (#8277).
    if (!isNumericToken(flags.importance) || isNaN(imp) || imp < 1 || imp > 3) {
      fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
      return;
    }
    updates.push('importance = ?'); params.push(imp);
  }
  if (flags.lesson !== undefined || flags['lesson-learned'] !== undefined) {
    const rawLesson = flags.lesson ?? flags['lesson-learned'] ?? '';
    // Mirror cmdSave's 500-char cap — pre-fix `update --lesson <501-char>` was silently
    // accepted, letting overlong lessons leak into the DB through the update path
    // even though save's path rejected them. MCP memSaveSchema also caps at 500.
    if (typeof rawLesson === 'string' && rawLesson.length > 500) {
      fail(`[mem] --lesson too long (${rawLesson.length} chars, max 500).`);
      return;
    }
    updates.push('lesson_learned = ?');
    params.push(scrubSecrets(rawLesson));
  }
  if (flags.concepts !== undefined) { updates.push('concepts = ?'); params.push(flags.concepts); }

  if (updates.length === 0) {
    fail('[mem] No fields to update. Use --title, --type, --importance, --lesson/--lesson-learned, --narrative, --concepts');
    return;
  }

  params.push(id);

  // Atomic: update fields + rebuild derived columns (FTS text + vector) via the
  // shared core — single source with MCP mem_update (lib/observation-write.mjs).
  db.transaction(() => {
    db.prepare(`UPDATE observations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    rebuildObservationDerived(db, id);
  })();

  out(`[mem] Updated #${id}: ${updates.map(u => u.split(' =')[0]).join(', ')}`);
}

// ─── Export ──────────────────────────────────────────────────────────────────

function cmdExport(db, args) {
  const { flags } = parseArgs(args);
  const wheres = [];
  const params = [];
  // --include-compressed: include compressed observations (aligned with MCP mem_export)
  if (!(flags['include-compressed'] === true || flags['include-compressed'] === 'true')) {
    wheres.push('COALESCE(compressed_into, 0) = 0');
  }
  wheres.push('superseded_at IS NULL');

  const project = flags.project ? resolveProject(db, flags.project) : null;
  if (project) { wheres.push('project = ?'); params.push(project); }
  if (flags.type) {
    // Reject unknown types — silently returning [] for `--type bogus` looked like a
    // legitimate empty filter result, hiding the typo. Mirrors cmdSearch / cmdSave / cmdUpdate.
    const validObsTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
    if (!validObsTypes.has(flags.type)) {
      fail(`[mem] Invalid --type "${flags.type}". Valid: ${[...validObsTypes].join(', ')}`);
      return;
    }
    wheres.push('type = ?'); params.push(flags.type);
  }
  let exportFromEpoch = null;
  let exportToEpoch = null;
  if (flags.from) {
    exportFromEpoch = new Date(flags.from).getTime();
    if (isNaN(exportFromEpoch)) { fail(`[mem] Invalid --from date: "${flags.from}". Use YYYY-MM-DD or ISO 8601.`); return; }
    wheres.push('created_at_epoch >= ?'); params.push(exportFromEpoch);
  }
  if (flags.to) {
    exportToEpoch = new Date(flags.to).getTime();
    if (isNaN(exportToEpoch)) { fail(`[mem] Invalid --to date: "${flags.to}". Use YYYY-MM-DD or ISO 8601.`); return; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(flags.to)) exportToEpoch += 86400000 - 1;
    wheres.push('created_at_epoch <= ?'); params.push(exportToEpoch);
  }
  if (exportFromEpoch !== null && exportToEpoch !== null && exportFromEpoch > exportToEpoch) {
    process.stderr.write(`[mem] Note: --from "${flags.from}" is after --to "${flags.to}"; this range is empty\n`);
  }

  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 200, max: 1000 });
  const format = flags.format || 'json';
  if (!['json', 'jsonl'].includes(format)) {
    fail(`[mem] Invalid format "${format}". Use: json or jsonl`);
    return;
  }

  // Full round-trippable column set so `restore` rebuilds observations faithfully —
  // content + value-signals (access/cited/uncited/injection/decay) + branch + timing.
  // `search_aliases` is an FTS5-indexed column (BM25 weight 5) — dropping it on
  // export silently lost the LLM-generated alternate query terms on restore, so a
  // restored memory became unfindable by its aliases. Additive vs the pre-v2.90
  // 13-col shape; existing `export | jq '.[].title'` consumers are unaffected.
  // id + memory_session_id are informational (restore remaps id and buckets under
  // a restore session).
  const rows = db.prepare(`
    SELECT id, memory_session_id, project, type, title, subtitle, narrative, concepts, facts,
           files_read, files_modified, lesson_learned, search_aliases, importance, branch,
           access_count, cited_count, uncited_streak, injection_count, decay_seen_count,
           last_accessed_at, created_at, created_at_epoch
    FROM observations WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(...params, limit);

  if (rows.length === 0) {
    // Empty result must respect the requested format so `export … | jq` works:
    //   json  → "[]" (valid empty array)
    //   jsonl → 0 lines (valid empty file)
    // The friendly note goes to stderr so it doesn't poison stdout for callers
    // piping to a parser.
    if (format === 'json') out('[]');
    process.stderr.write('[mem] No observations found matching criteria\n');
    return;
  }

  if (format === 'jsonl') {
    for (const r of rows) out(JSON.stringify(r));
  } else {
    out(JSON.stringify(rows, null, 2));
  }

  if (rows.length >= limit) {
    process.stderr.write(`[mem] Note: Results capped at ${limit}. Use --from/--to or --limit to export more.\n`);
  }
}

// ─── Restore ───────────────────────────────────────────────────────────────
// Inverse of `export` — the backup/restore half README:690 promises. Reuses
// lib/save-observation.mjs so FK / FTS / TF-IDF vector / minhash / files-junction
// stay consistent with cmdSave, then a targeted UPDATE re-applies the value-signals
// (access/cited/uncited/injection/decay), branch, and concepts/facts/files_read that
// saveObservation derives or zeros — so a restored backup keeps its citation-decay
// history and original timing (created_at via the `now` param). Source ids are
// discarded (local AUTOINCREMENT; export omits related_ids); session provenance
// collapses to saveObservation's manual-<project> bucket (documented MVP tradeoff).
function cmdRestore(db, argv) {
  const { positional, flags } = parseArgs(argv);
  const file = positional[0];
  if (!file) { fail('[mem] Usage: claude-mem-lite restore <file> [--project P] [--dry-run]'); return; }
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) { fail(`[mem] Cannot read "${file}": ${e.message}`); return; }
  const trimmed = raw.trim();
  if (!trimmed) { out('[mem] Empty file — nothing to restore.'); return; }
  let rows;
  try {
    rows = trimmed[0] === '['
      ? JSON.parse(trimmed)
      : trimmed.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch (e) { fail(`[mem] "${file}" is not valid export JSON/JSONL: ${e.message}`); return; }
  if (!Array.isArray(rows) || rows.length === 0) { out('[mem] No observations in file.'); return; }

  const projOverride = flags.project ? resolveProject(db, flags.project) : null;
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const num = (v) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0;

  const dupCheck = db.prepare('SELECT id FROM observations WHERE project = ? AND title = ? AND created_at_epoch = ? LIMIT 1');
  const signalUpdate = db.prepare(`UPDATE observations SET
      subtitle = ?, concepts = ?, facts = ?, search_aliases = ?, files_read = ?, branch = COALESCE(?, branch),
      access_count = ?, cited_count = ?, uncited_streak = ?, injection_count = ?,
      decay_seen_count = ?, last_accessed_at = ?
    WHERE id = ?`);

  let restored = 0, skipped = 0, malformed = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.type || !r.title) { malformed++; continue; }
    const project = projOverride || r.project || inferProject();
    const createdEpoch = Number.isFinite(Number(r.created_at_epoch)) ? Number(r.created_at_epoch) : Date.now();
    // Durable exact-dup guard — saveObservation's 5-min Jaccard window can't catch a
    // re-restore of an old-timestamped backup, so gate on project+title+created_at.
    if (dupCheck.get(project, r.title, createdEpoch)) { skipped++; continue; }
    if (dryRun) { restored++; continue; }
    try {
      let files = [];
      try { const fm = JSON.parse(r.files_modified || '[]'); if (Array.isArray(fm)) files = fm; } catch { /* leave [] */ }
      const imp = num(r.importance);
      const res = saveObservation(db, {
        content: r.narrative || r.title,
        title: r.title,
        type: r.type,
        importance: imp >= 1 && imp <= 3 ? imp : 1,
        project,
        files,
        lesson_learned: r.lesson_learned || null,
        now: new Date(createdEpoch),
      });
      if (res.kind !== 'saved') { skipped++; continue; } // saveObservation Jaccard dedup
      // Re-apply the fields saveObservation zeros/derives so the backup is faithful.
      // search_aliases is its own FTS5 column, so this UPDATE re-syncs the index
      // (via the observations FTS triggers) and restored aliases stay searchable.
      signalUpdate.run(
        r.subtitle || '', r.concepts || '', r.facts || '', r.search_aliases ?? null, r.files_read || '[]', r.branch ?? null,
        num(r.access_count), num(r.cited_count), num(r.uncited_streak), num(r.injection_count),
        num(r.decay_seen_count), r.last_accessed_at ?? null,
        res.id,
      );
      restored++;
    } catch (e) {
      malformed++;
      if (process.env.CLAUDE_MEM_DEBUG) process.stderr.write(`[mem] restore row failed: ${e.message}\n`);
    }
  }
  out(`[mem] Restore${dryRun ? ' (dry-run)' : ''}: ${restored} restored, ${skipped} duplicate(s) skipped, ${malformed} malformed/failed from ${rows.length} row(s).`);
}

// ─── Compress ────────────────────────────────────────────────────────────────

function cmdCompress(db, args) {
  const { flags } = parseArgs(args);
  const preview = flags.execute !== true && flags.execute !== 'true';
  // Reject malformed --age-days explicitly. The prior fallback (`|| 30`) silently used
  // the default whenever the value parsed as NaN or <1, so users typing `--age-days abc`
  // got the 30-day cutoff without knowing their input was discarded.
  let ageDays = 30;
  if (flags['age-days'] !== undefined) {
    const parsed = parseInt(flags['age-days'], 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail(`[mem] Invalid --age-days "${flags['age-days']}". Must be a positive integer.`);
      return;
    }
    ageDays = parsed;
  }
  const cutoff = Date.now() - ageDays * 86400000;
  const project = flags.project ? resolveProject(db, flags.project) : null;

  const candidates = selectCompressionCandidates(db, { cutoff, project });

  if (candidates.length === 0) {
    out('[mem] No candidates for compression.');
    return;
  }

  const compressableGroups = groupByProjectWeek(candidates);

  if (preview) {
    const totalCandidates = compressableGroups.reduce((s, [, obs]) => s + obs.length, 0);
    out(`[mem] Compression preview:`);
    out(`  Total candidates: ${candidates.length}`);
    out(`  Compressable groups (≥3 obs): ${compressableGroups.length}`);
    out(`  Observations to compress: ${totalCandidates}`);
    for (const [key, obs] of compressableGroups.slice(0, 20)) {
      const [proj, week] = key.split('::');
      const types = {};
      for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
      const typeStr = Object.entries(types).map(([t, c]) => `${c} ${t}`).join(', ');
      out(`  ${proj} ${week}: ${obs.length} obs (${typeStr})`);
    }
    out('[mem] Run with --execute to compress.');
    return;
  }

  // Execute compression — one transaction over all groups (the hook transacts per group).
  let totalCompressed = 0;
  db.transaction(() => {
    for (const [key, obs] of compressableGroups) {
      const [proj] = key.split('::');
      totalCompressed += compressGroup(db, proj, obs).compressed;
    }
  })();

  out(`[mem] Compressed ${totalCompressed} observations into ${compressableGroups.length} weekly summaries.`);
}

// ─── Maintain ────────────────────────────────────────────────────────────────

function cmdMaintain(db, args) {
  const { positional, flags } = parseArgs(args);
  const action = positional[0];
  if (!action || !['scan', 'execute'].includes(action)) {
    fail("[mem] Usage: claude-mem-lite maintain <scan|execute> [--ops cleanup,decay,boost,demote_pinned,dedup,purge_stale,rebuild_vectors,vacuum] [--project P] [--retain-days N] [--merge-ids keepId:removeId,...] — 'scan' previews, 'execute' applies.");
    return;
  }

  const project = flags.project ? resolveProject(db, flags.project) : null;
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  if (action === 'scan') {
    const staleAge = Date.now() - STALE_AGE_MS;
    const mctx = { projectFilter, baseParams, staleAge };
    const duplicates = findDuplicates(db, mctx);
    const stats = maintenanceStats(db, mctx);

    out(`[mem] Maintenance scan:`);
    out(`  Total active: ${stats.total}`);
    out(`  Near-duplicate pairs: ${duplicates.length}`);
    out(`  Stale (>30d, imp=1, no access): ${stats.stale}`);
    out(`  Broken (no title/narrative): ${stats.broken}`);
    out(`  Boostable (accessed>3, imp<3): ${stats.boostable}`);
    out(`  Pinned-but-uncited (inj>=${PINNED_INJ_THRESHOLD}, cited=0, imp>1): ${stats.pinned} — run: maintain execute --ops demote_pinned`);
    out(`  Pending purge: ${stats.pendingPurge} (compressed originals awaiting cleanup)`);
    if (duplicates.length > 0) {
      const autoMergeable = duplicates.filter(d => parseFloat(d.similarity) >= AUTO_MERGE_THRESHOLD);
      const manualReview = duplicates.filter(d => parseFloat(d.similarity) < AUTO_MERGE_THRESHOLD);

      if (autoMergeable.length > 0) {
        out(`  Auto-mergeable (similarity >= ${AUTO_MERGE_THRESHOLD}):`);
        for (const d of autoMergeable.slice(0, 15)) {
          const keep = (d.a.importance ?? 1) >= (d.b.importance ?? 1) ? d.a : d.b;
          const remove = keep === d.a ? d.b : d.a;
          out(`    [${keep.id}] "${truncate(keep.title, 40)}" <-> [${remove.id}] "${truncate(remove.title, 40)}" (${d.similarity})`);
        }
        const mergeIds = autoMergeable.map(d => {
          const keep = (d.a.importance ?? 1) >= (d.b.importance ?? 1) ? d.a : d.b;
          const remove = keep === d.a ? d.b : d.a;
          return `${keep.id}:${remove.id}`;
        });
        out(`  Ready-to-use: claude-mem-lite maintain execute --ops dedup --merge-ids ${mergeIds.join(',')}`);
      }

      if (manualReview.length > 0) {
        out('  Needs review:');
        for (const d of manualReview.slice(0, 15)) {
          out(`    [${d.a.id}] "${truncate(d.a.title, 40)}" <-> [${d.b.id}] "${truncate(d.b.title, 40)}" (${d.similarity})`);
        }
      }
    }
    return;
  }

  // Execute
  const VALID_OPS = ['cleanup', 'decay', 'boost', 'demote_pinned', 'dedup', 'purge_stale', 'rebuild_vectors', 'vacuum'];
  // Distinguish flag-absent (use default op set) from flag-present-but-empty
  // (`--ops ""`, e.g. an unset shell var). The latter previously coerced via `||`
  // to the destructive default cleanup,decay,boost and EXECUTED it; route it to the
  // VALID_OPS check below instead so it's rejected like `--ops " "` / `--ops "decay,"`.
  const opsStr = flags.ops === undefined ? 'cleanup,decay,boost' : String(flags.ops);
  const ops = opsStr.split(',').map(s => s.trim());
  const invalidOps = ops.filter(op => !VALID_OPS.includes(op));
  if (invalidOps.length > 0) {
    fail(`[mem] Unknown operation(s): ${invalidOps.join(', ')}. Valid: ${VALID_OPS.join(', ')}`);
    return;
  }
  const staleAge = Date.now() - STALE_AGE_MS;
  const mctx = { projectFilter, baseParams, staleAge, opCap: OP_CAP };
  const results = [];

  // T2-P1-B: surface the OP_CAP hit so users know to re-run, matching MCP mem_maintain.
  const capHint = (changes) => (changes >= OP_CAP ? ' (cap reached, re-run for more)' : '');

  db.transaction(() => {
    if (ops.includes('cleanup')) {
      const deleted = cleanupBroken(db, mctx);
      results.push(`Cleaned up ${deleted} broken observations${capHint(deleted)}`);
    }

    if (ops.includes('decay')) {
      // injection_count>0 protected (maintain-core; shared with MCP + hook auto-maintain).
      const { decayed, idleMarked } = decayAndMarkIdle(db, mctx);
      const decayCap = (decayed >= OP_CAP || idleMarked >= OP_CAP) ? ' (cap reached, re-run for more)' : '';
      results.push(`Decayed ${decayed} stale observations, marked ${idleMarked} idle as pending-purge${decayCap}`);
    }

    if (ops.includes('demote_pinned')) {
      // Repair the citation-decay blind spot: decay protects injection_count>0, so a
      // heavily-injected-but-uncited memory stays pinned at max importance forever.
      // demotePinned (maintain-core) drops it to 1 in one pass. Floor 1, not purge.
      const demoted = demotePinned(db, mctx);
      results.push(`Demoted ${demoted} pinned-but-uncited observations to importance 1 (inj>=${PINNED_INJ_THRESHOLD}, cited=0)${capHint(demoted)}`);
    }

    if (ops.includes('boost')) {
      const boosted = boostAccessed(db, mctx);
      results.push(`Boosted ${boosted} frequently-accessed observations${capHint(boosted)}`);
    }

    if (ops.includes('dedup') && flags['merge-ids']) {
      // Parse "keepId:removeId1:removeId2,keepId2:removeId3"; surface malformed segments
      // (non-numeric / single-element) instead of silently dropping them. The merge SQL
      // itself lives in maintain-core mergeDuplicates (shared with MCP).
      const invalidSegments = [];
      const groups = [];
      for (const seg of flags['merge-ids'].split(',').map(s => s.trim()).filter(Boolean)) {
        const parts = seg.split(':').map(s => s.trim());
        const nums = parts.map(p => Number(p));
        if (parts.length < 2 || nums.some(n => !Number.isFinite(n) || n <= 0)) { invalidSegments.push(seg); continue; }
        groups.push(nums);
      }
      const totalMerged = mergeDuplicates(db, groups);
      if (invalidSegments.length) {
        results.push(`Warning: ignored ${invalidSegments.length} malformed --merge-ids segment(s): ${invalidSegments.join(', ')} (expected keepId:removeId[:removeId...] with positive integers)`);
      }
      results.push(`Merged ${totalMerged} duplicate observations`);
    }

    // T2-P1-B parity with MCP: warn when merge-ids is provided but dedup wasn't requested.
    if (!ops.includes('dedup') && flags['merge-ids']) {
      results.push('Warning: --merge-ids provided but "dedup" not in operations — merge-ids ignored');
    }

    if (ops.includes('purge_stale')) {
      const retainDays = parseInt(flags['retain-days'], 10) || 30;
      const retainCutoff = Date.now() - retainDays * 86400000;
      // T2-P0-A (CLI parity): purge_stale is the only DELETE in this code path — require
      // --confirm so a mis-typed `maintain execute --ops purge_stale` can't wipe rows silently.
      const confirmed = flags.confirm === true || flags.confirm === 'true';
      if (!confirmed) {
        const previewRow = purgeStalePreview(db, mctx, retainCutoff);
        const pushLines = [`purge_stale preview (no --confirm):`,
          `  Candidates (pending-purge, older than ${retainDays}d): ${previewRow.candidates}`];
        if (previewRow.candidates > 0) {
          pushLines.push(`  Oldest: ${new Date(previewRow.oldest).toISOString().slice(0, 10)}`);
          pushLines.push(`  Newest: ${new Date(previewRow.newest).toISOString().slice(0, 10)}`);
        }
        pushLines.push(`  To delete, re-run with --confirm.`);
        results.push(pushLines.join('\n'));
      } else {
        const purged = purgeStale(db, mctx, retainCutoff);
        results.push(`Purged ${purged} stale observations (retained last ${retainDays} days)${capHint(purged)}`);
      }
    }
  })();

  // FTS optimize
  db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
  results.push('FTS5 index optimized');

  // rebuild_vectors: outside main transaction (maintain-core, shared with MCP).
  if (ops.includes('rebuild_vectors')) {
    try {
      const r = rebuildVectors(db);
      results.push(r.ok
        ? `Vectors: rebuilt vocabulary (${r.terms} terms), updated ${r.updated}/${r.total} vectors`
        : `Vectors: ${r.reason}`);
    } catch (e) {
      results.push(`Vectors: rebuild failed — ${e.message}`);
    }
  }

  // vacuum: reclaim freelist pages left by DELETEs. Whole-DB, outside any transaction.
  // maintain-core, shared with MCP. Reports freelist before/after as the §7 reclaim metric.
  if (ops.includes('vacuum')) {
    try {
      const v = vacuum(db);
      results.push(`VACUUM: reclaimed ~${v.reclaimedMB}MB (freelist ${v.freeBefore} → ${v.freeAfter} pages)`);
    } catch (e) {
      results.push(`VACUUM failed — ${e.message}`);
    }
  }

  out(`[mem] ${results.join('\n[mem] ')}`);
}

// cmdFtsCheck extracted to cli/fts-check.mjs (v2.41 split).
import { cmdFtsCheck } from './cli/fts-check.mjs';

// ─── Registry ─────────────────────────────────────────────────────────────────

function cmdRegistry(_memDb, args) {
  const { positional, flags } = parseArgs(args);
  const action = positional[0];
  if (!action || !['list', 'stats', 'search', 'import', 'remove', 'reindex'].includes(action)) {
    fail('[mem] Usage: claude-mem-lite registry <list|stats|search|import|remove|reindex> [--type skill|agent] [--query Q] [--name N] [--resource-type T]');
    return;
  }

  let rdb;
  try {
    rdb = ensureRegistryDb(REGISTRY_DB_PATH);
    rdb.pragma('busy_timeout = 3000');
  } catch (e) {
    out(`[mem] Registry DB not available: ${e.message}`);
    return;
  }

  // `--type` and `--resource-type` are both constrained to skill|agent across
  // registry sub-actions. Validating once here means search/list/import/remove
  // all reject typos like `--type sklil` instead of silently returning
  // "No resources found." (which looked like the registry was empty for that
  // type, not like a typo).
  if (flags.type !== undefined && flags.type !== 'skill' && flags.type !== 'agent') {
    fail(`[mem] Invalid --type "${flags.type}". Use: skill, agent`);
    return;
  }
  if (flags['resource-type'] !== undefined && flags['resource-type'] !== 'skill' && flags['resource-type'] !== 'agent') {
    fail(`[mem] Invalid --resource-type "${flags['resource-type']}". Use: skill, agent`);
    return;
  }

  try {
    if (action === 'search') {
      // Bare `--query` parses to boolean true; `true || ...` would search for the literal
      // string "true". Reject it cleanly (#8470) before it becomes a confusing no-match.
      if (rejectBareStringFlags(flags, ['query', 'category', 'quality'])) return;
      const query = flags.query || positional.slice(1).join(' ');
      if (!query) { fail('[mem] Usage: claude-mem-lite registry search <query> [--type skill|agent] [--category C] [--quality Q]'); return; }
      let results = searchResources(rdb, query, {
        type: flags.type || undefined,
        limit: (flags.category || flags.quality) ? 20 : 10,
      });
      // Apply category/quality post-filters (aligned with MCP mem_registry)
      if (flags.category) results = results.filter(r => r.category === flags.category);
      if (flags.quality) results = results.filter(r => r.quality_tier === flags.quality);
      // Prioritize directly invocable resources (aligned with MCP mem_registry)
      results.sort((a, b) => {
        const aInvocable = a.invocation_name ? 1 : 0;
        const bInvocable = b.invocation_name ? 1 : 0;
        if (aInvocable !== bInvocable) return bInvocable - aInvocable;
        return 0;
      });
      results = results.slice(0, 5);
      if (results.length === 0) { out(`[mem] No matching resources for: "${query}"`); return; }
      out(`[mem] ${results.length} resource(s) for "${query}":`);
      const home = homedir();
      for (const r of results) {
        const badge = r.quality_tier === 'installed' ? '[✓]' : r.quality_tier === 'verified' ? '[★]' : '[○]';
        const categoryLabel = r.category ? ` [${r.category}]` : '';
        const isManaged = r.local_path && r.local_path.includes(join(DB_DIR, 'managed') + sep);
        const portablePath = isManaged && r.local_path.startsWith(home) ? '~' + r.local_path.slice(home.length) : (r.local_path || '');
        let howToUse;
        if (isManaged) {
          const resolvedPath = portablePath.endsWith('.md') ? portablePath : `${portablePath}/SKILL.md`;
          howToUse = `Read("${resolvedPath}") or mem_use(name="${r.name}"${r.type === 'agent' ? ', type="agent"' : ''})`;
        } else if (r.invocation_name) {
          howToUse = r.type === 'skill'
            ? `Skill("${r.invocation_name}")`
            : `Agent(subagent_type="${r.invocation_name}")`;
        } else {
          howToUse = `mem_use(name="${r.name}"${r.type === 'agent' ? ', type="agent"' : ''})`;
        }
        const pathLine = portablePath ? `\n    Path: ${portablePath}` : '';
        out(`  ${badge} ${r.type === 'skill' ? 'S' : 'A'} ${r.name}${categoryLabel} — ${truncate(r.capability_summary || '', 80)}${pathLine}\n    Use: ${howToUse}`);
      }
      return;
    }

    if (action === 'list') {
      const typeFilter = flags.type;
      const listLimit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 20, max: 1000 });
      const where = typeFilter ? 'WHERE type = ? AND status = ?' : 'WHERE status = ?';
      const params = typeFilter ? [typeFilter, 'active'] : ['active'];
      const allResources = rdb.prepare(`
        SELECT name, type, invocation_name, recommend_count, adopt_count, capability_summary
        FROM resources ${where} ORDER BY adopt_count DESC, recommend_count DESC, type, name
      `).all(...params);
      if (allResources.length === 0) { out('[mem] No resources found.'); return; }
      const resources = allResources.slice(0, listLimit);
      out(`[mem] Resources (showing ${resources.length} of ${allResources.length}):`);
      for (const r of resources) {
        out(`  ${r.type === 'skill' ? 'S' : 'A'} ${r.name}${r.invocation_name ? ` (${r.invocation_name})` : ''} — rec:${r.recommend_count} adopt:${r.adopt_count} — ${truncate(r.capability_summary || '', 50)}`);
      }
      if (allResources.length > listLimit) {
        out(`[mem] Use --limit N to see more, or "registry search <query>" to find specific resources.`);
      }
      return;
    }

    if (action === 'stats') {
      const total = rdb.prepare('SELECT COUNT(*) as c FROM resources WHERE status = ?').get('active');
      const byType = rdb.prepare('SELECT type, COUNT(*) as c FROM resources WHERE status = ? GROUP BY type').all('active');
      const topAdopted = rdb.prepare(
        'SELECT name, type, adopt_count, recommend_count FROM resources WHERE status = ? AND adopt_count > 0 ORDER BY adopt_count DESC LIMIT 10'
      ).all('active');
      const zeroAdopt = rdb.prepare(
        'SELECT COUNT(*) as c FROM resources WHERE status = ? AND recommend_count > 0 AND adopt_count = 0'
      ).get('active');
      const userAdded = rdb.prepare(
        "SELECT COUNT(*) as c FROM resources WHERE status = ? AND source = 'user'"
      ).get('active');
      out(`[mem] Registry Stats:`);
      out(`  Total active: ${total.c}`);
      for (const t of byType) out(`  ${t.type}: ${t.c}`);
      out(`  User-added: ${userAdded.c}`);
      out(`  Zero adoption (recommended but never adopted): ${zeroAdopt.c}`);
      if (topAdopted.length > 0) {
        out('  Top adopted:');
        for (const r of topAdopted) out(`    ${r.name} (${r.type}): ${r.adopt_count}/${r.recommend_count}`);
      }
      return;
    }

    if (action === 'import') {
      // Bare value-less flags → boolean true → SQLite-bind crash in upsertResource (#8470).
      // Shared guard — single source with update/remove/the other commands.
      if (rejectBareStringFlags(flags, ['name', 'resource-type', 'invocation-name', 'source', 'repo-url', 'local-path', 'intent-tags', 'domain-tags', 'trigger-patterns', 'capability-summary', 'keywords', 'tech-stack', 'use-cases'])) return;
      const name = flags.name;
      const resourceType = flags['resource-type'];
      if (!name || !resourceType) { fail('[mem] Usage: claude-mem-lite registry import --name N --resource-type skill|agent [--invocation-name I] [--capability-summary S]'); return; }
      const fields = { name, type: resourceType, status: 'active', source: flags.source || 'user' };
      for (const f of ['repo-url', 'local-path', 'invocation-name', 'intent-tags', 'domain-tags', 'trigger-patterns', 'capability-summary', 'keywords', 'tech-stack', 'use-cases']) {
        const camel = f.replace(/-([a-z])/g, (_, c) => '_' + c);
        fields[camel] = flags[f] || '';
      }
      const id = upsertResource(rdb, fields);
      // User-imported resources get 'installed' quality tier (user explicitly chose to add them)
      if (id && !flags.source) {
        rdb.prepare("UPDATE resources SET quality_tier = 'installed' WHERE id = ?").run(id);
      }
      out(`[mem] Imported: ${resourceType}:${name} (id=${id})`);
      if (!flags['capability-summary'] && !flags['use-cases']) {
        out('[mem] Tip: Add --capability-summary or --use-cases so the resource appears in searches.');
      }
      return;
    }

    if (action === 'remove') {
      // Bare value-less --name / --resource-type → boolean true → SQLite-bind crash on
      // the DELETE below; shared guard, single source with import/update.
      if (rejectBareStringFlags(flags, ['name', 'resource-type'])) return;
      const name = flags.name;
      const resourceType = flags['resource-type'];
      if (!name || !resourceType) { fail('[mem] Usage: claude-mem-lite registry remove --name N --resource-type skill|agent'); return; }
      const result = rdb.prepare('DELETE FROM resources WHERE type = ? AND name = ?').run(resourceType, name);
      out(result.changes > 0
        ? `[mem] Removed: ${resourceType}:${name}`
        : `[mem] Not found: ${resourceType}:${name}`);
      return;
    }

    if (action === 'reindex') {
      rdb.exec("INSERT INTO resources_fts(resources_fts) VALUES('rebuild')");
      const count = rdb.prepare('SELECT COUNT(*) as c FROM resources WHERE status = ?').get('active');
      out(`[mem] FTS5 reindexed. ${count.c} active resources.`);
      return;
    }
  } finally {
    try { rdb.close(); } catch {}
  }
}

// ─── memdir-audit ────────────────────────────────────────────────────────────
// Body-structure audit for ~/.claude/projects/<encoded>/memory/feedback_*.md
// and project_*.md. CLI-only by design — running this every session would be
// noise; it's a one-shot governance pass. Exit code 0 = 100% compliant,
// 1 = at least one file is non-compliant (so it can gate CI if a project
// wants to enforce structure).

function _formatAuditResult(memdir, result) {
  const lines = [`[mem] memdir audit: ${memdir}`];
  const fmt = (label, list) =>
    list.length ? `${label} (${list.length}):\n  - ${list.join('\n  - ')}` : `${label} (0)`;
  lines.push(fmt('Compliant', result.compliant));
  lines.push(fmt('Missing **Why:**', result.missingWhy));
  lines.push(fmt('Missing **How to apply:**', result.missingHowToApply));
  lines.push(fmt('Missing both', result.missingBoth));
  lines.push(`Total: ${result.total} file(s) (${result.compliant.length} compliant)`);
  return lines.join('\n');
}

function _resolveMemdirsForAudit(flags) {
  if (typeof flags.memdir === 'string' && flags.memdir.length > 0) {
    return [flags.memdir];
  }
  if (flags.all === true || flags.all === 'true') {
    const projectsRoot = join(homedir(), '.claude', 'projects');
    if (!existsSync(projectsRoot)) return [];
    let entries;
    try { entries = readdirSync(projectsRoot); } catch { return []; }
    return entries
      .map(name => join(projectsRoot, name, 'memory'))
      .filter(p => existsSync(p))
      .sort();
  }
  return [memdirPath(process.cwd())];
}

function cmdMemdirAudit(args) {
  const { flags } = parseArgs(args);
  const memdirs = _resolveMemdirsForAudit(flags);
  if (memdirs.length === 0) {
    out('[mem] No memdirs to audit (use --memdir <path> or run inside a Claude Code project).');
    return;
  }
  let nonCompliant = 0;
  let totalScanned = 0;
  for (const md of memdirs) {
    const result = auditMemdir(md);
    out(_formatAuditResult(md, result));
    totalScanned += result.total;
    nonCompliant +=
      result.missingWhy.length + result.missingHowToApply.length + result.missingBoth.length;
    if (memdirs.length > 1) out('');
  }
  if (memdirs.length > 1) {
    out(`[mem] Scanned ${memdirs.length} memdir(s), ${totalScanned} memory file(s), ${nonCompliant} non-compliant.`);
  }
  if (nonCompliant > 0) process.exitCode = 1;
}

/**
 * `citation-stats` — visualize the citation-decay feedback loop:
 * per-project cite rate + active decay queue + recently promoted.
 * Read-only over observations.
 *
 * Flags:
 *   --json      machine-readable output
 *   --days N    project cite-rate window (default 7)
 */
function cmdCitationStats(db, args) {
  const { flags } = parseArgs(args);
  const json = flags.json === true || flags.json === 'true';
  const days = parseIntFlag(flags.days, { name: '--days', defaultValue: 7, max: 365 });

  const cutoff = Date.now() - days * 86400 * 1000;
  const perProject = db.prepare(`
    SELECT project,
           COALESCE(SUM(cited_count), 0) AS cited,
           COALESCE(SUM(decay_seen_count), 0) AS resolved,
           SUM(CASE WHEN uncited_streak >= 2 THEN 1 ELSE 0 END) AS at_risk
      FROM observations
     WHERE created_at_epoch >= ?
       AND COALESCE(compressed_into, 0) = 0
       AND superseded_at IS NULL
  GROUP BY project
  ORDER BY resolved DESC
  `).all(cutoff);

  const decayQueue = db.prepare(`
    SELECT id, project, type, title, importance, uncited_streak, cited_count
      FROM observations
     WHERE uncited_streak >= 2
       AND COALESCE(compressed_into, 0) = 0
       AND superseded_at IS NULL
  ORDER BY uncited_streak DESC, importance ASC
     LIMIT 20
  `).all();

  const promoted = db.prepare(`
    SELECT id, project, type, title, importance, cited_count
      FROM observations
     WHERE importance >= 3 AND cited_count >= 1
       AND COALESCE(compressed_into, 0) = 0
       AND superseded_at IS NULL
  ORDER BY cited_count DESC
     LIMIT 10
  `).all();

  const demoted = db.prepare(`
    SELECT id, project, type, title, importance, demoted_at
      FROM observations
     WHERE demoted_at IS NOT NULL
       AND demoted_at >= ?
       AND COALESCE(compressed_into, 0) = 0
       AND superseded_at IS NULL
  ORDER BY demoted_at DESC
     LIMIT 10
  `).all(cutoff);

  // v34.x: surface pre-v34 data pollution. applyCitationDecay bumps cited_count
  // and decay_seen_count atomically (same UPDATE statement), so the invariant
  // cited_count <= decay_seen_count holds for every resolution this codepath
  // performs. Yet a small set of obs violate it — these are pre-v34 rows
  // where a backfill seeded cited_count without populating decay_seen_count.
  // Without this note, those rows make per-project cite_pct >100% with no
  // explanation. Cite rate stays unbiased for obs created after this commit.
  const pollutedRows = db.prepare(`
    SELECT COUNT(*) AS n FROM observations
     WHERE cited_count > decay_seen_count
       AND COALESCE(compressed_into, 0) = 0
       AND superseded_at IS NULL
  `).get();
  const dataPollutionNote = pollutedRows.n > 0
    ? `${pollutedRows.n} obs have cited_count > decay_seen_count (pre-v34 backfill — invariant holds for new data).`
    : null;

  if (json) {
    out(JSON.stringify({ window_days: days, per_project: perProject, decay_queue: decayQueue, promoted, demoted, data_pollution_note: dataPollutionNote }, null, 2));
    return;
  }

  if (dataPollutionNote) out(`Note: ${dataPollutionNote}\n`);
  out(`Cite rate by project (last ${days}d, cited / decay-resolutions):`);
  for (const r of perProject) {
    const rate = r.resolved > 0 ? (r.cited * 100 / r.resolved).toFixed(1) + '%' : '—';
    out(`  ${r.project.padEnd(34)} ${String(rate).padStart(6)}   cited:${r.cited}/${r.resolved}   at_risk:${r.at_risk}`);
  }
  out('');
  out('Active decay queue (uncited_streak >= 2, next miss → demote):');
  if (decayQueue.length === 0) out('  (none)');
  for (const r of decayQueue) {
    out(`  #${r.id} [${r.type}] ${(r.title || '').slice(0, 60)}   imp=${r.importance} streak=${r.uncited_streak}`);
  }
  out('');
  out('Recently promoted (importance=3, cited_count >= 1):');
  if (promoted.length === 0) out('  (none)');
  for (const r of promoted) {
    out(`  #${r.id} [${r.type}] ${(r.title || '').slice(0, 60)}   cited ${r.cited_count}x`);
  }
  out('');
  out(`Recently demoted (last ${days}d, importance ↓):`);
  if (demoted.length === 0) out('  (none)');
  for (const r of demoted) {
    const ago = Math.round((Date.now() - r.demoted_at) / 86400000);
    out(`  #${r.id} [${r.type}] ${(r.title || '').slice(0, 60)}   imp=${r.importance}   ${ago}d ago`);
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────

function cmdHelp() {
  out(`claude-mem-lite CLI

Commands:
  search <query>        FTS5 search across observations, sessions, and prompts
    --source S          Table: observations|sessions|prompts (default: all)
    --type T            Filter obs type (bugfix|decision|discovery|feature|refactor|change)
    --limit N           Max results (default 20)
    --project P         Filter by project
    --from DATE         Start date (YYYY-MM-DD or ISO 8601)
    --to DATE           End date (YYYY-MM-DD or ISO 8601)
    --importance N      Minimum importance (1=routine, 2=notable, 3=critical)
    --branch B          Filter by git branch
    --offset N          Skip first N results (pagination)
    --tier T            Filter by tier (working|active|archive, observations only)
    --sort S            Sort: relevance (default), time, importance
    --or                Use OR instead of AND between search terms
    --include-noise     Include hook-llm fallback titles ("Modified X", raw error logs)
    --json              Output as JSON: {query,total,returned,offset,limit,results:[…]}

  recent [N]            Show N most recent observations (default 10)
    --limit N           Sibling-parity alias for [N] (max 1000)
    --project P         Filter by project
    --type T            Filter obs type (bugfix|decision|discovery|feature|refactor|change)
    --json              Output as JSON: {project,limit,type,total,results:[…]}

  recall <file>         Show observations related to a file
    --limit N           Max results (default 10)
    --include-noise     Include hook-llm fallback titles ("Modified X", raw error logs)
    --json              Output as JSON: {file,limit,include_noise,total,results:[…]}

  get <id1,id2,...>     Get full details by ID
    IDs accept search-output prefixes: #123 (obs), P#123 (prompt), S#123 (session).
    Bare N defaults to obs. Mixed prefixes in one call route each token correctly.
    --source S          Force record type (obs|session|prompt); overrides prefixes.
    --fields f1,f2,...  Select specific fields to return (observations only).

  timeline              Show observations around an anchor (shows recent if no anchor)
    --anchor ID         Center on this ID. Accepts N, #N, P#N, or S#N — P#/S# anchors
                        resolve to the nearest-in-time observation in the same project.
    --query "text"      Find anchor by FTS5 search. Ranks by BM25 × time-decay,
                        so multi-term queries surface the BEST topical match
                        (highest term coverage), not the most recent. For
                        "recent activity around X", use 'recent' or
                        'search "X" --sort time' instead.
    --before N          Show N before anchor (default 5)
    --after N           Show N after anchor (default 5)
    --project P         Filter by project
    --json              Output as JSON: {anchor,anchor_note,before:[…],after:[…]}
                        (or {anchor:null,fallback:"recent",results:[…]} when no anchor)

  save "<text>"         Save a new observation
    --type T            Observation type (default: discovery)
    --title T           Title (auto-generated if omitted)
    --importance N      1=routine, 2=notable, 3=critical (default: 2)
    --project P         Project name
    --files f1,f2       Comma-separated file paths
    --lesson T          Lesson learned (≤500 chars; alias: --lesson-learned)
    --closes-deferred 1,D#42  Close deferred items in same transaction

  defer <action>        First-class deferred work (v2.70+)
    add "<title>"       Mark deferred work for next session (≤200 chars)
      --priority N      1=low, 2=normal, 3=urgent (default: 2)
      --detail T        Constraint + why deferred
      --files f1,f2     Comma-separated file paths
      --project P       Project name
    list                List open deferred items
      --limit N         Max results (default 10)
      --project P       Filter by project
    drop <D#N|ordinal>[,...]  Drop one or more deferred items (no fix needed)
      --reason "..."    Required audit trail

  delete <id1,id2,...>  Delete observations by ID
    --confirm           Execute deletion (preview by default)

  update <id>           Update an existing observation
    --title T           New title
    --type T            New type
    --importance N      New importance (1=routine, 2=notable, 3=critical)
    --lesson T          Add/update lesson learned (alias: --lesson-learned)
    --narrative T       New narrative
    --concepts T        Space-separated concept tags

  export                Export observations as JSON/JSONL
  restore <file>        Restore observations from an export file (JSON/JSONL); --dry-run to preview
    --project P         Filter by project
    --type T            Filter by type
    --format F          json (default) or jsonl
    --from DATE         Start date
    --to DATE           End date
    --include-compressed  Include compressed observations
    --limit N           Max results (default 200, max 1000)

  compress              Compress old low-value observations
    --execute           Execute compression (preview by default)
    --age-days N        Min age in days (default 30)
    --project P         Filter by project

  maintain <scan|execute>  Memory maintenance
    --ops O             Comma-separated: cleanup,decay,boost,demote_pinned,dedup,purge_stale,rebuild_vectors,vacuum
    --merge-ids K:R,... For dedup: keepId:removeId pairs (e.g. 10:11,20:21:22)
    --project P         Filter by project
    --retain-days N     For purge_stale: keep last N days (default 30)
                        demote_pinned: importance→1 for inj>=8 & cited=0 (clears pinned noise)
                        vacuum: reclaim freelist dead space (whole-DB, ignores --project)

  optimize              LLM-powered memory optimization (preview by default)
    --run               Execute (default: preview gates)
    --run-all           Execute bypassing gates
    --task T            Comma-separated: re-enrich,normalize,cluster-merge,smart-compress
    --max N             Max items per task (1-100, default 15)
    --scope S           re-enrich scope: narrow (default) or wide
    --project P         Limit to a single project (.|current = inferProject())
    --verbose / -v      Preview also dumps cluster contents + re-enrich samples

  doctor                Environment diagnostics and benchmarks
    --benchmark         Run perf benchmark and emit JSON

  fts-check <check|rebuild>  FTS5 index check or rebuild

  stats                 Show memory statistics
    --project P         Filter by project
    --days N            Lookback window (default 30)
    --quality           Quality dashboard: lesson rate, LOW_SIGNAL rate, per-type
                        hit/lesson %, top-accessed lessons, R-2 watchdog targets
    --json              Output as JSON: nested by section
                        ({totals,recent,type_distribution,top_projects,
                          daily_activity,data_health,tier_distribution})
                        or quality shape when --quality --json combined

  context               Show current CLAUDE.md context block
    --json              Output as structured JSON

  browse                Tier-grouped memory dashboard
    --tier T            Filter: working|active|archive
    --project P         Filter by project
    --limit N           Max entries per tier (default 5)
    --json              Output as JSON: {project,limit,tier_filter,
                          totals:{working,active,archive,grand_total},
                          tiers:{working:{count,results:[…]}, …}}

  citation-stats        Citation-decay feedback loop telemetry
    --days N            Cite-rate window in days (default 7)
    --json              Output as JSON: {window_days,per_project:[],decay_queue:[],promoted:[]}

  registry <action>     Manage tool resource registry
    list                List resources [--type skill|agent] [--limit N] (default 20)
    stats               Registry statistics
    search <query>      Search resources [--type skill|agent] [--category C] [--quality Q]
    import              Import resource --name N --resource-type T [--repo-url U] [--local-path P] [--use-cases U]
    remove              Remove resource --name N --resource-type T
    reindex             Rebuild FTS5 index

  import-jsonl <file-or-dir>      Import Claude Code JSONL transcripts (cold-start backfill)
    --project P         Project name (default: inferred from cwd)

  import <github-url>   Import skills/agents into the resource registry from a GitHub repo
    --enrich            Auto-enrich each imported resource with a Haiku capability summary

  enrich <name>         Re-enrich a single registry resource (Haiku capability summary)
    --all               Enrich every active resource missing or failed enrichment
    --batch             Skip the inter-call delay (use only with low rate-limit risk)

  activity <action>     Non-memdir event log (v2.31) — bugfix/lesson/bug/discovery/etc.
    save --type T "<title>" [--body "<text>"] [--files f1,f2] [--file path] [--importance 1-3] [--project P]
    search "<query>"    Search events [--type T] [--limit N] [--project P]
    recent [N]          Most recent events [--type T] [--project P]
    show <id>           Show full event row by id
    delete <id1,id2,…>  Delete events by ID (preview by default; use --confirm to execute)

    Valid types: bugfix, lesson, bug, discovery, refactor, feature, observation, decision
    --files (plural, comma-split) preferred; --file (singular) kept for back-compat.
    Use /lesson or /bug slash commands for faster capture (T8).

  adopt                 Inject claude-mem-lite sentinel line into this project's
                        ~/.claude/projects/<encoded>/memory/MEMORY.md so Claude Code
                        auto-loads it as user-memory (higher instruction authority).
    --all               Adopt every project under ~/.claude/projects/*/memory/
    --force             Overwrite a sentinel block that was manually edited
    --dry-run           Print intended writes without touching disk
    --status            List adopted projects + version

  unadopt               Precise removal of the sentinel block + plugin_claude_mem_lite.md.
    --all               Unadopt every project
    --status            Read-only: list adopted projects (same as adopt --status)
    --dry-run           Preview what would be removed; no filesystem writes

  memdir-audit          Audit memdir feedback_*.md / project_*.md for the
                        body-structure contract (**Why:** + **How to apply:**).
                        Exit 0 if every file is compliant, 1 otherwise.
    --memdir <path>     Audit an explicit memdir path (escape hatch)
    --all               Audit every project under ~/.claude/projects/*/memory/

DB: ${DB_PATH}`);
}

// ─── Import (GitHub) ────────────────────────────────────────────────────────

async function cmdImport(argv) {
  const { positional, flags } = parseArgs(argv);
  const url = positional[0];

  if (!url) { fail('[mem] Usage: claude-mem-lite import <github-url> [--enrich]'); return; }

  let rdb;
  try {
    rdb = ensureRegistryDb(REGISTRY_DB_PATH);
    rdb.pragma('busy_timeout = 3000');
  } catch (e) {
    fail(`[mem] Registry DB error: ${e.message}`);
    return;
  }

  try {
    const { importFromGitHub } = await import('./registry-importer.mjs');
    out(`[mem] Importing from ${url}...`);
    const results = await importFromGitHub(rdb, url);

    if (results.length === 0) {
      out('[mem] No skills/agents found in this repository.');
      return;
    }

    out(`[mem] Imported ${results.length} resource(s):`);
    for (const r of results) {
      out(`  ${r.type === 'skill' ? 'S' : 'A'} ${r.name} (id=${r.id})`);
    }

    if (flags.enrich) {
      out('[mem] Running LLM enrichment...');
      const { enrichResource } = await import('./registry-enricher.mjs');
      let enriched = 0;
      for (const r of results) {
        const row = rdb.prepare('SELECT local_path FROM resources WHERE id = ?').get(r.id);
        if (!row?.local_path) continue;
        try {
          const content = readFileSync(row.local_path, 'utf8');
          const ok = await enrichResource(rdb, r.name, r.type, content);
          if (ok) enriched++;
        } catch {}
      }
      out(`[mem] Enriched ${enriched}/${results.length} resources.`);
    }
  } catch (e) {
    fail(`[mem] Import failed: ${e.message}`);
  } finally {
    try { rdb.close(); } catch {}
  }
}

// ─── Import (Claude Code JSONL transcript — cold-start backfill) ─────────────

async function cmdImportJsonl(db, argv) {
  const { positional, flags } = parseArgs(argv);
  const target = positional[0];
  if (!target) {
    fail('[mem] Usage: claude-mem-lite import-jsonl <file-or-dir> [--project <name>]');
    return;
  }

  const project = flags.project || inferProject();
  const fs = await import('fs');
  const { join: pjoin, resolve } = await import('path');
  const abs = resolve(target);

  let files = [];
  let st;
  try { st = fs.statSync(abs); }
  catch (e) { fail(`[mem] Cannot stat ${abs}: ${e.message}`); return; }

  if (st.isDirectory()) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = pjoin(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && p.endsWith('.jsonl')) files.push(p);
      }
    };
    walk(abs);
  } else {
    files = [abs];
  }

  if (files.length === 0) { out('[mem] No .jsonl files found.'); return; }

  const { importJsonl } = await import('./lib/import-jsonl.mjs');
  let totalPrompts = 0, totalObs = 0, totalSkip = 0, totalOrphans = 0, errorCount = 0;
  for (const f of files) {
    // Per-file isolation: one unreadable file (EACCES, EBUSY, mid-batch IO error)
    // shouldn't crash the whole import — readFileSync inside importJsonl would
    // otherwise throw an unhandled exception with a node stack trace, leaving
    // earlier successes uncommitted-looking from the user's perspective.
    let r;
    try {
      r = await importJsonl(db, f, { project });
    } catch (e) {
      errorCount++;
      // e.message for node fs errors already begins with the code (e.g. "EACCES: permission denied, ...");
      // don't double-prefix.
      process.stderr.write(`[mem] ${f}: import failed — ${e.message}\n`);
      continue;
    }
    totalPrompts += r.prompts;
    totalObs += r.observations;
    totalSkip += r.skipped;
    totalOrphans += r.orphans || 0;
    out(`[mem] ${f}: +${r.prompts} prompts, +${r.observations} observations, ${r.orphans || 0} orphan tool_use, ${r.skipped} skipped`);
  }
  const errorTail = errorCount > 0 ? `, ${errorCount} file(s) errored` : '';
  out(`[mem] Total: ${totalPrompts} prompts, ${totalObs} observations, ${totalOrphans} orphan tool_use, ${totalSkip} skipped from ${files.length} file(s)${errorTail}.`);
  if (totalPrompts > 0 || totalObs > 0) {
    out(`[mem] Try: claude-mem-lite recent 5 --project ${project}`);
  } else if (totalSkip > 0 && errorCount === 0) {
    // Nothing imported but every line was skipped — almost always the wrong file
    // format (import-jsonl ingests Claude Code transcript JSONL, not `export` output,
    // which is observation-shaped). Pre-fix this exited 0 with no signal, so pointing
    // it at the wrong file looked like success. Make the no-op explicit (stdout, like
    // the summary lines above).
    out(`[mem] Warning: 0 imported, ${totalSkip} line(s) skipped — none matched the expected Claude Code transcript JSONL shape (user/assistant/tool_result). 'export' output is NOT re-importable via import-jsonl.`);
  }
}

// ─── Enrich ─────────────────────────────────────────────────────────────────

async function cmdEnrich(argv) {
  const { positional, flags } = parseArgs(argv);
  const name = positional[0];

  let rdb;
  try {
    rdb = ensureRegistryDb(REGISTRY_DB_PATH);
    rdb.pragma('busy_timeout = 3000');
  } catch (e) {
    fail(`[mem] Registry DB error: ${e.message}`);
    return;
  }

  try {
    const { enrichResource } = await import('./registry-enricher.mjs');

    if (flags.all) {
      const rows = rdb.prepare("SELECT name, type, local_path FROM resources WHERE status = 'active' AND (enrichment_status IS NULL OR enrichment_status = 'failed')").all();
      if (rows.length === 0) { out('[mem] All resources already enriched.'); return; }
      out(`[mem] Enriching ${rows.length} resources...`);
      let ok = 0, failCount = 0;
      for (const r of rows) {
        if (!r.local_path) { failCount++; continue; }
        try {
          const content = readFileSync(r.local_path, 'utf8');
          const success = await enrichResource(rdb, r.name, r.type, content);
          if (success) ok++; else failCount++;
          if (!flags.batch) await new Promise(resolve => setTimeout(resolve, 500));
        } catch { failCount++; }
      }
      out(`[mem] Done: ${ok} enriched, ${failCount} failed.`);
    } else if (name) {
      const row = rdb.prepare("SELECT name, type, local_path FROM resources WHERE name = ? AND status = 'active'").get(name);
      if (!row) { fail(`[mem] Resource not found: ${name}`); return; }
      if (!row.local_path) { fail(`[mem] No local_path for ${name}`); return; }
      const content = readFileSync(row.local_path, 'utf8');
      const success = await enrichResource(rdb, row.name, row.type, content);
      out(success ? `[mem] Enriched: ${name}` : `[mem] Enrichment failed for ${name}`);
    } else {
      fail('[mem] Usage: claude-mem-lite enrich <name> OR claude-mem-lite enrich --all [--batch]');
    }
  } catch (e) {
    fail(`[mem] Enrich error: ${e.message}`);
  } finally {
    try { rdb.close(); } catch {}
  }
}

async function cmdOptimize(db, args) {
  const run = args.includes('--run');
  const runAll = args.includes('--run-all');
  const verbose = args.includes('--verbose') || args.includes('-v');
  // T2-P1-D: --task accepts a single task or a comma-separated list, parity with MCP memOptimizeSchema.tasks.
  const VALID_TASKS = ['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'];
  const taskIdx = args.indexOf('--task');
  let tasks;
  if (taskIdx >= 0 && args[taskIdx + 1]) {
    const parsed = args[taskIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
    const invalid = parsed.filter(t => !VALID_TASKS.includes(t));
    if (invalid.length > 0) {
      fail(`[mem] Unknown task(s): ${invalid.join(', ')}. Valid: ${VALID_TASKS.join(', ')}`);
      return;
    }
    tasks = parsed;
  }
  // T2-P1-C: reject --max 0 / --max <non-positive> / --max <non-number> explicitly — the old
  // `|| 15` fallback silently turned these into the default (15), burning LLM tokens.
  const maxIdx = args.indexOf('--max');
  let maxItems = 15;
  if (maxIdx >= 0) {
    const raw = args[maxIdx + 1];
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      fail(`[mem] Invalid --max "${raw}". Must be an integer between 1 and 100.`);
      return;
    }
    maxItems = parsed;
  }
  // R-7 micro: --scope wide targets bugfix/refactor/feature/decision with narrative but no
  // lesson_learned (the "Haiku judged 'none'" cases). Default 'narrow' preserves old behavior.
  // Validate explicitly so `--scope wlde` (typo) doesn't silently become narrow and waste an LLM run.
  const scopeIdx = args.indexOf('--scope');
  let reenrichScope = 'narrow';
  if (scopeIdx >= 0 && args[scopeIdx + 1] !== undefined) {
    const raw = args[scopeIdx + 1];
    if (raw !== 'narrow' && raw !== 'wide') {
      fail(`[mem] Invalid --scope "${raw}". Use: narrow, wide`);
      return;
    }
    reenrichScope = raw;
  }
  // --project <name> filters all 4 tasks to one project. Opt-in; absence
  // preserves prior cross-project default. `.` or `current` auto-resolve via
  // inferProject() so users don't need to remember the exact name.
  const projectIdx = args.indexOf('--project');
  let project;
  if (projectIdx >= 0 && args[projectIdx + 1]) {
    const raw = args[projectIdx + 1];
    project = (raw === '.' || raw === 'current') ? inferProject() : raw;
  }

  if (!run && !runAll) {
    const preview = optimizePreview(db, { project, detail: verbose });
    out('[mem] 🔍 LLM Optimization Preview:');
    if (project) out(`  Project filter: ${project}`);
    out(`  Re-enrich candidates: ${preview.reenrich}${preview.reenrichWide !== undefined && preview.reenrichWide !== null ? `  (wide scope: ${preview.reenrichWide})` : ''}`);
    out(`  Normalize: ${preview.normalizeGateOpen ? `${preview.normalize} unique concepts` : 'gate closed (7-day interval)'}`);
    out(`  Cluster-merge: ${preview.clusterMerge} clusters`);
    out(`  Smart-compress: ${preview.smartCompress} clusters`);
    out(`  Total: ${preview.total} items`);
    if (verbose) {
      out('');
      if (preview.mergeClusters && preview.mergeClusters.length > 0) {
        out('─── Cluster-merge details ───');
        for (const [i, cluster] of preview.mergeClusters.entries()) {
          out(`  Cluster ${i + 1} (${cluster.length} obs, project=${cluster[0]?.project || '?'}):`);
          for (const obs of cluster) out(`    #${obs.id} [${obs.type || 'change'}] ${truncate(obs.title || '(untitled)', 100)}`);
        }
      }
      if (preview.reenrichSamples && preview.reenrichSamples.length > 0) {
        out('─── Re-enrich sample (first 20) ───');
        for (const obs of preview.reenrichSamples) {
          out(`  #${obs.id} [${obs.type || 'change'}] (project=${obs.project || '?'}) ${truncate(obs.title || '(untitled)', 100)}`);
        }
      }
      if (preview.compressSamples && preview.compressSamples.length > 0) {
        out('─── Smart-compress sample (first 5 clusters) ───');
        for (const [i, cluster] of preview.compressSamples.entries()) {
          out(`  Cluster ${i + 1} (${cluster.observations?.length || 0} obs, project=${cluster.project || '?'})`);
        }
      }
    }
    out('');
    out('Run with --run to execute, --run-all to bypass gates.');
    out('For R-7 backfill: --run --task re-enrich --scope wide --max N');
    out('Scope: --project <name|.|current> to limit; --verbose for cluster details.');
    return;
  }

  out(`[mem] Running LLM optimization${reenrichScope === 'wide' ? ' (scope: wide)' : ''}${project ? ` (project: ${project})` : ''}...`);
  const results = await optimizeRun(db, { tasks, maxItems, force: runAll, reenrichScope, project });

  if (results.reenrich) out(`  Re-enrich: ${results.reenrich.processed || 0} processed, ${results.reenrich.skipped || 0} skipped`);
  if (results.normalize) {
    if (results.normalize.skipped) out(`  Normalize: skipped (${results.normalize.reason})`);
    else out(`  Normalize: ${results.normalize.processed || 0} updated, ${results.normalize.groups || 0} synonym groups`);
  }
  if (results.clusterMerge) out(`  Cluster-merge: ${results.clusterMerge.merged || 0} merged of ${results.clusterMerge.processed || 0} clusters`);
  if (results.smartCompress) out(`  Smart-compress: ${results.smartCompress.compressed || 0} compressed of ${results.smartCompress.processed || 0} clusters`);
}

// cmdDoctor extracted to cli/doctor.mjs (v2.41 split).
import { cmdDoctor } from './cli/doctor.mjs';

// cmdActivity (T7 v2.31) extracted to cli/activity.mjs (v2.41 split).
import { cmdActivity } from './cli/activity.mjs';

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function run(argv) {
  const cmd = argv[0];
  const cmdArgs = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    cmdHelp();
    return;
  }

  // Support `<cmd> --help` or `<cmd> -h` for any subcommand
  if (cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
    cmdHelp();
    return;
  }

  // adopt / unadopt do pure filesystem work on ~/.claude/projects/<encoded>/memory/ —
  // no DB needed. Route them before ensureDb() so an unbootable DB doesn't block.
  if (cmd === 'adopt') { cmdAdopt(cmdArgs); return; }
  if (cmd === 'unadopt') { cmdUnadopt(cmdArgs); return; }
  if (cmd === 'memdir-audit') { cmdMemdirAudit(cmdArgs); return; }

  let db;
  try {
    db = ensureDb();
  } catch (e) {
    out(`[mem] Error: Cannot open database: ${e.message}`);
    out(`[mem] DB path: ${DB_PATH}`);
    process.exitCode = 1;
    return;
  }

  // --json contract surfacing: only `search` and `context` actually emit JSON;
  // historically `recent --json | jq` etc. silently produced text, breaking
  // automation. Emit a one-line stderr note when --json is passed to a command
  // that doesn't honor it. Stdout output and exit code are unchanged so existing
  // text-parsing callers keep working — the note lives in stderr for scripts to
  // detect the gap.
  const JSON_SUPPORTED_CMDS = new Set([
    'search', 'context', 'recent', 'recall', 'timeline', 'stats', 'browse', 'export', 'citation-stats',
  ]);
  // `doctor --benchmark` already emits JSON on its own — don't print the misleading
  // "doctor outputs text" note for that subpath. Without --benchmark, doctor is text
  // and the note is still useful.
  const doctorBenchmark = cmd === 'doctor' && cmdArgs.includes('--benchmark');
  if (cmdArgs.includes('--json') && !JSON_SUPPORTED_CMDS.has(cmd) && !doctorBenchmark) {
    process.stderr.write(`[mem] Note: --json is supported only on: ${[...JSON_SUPPORTED_CMDS].join(', ')}. "${cmd}" outputs text.\n`);
  }

  try {
    switch (cmd) {
      case 'search':    await cmdSearch(db, cmdArgs); break;
      case 'recent':    cmdRecent(db, cmdArgs); break;
      case 'recall':    cmdRecall(db, cmdArgs); break;
      case 'get':       cmdGet(db, cmdArgs); break;
      case 'timeline':  cmdTimeline(db, cmdArgs); break;
      case 'save':      cmdSave(db, cmdArgs); break;
      case 'defer':     cmdDefer(db, cmdArgs); break;
      case 'delete':    cmdDelete(db, cmdArgs); break;
      case 'update':    cmdUpdate(db, cmdArgs); break;
      case 'export':    cmdExport(db, cmdArgs); break;
      case 'restore':   cmdRestore(db, cmdArgs); break;
      case 'compress':  cmdCompress(db, cmdArgs); break;
      case 'maintain':  cmdMaintain(db, cmdArgs); break;
      case 'optimize':  await cmdOptimize(db, cmdArgs); break;
      case 'fts-check': cmdFtsCheck(db, cmdArgs); break;
      case 'stats':     await cmdStats(db, cmdArgs); break;
      case 'context':   cmdContext(db, cmdArgs); break;
      case 'browse':    cmdBrowse(db, cmdArgs); break;
      case 'citation-stats': cmdCitationStats(db, cmdArgs); break;
      case 'registry':  cmdRegistry(db, cmdArgs); break;
      case 'import':    await cmdImport(cmdArgs); break;
      case 'import-jsonl': await cmdImportJsonl(db, cmdArgs); break;
      case 'enrich':    await cmdEnrich(cmdArgs); break;
      case 'doctor':    await cmdDoctor(db, cmdArgs); break;
      case 'activity':  await cmdActivity(db, cmdArgs); break;
      default:
        out(`[mem] Unknown command: ${cmd}`);
        out('[mem] Run "claude-mem-lite help" for usage');
        process.exitCode = 1;
    }
  } catch (e) {
    // SQLITE_BUSY / SQLITE_LOCKED + extended variants (SQLITE_BUSY_SNAPSHOT,
    // SQLITE_BUSY_RECOVERY, SQLITE_LOCKED_SHAREDCACHE…). All mean the same thing
    // to the user: writer contention past the 5s busy_timeout. Pre-fix this
    // raised an unhandled SqliteError with a node stack trace.
    const code = e && typeof e.code === 'string' ? e.code : '';
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ||
        code.startsWith('SQLITE_BUSY_') || code.startsWith('SQLITE_LOCKED_')) {
      process.stderr.write(`[mem] Database busy — another process held the writer past the 5s timeout. Retry shortly.\n`);
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    try { db.close(); } catch {}
  }
}
