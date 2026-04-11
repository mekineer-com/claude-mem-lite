#!/usr/bin/env node
// claude-mem-lite CLI — lightweight command layer for direct memory access
// No MCP SDK or heavy deps — only imports schema.mjs and utils.mjs

import { homedir } from 'os';
import { ensureDb, DB_PATH, REGISTRY_DB_PATH, checkFTSIntegrity, rebuildFTS } from './schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, jaccardSimilarity, computeMinHash, estimateJaccardFromMinHash, scrubSecrets, cjkBigrams, isoWeekKey, COMPRESSED_PENDING_PURGE, OBS_BM25, SESS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE, DEFAULT_DECAY_HALF_LIFE_MS, getCurrentBranch, notLowSignalTitleClause, LOW_SIGNAL_TITLE } from './utils.mjs';
import { extractCjkLikePatterns } from './nlp.mjs';
import { resolveProject } from './project-utils.mjs';
import { computeTier, TIER_CASE_SQL, tierSqlParams } from './tier.mjs';
import { getVocabulary, computeVector, vectorSearch, rrfMerge, VECTOR_SCAN_LIMIT, rebuildVocabulary, _resetVocabCache } from './tfidf.mjs';
import { autoBoostIfNeeded, reRankWithContext, markSuperseded, extractPRFTerms, expandQueryByConcepts } from './server-internals.mjs';
import { ensureRegistryDb, upsertResource } from './registry.mjs';
import { searchResources } from './registry-retriever.mjs';
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
import { buildSessionContextLines } from './hook-context.mjs';
import { basename } from 'path';
import { readFileSync } from 'fs';

// OBS_BM25, TYPE_DECAY_CASE imported from utils.mjs

// ─── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && (!next.startsWith('-') || /^-\d/.test(next))) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg === '-h') {
      flags.help = true;
      i++;
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function out(text) {
  process.stdout.write(text + '\n');
}

function fail(text) {
  process.stderr.write(text + '\n');
  process.exitCode = 1;
}

