#!/usr/bin/env node
// claude-mem-lite CLI — lightweight command layer for direct memory access
// No MCP SDK or heavy deps — only imports schema.mjs and utils.mjs

import { homedir } from 'os';
import { ensureDb, DB_PATH, REGISTRY_DB_PATH } from './schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, jaccardSimilarity, computeMinHash, estimateJaccardFromMinHash, scrubSecrets, cjkBigrams, isoWeekKey, COMPRESSED_PENDING_PURGE, SESS_BM25, DEFAULT_DECAY_HALF_LIFE_MS, notLowSignalTitleClause } from './utils.mjs';
import { cjkPrecisionOk } from './nlp.mjs';
import { extractCjkLikePatterns } from './nlp.mjs';
import { resolveProject } from './project-utils.mjs';
import { computeTier, TIER_CASE_SQL, tierSqlParams } from './tier.mjs';
import { getVocabulary, computeVector, rebuildVocabulary, _resetVocabCache } from './tfidf.mjs';
import { autoBoostIfNeeded, reRankWithContext, markSuperseded } from './server-internals.mjs';
import { searchObservationsHybrid, findFtsAnchor } from './search-engine.mjs';
import { ensureRegistryDb, upsertResource } from './registry.mjs';
import { searchResources } from './registry-retriever.mjs';
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
import { buildSessionContextLines } from './hook-context.mjs';
import { cmdAdopt, cmdUnadopt } from './adopt-cli.mjs';
import { auditMemdir, memdirPath } from './memdir.mjs';
import { probeOtherSources as probeIdSources, bucketIdTokens } from './lib/id-routing.mjs';
import { basename, join } from 'path';
import { readFileSync, existsSync, readdirSync } from 'fs';

// v2.41: shared CLI helpers extracted to cli/common.mjs. Keep this file as the
// router + remaining-command bodies during the incremental split. Future work:
// move each cmdXxx into its own cli/<cmd>.mjs; mem-cli.mjs becomes pure dispatch.
import { parseArgs, out, fail, relativeTime, fmtDateShort, parseIdToken, formatProbeHints } from './cli/common.mjs';
import { saveObservation } from './lib/save-observation.mjs';

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdSearch(db, args) {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ');
  if (!query) {
    fail('[mem] Usage: claude-mem-lite search <query> [--type TYPE] [--source SOURCE] [--limit N] [--project P] [--from DATE] [--to DATE] [--importance N] [--branch B] [--offset N] [--sort relevance|time|importance] [--include-noise]');
    return;
  }

  const rawLimit = flags.limit !== undefined ? parseInt(flags.limit, 10) : NaN;
  // Distinguish missing/non-integer (use default) from non-positive (silently clamping to 1
  // produced confusing "Found 1 of 44 result" output for --limit 0/-N — warn instead).
  if (flags.limit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
    process.stderr.write(`[mem] Invalid --limit "${flags.limit}" (must be a positive integer); using default 20\n`);
  }
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? rawLimit : 20;
  const type = flags.type || null;
  const validObsTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  if (type && !validObsTypes.has(type)) {
    fail(`[mem] Invalid --type "${type}". Valid: ${[...validObsTypes].join(', ')}`);
    return;
  }
  const source = flags.source || null; // observations|sessions|prompts (null = all)
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const dateFrom = flags.from ? new Date(flags.from).getTime() : null;
  let dateTo = flags.to ? new Date(flags.to).getTime() : null;
  if (dateTo && flags.to && /^\d{4}-\d{2}-\d{2}$/.test(flags.to)) dateTo += 86400000 - 1;
  if (flags.from && isNaN(dateFrom)) { fail(`[mem] Invalid --from date: "${flags.from}". Use YYYY-MM-DD or ISO 8601.`); return; }
  if (flags.to && isNaN(dateTo)) { fail(`[mem] Invalid --to date: "${flags.to}". Use YYYY-MM-DD or ISO 8601.`); return; }
  // Inverted range silently returns 0 rows; warn so users see the cause, don't error
  // (a deliberate "search for nothing in this window" is not malformed input).
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    process.stderr.write(`[mem] Note: --from "${flags.from}" is after --to "${flags.to}"; this range is empty\n`);
  }
  const minImportance = flags.importance !== undefined ? parseInt(flags.importance, 10) : null;
  if (minImportance !== null && (isNaN(minImportance) || minImportance < 1 || minImportance > 3)) {
    fail(`[mem] Invalid --importance "${flags.importance}". Must be 1, 2, or 3.`);
    return;
  }
  const branch = flags.branch || null;
  const rawOffset = flags.offset !== undefined ? parseInt(flags.offset, 10) : NaN;
  if (flags.offset !== undefined && (!Number.isInteger(rawOffset) || rawOffset < 0)) {
    process.stderr.write(`[mem] Invalid --offset "${flags.offset}" (must be a non-negative integer); using 0\n`);
  }
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
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

  if (source && !['observations', 'sessions', 'prompts'].includes(source)) {
    fail(`[mem] Invalid --source "${source}". Use: observations, sessions, prompts`);
    return;
  }

  let ftsQuery = sanitizeFtsQuery(query);
  if (ftsQuery && useOr) ftsQuery = relaxFtsQueryToOr(ftsQuery) || ftsQuery;
  if (!ftsQuery) {
    fail(`[mem] No valid search terms in "${query}"`);
    return;
  }

  // Warn if obs-only filters used with non-observation source
  if (source && source !== 'observations' && (type || tier || minImportance)) {
    const ignored = [type && '--type', tier && '--tier', minImportance && '--importance'].filter(Boolean);
    process.stderr.write(`[mem] Note: ${ignored.join(', ')} only apply to observations, ignored for --source ${source}\n`);
  }

  // When --type/--tier/--importance (obs-only fields) is specified, implicitly restrict to observations
  const effectiveSource = source || ((type || tier || minImportance) ? 'observations' : null);

  // Cross-source mode: each source needs more candidates than the final limit
  // so the post-merge sort has room to pick the best from each (paired-path with
  // server.mjs:377 — without this, obs gets systematically squeezed out by sessions).
  const isCrossSourceMode = !effectiveSource;
  const perSourceLimit = isCrossSourceMode ? Math.max(limit * 3, offset + limit + 10) : limit;
  const perSourceOffset = isCrossSourceMode ? 0 : offset;

  const results = [];
  // Tracks whether AND returned 0 and OR recovered non-empty. Mirrors server.mjs
  // ctx.orFallbackFired so the header can surface a "(relaxed AND→OR)" hint.
  let orFallbackFired = false;

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
    const obsResults = searchObservationsHybrid(db, obsCtx);
    if (obsCtx.orFallbackFired) orFallbackFired = true;
    for (const r of obsResults) results.push({ ...r, _source: 'obs', score: r.score ?? 0 });

    // Tier post-filter — applied to ALL obs results from the engine.
    if (tier) {
      const obsInResults = results.filter(r => r._source === 'obs');
      if (obsInResults.length > 0) {
        const obsIds = obsInResults.map(r => r.id);
        const ph = obsIds.map(() => '?').join(',');
        const fullRows = db.prepare(
          `SELECT id, compressed_into, superseded_at, memory_session_id, project, importance, last_accessed_at, created_at_epoch, type FROM observations WHERE id IN (${ph})`
        ).all(...obsIds);
        const rowMap = new Map(fullRows.map(r => [r.id, r]));
        const tierCtx = { now: Date.now(), currentProject: project || inferProject(), currentSessionId: '' };
        const allowedIds = new Set();
        for (const [id, full] of rowMap) {
          if (computeTier(full, tierCtx) === tier) allowedIds.add(id);
        }
        for (let i = results.length - 1; i >= 0; i--) {
          if (results[i]._source === 'obs' && !allowedIds.has(results[i].id)) results.splice(i, 1);
        }
      }
    }
  }

  // Search sessions (aligned with MCP mem_search)
  if (!effectiveSource || effectiveSource === 'sessions') {
    const now = Date.now();
    const sessionProjectBoost = project ? null : inferProject();
    const sessWheres = ['session_summaries_fts MATCH ?'];
    const sessParams = [now, sessionProjectBoost, sessionProjectBoost, ftsQuery];
    if (project) { sessWheres.push('s.project = ?'); sessParams.push(project); }
    if (dateFrom) { sessWheres.push('s.created_at_epoch >= ?'); sessParams.push(dateFrom); }
    if (dateTo) { sessWheres.push('s.created_at_epoch <= ?'); sessParams.push(dateTo); }
    sessParams.push(perSourceLimit, perSourceOffset);
    try {
      const sessRows = db.prepare(`
        SELECT s.id, s.request, s.completed, s.project, s.created_at, s.created_at_epoch,
               ${SESS_BM25}
                 * (1.0 + EXP(-0.693 * (? - s.created_at_epoch) / ${DEFAULT_DECAY_HALF_LIFE_MS}.0))
                 * (CASE WHEN ? IS NOT NULL AND s.project = ? THEN 2.0 ELSE 1.0 END) as score
        FROM session_summaries_fts
        JOIN session_summaries s ON session_summaries_fts.rowid = s.id
        WHERE ${sessWheres.join(' AND ')}
        ORDER BY score
        LIMIT ? OFFSET ?
      `).all(...sessParams);
      for (const r of sessRows) results.push({ ...r, _source: 'session' });
    } catch { /* session FTS may not exist in older DBs */ }
  }

  // Search prompts (aligned with MCP mem_search)
  if (!effectiveSource || effectiveSource === 'prompts') {
    const promptWheres = ['user_prompts_fts MATCH ?', "p.prompt_text NOT LIKE '<task-notification>%'"];
    const promptParams = [ftsQuery];
    if (project) { promptWheres.push('s.project = ?'); promptParams.push(project); }
    if (dateFrom) { promptWheres.push('p.created_at_epoch >= ?'); promptParams.push(dateFrom); }
    if (dateTo) { promptWheres.push('p.created_at_epoch <= ?'); promptParams.push(dateTo); }
    promptParams.push(perSourceLimit, perSourceOffset);
    try {
      const promptRows = db.prepare(`
        SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch,
               bm25(user_prompts_fts, 1) as score
        FROM user_prompts_fts
        JOIN user_prompts p ON user_prompts_fts.rowid = p.id
        JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
        WHERE ${promptWheres.join(' AND ')}
        ORDER BY score
        LIMIT ? OFFSET ?
      `).all(...promptParams);
      // CJK precision filter (read-path parity with server.mjs): unicode61
      // degrades bigram queries to single-char AND, letting common-char
      // Chinese prose leak through. Drop rows that miss < 20% of query
      // bigrams/keywords as contiguous substrings.
      const keptPromptRows = promptRows.filter(r => cjkPrecisionOk(query, r.prompt_text));
      for (const r of keptPromptRows) results.push({ ...r, _source: 'prompt' });
      // CJK LIKE fallback: FTS5 unicode61 can't tokenize CJK substrings in prompts
      if (keptPromptRows.length === 0) {
        const cjkPatterns = extractCjkLikePatterns(query);
        if (cjkPatterns.length > 0) {
          const likeConds = cjkPatterns.map(() => 'p.prompt_text LIKE ?');
          const likeParams = cjkPatterns.map(p => `%${p}%`);
          if (project) likeParams.push(project);
          if (dateFrom) likeParams.push(dateFrom);
          if (dateTo) likeParams.push(dateTo);
          likeParams.push(perSourceLimit, perSourceOffset);
          const fallbackRows = db.prepare(`
            SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch
            FROM user_prompts p
            JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
            WHERE (${likeConds.join(' OR ')})
              AND p.prompt_text NOT LIKE '<task-notification>%'
              ${project ? 'AND s.project = ?' : ''}
              ${dateFrom ? 'AND p.created_at_epoch >= ?' : ''}
              ${dateTo ? 'AND p.created_at_epoch <= ?' : ''}
            ORDER BY p.created_at_epoch DESC
            LIMIT ? OFFSET ?
          `).all(...likeParams);
          // CJK precision filter applies here too: the LIKE fallback is just
          // OR'd substring bigrams; without the precision gate it re-admits
          // the same common-char noise the FTS path dropped (this was the
          // actual leak source — FTS returned 0, fallback filled 20).
          const keptFallback = fallbackRows.filter(r => cjkPrecisionOk(query, r.prompt_text));
          for (const r of keptFallback) results.push({ ...r, _source: 'prompt', score: 0 });
        }
      }
    } catch { /* prompt FTS may not exist in older DBs */ }
  }

  if (results.length === 0) {
    if (jsonOutput) {
      out(JSON.stringify({ query, total: 0, returned: 0, offset, limit, results: [] }));
    } else {
      out(`[mem] No results for "${query}"`);
    }
    return;
  }

  // Cross-source score normalization (paired-path with server.mjs:428).
  // ftsQuery gate prevents normalization when scores are all 0 (no-FTS path).
  const isCrossSource = isCrossSourceMode;
  if (isCrossSource && results.length > 0 && ftsQuery) {
    for (const src of ['obs', 'session', 'prompt']) {
      const srcResults = results.filter(r => r._source === src && r.score !== null && r.score !== undefined);
      if (srcResults.length < 2) continue;
      const maxAbs = Math.max(...srcResults.map(r => Math.abs(r.score)));
      if (maxAbs > 0) {
        for (const r of srcResults) r.score = r.score / maxAbs;
      }
    }
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

  // Apply user-requested sort (after relevance scoring)
  if (sort === 'time') {
    results.sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  } else if (sort === 'importance') {
    results.sort((a, b) => (b.importance ?? 1) - (a.importance ?? 1) || (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  }
  // else 'relevance' keeps BM25 score order (already sorted)

  // Trim to limit with offset
  const total = results.length;
  const paged = results.slice(offset, offset + limit);

  if (paged.length === 0) {
    if (jsonOutput) {
      out(JSON.stringify({ query, total, returned: 0, offset, limit, results: [] }));
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
  const isValid = Number.isInteger(rawLimit) && rawLimit > 0;
  if (rawArg !== undefined && !isValid) {
    process.stderr.write(`[mem] Invalid count "${rawArg}" (must be a positive integer); using default 10\n`);
  }
  const limit = isValid ? rawLimit : 10;
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();

  const params = [];
  const wheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL'];
  if (project) { wheres.push('project = ?'); params.push(project); }
  params.push(limit);

  const rows = db.prepare(`
    SELECT id, type, title, subtitle, created_at_epoch, created_at
    FROM observations
    WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...params);

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
    fail('[mem] Usage: claude-mem-lite recall <file> [--limit N] [--include-noise]');
    return;
  }

  const filename = basename(file);
  const rawLimit = flags.limit !== undefined ? parseInt(flags.limit, 10) : NaN;
  if (flags.limit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
    process.stderr.write(`[mem] Invalid --limit "${flags.limit}" (must be a positive integer); using default 10\n`);
  }
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? rawLimit : 10;
  const includeNoise = flags['include-noise'] === true || flags['include-noise'] === 'true';

  // Search via observation_files junction table for indexed filename lookups
  const escaped = filename.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const likePattern = `%${escaped}`;
  const noiseClause = includeNoise ? '' : `AND ${notLowSignalTitleClause('o')}`;
  const rows = db.prepare(`
    SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned, o.created_at, o.project
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE COALESCE(o.compressed_into, 0) = 0
      AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
      ${noiseClause}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(filename, likePattern, limit);

  if (rows.length === 0) {
    out(`[mem] No history for "${filename}"`);
    return;
  }

  // Update access_count for recalled observations (aligned with MCP mem_recall)
  const recalledIds = rows.map(r => r.id);
  const recallPh = recalledIds.map(() => '?').join(',');
  try {
    db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${recallPh})`).run(Date.now(), ...recalledIds);
  } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }

  out(`[mem] History for ${filename} (${rows.length}):`);
  for (const r of rows) {
    const title = truncate(r.title || '(untitled)', 80);
    const lesson = r.lesson_learned ? `\n     Lesson: ${truncate(r.lesson_learned, 80)}` : '';
    const date = fmtDateShort(r.created_at);
    out(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${title} | ${r.project} | ${date}${lesson}`);
  }
}

const OBS_FIELDS = ['id', 'type', 'title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned', 'search_aliases', 'files_read', 'files_modified', 'project', 'created_at', 'memory_session_id', 'prompt_number', 'importance', 'related_ids', 'access_count', 'branch', 'superseded_at', 'superseded_by', 'last_accessed_at'];

// Integer-typed time-epoch fields on the observations table that the `get`
// command renders. Callers expect raw ms (audit) AND a relative-time hint
// (human-scan), so formatObsFieldValue emits both. Other epoch fields like
// `created_at_epoch` / `optimized_at` / `last_injected_at` aren't in
// OBS_FIELDS so they don't surface via `get`.
export const OBS_TIME_FIELDS = ['superseded_at', 'last_accessed_at'];

// Pure formatter — null/undefined/non-time pass through; time fields on
// integer values render as `<raw> (<relative>)` mirroring the convention
// already used by `recent` / `timeline` / `recall`. Pre-2.63.0 the get
// path printed bare ms (e.g. `last_accessed_at: 1778357330957`).
export function formatObsFieldValue(field, val) {
  if (val === null || val === undefined) return val;
  if (OBS_TIME_FIELDS.includes(field) && typeof val === 'number') {
    return `${val} (${relativeTime(val)})`;
  }
  return val;
}

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
  // parseInt('-5') === -5 is truthy, so `|| 5` doesn't rescue negative input.
  // Match cmdSearch's warn-then-default pattern for consistency across CLI flags.
  const parseWindow = (label, raw) => {
    if (raw === undefined) return 5;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) {
      process.stderr.write(`[mem] Invalid --${label} "${raw}" (must be a non-negative integer); using default 5\n`);
      return 5;
    }
    return n;
  };
  const before = parseWindow('before', flags.before);
  const after = parseWindow('after', flags.after);
  const project = flags.project ? resolveProject(db, flags.project) : null;

  // Parse --anchor, accepting P#/S#/# prefix so callers can paste search-result IDs verbatim.
  // For prompt/session anchors, resolve to the nearest-in-time observation so timeline semantics
  // (before/after observations) still apply.
  let anchorId = null;
  let anchorNote = null; // hint line for output when anchor was resolved via conversion
  if (flags.anchor !== undefined && flags.anchor !== true) {
    const parsed = parseIdToken(flags.anchor);
    if (!parsed) {
      fail(`[mem] Invalid --anchor "${flags.anchor}". Expected N, #N, P#N, or S#N.`);
      return;
    }
    if (parsed.source === 'prompt') {
      const row = db.prepare('SELECT created_at_epoch FROM user_prompts WHERE id = ?').get(parsed.id);
      if (!row) { fail(`[mem] Prompt P#${parsed.id} not found`); return; }
      const proj = project;
      const nearest = db.prepare(`
        SELECT id FROM observations
        WHERE COALESCE(compressed_into, 0) = 0 ${proj ? 'AND project = ?' : ''}
        ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1
      `).get(...(proj ? [proj, row.created_at_epoch] : [row.created_at_epoch]));
      if (!nearest) { fail(`[mem] No observations near P#${parsed.id}`); return; }
      anchorId = nearest.id;
      anchorNote = `(anchored to #${nearest.id}, closest obs to P#${parsed.id})`;
    } else if (parsed.source === 'session') {
      const row = db.prepare('SELECT created_at_epoch FROM session_summaries WHERE id = ?').get(parsed.id);
      if (!row) { fail(`[mem] Session S#${parsed.id} not found`); return; }
      const proj = project;
      const nearest = db.prepare(`
        SELECT id FROM observations
        WHERE COALESCE(compressed_into, 0) = 0 ${proj ? 'AND project = ?' : ''}
        ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1
      `).get(...(proj ? [proj, row.created_at_epoch] : [row.created_at_epoch]));
      if (!nearest) { fail(`[mem] No observations near S#${parsed.id}`); return; }
      anchorId = nearest.id;
      anchorNote = `(anchored to #${nearest.id}, closest obs to S#${parsed.id})`;
    } else {
      // Bare integer (no prefix): try observation first. Fall back to user_prompts
      // then session_summaries so pasted P#/S# IDs still work when the prefix is
      // omitted — matches the prefix-aware routing used by search/probe.
      const obsRow = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(parsed.id);
      if (obsRow) {
        const ci = obsRow.compressed_into;
        if (ci && ci > 0) {
          // Compressed into a live parent: re-anchor so the window doesn't silently
          // straddle a dead record. Negative sentinels (-1 dropped, -2 pending purge)
          // have no canonical parent — surface an explicit error instead.
          anchorId = ci;
          anchorNote = `(anchored to #${ci}, #${parsed.id} was compressed into it)`;
        } else if (ci && ci < 0) {
          fail(`[mem] Observation #${parsed.id} was compressed and pruned; no canonical anchor available`);
          return;
        } else {
          anchorId = parsed.id;
        }
      } else {
        const promptRow = db.prepare('SELECT created_at_epoch FROM user_prompts WHERE id = ?').get(parsed.id);
        const sessionRow = promptRow ? null : db.prepare('SELECT created_at_epoch FROM session_summaries WHERE id = ?').get(parsed.id);
        const hit = promptRow ? { row: promptRow, prefix: 'P', name: 'prompt' }
                  : sessionRow ? { row: sessionRow, prefix: 'S', name: 'session' }
                  : null;
        if (!hit) {
          fail(`[mem] Observation, prompt, or session with id ${parsed.id} not found`);
          return;
        }
        const proj = project;
        const nearest = db.prepare(`
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0 ${proj ? 'AND project = ?' : ''}
          ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1
        `).get(...(proj ? [proj, hit.row.created_at_epoch] : [hit.row.created_at_epoch]));
        if (!nearest) { fail(`[mem] No observations near ${hit.prefix}#${parsed.id} (${hit.name})`); return; }
        anchorId = nearest.id;
        anchorNote = `(anchored to #${nearest.id}, closest obs to ${hit.prefix}#${parsed.id})`;
      }
    }
  }

  // Support query-based anchor: `timeline --query "search terms"` or positional.
  // Routes through shared findFtsAnchor (paired-path with MCP mem_timeline)
  // so AND→OR fallback semantics match `search` — without this, queries like
  // "ep-flush leak" miss rows whose title is "ep-flush ... leaked" that
  // search would otherwise find via OR relaxation.
  const queryStr = flags.query || positional.join(' ');
  if ((!anchorId || isNaN(anchorId)) && queryStr) {
    const ftsQuery = sanitizeFtsQuery(queryStr);
    const found = findFtsAnchor(db, { ftsQuery, project: project ?? null });
    if (found) {
      anchorId = found.id;
      if (found.relaxed && !anchorNote) {
        anchorNote = `(query "${queryStr}" relaxed AND→OR — no row matched all terms)`;
      }
    }
  }

  // No anchor: show most recent observations (aligned with MCP mem_timeline fallback)
  if (!anchorId || isNaN(anchorId)) {
    if (queryStr) {
      process.stderr.write(`[mem] No anchor found for "${queryStr}", showing recent timeline\n`);
    }
    const compressedFilter = 'COALESCE(compressed_into, 0) = 0';
    const projectFilter = project ? `WHERE ${compressedFilter} AND project = ?` : `WHERE ${compressedFilter}`;
    const fallbackParams = project ? [project, before + after + 1] : [before + after + 1];
    const rows = db.prepare(`
      SELECT id, type, title, subtitle, created_at, created_at_epoch
      FROM observations ${projectFilter}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(...fallbackParams);

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

  // Update access_count for anchor (aligned with MCP mem_timeline)
  try {
    db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?').run(Date.now(), anchorId);
  } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }

  // Get anchor epoch
  const anchorRow = db.prepare('SELECT created_at_epoch, project FROM observations WHERE id = ?').get(anchorId);
  if (!anchorRow) {
    fail(`[mem] Observation #${anchorId} not found`);
    return;
  }

  // Auto-scope to anchor's project when --project not explicitly given: users asking
  // "what happened around #N" expect same-project context, not cross-project time-bleed.
  const effectiveProject = project || anchorRow.project;
  const projectFilter = effectiveProject ? 'AND project = ?' : '';
  const baseParams = effectiveProject ? [effectiveProject] : [];

  // Before anchor
  const beforeRows = db.prepare(`
    SELECT id, type, title, subtitle, created_at, created_at_epoch
    FROM observations
    WHERE created_at_epoch < ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(anchorRow.created_at_epoch, ...baseParams, before);

  // After anchor
  const afterRows = db.prepare(`
    SELECT id, type, title, subtitle, created_at, created_at_epoch
    FROM observations
    WHERE created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
    ORDER BY created_at_epoch ASC
    LIMIT ?
  `).all(anchorRow.created_at_epoch, ...baseParams, after);

  // Anchor itself
  const anchor = db.prepare(
    'SELECT id, type, title, subtitle, created_at, created_at_epoch FROM observations WHERE id = ?'
  ).get(anchorId);

  const all = [...beforeRows.reverse(), anchor, ...afterRows];

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
  if (!text) {
    fail('[mem] Usage: claude-mem-lite save "<text>" [--type T] [--title T] [--importance N] [--project P] [--files f1,f2] [--lesson T]');
    return;
  }

  const type = flags.type || 'discovery';
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  if (!validTypes.has(type)) {
    fail(`[mem] Invalid type "${type}". Valid: ${[...validTypes].join(', ')}`);
    return;
  }

  // Explicit saves default to importance=2 (notable) — user chose to save
  const rawImp = flags.importance !== undefined ? parseInt(flags.importance, 10) : 2;
  if (flags.importance !== undefined && (isNaN(rawImp) || rawImp < 1 || rawImp > 3)) {
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

  const result = saveObservation(db, {
    content: text,
    title: flags.title,
    type,
    importance: rawImp,
    project,
    files: saveFiles,
    lesson_learned: rawLesson,
  });

  if (result.kind === 'duplicate') {
    out(`[mem] Skipped: similar to existing #${result.existingId}. Use "claude-mem-lite get ${result.existingId}" to review.`);
    return;
  }

  const lessonNote = result.lessonCaptured ? ' 💡lesson captured' : '';
  out(`[mem] Saved #${result.id} [${result.type}] "${truncate(result.title, 80)}" (project: ${result.project})${lessonNote}`);
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
  const days = parseInt(flags.days, 10) || 30;
  // N-1: --quality routes to a separate quality-focused report (lesson rate,
  // LOW_SIGNAL rate, per-type hit+lesson %, R-2 watchdog targets). Intended as
  // the baseline metric dashboard for the future Haiku prompt A/B test.
  const quality = flags.quality === true || flags.quality === 'true';
  if (quality) {
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
      AND created_at_epoch < ? ${projectFilter}
  `).get(thirtyDaysAgo, ...baseParams);
  const noiseRatio = obsTotal.c > 0 ? lowVal.c / obsTotal.c : 0;
  const compressedCount = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE compressed_into IS NOT NULL ${projectFilter}`
  ).get(...baseParams);
  const supersededOnlyCount = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE superseded_at IS NOT NULL AND compressed_into IS NULL ${projectFilter}`
  ).get(...baseParams);

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
  const rawLimit = flags.limit !== undefined ? parseInt(flags.limit, 10) : NaN;
  const limit = Number.isInteger(rawLimit) ? Math.max(1, rawLimit) : (tierFilter ? 20 : 5);
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

  out(`📊 Memory Dashboard (${project})\n`);

  let grandTotal = 0;
  const tierCounts = {};

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

    out(`${tierLabels[tier]} (${count})`);

    if (tier === 'archive' && !tierFilter) {
      if (count > 0) out('');
      continue;
    }

    if (count === 0) { out(''); continue; }

    const rows = db.prepare(`
      SELECT * FROM (
        SELECT id, type, title, created_at_epoch, ${TIER_CASE_SQL} as tier
        FROM observations
        WHERE project = ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
      ) WHERE tier = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(...params, project, tier, limit);

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
    return db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);
  });
  const result = deleteTx();
  const missing = ids.filter(id => !rows.some(r => r.id === id));
  out(`[mem] Deleted ${result.changes} observation(s).${missing.length > 0 ? ` Note: ID(s) ${missing.join(', ')} not found.` : ''}`);
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

  const updates = [];
  const params = [];
  if (flags.title !== undefined) { updates.push('title = ?'); params.push(scrubSecrets(flags.title)); }
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
    if (isNaN(imp) || imp < 1 || imp > 3) {
      fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
      return;
    }
    updates.push('importance = ?'); params.push(imp);
  }
  if (flags.lesson !== undefined || flags['lesson-learned'] !== undefined) { updates.push('lesson_learned = ?'); params.push(scrubSecrets(flags.lesson ?? flags['lesson-learned'] ?? '')); }
  if (flags.concepts !== undefined) { updates.push('concepts = ?'); params.push(flags.concepts); }

  if (updates.length === 0) {
    fail('[mem] No fields to update. Use --title, --type, --importance, --lesson/--lesson-learned, --narrative, --concepts');
    return;
  }

  params.push(id);

  // Atomic: update fields + rebuild FTS text + re-vectorize (aligned with MCP mem_update)
  db.transaction(() => {
    db.prepare(`UPDATE observations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Rebuild FTS text field
    const row = db.prepare('SELECT title, subtitle, narrative, concepts, facts, lesson_learned, search_aliases FROM observations WHERE id = ?').get(id);
    const base = [row.title, row.subtitle, row.narrative, row.concepts, row.facts, row.lesson_learned, row.search_aliases].filter(Boolean).join(' ');
    const bigrams = cjkBigrams((row.title || '') + ' ' + (row.narrative || ''));
    const textField = bigrams ? base + ' ' + bigrams : base;
    db.prepare('UPDATE observations SET text = ? WHERE id = ?').run(textField, id);

    // Re-vectorize (non-critical — catch to avoid rollback)
    try {
      const vocab = getVocabulary(db);
      if (vocab) {
        const vec = computeVector(textField, vocab);
        if (vec) {
          db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
            .run(id, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
    } catch { /* non-critical */ }
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
  if (flags.type) { wheres.push('type = ?'); params.push(flags.type); }
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

  const rawLimit = flags.limit !== undefined ? parseInt(flags.limit, 10) : NaN;
  const limit = Math.min(Number.isInteger(rawLimit) ? Math.max(1, rawLimit) : 200, 1000);
  const format = flags.format || 'json';
  if (!['json', 'jsonl'].includes(format)) {
    fail(`[mem] Invalid format "${format}". Use: json or jsonl`);
    return;
  }

  const rows = db.prepare(`
    SELECT id, project, type, title, subtitle, narrative, concepts, facts, lesson_learned, importance, files_modified, created_at, created_at_epoch
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

// ─── Compress ────────────────────────────────────────────────────────────────

function cmdCompress(db, args) {
  const { flags } = parseArgs(args);
  const preview = flags.execute !== true && flags.execute !== 'true';
  const ageDaysRaw = parseInt(flags['age-days'], 10);
  const ageDays = Number.isFinite(ageDaysRaw) && ageDaysRaw >= 1 ? ageDaysRaw : 30;
  const cutoff = Date.now() - ageDays * 86400000;
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  const candidates = db.prepare(`
    SELECT id, project, type, title, created_at, created_at_epoch
    FROM observations
    WHERE COALESCE(importance, 1) = 1
      AND COALESCE(access_count, 0) = 0
      AND created_at_epoch < ?
      AND compressed_into IS NULL
      ${projectFilter}
    ORDER BY project, created_at_epoch
  `).all(cutoff, ...baseParams);

  if (candidates.length === 0) {
    out('[mem] No candidates for compression.');
    return;
  }

  // Group by project + ISO week
  const groups = new Map();
  for (const c of candidates) {
    const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const compressableGroups = [...groups.entries()].filter(([, obs]) => obs.length >= 3);

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

  // Execute compression
  let totalCompressed = 0;
  const insertSummary = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, '', ?, '', '', '[]', '[]', 2, ?, ?)
  `);

  db.transaction(() => {
    for (const [key, obs] of compressableGroups) {
      const [proj] = key.split('::');
      const types = {};
      for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
      const dominantType = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
      const title = `Weekly summary: ${obs.length} ${dominantType} observations`;
      const narrative = obs.map(o => `- ${o.title || '(untitled)'}`).join('\n');
      const sessionId = `compress-${proj}`;

      const sortedEpochs = obs.map(o => o.created_at_epoch).sort((a, b) => a - b);
      const medianEpoch = sortedEpochs[Math.floor(sortedEpochs.length / 2)];
      const medianDate = new Date(medianEpoch);

      const now = new Date();
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(sessionId, sessionId, proj, now.toISOString(), now.getTime());

      const summaryResult = insertSummary.run(
        sessionId, proj, narrative, dominantType, title, narrative,
        medianDate.toISOString(), medianEpoch
      );
      const summaryId = Number(summaryResult.lastInsertRowid);

      const obsIds = obs.map(o => o.id);
      const obsPh = obsIds.map(() => '?').join(',');
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${obsPh})`).run(summaryId, ...obsIds);
      totalCompressed += obs.length;
    }
  })();

  out(`[mem] Compressed ${totalCompressed} observations into ${compressableGroups.length} weekly summaries.`);
}