function relativeTime(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fmtDateShort(iso) {
  if (!iso) return '';
  return iso.slice(0, 10); // YYYY-MM-DD
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdSearch(db, args) {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ');
  if (!query) {
    fail('[mem] Usage: mem search <query> [--type TYPE] [--source SOURCE] [--limit N] [--project P] [--from DATE] [--to DATE] [--importance N] [--branch B] [--offset N] [--sort relevance|time|importance] [--include-noise]');
    return;
  }

  const rawLimit = flags.limit !== undefined ? parseInt(flags.limit, 10) : NaN;
  const limit = Number.isInteger(rawLimit) ? Math.max(1, rawLimit) : 20;
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
  const minImportance = flags.importance !== undefined ? parseInt(flags.importance, 10) : null;
  if (minImportance !== null && (isNaN(minImportance) || minImportance < 1 || minImportance > 3)) {
    fail(`[mem] Invalid --importance "${flags.importance}". Must be 1, 2, or 3.`);
    return;
  }
  const branch = flags.branch || null;
  const offset = Math.max(0, parseInt(flags.offset, 10) || 0);
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

  const results = [];

  // Search observations
  if (!effectiveSource || effectiveSource === 'observations') {
    let obsRows = searchFts(db, ftsQuery, { type, project, limit, dateFrom, dateTo, minImportance, branch, includeNoise, offset: effectiveSource ? offset : 0 });
    if (obsRows.length === 0) {
      const orQuery = relaxFtsQueryToOr(ftsQuery);
      if (orQuery) {
        try { obsRows = searchFts(db, orQuery, { type, project, limit, dateFrom, dateTo, minImportance, branch, includeNoise, offset: effectiveSource ? offset : 0 }); } catch {}
      }
    }
    // Type-list fallback
    if (obsRows.length === 0 && type) {
      const typeWheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL', 'type = ?'];
      const typeParams = [type];
      if (project) { typeWheres.push('project = ?'); typeParams.push(project); }
      if (dateFrom) { typeWheres.push('created_at_epoch >= ?'); typeParams.push(dateFrom); }
      if (dateTo) { typeWheres.push('created_at_epoch <= ?'); typeParams.push(dateTo); }
      if (minImportance) { typeWheres.push('COALESCE(importance, 1) >= ?'); typeParams.push(minImportance); }
      if (branch) { typeWheres.push('branch = ?'); typeParams.push(branch); }
      typeParams.push(limit);
      obsRows = db.prepare(`
        SELECT id, type, title, subtitle, created_at, lesson_learned
        FROM observations
        WHERE ${typeWheres.join(' AND ')}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `).all(...typeParams);
    }
    for (const r of obsRows) results.push({ ...r, _source: 'obs', score: r.score ?? 0 });

    // Concept co-occurrence + PRF expansion (aligned with MCP searchObservations)
    if (obsRows.length > 0 && results.filter(r => r._source === 'obs').length < Math.ceil(limit / 2)) {
      const existingIds = new Set(results.filter(r => r._source === 'obs').map(r => r.id));
      // Concept co-occurrence expansion
      const expanded = expandQueryByConcepts(db, ftsQuery, project || null);
      if (expanded.length > 0) {
        const expansionFts = expanded.map(c => `"${c.replace(/"/g, '""')}"`).join(' OR ');
        try {
          const expRows = searchFts(db, expansionFts, { type, project, limit, dateFrom, dateTo, minImportance, branch, includeNoise, offset: 0 });
          for (const r of expRows) {
            if (!existingIds.has(r.id)) {
              existingIds.add(r.id);
              results.push({ ...r, _source: 'obs', score: (r.score ?? 0) * 0.7 });
            }
          }
        } catch { /* expansion is best-effort */ }
      }
      // PRF expansion (only if ≥3 primary results)
      if (obsRows.length >= 3) {
        const topResults = db.prepare(`
          SELECT o.title, o.narrative FROM observations_fts
          JOIN observations o ON observations_fts.rowid = o.id
          WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
            AND (? IS NULL OR o.project = ?)
          ORDER BY ${OBS_BM25}
          LIMIT 8
        `).all(ftsQuery, project ?? null, project ?? null);
        const prfTerms = extractPRFTerms(topResults, ftsQuery);
        if (prfTerms.length > 0) {
          const prfFts = prfTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
          try {
            const prfRows = searchFts(db, prfFts, { type, project, limit, dateFrom, dateTo, minImportance, branch, includeNoise, offset: 0 });
            for (const r of prfRows) {
              if (!existingIds.has(r.id)) {
                existingIds.add(r.id);
                results.push({ ...r, _source: 'obs', score: (r.score ?? 0) * 0.6 });
              }
            }
          } catch { /* PRF is best-effort */ }
        }
      }
    }

    // Tier post-filter — applied to ALL obs results (initial + expansion + PRF)
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
    sessParams.push(effectiveSource ? limit : limit, effectiveSource ? offset : 0);
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
    promptParams.push(effectiveSource ? limit : limit, effectiveSource ? offset : 0);
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
      for (const r of promptRows) results.push({ ...r, _source: 'prompt' });
      // CJK LIKE fallback: FTS5 unicode61 can't tokenize CJK substrings in prompts
      if (promptRows.length === 0) {
        const cjkPatterns = extractCjkLikePatterns(query);
        if (cjkPatterns.length > 0) {
          const likeConds = cjkPatterns.map(() => 'p.prompt_text LIKE ?');
          const likeParams = cjkPatterns.map(p => `%${p}%`);
          if (project) likeParams.push(project);
          if (dateFrom) likeParams.push(dateFrom);
          if (dateTo) likeParams.push(dateTo);
          likeParams.push(effectiveSource ? limit : limit, effectiveSource ? offset : 0);
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
          for (const r of fallbackRows) results.push({ ...r, _source: 'prompt', score: 0 });
        }
      }
    } catch { /* prompt FTS may not exist in older DBs */ }
  }

  if (results.length === 0) {
    out(`[mem] No results for "${query}"`);
    return;
  }

  // Cross-source score normalization (aligned with MCP mem_search)
  const isCrossSource = !effectiveSource;
  if (isCrossSource && results.length > 0) {
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
  const paged = results.slice(offset, offset + limit);

  if (paged.length === 0) {
    out(`[mem] No results for "${query}" at offset ${offset}`);
    return;
  }

  const showTime = sort === 'time';
  const hasMixed = paged.some(r => r._source === 'session' || r._source === 'prompt');
  out(`[mem] ${paged.length} result${paged.length !== 1 ? 's' : ''} for "${query}":${hasMixed ? ' (# observation, S# session, P# prompt)' : ''}`);
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

function searchFts(db, ftsQuery, { type, project, limit, dateFrom, dateTo, minImportance, branch, includeNoise, offset }) {
  const now = Date.now();
  // Current project for boost (2× when no explicit project filter)
  const currentProject = !project ? inferProject() : null;

  // WHERE clause params (positional ? in SQL order)
  const whereParams = [ftsQuery];
  const wheres = [
    'observations_fts MATCH ?',
    'COALESCE(o.compressed_into, 0) = 0',
    'o.superseded_at IS NULL',
  ];
  if (project) { wheres.push('o.project = ?'); whereParams.push(project); }
  if (type) { wheres.push('o.type = ?'); whereParams.push(type); }
  if (dateFrom) { wheres.push('o.created_at_epoch >= ?'); whereParams.push(dateFrom); }
  if (dateTo) { wheres.push('o.created_at_epoch <= ?'); whereParams.push(dateTo); }
  if (minImportance) { wheres.push('COALESCE(o.importance, 1) >= ?'); whereParams.push(minImportance); }
  if (branch) { wheres.push('o.branch = ?'); whereParams.push(branch); }
  // R-1: exclude hook-llm fallback titles ("Modified X", "Worked on X", raw error logs)
  // from default search. They compete for BM25 rank but have ~3% access rate. Mirrors the
  // filter already applied in hook-memory.mjs, hook-context.mjs, and user-prompt-search.js.
  // Use --include-noise to audit them.
  if (!includeNoise) wheres.push(notLowSignalTitleClause('o'));

  // Param order: SELECT scoring (now, proj, proj) → WHERE (ftsQuery, filters...) → ORDER BY scoring (now, proj, proj) → LIMIT/OFFSET
  const scoreParams = [now, currentProject, currentProject];
  const params = [...scoreParams, ...whereParams, ...scoreParams, limit, offset || 0];

  // Scoring aligned with server.mjs: BM25 × type-decay × type-quality × project_boost × importance × access_bonus × lesson-boost
  // R-3: lesson_learned presence adds a +0.3 multiplier (empirical: +6.3pp hit-rate lift on bugfix).
  const ftsRows = db.prepare(`
    SELECT o.id, o.type, o.title, o.subtitle, o.created_at, o.created_at_epoch, o.lesson_learned,
           o.files_modified, o.importance,
           ${OBS_BM25}
             * (1.0 + EXP(-0.693 * (? - MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))) / ${TYPE_DECAY_CASE}))
             * ${TYPE_QUALITY_CASE}
             * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
             * (0.5 + 0.5 * COALESCE(o.importance, 1))
             * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
             * (1.0 + 0.3 * (o.lesson_learned IS NOT NULL)) as score
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE ${wheres.join(' AND ')}
    ORDER BY ${OBS_BM25}
      * (1.0 + EXP(-0.693 * (? - MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))) / ${TYPE_DECAY_CASE}))
      * ${TYPE_QUALITY_CASE}
      * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
      * (0.5 + 0.5 * COALESCE(o.importance, 1))
      * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
      * (1.0 + 0.3 * (o.lesson_learned IS NOT NULL))
    LIMIT ? OFFSET ?
  `).all(...params);

  // Hybrid: vector search + RRF merge (best-effort)
  try {
    const vocab = getVocabulary(db);
    if (vocab) {
      const queryText = ftsQuery.replace(/['"()]/g, ' ');
      const queryVec = computeVector(queryText, vocab);
      if (queryVec) {
        const vecResults = vectorSearch(db, queryVec, {
          project: project || null,
          vocabVersion: vocab.version,
          limit: VECTOR_SCAN_LIMIT,
        });
        if (vecResults.length > 0 && ftsRows.length > 0) {
          const rrfRanking = rrfMerge(ftsRows, vecResults);
          const rowMap = new Map(ftsRows.map(r => [r.id, r]));
          for (const vr of vecResults) {
            if (!rowMap.has(vr.id)) {
              const obs = db.prepare('SELECT id, type, title, subtitle, created_at, created_at_epoch, lesson_learned, importance, branch, files_modified FROM observations WHERE id = ?').get(vr.id);
              if (obs) {
                // Apply same filters as FTS5 query (aligned with MCP searchObservations)
                if (dateFrom && obs.created_at_epoch < dateFrom) continue;
                if (dateTo && obs.created_at_epoch > dateTo) continue;
                if (minImportance && (obs.importance ?? 1) < minImportance) continue;
                if (branch && obs.branch !== branch) continue;
                // R-1: LOW_SIGNAL filter also applies to vector-side additions (the SQL
                // clause only filtered the FTS5 side) so RRF can't re-admit noise.
                if (!includeNoise && obs.title && LOW_SIGNAL_TITLE.test(obs.title)) continue;
                rowMap.set(vr.id, obs);
              }
            }
          }
          return rrfRanking
            .filter(rr => rowMap.has(rr.id))
            .map(rr => rowMap.get(rr.id))
            .slice(0, limit);
        } else if (vecResults.length > 0 && ftsRows.length === 0) {
          return vecResults
            .map(vr => db.prepare('SELECT id, type, title, subtitle, created_at, created_at_epoch, lesson_learned, importance, branch FROM observations WHERE id = ?').get(vr.id))
            .filter(obs => {
              if (!obs) return false;
              if (dateFrom && obs.created_at_epoch < dateFrom) return false;
              if (dateTo && obs.created_at_epoch > dateTo) return false;
              if (minImportance && (obs.importance ?? 1) < minImportance) return false;
              if (branch && obs.branch !== branch) return false;
              if (!includeNoise && obs.title && LOW_SIGNAL_TITLE.test(obs.title)) return false;
              return true;
            })
            .slice(0, limit);
        }
      }
    }
  } catch { /* vector search is best-effort */ }

  return ftsRows;
}

function cmdRecent(db, args) {
  const { positional, flags } = parseArgs(args);
  const rawLimit = parseInt(positional[0], 10);
  const limit = (Number.isInteger(rawLimit) && rawLimit > 0) ? rawLimit : 10;
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
    out(`#${String(r.id).padStart(5)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
  }
}

function cmdRecall(db, args) {
  const { positional, flags } = parseArgs(args);
  const file = positional.join(' ');
  if (!file) {
    fail('[mem] Usage: mem recall <file>');
    return;
  }

  const filename = basename(file);
  const rawLimit = flags.limit !== undefined ? parseInt(flags.limit, 10) : NaN;
  const limit = Number.isInteger(rawLimit) ? Math.max(1, rawLimit) : 10;

  // Search via observation_files junction table for indexed filename lookups
  const escaped = filename.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const likePattern = `%${escaped}`;
  const rows = db.prepare(`
    SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned, o.created_at, o.project
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE COALESCE(o.compressed_into, 0) = 0
      AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
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

function cmdGet(db, args) {
  const { positional, flags } = parseArgs(args);
  const idStr = positional.join(',');
  if (!idStr) {
    fail('[mem] Usage: mem get <id1,id2,...> [--source obs|session|prompt] [--fields f1,f2,...]');
    return;
  }

  const ids = idStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (ids.length === 0) {
    fail('[mem] No valid IDs provided');
    return;
  }

  const source = flags.source || 'obs';
  const placeholders = ids.map(() => '?').join(',');

  if (source === 'session') {
    const rows = db.prepare(`SELECT * FROM session_summaries WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...ids);
    if (rows.length === 0) { fail('[mem] No sessions found for given IDs'); return; }
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
    out(parts.join('\n\n'));
    return;
  }

  if (source === 'prompt') {
    const rows = db.prepare(`SELECT * FROM user_prompts WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...ids);
    if (rows.length === 0) { fail('[mem] No prompts found for given IDs'); return; }
    const parts = [];
    for (const r of rows) {
      const lines = [`P#${r.id} ${fmtDateShort(r.created_at)}`];
      if (r.prompt_text) lines.push(`Text: ${r.prompt_text}`);
      if (r.content_session_id) lines.push(`Session: ${r.content_session_id}`);
      parts.push(lines.join('\n'));
    }
    out(parts.join('\n\n'));
    return;
  }

  // Default: observations (aligned with MCP mem_get)
  const OBS_FIELDS = ['id', 'type', 'title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned', 'search_aliases', 'files_read', 'files_modified', 'project', 'created_at', 'memory_session_id', 'prompt_number', 'importance', 'related_ids', 'access_count', 'branch', 'superseded_at', 'superseded_by', 'last_accessed_at'];
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

  // Update access_count + auto-boost (aligned with MCP mem_get)
  try {
    db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${placeholders})`).run(Date.now(), ...ids);
    autoBoostIfNeeded(db, ids);
  } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }

  const rows = db.prepare(`
    SELECT * FROM observations
    WHERE id IN (${placeholders})
    ORDER BY created_at_epoch ASC
  `).all(...ids);

  if (rows.length === 0) {
    fail('[mem] No observations found for given IDs');
    return;
  }

  const fields = requestedFields || OBS_FIELDS;
  const parts = [];
  for (const r of rows) {
    const lines = [`#${r.id} [${r.type}] ${fmtDateShort(r.created_at)}`];
    for (const f of fields) {
      if (f === 'id' || f === 'type' || f === 'created_at') continue; // already in header
      const val = r[f];
      if (val === null || val === undefined || val === '') continue;
      // Skip 'text' field when it duplicates narrative (aligned with MCP mem_get)
      if (f === 'text' && r.narrative && typeof val === 'string' && val.startsWith(r.narrative)) continue;
      const maxLen = f === 'narrative' ? 1000 : f === 'lesson_learned' ? 500 : f === 'text' ? 500 : 200;
      const display = typeof val === 'string' && val.length > maxLen ? val.slice(0, maxLen) + '…' : val;
      lines.push(`${f}: ${display}`);
    }
    parts.push(lines.join('\n'));
  }

  out(parts.join('\n\n'));
}

function cmdTimeline(db, args) {
  const { positional, flags } = parseArgs(args);
  let anchorId = parseInt(flags.anchor, 10);
  const before = parseInt(flags.before, 10) || 5;
  const after = parseInt(flags.after, 10) || 5;
  const project = flags.project ? resolveProject(db, flags.project) : null;

  // Support query-based anchor: `timeline --query "search terms"` or positional
  // Uses recency-weighted BM25 + project filter (aligned with MCP mem_timeline)
  const queryStr = flags.query || positional.join(' ');
  if ((!anchorId || isNaN(anchorId)) && queryStr) {
    const ftsQuery = sanitizeFtsQuery(queryStr);
    if (ftsQuery) {
      const nowT = Date.now();
      const match = db.prepare(`
        SELECT o.id FROM observations_fts
        JOIN observations o ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
          AND (? IS NULL OR o.project = ?)
          AND COALESCE(o.compressed_into, 0) = 0
        ORDER BY ${OBS_BM25}
          * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${DEFAULT_DECAY_HALF_LIFE_MS}.0))
        LIMIT 1
      `).get(ftsQuery, project ?? null, project ?? null, nowT);
      if (match) anchorId = match.id;
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
      out(`#${String(r.id).padStart(5)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
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

  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

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

  out(`[mem] Timeline around #${anchorId}:`);
  for (const r of all) {
    const marker = r.id === anchorId ? ' <--' : '';
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 80);
    out(`#${String(r.id).padStart(5)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}${marker}`);
  }
}

function cmdSave(db, args) {
  const { positional, flags } = parseArgs(args);
  const text = positional.join(' ');
  if (!text) {
    fail('[mem] Usage: mem save "<text>" [--type T] [--title T] [--importance N] [--project P] [--files f1,f2]');
    return;
  }

  const type = flags.type || 'discovery';
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  if (!validTypes.has(type)) {
    fail(`[mem] Invalid type "${type}". Valid: ${[...validTypes].join(', ')}`);
    return;
  }

  const rawTitle = flags.title || text.slice(0, 100);
  // Explicit saves default to importance=2 (notable) — user chose to save
  const rawImp = flags.importance !== undefined ? parseInt(flags.importance, 10) : 2;
  if (flags.importance !== undefined && (isNaN(rawImp) || rawImp < 1 || rawImp > 3)) {
    fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
    return;
  }
  const importance = rawImp;
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const saveFiles = flags.files ? flags.files.split(',').map(f => f.trim()).filter(Boolean) : [];

  // Secret scrubbing (aligned with MCP mem_save)
  const safeContent = scrubSecrets(text);
  const safeTitle = scrubSecrets(rawTitle);

  // Dedup: skip if similar title/content saved in last 5 minutes (aligned with MCP mem_save)
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recent = db.prepare(`
    SELECT id, title, text FROM observations
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC LIMIT 50
  `).all(project, fiveMinAgo);

  const dupMatch = recent.find(r =>
    jaccardSimilarity(r.title, safeTitle) > 0.7 ||
    jaccardSimilarity(r.text || '', safeContent) > 0.7
  );
  if (dupMatch) {
    out(`[mem] Skipped: similar to existing #${dupMatch.id}. Use "claude-mem-lite get ${dupMatch.id}" to review.`);
    return;
  }

  // MinHash + CJK bigrams (aligned with MCP mem_save)
  const minhashSig = computeMinHash(safeTitle + ' ' + safeContent);
  const bigramText = cjkBigrams(safeTitle + ' ' + safeContent);
  const textField = bigramText ? safeContent + ' ' + bigramText : safeContent;

  const now = new Date();
  const sessionId = `manual-${project}`;

  // Ensure a session exists for the FK constraint
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

  // Atomic: insert observation + observation_files + TF-IDF vector (aligned with MCP mem_save)
  const saveTx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, branch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', ?, ?, ?, ?, ?, ?)
    `).run(sessionId, project, textField, type, safeTitle, safeContent, JSON.stringify(saveFiles), importance, minhashSig, getCurrentBranch(), now.toISOString(), now.getTime());
    const savedId = Number(result.lastInsertRowid);

    // Populate observation_files junction table (aligned with MCP mem_save)
    if (savedId && saveFiles.length > 0) {
      const insertFile = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
      for (const f of saveFiles) insertFile.run(savedId, f);
    }

    // Write TF-IDF vector
    try {
      const vocab = getVocabulary(db);
      if (vocab) {
        const vec = computeVector(safeTitle + ' ' + safeContent, vocab);
        if (vec) {
          db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
            .run(savedId, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
    } catch { /* non-critical */ }

    return result;
  });
  const result = saveTx();

  out(`[mem] Saved #${result.lastInsertRowid} [${type}] "${truncate(safeTitle, 80)}" (project: ${project})`);
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
function renderQualityReport(db, { project, days }) {
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];
  const now = Date.now();
  const cutoff = now - days * 86400000;

  // LOW_SIGNAL is the inverse of notLowSignalTitleClause() — inline a SUM(CASE)
  // that flips the sign so we count titles that DO match the LOW_SIGNAL regex.
  const lowSignalIsMatchExpr = `NOT ${notLowSignalTitleClause('')}`;

  // Unresolved-bugfix detection: narrative-text proxies for "investigation in progress,
  // never reached a fix". Heuristic — false positives possible (e.g. a real lesson noting
  // "the bug persists in legacy clients"), but the directional signal is what we care about.
  // R-7 micro-experiment surfaced this pollution: ~3/5 of randomly-sampled bugfix narratives
  // explicitly ended with "root cause not yet identified".
  const unresolvedNarrativeExpr = `(
    LOWER(COALESCE(narrative,'')) LIKE '%not yet identified%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%not yet resolved%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%not yet fixed%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%root cause not%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%still fail%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%errors persisted%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%persisted on retry%'
  )`;

  // In-window aggregates
  const windowRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END) as with_lesson,
      SUM(CASE WHEN ${lowSignalIsMatchExpr} THEN 1 ELSE 0 END) as low_signal,
      SUM(CASE WHEN type = 'bugfix' THEN 1 ELSE 0 END) as bugfix_total,
      SUM(CASE WHEN type = 'bugfix' AND ${unresolvedNarrativeExpr} THEN 1 ELSE 0 END) as bugfix_unresolved
    FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
  `).get(cutoff, ...baseParams);

  // All-time aggregates (context for recent numbers)
  const allTimeRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END) as with_lesson,
      SUM(CASE WHEN ${lowSignalIsMatchExpr} THEN 1 ELSE 0 END) as low_signal
    FROM observations
    WHERE 1=1 ${projectFilter}
  `).get(...baseParams);

  // Per-type: count, hit rate (access_count > 0), lesson rate
  const typeRows = db.prepare(`
    SELECT
      type,
      COUNT(*) as total,
      SUM(CASE WHEN COALESCE(access_count, 0) > 0 THEN 1 ELSE 0 END) as accessed,
      SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END) as with_lesson
    FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
    GROUP BY type
    ORDER BY total DESC
  `).all(cutoff, ...baseParams);

  // Top-5 most-accessed lessons (all-time, this project scope)
  const topLessons = db.prepare(`
    SELECT id, type, title, lesson_learned, COALESCE(access_count, 0) as ac
    FROM observations
    WHERE lesson_learned IS NOT NULL AND lesson_learned != ''
      AND COALESCE(access_count, 0) > 0
      AND COALESCE(compressed_into, 0) = 0
      ${projectFilter}
    ORDER BY ac DESC
    LIMIT 5
  `).all(...baseParams);

  const pct = (n, d) => d > 0 ? (100 * n / d).toFixed(1) : '0.0';
  const scope = project ? ` — ${project}` : '';
  out(`[mem] Quality snapshot${scope} — window: ${days}d`);
  out('────────────────────────────────────────────────────');
  out(`  Writes (${days}d):     ${windowRow.total} observations`);

  const lessonPct = pct(windowRow.with_lesson, windowRow.total);
  const allLessonPct = pct(allTimeRow.with_lesson, allTimeRow.total);
  out(`  Lesson rate:      ${windowRow.with_lesson} / ${windowRow.total} (${lessonPct}%)    [all-time: ${allTimeRow.with_lesson} / ${allTimeRow.total} = ${allLessonPct}%]`);

  const noisePct = pct(windowRow.low_signal, windowRow.total);
  const allNoisePct = pct(allTimeRow.low_signal, allTimeRow.total);
  out(`  LOW_SIGNAL:       ${windowRow.low_signal} / ${windowRow.total} (${noisePct}%)    [all-time: ${allTimeRow.low_signal} / ${allTimeRow.total} = ${allNoisePct}%]`);

  if (windowRow.bugfix_total > 0) {
    const unresolvedPct = pct(windowRow.bugfix_unresolved, windowRow.bugfix_total);
    out(`  Unresolved bugfix: ${windowRow.bugfix_unresolved} / ${windowRow.bugfix_total} (${unresolvedPct}%)    [investigation-only narratives — should trend ↓ with R-6 manual-save contract]`);
  }
  out('');

  if (typeRows.length > 0) {
    out(`  Type breakdown (${days}d):`);
    for (const r of typeRows) {
      const hit = pct(r.accessed, r.total);
      const lp = pct(r.with_lesson, r.total);
      const typeLabel = r.type.padEnd(10);
      // padStart(5) on count so rows align up to 5-digit totals (99999).
      out(`    ${typeLabel}${String(r.total).padStart(5)}   hit ${hit.padStart(5)}%   lesson ${lp.padStart(5)}%`);
    }
    out('');
  }

  if (topLessons.length > 0) {
    out('  Top accessed lessons (all-time):');
    for (const l of topLessons) {
      const t = truncate(l.lesson_learned, 80);
      out(`    #${l.id} [${l.type}] (${l.ac}x) ${t}`);
    }
    out('');
  }

  // R-2 watchdog — explicit targets make progress legible.
  const lessonNum = parseFloat(lessonPct);
  const noiseNum = parseFloat(noisePct);
  const lessonGap = (lessonNum - 15).toFixed(1);
  const noiseGap = (noiseNum - 30).toFixed(1);
  const lessonStatus = lessonNum >= 15 ? '✅' : '🔴';
  const noiseStatus = noiseNum <= 30 ? '✅' : '🔴';
  out('  Targets (R-2 watchdog):');
  out(`    ${lessonStatus} Lesson rate ≥ 15%    → currently ${lessonPct}%  (gap ${lessonGap >= 0 ? '+' : ''}${lessonGap}pp)`);
  out(`    ${noiseStatus} LOW_SIGNAL  ≤ 30%    → currently ${noisePct}%  (gap ${noiseGap >= 0 ? '+' : ''}${noiseGap}pp)`);
}

function cmdStats(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const days = parseInt(flags.days, 10) || 30;
  // N-1: --quality routes to a separate quality-focused report (lesson rate,
  // LOW_SIGNAL rate, per-type hit+lesson %, R-2 watchdog targets). Intended as
  // the baseline metric dashboard for the future Haiku prompt A/B test.
  const quality = flags.quality === true || flags.quality === 'true';
  if (quality) {
    renderQualityReport(db, { project, days });
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
  out('Tier distribution:');
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
    fail('[mem] Usage: mem delete <id1,id2,...> [--confirm]');
    return;
  }

  const ids = idStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
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
  const id = parseInt(positional[0], 10);
  if (!id || isNaN(id)) {
    fail('[mem] Usage: mem update <id> [--title T] [--type T] [--importance N] [--lesson T] [--narrative T] [--concepts T]');
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
  if (flags.from) {
    const epoch = new Date(flags.from).getTime();
    if (isNaN(epoch)) { fail(`[mem] Invalid --from date: "${flags.from}". Use YYYY-MM-DD or ISO 8601.`); return; }
    wheres.push('created_at_epoch >= ?'); params.push(epoch);
  }
  if (flags.to) {
    let epoch = new Date(flags.to).getTime();
    if (isNaN(epoch)) { fail(`[mem] Invalid --to date: "${flags.to}". Use YYYY-MM-DD or ISO 8601.`); return; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(flags.to)) epoch += 86400000 - 1;
    wheres.push('created_at_epoch <= ?'); params.push(epoch);
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
    out('[mem] No observations found matching criteria');
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
    fail('[mem] Usage: mem maintain <scan|execute> [--ops cleanup,decay,boost,dedup,purge_stale,rebuild_vectors] [--project P] [--retain-days N] [--merge-ids keepId:removeId,...]');
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
      results.push(`Cleaned up ${deleted.changes} broken observations`);
    }

    if (ops.includes('decay')) {
      const decayed = db.prepare(`
        UPDATE observations SET importance = MAX(1, COALESCE(importance, 1) - 1)
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(importance, 1) > 1
            AND COALESCE(access_count, 0) = 0
            AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(staleAge, ...baseParams);

      // Mark importance=1, never-accessed, old observations as pending-purge (aligned with MCP)
      const idleMarked = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(importance, 1) = 1
            AND COALESCE(access_count, 0) = 0
            AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(staleAge, ...baseParams);
      results.push(`Decayed ${decayed.changes} stale observations, marked ${idleMarked.changes} idle as pending-purge`);
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
      results.push(`Boosted ${boosted.changes} frequently-accessed observations`);
    }

    if (ops.includes('dedup') && flags['merge-ids']) {
      // Parse merge-ids: "keepId:removeId1:removeId2,keepId2:removeId3" format
      let totalMerged = 0;
      const mergeStmt = db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ? AND COALESCE(compressed_into, 0) = 0');
      const groups = flags['merge-ids'].split(',').map(g => g.trim().split(':').map(Number).filter(n => !isNaN(n)));
      for (const group of groups) {
        if (group.length < 2) continue;
        const [keepId, ...removeIds] = group;
        for (const removeId of removeIds) {
          totalMerged += mergeStmt.run(keepId, removeId).changes;
        }
      }
      results.push(`Merged ${totalMerged} duplicate observations`);
    }

    if (ops.includes('purge_stale')) {
      const retainDays = parseInt(flags['retain-days'], 10) || 30;
      const retainCutoff = Date.now() - retainDays * 86400000;
      const purged = db.prepare(`
        DELETE FROM observations WHERE id IN (
          SELECT id FROM observations
          WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(retainCutoff, ...baseParams);
      results.push(`Purged ${purged.changes} stale observations`);
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

// ─── FTS Check ───────────────────────────────────────────────────────────────

function cmdFtsCheck(db, args) {
  const { positional } = parseArgs(args);
  const action = positional[0];
  if (!action || !['check', 'rebuild'].includes(action)) {
    fail('[mem] Usage: mem fts-check <check|rebuild>');
    return;
  }

  if (action === 'check') {
    const result = checkFTSIntegrity(db);
    if (result.healthy) {
      out('[mem] FTS5 indexes are healthy — all integrity checks passed.');
    } else {
      out(`[mem] FTS5 issues found:`);
      for (const d of result.details) out(`  ${d}`);
    }
    return;
  }

  if (action === 'rebuild') {
    const result = rebuildFTS(db);
    if (result.errors.length > 0) {
      out(`[mem] Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`);
    } else {
      out(`[mem] Successfully rebuilt: ${result.rebuilt.join(', ')}`);
    }
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function cmdRegistry(_memDb, args) {
  const { positional, flags } = parseArgs(args);
  const action = positional[0];
  if (!action || !['list', 'stats', 'search', 'import', 'remove', 'reindex'].includes(action)) {
    fail('[mem] Usage: mem registry <list|stats|search|import|remove|reindex> [--type skill|agent] [--query Q] [--name N] [--resource-type T]');
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
      if (!query) { fail('[mem] Usage: mem registry search <query> [--type skill|agent] [--category C] [--quality Q]'); return; }
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
      if (!name || !resourceType) { fail('[mem] Usage: mem registry import --name N --resource-type skill|agent [--invocation-name I] [--capability-summary S]'); return; }
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
      if (!name || !resourceType) { fail('[mem] Usage: mem registry remove --name N --resource-type skill|agent'); return; }
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

  recent [N]            Show N most recent observations (default 10)
    --project P         Filter by project

  recall <file>         Show observations related to a file
    --limit N           Max results (default 10)

  get <id1,id2,...>     Get full details by ID
    --source S          Record type: obs (default), session, prompt
    --fields f1,f2,...  Select specific fields to return

  timeline              Show observations around an anchor (shows recent if no anchor)
    --anchor ID         Center on this observation ID
    --query "text"      Find anchor by FTS5 search
    --before N          Show N before anchor (default 5)
    --after N           Show N after anchor (default 5)
    --project P         Filter by project

  save "<text>"         Save a new observation
    --type T            Observation type (default: discovery)
    --title T           Title (auto-generated if omitted)
    --importance N      1-3 (default: 2)
    --project P         Project name
    --files f1,f2       Comma-separated file paths

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
  const taskIdx = args.indexOf('--task');
  const tasks = taskIdx >= 0 && args[taskIdx + 1] ? [args[taskIdx + 1]] : undefined;
  const maxIdx = args.indexOf('--max');
  const maxItems = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) || 15 : 15;
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

  let db;
  try {
    db = ensureDb();
  } catch (e) {
    out(`[mem] Error: Cannot open database: ${e.message}`);
    out(`[mem] DB path: ${DB_PATH}`);
    process.exitCode = 1;
    return;
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
      case 'stats':     cmdStats(db, cmdArgs); break;
      case 'context':   cmdContext(db, cmdArgs); break;
      case 'browse':    cmdBrowse(db, cmdArgs); break;
      case 'registry':  cmdRegistry(db, cmdArgs); break;
      case 'import':    await cmdImport(cmdArgs); break;
      case 'enrich':    await cmdEnrich(cmdArgs); break;
      default:
        out(`[mem] Unknown command: ${cmd}`);
        out('[mem] Run "claude-mem-lite help" for usage');
        process.exitCode = 1;
    }
  } finally {
    try { db.close(); } catch {}
  }
}