// ─── Maintain ────────────────────────────────────────────────────────────────

function cmdMaintain(db, args) {
  const { positional, flags } = parseArgs(args);
  const action = positional[0];
  if (!action || !['scan', 'execute'].includes(action)) {
    fail("[mem] Usage: claude-mem-lite maintain <scan|execute> [--ops cleanup,decay,boost,dedup,purge_stale,rebuild_vectors] [--project P] [--retain-days N] [--merge-ids keepId:removeId,...] — 'scan' previews, 'execute' applies.");
    return;
  }

  const project = flags.project ? resolveProject(db, flags.project) : null;
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];
  const STALE_AGE_MS = 30 * 86400000;
  const SCAN_LIMIT = 500;
  const SIMILARITY_THRESHOLD = 0.7;

  if (action === 'scan') {
    const staleAge = Date.now() - STALE_AGE_MS;

    // Find near-duplicates (MinHash pre-filter → Jaccard)
    const recent = db.prepare(`
      SELECT id, title, importance, access_count, created_at_epoch
      FROM observations
      WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
      ORDER BY created_at_epoch DESC LIMIT ${SCAN_LIMIT}
    `).all(...baseParams);

    const titles = recent.map(r => (r.title || '').trim());
    const minhashes = titles.map(t => t ? computeMinHash(t) : null);
    const duplicates = [];
    for (let i = 0; i < recent.length && duplicates.length < 50; i++) {
      if (!titles[i] || !minhashes[i]) continue;
      for (let j = i + 1; j < recent.length; j++) {
        if (!titles[j] || !minhashes[j]) continue;
        if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < 0.5) continue;
        const sim = jaccardSimilarity(titles[i], titles[j]);
        if (sim > SIMILARITY_THRESHOLD) {
          duplicates.push({ a: recent[i], b: recent[j], similarity: sim.toFixed(2) });
        }
        if (duplicates.length >= 50) break;
      }
    }

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN COALESCE(importance, 1) = 1 AND COALESCE(access_count, 0) = 0
                      AND created_at_epoch < ? THEN 1 ELSE 0 END) as stale,
        SUM(CASE WHEN (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
                 THEN 1 ELSE 0 END) as broken,
        SUM(CASE WHEN COALESCE(access_count, 0) > 3 AND COALESCE(importance, 1) < 3
                 THEN 1 ELSE 0 END) as boostable
      FROM observations
      WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
    `).get(staleAge, ...baseParams);

    const pendingPurge = db.prepare(
      `SELECT COUNT(*) as count FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} ${projectFilter}`
    ).get(...baseParams);

    out(`[mem] Maintenance scan:`);
    out(`  Total active: ${stats.total}`);
    out(`  Near-duplicate pairs: ${duplicates.length}`);
    out(`  Stale (>30d, imp=1, no access): ${stats.stale}`);
    out(`  Broken (no title/narrative): ${stats.broken}`);
    out(`  Boostable (accessed>3, imp<3): ${stats.boostable}`);
    out(`  Pending purge: ${pendingPurge.count} (compressed originals awaiting cleanup)`);
    if (duplicates.length > 0) {
      const AUTO_MERGE_THRESHOLD = 0.85;
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
  const VALID_OPS = ['cleanup', 'decay', 'boost', 'dedup', 'purge_stale', 'rebuild_vectors'];
  const opsStr = flags.ops || 'cleanup,decay,boost';
  const ops = opsStr.split(',').map(s => s.trim());
  const invalidOps = ops.filter(op => !VALID_OPS.includes(op));
  if (invalidOps.length > 0) {
    fail(`[mem] Unknown operation(s): ${invalidOps.join(', ')}. Valid: ${VALID_OPS.join(', ')}`);
    return;
  }
  const staleAge = Date.now() - STALE_AGE_MS;
  const OP_CAP = 1000;
  const results = [];

  // T2-P1-B: surface the OP_CAP hit so users know to re-run, matching MCP mem_maintain.
  const capHint = (changes) => (changes >= OP_CAP ? ' (cap reached, re-run for more)' : '');

  db.transaction(() => {
    if (ops.includes('cleanup')) {
      const deleted = db.prepare(`
        DELETE FROM observations WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(...baseParams);
      results.push(`Cleaned up ${deleted.changes} broken observations${capHint(deleted.changes)}`);
    }

    if (ops.includes('decay')) {
      // v2.56.0 #4: parity with hook.mjs auto-maintain — injection_count > 0
      // protects from decay/mark-idle, treating hook injection as first-class
      // engagement alongside access_count.
      const decayed = db.prepare(`
        UPDATE observations SET importance = MAX(1, COALESCE(importance, 1) - 1)
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(importance, 1) > 1
            AND COALESCE(access_count, 0) = 0
            AND COALESCE(injection_count, 0) = 0
            AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(staleAge, ...baseParams);

      // Mark importance=1, never-accessed, never-injected, old → pending-purge.
      const idleMarked = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(importance, 1) = 1
            AND COALESCE(access_count, 0) = 0
            AND COALESCE(injection_count, 0) = 0
            AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(staleAge, ...baseParams);
      const decayCap = (decayed.changes >= OP_CAP || idleMarked.changes >= OP_CAP) ? ' (cap reached, re-run for more)' : '';
      results.push(`Decayed ${decayed.changes} stale observations, marked ${idleMarked.changes} idle as pending-purge${decayCap}`);
    }

    if (ops.includes('boost')) {
      const boosted = db.prepare(`
        UPDATE observations SET importance = MIN(3, COALESCE(importance, 1) + 1)
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(access_count, 0) > 3
            AND COALESCE(importance, 1) < 3
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(...baseParams);
      results.push(`Boosted ${boosted.changes} frequently-accessed observations${capHint(boosted.changes)}`);
    }

    if (ops.includes('dedup') && flags['merge-ids']) {
      // Parse merge-ids: "keepId:removeId1:removeId2,keepId2:removeId3" format.
      // Surface malformed segments (non-numeric tokens, single-element pairs) instead of
      // silently dropping them, so typos like "abc:def" don't hide behind "Merged 0".
      let totalMerged = 0;
      const invalidSegments = [];
      const mergeStmt = db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ? AND COALESCE(compressed_into, 0) = 0');
      const rawSegments = flags['merge-ids'].split(',').map(s => s.trim()).filter(Boolean);
      for (const seg of rawSegments) {
        const parts = seg.split(':').map(s => s.trim());
        const nums = parts.map(p => Number(p));
        const badToken = parts.length < 2 || nums.some(n => !Number.isFinite(n) || n <= 0);
        if (badToken) { invalidSegments.push(seg); continue; }
        const [keepId, ...removeIds] = nums;
        for (const removeId of removeIds) {
          totalMerged += mergeStmt.run(keepId, removeId).changes;
        }
      }
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
        const previewRow = db.prepare(`
          SELECT COUNT(*) AS candidates, MIN(created_at_epoch) AS oldest, MAX(created_at_epoch) AS newest
          FROM observations
          WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ? ${projectFilter}
        `).get(retainCutoff, ...baseParams);
        const pushLines = [`purge_stale preview (no --confirm):`,
          `  Candidates (pending-purge, older than ${retainDays}d): ${previewRow.candidates}`];
        if (previewRow.candidates > 0) {
          pushLines.push(`  Oldest: ${new Date(previewRow.oldest).toISOString().slice(0, 10)}`);
          pushLines.push(`  Newest: ${new Date(previewRow.newest).toISOString().slice(0, 10)}`);
        }
        pushLines.push(`  To delete, re-run with --confirm.`);
        results.push(pushLines.join('\n'));
      } else {
        const purged = db.prepare(`
          DELETE FROM observations WHERE id IN (
            SELECT id FROM observations
            WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ?
              ${projectFilter} LIMIT ${OP_CAP}
          )
        `).run(retainCutoff, ...baseParams);
        results.push(`Purged ${purged.changes} stale observations (retained last ${retainDays} days)${capHint(purged.changes)}`);
      }
    }
  })();

  // FTS optimize
  db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
  results.push('FTS5 index optimized');

  // rebuild_vectors: outside main transaction (aligned with MCP mem_maintain)
  if (ops.includes('rebuild_vectors')) {
    try {
      _resetVocabCache();
      const vocab = rebuildVocabulary(db);
      if (!vocab) {
        results.push('Vectors: no observations to build vocabulary from');
      } else {
        const allObs = db.prepare(`
          SELECT id, title, narrative, concepts FROM observations
          WHERE COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
        `).all();
        let updated = 0;
        const insertStmt = db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)');
        const vecNow = Date.now();
        db.transaction(() => {
          db.prepare('DELETE FROM observation_vectors').run();
          for (const obs of allObs) {
            const text = [obs.title || '', obs.narrative || '', obs.concepts || ''].filter(Boolean).join(' ');
            const vec = computeVector(text, vocab);
            if (vec) {
              insertStmt.run(obs.id, Buffer.from(vec.buffer), vocab.version, vecNow);
              updated++;
            }
          }
        })();
        results.push(`Vectors: rebuilt vocabulary (${vocab.terms.size} terms), updated ${updated}/${allObs.length} vectors`);
      }
    } catch (e) {
      results.push(`Vectors: rebuild failed — ${e.message}`);
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

  try {
    if (action === 'search') {
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
        const isManaged = r.local_path && r.local_path.includes('/.claude-mem-lite/managed/');
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
      const rawLimit = parseInt(flags.limit, 10);
      const listLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 20;
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
      const name = flags.name;
      const resourceType = flags['resource-type'];
      if (!name || !resourceType) { fail('[mem] Usage: claude-mem-lite registry remove --name N --resource-type skill|agent'); return; }
      const result = rdb.prepare('DELETE FROM resources WHERE type = ? AND name = ?').run(resourceType, name);
      out(result.changes > 0 ? `[mem] Removed: ${resourceType}:${name}` : '[mem] Not found.');
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
    --importance N      Minimum importance (1-3)
    --branch B          Filter by git branch
    --offset N          Skip first N results (pagination)
    --tier T            Filter by tier (working|active|archive, observations only)
    --sort S            Sort: relevance (default), time, importance
    --or                Use OR instead of AND between search terms
    --include-noise     Include hook-llm fallback titles ("Modified X", raw error logs)
    --json              Output as JSON: {query,total,returned,offset,limit,results:[…]}

  recent [N]            Show N most recent observations (default 10)
    --project P         Filter by project

  recall <file>         Show observations related to a file
    --limit N           Max results (default 10)
    --include-noise     Include hook-llm fallback titles ("Modified X", raw error logs)

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

  save "<text>"         Save a new observation
    --type T            Observation type (default: discovery)
    --title T           Title (auto-generated if omitted)
    --importance N      1-3 (default: 2)
    --project P         Project name
    --files f1,f2       Comma-separated file paths
    --lesson T          Lesson learned (≤500 chars; alias: --lesson-learned)

  delete <id1,id2,...>  Delete observations by ID
    --confirm           Execute deletion (preview by default)

  update <id>           Update an existing observation
    --title T           New title
    --type T            New type
    --importance N      New importance (1-3)
    --lesson T          Add/update lesson learned (alias: --lesson-learned)
    --narrative T       New narrative
    --concepts T        Space-separated concept tags

  export                Export observations as JSON/JSONL
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
    --ops O             Comma-separated: cleanup,decay,boost,dedup,purge_stale,rebuild_vectors
    --merge-ids K:R,... For dedup: keepId:removeId pairs (e.g. 10:11,20:21:22)
    --project P         Filter by project
    --retain-days N     For purge_stale: keep last N days (default 30)

  optimize              LLM-powered memory optimization (preview by default)
    --run               Execute (default: preview gates)
    --run-all           Execute bypassing gates
    --task T            Comma-separated: re-enrich,normalize,cluster-merge,smart-compress
    --max N             Max items per task (1-100, default 15)
    --scope S           re-enrich scope: narrow (default) or wide

  doctor                Environment diagnostics and benchmarks
    --benchmark         Run perf benchmark and emit JSON

  fts-check <check|rebuild>  FTS5 index check or rebuild

  stats                 Show memory statistics
    --project P         Filter by project
    --days N            Lookback window (default 30)
    --quality           Quality dashboard: lesson rate, LOW_SIGNAL rate, per-type
                        hit/lesson %, top-accessed lessons, R-2 watchdog targets

  context               Show current CLAUDE.md context block
    --json              Output as structured JSON

  browse                Tier-grouped memory dashboard
    --tier T            Filter: working|active|archive
    --project P         Filter by project
    --limit N           Max entries per tier (default 5)

  registry <action>     Manage tool resource registry
    list                List resources [--type skill|agent] [--limit N] (default 20)
    stats               Registry statistics
    search <query>      Search resources [--type skill|agent] [--category C] [--quality Q]
    import              Import resource --name N --resource-type T [--repo-url U] [--local-path P] [--use-cases U]
    remove              Remove resource --name N --resource-type T
    reindex             Rebuild FTS5 index

  activity <action>     Non-memdir event log (v2.31) — bugfix/lesson/bug/discovery/etc.
    save --type T "<title>" [--body "<text>"] [--files f1,f2] [--file path] [--importance 1-3] [--project P]
    search "<query>"    Search events [--type T] [--limit N] [--project P]
    recent [N]          Most recent events [--type T] [--project P]
    show <id>           Show full event row by id

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
  const scopeIdx = args.indexOf('--scope');
  const reenrichScope = scopeIdx >= 0 && args[scopeIdx + 1] === 'wide' ? 'wide' : 'narrow';

  if (!run && !runAll) {
    const preview = optimizePreview(db);
    out('[mem] 🔍 LLM Optimization Preview:');
    out(`  Re-enrich candidates: ${preview.reenrich}${preview.reenrichWide !== undefined && preview.reenrichWide !== null ? `  (wide scope: ${preview.reenrichWide})` : ''}`);
    out(`  Normalize: ${preview.normalizeGateOpen ? `${preview.normalize} unique concepts` : 'gate closed (7-day interval)'}`);
    out(`  Cluster-merge: ${preview.clusterMerge} clusters`);
    out(`  Smart-compress: ${preview.smartCompress} clusters`);
    out(`  Total: ${preview.total} items`);
    out('');
    out('Run with --run to execute, --run-all to bypass gates.');
    out('For R-7 backfill: --run --task re-enrich --scope wide --max N');
    return;
  }

  out(`[mem] Running LLM optimization${reenrichScope === 'wide' ? ' (scope: wide)' : ''}...`);
  const results = await optimizeRun(db, { tasks, maxItems, force: runAll, reenrichScope });

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
  const JSON_SUPPORTED_CMDS = new Set(['search', 'context']);
  if (cmdArgs.includes('--json') && !JSON_SUPPORTED_CMDS.has(cmd)) {
    process.stderr.write(`[mem] Note: --json is supported only on: ${[...JSON_SUPPORTED_CMDS].join(', ')}. "${cmd}" outputs text.\n`);
  }

  try {
    switch (cmd) {
      case 'search':    cmdSearch(db, cmdArgs); break;
      case 'recent':    cmdRecent(db, cmdArgs); break;
      case 'recall':    cmdRecall(db, cmdArgs); break;
      case 'get':       cmdGet(db, cmdArgs); break;
      case 'timeline':  cmdTimeline(db, cmdArgs); break;
      case 'save':      cmdSave(db, cmdArgs); break;
      case 'delete':    cmdDelete(db, cmdArgs); break;
      case 'update':    cmdUpdate(db, cmdArgs); break;
      case 'export':    cmdExport(db, cmdArgs); break;
      case 'compress':  cmdCompress(db, cmdArgs); break;
      case 'maintain':  cmdMaintain(db, cmdArgs); break;
      case 'optimize':  await cmdOptimize(db, cmdArgs); break;
      case 'fts-check': cmdFtsCheck(db, cmdArgs); break;
      case 'stats':     await cmdStats(db, cmdArgs); break;
      case 'context':   cmdContext(db, cmdArgs); break;
      case 'browse':    cmdBrowse(db, cmdArgs); break;
      case 'registry':  cmdRegistry(db, cmdArgs); break;
      case 'import':    await cmdImport(cmdArgs); break;
      case 'enrich':    await cmdEnrich(cmdArgs); break;
      case 'doctor':    await cmdDoctor(db, cmdArgs); break;
      case 'activity':  await cmdActivity(db, cmdArgs); break;
      default:
        out(`[mem] Unknown command: ${cmd}`);
        out('[mem] Run "claude-mem-lite help" for usage');
        process.exitCode = 1;
    }
  } finally {
    try { db.close(); } catch {}
  }
}
