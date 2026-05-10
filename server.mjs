#!/usr/bin/env node
// claude-mem-lite MCP Server — All-in-one memory system
// FTS5 search, zero LLM calls, single process

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { jaccardSimilarity, truncate, typeIcon, sanitizeFtsQuery, relaxFtsQueryToOr, inferProject, computeMinHash, estimateJaccardFromMinHash, scrubSecrets, cjkBigrams, fmtDate, isoWeekKey, debugLog, debugCatch, COMPRESSED_PENDING_PURGE, SESS_BM25, DEFAULT_DECAY_HALF_LIFE_MS, isPathConfined, notLowSignalTitleClause } from './utils.mjs';
import { extractCjkLikePatterns, cjkPrecisionOk } from './nlp.mjs';
import { resolveProject as _resolveProjectShared } from './project-utils.mjs';
import { ensureDb, DB_PATH, REGISTRY_DB_PATH } from './schema.mjs';
import { reRankWithContext, markSuperseded, autoBoostIfNeeded, runIdleCleanup, buildServerInstructions } from './server-internals.mjs';
import { searchObservationsHybrid, findFtsAnchor } from './search-engine.mjs';
import { effectiveQuiet } from './hook-shared.mjs';
import { computeTier, TIER_CASE_SQL, tierSqlParams } from './tier.mjs';
import { memSearchSchema, memRecentSchema, memTimelineSchema, memGetSchema, memDeleteSchema, memSaveSchema, memStatsSchema, memCompressSchema, memMaintainSchema, memOptimizeSchema, memUpdateSchema, memExportSchema, memRecallSchema, memFtsCheckSchema, memRegistrySchema, memBrowseSchema, memUseSchema, tools as TOOL_DEFS } from './tool-schemas.mjs';

// Lookup helper: all user-facing tool descriptions live in tool-schemas.mjs
// (discouragement-style, Task 5). This keeps server.mjs from drifting.
const _toolDescByName = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t.description]));
function descriptionOf(name) {
  const d = _toolDescByName[name];
  if (!d) throw new Error(`tool-schemas.mjs is missing description for "${name}"`);
  return d;
}
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { ensureRegistryDb, upsertResource } from './registry.mjs';
import { searchResources } from './registry-retriever.mjs';
import { probeOtherSources as probeIdSources, parseIdToken, bucketIdTokens } from './lib/id-routing.mjs';
import { saveObservation } from './lib/save-observation.mjs';
import { getVocabulary, rebuildVocabulary, _resetVocabCache, computeVector } from './tfidf.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('./package.json');

// ─── Database ───────────────────────────────────────────────────────────────

import { rmSync, existsSync, readFileSync } from 'fs';

let db;
try {
  db = ensureDb();
} catch (firstErr) {
  // Recovery: remove WAL/SHM files (corrupt WAL is the most common cause) and retry
  debugLog('WARN', 'server', `DB open failed, attempting WAL recovery: ${firstErr.message}`);
  try { rmSync(DB_PATH + '-wal', { force: true }); } catch {}
  try { rmSync(DB_PATH + '-shm', { force: true }); } catch {}
  try {
    db = ensureDb();
    debugLog('INFO', 'server', 'DB recovered after WAL cleanup');
  } catch (retryErr) {
    // Fatal: log and exit with descriptive message (Claude Code shows stderr)
    console.error(`[claude-mem-lite] FATAL: Database cannot be opened: ${retryErr.message}`);
    console.error(`[claude-mem-lite] Try: rm "${DB_PATH}-wal" "${DB_PATH}-shm" or reinstall with: node install.mjs install`);
    process.exit(1);
  }
}
// Server process uses longer busy_timeout for concurrent MCP requests
db.pragma('busy_timeout = 5000');

// ─── Registry Database (lazy-loaded on first mem_registry call) ─────────────

let registryDb = null;

function getRegistryDb() {
  if (registryDb) return registryDb;
  try {
    registryDb = ensureRegistryDb(REGISTRY_DB_PATH);
    registryDb.pragma('busy_timeout = 3000');
  } catch (e) {
    debugLog('WARN', 'server', `Registry DB not available: ${e.message}`);
  }
  return registryDb;
}

// inferProject, jaccardSimilarity, sanitizeFtsQuery, typeIcon, truncate, fmtDate imported from utils.mjs

// ─── Project Name Resolution ────────────────────────────────────────────────
// Users naturally type short names like "mem" but inferProject() stores
// "projects--mem" (parent--base from CWD). resolveProject() bridges this gap.
// Implementation extracted to project-utils.mjs; local adapter closes over module-level `db`.

function resolveProject(name) { return _resolveProjectShared(db, name); }

// ─── Scoring Model Constants ────────────────────────────────────────────────
//
// Composite scoring: BM25(weights) × recency_decay × [project_boost] × [importance] × [access_bonus]
//
// BM25 column weights — higher weight = matches in that column score higher:
//   observations_fts:        title=10, subtitle=5, narrative=5, text=3, facts=3, concepts=2, lesson_learned=8
//   session_summaries_fts:   request=5, investigated=3, learned=3, completed=3, next_steps=2, notes=1, remaining_items=1
//
// Recency decay — exponential half-life:
//   factor = 1 + e^(-ln2 × age_ms / half_life_ms)
//   At age=0: 2.0 (full boost) → at half_life: 1.5 → at ∞: 1.0
//   0.693 = ln(2), ensures exact halving at each half-life interval
//
// Optional per-query modifiers:
//   Project boost: 2× for current project matches
//   Importance:    0.5 + 0.5 × importance (range 0.5–2.0)
//   Access bonus:  1 + 0.1 × ln(1 + access_count)

// SESS_BM25, TYPE_DECAY_CASE imported from utils.mjs
const RECENCY_HALF_LIFE_MS = DEFAULT_DECAY_HALF_LIFE_MS;

// ─── MCP Server ─────────────────────────────────────────────────────────────

// Emit one-line instructions-mode trace on stderr so debugging the "why did
// the server send BASE instead of BASE+VERBOSE?" path doesn't require reading
// three files (server.mjs → hook-shared.mjs → memdir.mjs). CLAUDE_MEM_QUIET_TRACE=0
// opts out. stderr doesn't pollute the MCP stdio protocol channel.
const _quiet = effectiveQuiet();
if (process.env.CLAUDE_MEM_QUIET_TRACE !== '0') {
  const reason = process.env.MEM_QUIET_HOOKS === '1'
    ? 'env:MEM_QUIET_HOOKS=1'
    : _quiet ? 'adopted:MEMORY.md-sentinel' : 'none';
  const mode = _quiet ? 'BASE' : 'BASE+VERBOSE';
  process.stderr.write(`[mem] instructions: ${mode} reason=${reason}\n`);
}

const server = new McpServer(
  { name: 'claude-mem-lite', version: PKG_VERSION },
  { instructions: buildServerInstructions(_quiet) },
);

// Track MCP request activity for idle-time cleanup (see idle timer below)
let lastMcpRequestTime = Date.now();
let idleCleanupRan = false;

function safeHandler(fn) {
  return async (args, extra) => {
    try {
      lastMcpRequestTime = Date.now();
      idleCleanupRan = false;
      return await fn(args, extra);
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

// ─── Tool: mem_search — helper functions ────────────────────────────────────

// TYPE_DECAY_CASE imported from utils.mjs

// Score expression variants for FTS5 queries (see Scoring Model Constants above)
// Observation-search core (FTS query/params builders, hybrid pipeline) lives in
// search-engine.mjs so mem-cli.mjs gets the identical implementation.

// Thin wrapper around the shared engine — keeps the existing call sites
// (searchObservations(ctx)) without ferrying `db` through every layer.
function searchObservations(ctx) {
  return searchObservationsHybrid(db, ctx);
}

function searchSessions(ctx) {
  const { ftsQuery, searchType, args, epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject } = ctx;
  const results = [];

  if (ftsQuery) {
    const now = Date.now();
    const sessionProjectBoost = args.project ? null : currentProject;
    const rows = db.prepare(`
      SELECT s.id, s.request, s.completed, s.project, s.created_at, s.created_at_epoch,
             ${SESS_BM25}
               * (1.0 + EXP(-0.693 * (? - s.created_at_epoch) / ${RECENCY_HALF_LIFE_MS}.0))
               * (CASE WHEN ? IS NOT NULL AND s.project = ? THEN 2.0 ELSE 1.0 END) as score
      FROM session_summaries_fts
      JOIN session_summaries s ON session_summaries_fts.rowid = s.id
      WHERE session_summaries_fts MATCH ?
        AND (? IS NULL OR s.project = ?)
        AND (? IS NULL OR s.created_at_epoch >= ?)
        AND (? IS NULL OR s.created_at_epoch <= ?)
      ORDER BY score
      LIMIT ? OFFSET ?
    `).all(
      now,
      sessionProjectBoost, sessionProjectBoost,
      ftsQuery,
      args.project ?? null, args.project ?? null,
      epochFrom, epochFrom,
      epochTo, epochTo,
      perSourceLimit, perSourceOffset
    );
    for (const r of rows) {
      results.push({ source: 'session', id: r.id, request: r.request, completed: r.completed, project: r.project, date: r.created_at, created_at_epoch: r.created_at_epoch, score: r.score });
    }
  } else if (!searchType) {
    // Skip sessions in unfiltered no-query mode (too noisy)
  } else {
    const params = [];
    const wheres = [];
    if (args.project) { wheres.push('project = ?'); params.push(args.project); }
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
    for (const r of rows) {
      results.push({ source: 'session', id: r.id, request: r.request, completed: r.completed, project: r.project, date: r.created_at, created_at_epoch: r.created_at_epoch });
    }
  }

  return results;
}

function searchPrompts(ctx) {
  const { ftsQuery, searchType, args, epochFrom, epochTo, perSourceLimit, perSourceOffset } = ctx;
  const results = [];

  if (ftsQuery) {
    const rows = db.prepare(`
      SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch,
             bm25(user_prompts_fts, 1) as score
      FROM user_prompts_fts
      JOIN user_prompts p ON user_prompts_fts.rowid = p.id
      JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE user_prompts_fts MATCH ?
        AND p.prompt_text NOT LIKE '<task-notification>%'
        AND (? IS NULL OR s.project = ?)
        AND (? IS NULL OR p.created_at_epoch >= ?)
        AND (? IS NULL OR p.created_at_epoch <= ?)
      ORDER BY score
      LIMIT ? OFFSET ?
    `).all(
      ftsQuery,
      args.project ?? null, args.project ?? null,
      epochFrom, epochFrom,
      epochTo, epochTo,
      perSourceLimit, perSourceOffset
    );
    // CJK precision filter: unicode61 FTS degrades CJK bigram queries to
    // single-char AND, letting any prose sharing common chars leak through.
    // Require ≥30% of query's CJK bigrams/keywords as contiguous substrings.
    const keptRows = args.query ? rows.filter(r => cjkPrecisionOk(args.query, r.prompt_text)) : rows;
    for (const r of keptRows) {
      results.push({ source: 'prompt', id: r.id, text: r.prompt_text, session: r.content_session_id, date: r.created_at, created_at_epoch: r.created_at_epoch, score: r.score });
    }
    // CJK LIKE fallback: FTS5 unicode61 can't tokenize CJK substrings in prompts
    if (keptRows.length === 0 && args.query) {
      const cjkPatterns = extractCjkLikePatterns(args.query);
      if (cjkPatterns.length > 0) {
        const likeConds = cjkPatterns.map(() => 'p.prompt_text LIKE ?');
        const likeParams = cjkPatterns.map(p => `%${p}%`);
        const fallbackRows = db.prepare(`
          SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch
          FROM user_prompts p
          JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
          WHERE (${likeConds.join(' OR ')})
            AND p.prompt_text NOT LIKE '<task-notification>%'
            AND (? IS NULL OR s.project = ?)
            AND (? IS NULL OR p.created_at_epoch >= ?)
            AND (? IS NULL OR p.created_at_epoch <= ?)
          ORDER BY p.created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(
          ...likeParams,
          args.project ?? null, args.project ?? null,
          epochFrom, epochFrom,
          epochTo, epochTo,
          perSourceLimit, perSourceOffset
        );
        // Parity with mem-cli.mjs: the LIKE fallback is an OR'd bigram
        // substring scan with no scoring gate. The precision filter must
        // apply here too — without it, queries whose FTS set is empty
        // re-admit the full common-char noise band that FTS would have
        // dropped downstream anyway.
        const keptFallback = args.query ? fallbackRows.filter(r => cjkPrecisionOk(args.query, r.prompt_text)) : fallbackRows;
        for (const r of keptFallback) {
          results.push({ source: 'prompt', id: r.id, text: r.prompt_text, session: r.content_session_id, date: r.created_at, created_at_epoch: r.created_at_epoch, score: 0 });
        }
      }
    }
  } else if (searchType === 'prompts') {
    const params = [];
    const wheres = [];
    if (args.project) { wheres.push('s.project = ?'); params.push(args.project); }
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
    for (const r of rows) {
      results.push({ source: 'prompt', id: r.id, text: r.prompt_text, session: r.content_session_id, date: r.created_at, created_at_epoch: r.created_at_epoch });
    }
  }

  return results;
}

function formatSearchOutput(paginatedResults, args, ftsQuery, totalCount, isCrossSource, orFallbackFired = false) {
  if (paginatedResults.length === 0) {
    const hint = [];
    if (args.query && !ftsQuery) {
      hint.push(`Query "${args.query}" was filtered (FTS5 keywords/special chars only).`);
      hint.push('Tip: use content words instead of operators (AND, OR, NOT, NEAR).');
    } else {
      hint.push('No results found.');
      if (args.query) {
        const expanded = ftsQuery || args.query;
        if (expanded !== args.query) hint.push(`Searched as: ${expanded}`);
        hint.push('Tip: check spelling, try broader terms, or use mem_stats to see available data.');
      }
    }
    return { content: [{ type: 'text', text: hint.join('\n') }] };
  }

  const lines = [];
  const countLabel = isCrossSource && totalCount > paginatedResults.length
    ? `${paginatedResults.length} of ${totalCount}`
    : `${paginatedResults.length}`;
  const hasMixed = paginatedResults.some(r => r.source === 'session' || r.source === 'prompt');
  // P2-6: empty/omitted query falls through to a "listing recent" path — label it explicitly
  // so callers don't mistake BM25-less results for relevance-ranked ones.
  const qLabel = args.query ? ` for "${args.query}"` : ' (no query — listing recent)';
  // Surface AND→OR fallback so callers (incl. Claude) know a strict multi-term
  // query actually matched only a subset of the terms. Suppressed when the caller
  // explicitly requested OR semantics — there's no "fallback" in that path.
  const fallbackHint = orFallbackFired && !args.or ? ' (relaxed AND→OR)' : '';
  lines.push(`Found ${countLabel} result(s)${qLabel}${fallbackHint}:${hasMixed ? ' (# observation, S# session, P# prompt)' : ''}\n`);

  for (const r of paginatedResults) {
    if (r.source === 'obs') {
      const supersededTag = r.superseded ? ' [SUPERSEDED]' : '';
      lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.date)}${supersededTag}`);
      if (r.snippet && r.snippet.length > 10 && r.snippet !== r.title) {
        lines.push(`     ${truncate(r.snippet, 100)}`);
      }
    } else if (r.source === 'session') {
      lines.push(`S#${r.id} 📋 ${truncate(r.request || r.completed || '(no summary)')} | ${r.project} | ${fmtDate(r.date)}`);
    } else if (r.source === 'prompt') {
      lines.push(`P#${r.id} 💬 ${truncate(r.text)} | ${fmtDate(r.date)}`);
    }
  }

  lines.push(`\nWorkflow: mem_timeline(anchor=ID) for context | mem_get(ids=[...]) for full details`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Tool: mem_search ───────────────────────────────────────────────────────

server.registerTool(
  'mem_search',
  {
    description: descriptionOf('mem_search'),
    inputSchema: memSearchSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    // args.or (Batch A CLI↔MCP alignment): force OR from start, matching
    // CLI `search --or`. The default path still does AND with OR-fallback
    // inside searchObservations when AND returns 0.
    let ftsQuery = sanitizeFtsQuery(args.query);
    if (ftsQuery && args.or) {
      ftsQuery = relaxFtsQueryToOr(ftsQuery) || ftsQuery;
    }
    const searchType = args.type;
    const currentProject = inferProject();

    const isCrossSourceRaw = !searchType;
    const perSourceLimit = isCrossSourceRaw ? Math.max(limit * 3, offset + limit + 10) : limit;
    const perSourceOffset = isCrossSourceRaw ? 0 : offset;

    // Parse date bounds to epoch (with validation)
    // date_to with date-only format (YYYY-MM-DD) extends to end-of-day (23:59:59.999Z)
    const epochFrom = args.date_from ? new Date(args.date_from).getTime() : null;
    let epochTo = args.date_to ? new Date(args.date_to).getTime() : null;
    if (epochTo !== null && args.date_to && /^\d{4}-\d{2}-\d{2}$/.test(args.date_to)) {
      epochTo += 86400000 - 1; // extend to 23:59:59.999
    }
    if (epochFrom !== null && isNaN(epochFrom)) throw new Error(`Invalid date_from: "${args.date_from}" (use ISO 8601 or YYYY-MM-DD)`);
    if (epochTo !== null && isNaN(epochTo)) throw new Error(`Invalid date_to: "${args.date_to}" (use ISO 8601 or YYYY-MM-DD)`);

    // Early return when query was provided but sanitized to nothing (all FTS5 keywords/special chars)
    if (args.query && !ftsQuery && !epochFrom && !epochTo && !args.obs_type && !args.importance) {
      return formatSearchOutput([], args, ftsQuery, 0, false);
    }

    // When obs_type is specified, implicitly restrict to observations only
    const effectiveType = searchType || (args.obs_type ? 'observations' : undefined);
    const isCrossSource = !effectiveType;
    const ctx = { ftsQuery, searchType: effectiveType, args, epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject, limit };
    const results = [];

    if (!effectiveType || effectiveType === 'observations') results.push(...searchObservations(ctx));
    if (!effectiveType || effectiveType === 'sessions')     results.push(...searchSessions(ctx));
    if (!effectiveType || effectiveType === 'prompts')       results.push(...searchPrompts(ctx));

    // Type-list fallback: when obs_type is specified and FTS finds nothing,
    // list recent observations of that type (user likely wants to browse by type)
    if (results.length === 0 && args.obs_type) {
      const typeWheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL', 'type = ?'];
      const typeParams = [args.obs_type];
      if (args.project) { typeWheres.push('project = ?'); typeParams.push(args.project); }
      if (epochFrom !== null) { typeWheres.push('created_at_epoch >= ?'); typeParams.push(epochFrom); }
      if (epochTo !== null) { typeWheres.push('created_at_epoch <= ?'); typeParams.push(epochTo); }
      if (args.importance) { typeWheres.push('COALESCE(importance, 1) >= ?'); typeParams.push(args.importance); }
      typeParams.push(limit);
      const typeRows = db.prepare(`
        SELECT id, type, title, subtitle, project, created_at, importance, files_modified
        FROM observations WHERE ${typeWheres.join(' AND ')}
        ORDER BY created_at_epoch DESC LIMIT ?
      `).all(...typeParams);
      for (const r of typeRows) {
        results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, importance: r.importance, files_modified: r.files_modified, score: 0, snippet: '' });
      }
    }

    // Cross-source score normalization: normalize each source to [-1, 0] before merging
    // Prevents observations (BM25 scores can reach -40) from systematically outranking
    // sessions (-6) and prompts (-1) regardless of actual relevance
    if (isCrossSource && results.length > 0 && ftsQuery) {
      for (const source of ['obs', 'session', 'prompt']) {
        const sourceResults = results.filter(r => r.source === source && r.score !== null && r.score !== undefined);
        // Skip normalization for single-result sources — avoids inflating a weak match to -1.0
        if (sourceResults.length < 2) continue;
        const maxAbs = Math.max(...sourceResults.map(r => Math.abs(r.score)));
        if (maxAbs > 0) {
          for (const r of sourceResults) r.score = r.score / maxAbs;
        }
      }
    }

    // Global sort (cross-source)
    if (isCrossSource && results.length > 0) {
      if (ftsQuery) {
        results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
      } else {
        results.sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
      }
    }

    // Re-rank observations by file context overlap and mark superseded
    if (ftsQuery && results.some(r => r.source === 'obs')) {
      const obsResults = results.filter(r => r.source === 'obs');
      reRankWithContext(db, obsResults, currentProject);
      markSuperseded(obsResults);
      results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    }

    // Tier post-filter: batch-lookup full rows and classify
    if (args.tier) {
      const obsIds = results.filter(r => r.source === 'obs').map(r => r.id);
      if (obsIds.length > 0) {
        const placeholders = obsIds.map(() => '?').join(',');
        const fullRows = db.prepare(
          `SELECT id, compressed_into, superseded_at, memory_session_id, project, importance, last_accessed_at, created_at_epoch, type FROM observations WHERE id IN (${placeholders})`
        ).all(...obsIds);
        const rowMap = new Map(fullRows.map(r => [r.id, r]));
        const tierCtx = { now: Date.now(), currentProject: currentProject, currentSessionId: '' };
        const filtered = results.filter(r => {
          if (r.source !== 'obs') return true;
          const full = rowMap.get(r.id);
          return full && computeTier(full, tierCtx) === args.tier;
        });
        results.length = 0;
        results.push(...filtered);
      } else if (args.tier !== 'archive') {
        // No obs results but tier filter set — keep non-obs results
      }
    }

    // Apply user-requested sort (after relevance scoring)
    const sort = args.sort || 'relevance';
    if (sort === 'time') {
      results.sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
    } else if (sort === 'importance') {
      results.sort((a, b) => (b.importance ?? 1) - (a.importance ?? 1) || (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
    }
    // else 'relevance' keeps BM25 score order (already sorted)

    const totalBeforePagination = results.length;
    // Always apply pagination — single-source results can exceed SQL LIMIT due to expansion (concept co-occurrence, PRF, vector search)
    const paginatedResults = (offset > 0 || results.length > limit) ? results.slice(offset, offset + limit) : results;

    return formatSearchOutput(paginatedResults, args, ftsQuery, totalBeforePagination, isCrossSource, ctx.orFallbackFired === true);
  })
);

// ─── Tool: mem_recent ────────────────────────────────────────────────────────

server.registerTool(
  'mem_recent',
  {
    description: descriptionOf('mem_recent'),
    inputSchema: memRecentSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const limit = args.limit ?? 10;
    const project = args.project || inferProject();

    const params = [];
    const wheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL'];
    if (project) { wheres.push('project = ?'); params.push(project); }
    params.push(limit);

    const rows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at, created_at_epoch
      FROM observations
      WHERE ${wheres.join(' AND ')}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No recent observations${project ? ` (${project})` : ''}.` }] };
    }

    const lines = [`Recent observations (${project || 'all'}):\n`];
    for (const r of rows) {
      lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}`);
    }
    lines.push(`\nWorkflow: mem_get(ids=[...]) for full details | mem_timeline(anchor=ID) for context`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_timeline ─────────────────────────────────────────────────────

server.registerTool(
  'mem_timeline',
  {
    description: descriptionOf('mem_timeline'),
    inputSchema: memTimelineSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const before = args.before ?? 5;
    const after = args.after ?? 5;
    let anchorId = args.anchor;
    let anchorNote = null;

    // Resolve prefixed-token anchor (e.g. "P#3462" / "S#53" / "#8121") — users pasting
    // from mem_search results expect the same routing as CLI `timeline --anchor`.
    // Prompt/session anchors resolve to the nearest-in-time observation so
    // before/after semantics still apply to the observations timeline.
    // Also covers bare numeric anchors so compressed-obs routing applies uniformly —
    // without this, `anchor: 7826` (int) would bypass the compressed check and
    // silently straddle a dead record.
    if (typeof anchorId === 'string' || typeof anchorId === 'number') {
      const parsed = parseIdToken(anchorId);
      if (!parsed) {
        return { content: [{ type: 'text', text: `Invalid anchor "${args.anchor}". Expected N, #N, P#N, or S#N.` }] };
      }
      if (parsed.source === 'prompt' || parsed.source === 'session') {
        const srcTable = parsed.source === 'prompt' ? 'user_prompts' : 'session_summaries';
        const srcPrefix = parsed.source === 'prompt' ? 'P#' : 'S#';
        const row = db.prepare(`SELECT created_at_epoch FROM ${srcTable} WHERE id = ?`).get(parsed.id);
        if (!row) return { content: [{ type: 'text', text: `${parsed.source === 'prompt' ? 'Prompt' : 'Session'} ${srcPrefix}${parsed.id} not found.` }] };
        const projArg = args.project;
        const nearest = db.prepare(`
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0 ${projArg ? 'AND project = ?' : ''}
          ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1
        `).get(...(projArg ? [projArg, row.created_at_epoch] : [row.created_at_epoch]));
        if (!nearest) return { content: [{ type: 'text', text: `No observations near ${srcPrefix}${parsed.id}.` }] };
        anchorId = nearest.id;
        anchorNote = `(anchored to #${nearest.id}, closest obs to ${srcPrefix}${parsed.id})`;
      } else {
        // Bare "#N" or "N" — resolve to obs, falling back to prompt/session like CLI bare-int path.
        // Route compressed obs to its parent so the before/after window (which filters compressed)
        // isn't shown around a dead anchor. Negative sentinels (-1 dropped, -2 pending purge) surface
        // an explicit error — they have no canonical parent.
        const obsRow = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(parsed.id);
        if (obsRow) {
          const ci = obsRow.compressed_into;
          if (ci && ci > 0) {
            anchorId = ci;
            anchorNote = `(anchored to #${ci}, #${parsed.id} was compressed into it)`;
          } else if (ci && ci < 0) {
            return { content: [{ type: 'text', text: `Observation #${parsed.id} was compressed and pruned; no canonical anchor available.` }] };
          } else {
            anchorId = parsed.id;
          }
        } else {
          const promptRow = db.prepare('SELECT created_at_epoch FROM user_prompts WHERE id = ?').get(parsed.id);
          const sessionRow = promptRow ? null : db.prepare('SELECT created_at_epoch FROM session_summaries WHERE id = ?').get(parsed.id);
          const hit = promptRow ? { row: promptRow, prefix: 'P#', name: 'prompt' }
                    : sessionRow ? { row: sessionRow, prefix: 'S#', name: 'session' }
                    : null;
          if (!hit) {
            return { content: [{ type: 'text', text: `Observation, prompt, or session with id ${parsed.id} not found.` }] };
          }
          const projArg = args.project;
          const nearest = db.prepare(`
            SELECT id FROM observations
            WHERE COALESCE(compressed_into, 0) = 0 ${projArg ? 'AND project = ?' : ''}
            ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1
          `).get(...(projArg ? [projArg, hit.row.created_at_epoch] : [hit.row.created_at_epoch]));
          if (!nearest) return { content: [{ type: 'text', text: `No observations near ${hit.prefix}${parsed.id} (${hit.name}).` }] };
          anchorId = nearest.id;
          anchorNote = `(anchored to #${nearest.id}, closest obs to ${hit.prefix}${parsed.id})`;
        }
      }
    }

    // Auto-find anchor via FTS (with recency decay). Routes through shared
    // findFtsAnchor so CLI `timeline --query` and MCP mem_timeline use
    // identical AND→OR fallback semantics (paired-path per #8217). When the
    // OR fallback fired, surface a hint so the caller knows the match was
    // not an exact AND coverage of the query — mirrors search transparency.
    if (!anchorId && args.query) {
      const ftsQuery = sanitizeFtsQuery(args.query);
      const found = findFtsAnchor(db, { ftsQuery, project: args.project ?? null });
      if (found) {
        anchorId = found.id;
        if (found.relaxed && !anchorNote) {
          anchorNote = `(query "${args.query}" relaxed AND→OR — no row matched all terms)`;
        }
      }
    }

    // No anchor: return most recent
    if (!anchorId) {
      const compressedFilter = 'COALESCE(compressed_into, 0) = 0';
      const projectFilter = args.project ? `WHERE ${compressedFilter} AND project = ?` : `WHERE ${compressedFilter}`;
      const params = args.project ? [args.project, before + after + 1] : [before + after + 1];
      const rows = db.prepare(`
        SELECT id, type, title, subtitle, project, created_at
        FROM observations ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `).all(...params);

      if (rows.length === 0) {
        return { content: [{ type: 'text', text: 'No observations found.' }] };
      }

      const lines = [`Timeline (most recent ${rows.length}):\n`];
      for (const r of rows.reverse()) {
        lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Get anchor epoch
    const anchorRow = db.prepare('SELECT created_at_epoch, project FROM observations WHERE id = ?').get(anchorId);
    if (!anchorRow) {
      return { content: [{ type: 'text', text: `Observation #${anchorId} not found.` }] };
    }

    // Update access_count for anchor (aligned with CLI timeline)
    try {
      db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?').run(Date.now(), anchorId);
    } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }

    // Auto-scope to anchor's project when caller didn't pass one: "timeline around #N"
    // means same-project context by default; cross-project bleed breaks user mental model.
    const effectiveProject = args.project || anchorRow.project;
    const projectFilter = effectiveProject ? 'AND project = ?' : '';
    const baseParams = effectiveProject ? [effectiveProject] : [];

    // Before anchor
    const beforeRows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at
      FROM observations
      WHERE created_at_epoch < ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(anchorRow.created_at_epoch, ...baseParams, before);

    // After anchor
    const afterRows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at
      FROM observations
      WHERE created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `).all(anchorRow.created_at_epoch, ...baseParams, after);

    // Anchor itself
    const anchor = db.prepare('SELECT id, type, title, subtitle, project, created_at FROM observations WHERE id = ?').get(anchorId);

    const all = [...beforeRows.reverse(), anchor, ...afterRows];
    const lines = [`Timeline around #${anchorId}${anchorNote ? ' ' + anchorNote : ''}:\n`];
    for (const r of all) {
      const marker = r.id === anchorId ? ' ◀' : '';
      lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}${marker}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_get ──────────────────────────────────────────────────────────

server.registerTool(
  'mem_get',
  {
    description: descriptionOf('mem_get'),
    inputSchema: memGetSchema,
  },
  safeHandler(async (args) => {
    // Bucket by per-token prefix (or force all to `args.source` when explicit).
    // coerceMixedIdTokens has already stringified + regex-validated each token.
    const { bySrc, invalid } = bucketIdTokens(args.ids, { explicit: args.source || null, defaultSource: 'obs' });
    if (invalid.length > 0) {
      // Should not happen — schema regex already rejected bad tokens — but guard defensively.
      return { content: [{ type: 'text', text: `Invalid ID token(s): ${invalid.join(', ')}. Expected N, #N, P#N, or S#N.` }] };
    }
    const totalRequested = bySrc.obs.length + bySrc.session.length + bySrc.prompt.length;
    if (totalRequested === 0) {
      return { content: [{ type: 'text', text: 'No valid IDs provided.' }] };
    }

    const OBS_FIELDS = ['id', 'type', 'title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned', 'search_aliases', 'files_read', 'files_modified', 'project', 'created_at', 'memory_session_id', 'prompt_number', 'importance', 'related_ids', 'access_count', 'branch', 'superseded_at', 'superseded_by', 'last_accessed_at'];

    // `fields` filter only makes sense for obs rows; session/prompt ignore it.
    // Validate when obs is queried — throw on all-invalid, note on partial-invalid.
    let fieldsNote = '';
    let obsFieldFilter = null;
    if (args.fields?.length && bySrc.obs.length > 0) {
      const invalidFields = args.fields.filter(f => !OBS_FIELDS.includes(f));
      const validFields = args.fields.filter(f => OBS_FIELDS.includes(f));
      if (validFields.length === 0) {
        throw new Error(`No valid fields. Unknown field(s): ${invalidFields.join(', ')}. Valid: ${OBS_FIELDS.join(', ')}`);
      }
      if (invalidFields.length > 0) {
        fieldsNote = `Note: unknown field(s) dropped: ${invalidFields.join(', ')}. Valid: ${OBS_FIELDS.join(', ')}`;
      }
      obsFieldFilter = validFields;
    }

    // Per-source fetchers — each returns { rows, foundIds:Set, prefix }.
    const sections = [];
    const foundBySource = { obs: new Set(), session: new Set(), prompt: new Set() };

    if (bySrc.obs.length > 0) {
      const ph = bySrc.obs.map(() => '?').join(',');
      try {
        db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${ph})`).run(Date.now(), ...bySrc.obs);
        autoBoostIfNeeded(db, bySrc.obs);
      } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }
      const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`).all(...bySrc.obs);
      const renderFields = obsFieldFilter || OBS_FIELDS;
      for (const row of rows) {
        foundBySource.obs.add(row.id);
        const lines = [`── #${row.id} ──`];
        for (const f of renderFields) {
          const val = row[f];
          if (val === null || val === undefined || val === '') continue;
          if (f === 'text' && row.narrative && typeof val === 'string' && val.startsWith(row.narrative)) continue;
          const maxLen = f === 'narrative' ? 1000 : f === 'lesson_learned' ? 500 : f === 'text' ? 500 : 200;
          lines.push(`${f}: ${typeof val === 'string' && val.length > maxLen ? val.slice(0, maxLen) + '…' : val}`);
        }
        sections.push(lines.join('\n'));
      }
    }

    if (bySrc.session.length > 0) {
      const ph = bySrc.session.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM session_summaries WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`).all(...bySrc.session);
      const sessFields = ['id', 'request', 'investigated', 'learned', 'completed', 'next_steps', 'files_read', 'files_edited', 'notes', 'project', 'created_at', 'memory_session_id', 'prompt_number'];
      for (const row of rows) {
        foundBySource.session.add(row.id);
        const lines = [`── S#${row.id} ──`];
        for (const f of sessFields) {
          const val = row[f];
          if (val === null || val === undefined || val === '') continue;
          const maxLen = 500;
          lines.push(`${f}: ${typeof val === 'string' && val.length > maxLen ? val.slice(0, maxLen) + '…' : val}`);
        }
        sections.push(lines.join('\n'));
      }
    }

    if (bySrc.prompt.length > 0) {
      const ph = bySrc.prompt.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM user_prompts WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`).all(...bySrc.prompt);
      for (const row of rows) {
        foundBySource.prompt.add(row.id);
        const lines = [`── P#${row.id} ──`];
        if (row.prompt_text) lines.push(`prompt_text: ${row.prompt_text.length > 500 ? row.prompt_text.slice(0, 500) + '…' : row.prompt_text}`);
        if (row.content_session_id) lines.push(`content_session_id: ${row.content_session_id}`);
        if (row.prompt_number !== null && row.prompt_number !== undefined) lines.push(`prompt_number: ${row.prompt_number}`);
        if (row.created_at) lines.push(`created_at: ${row.created_at}`);
        sections.push(lines.join('\n'));
      }
    }

    const totalFound = foundBySource.obs.size + foundBySource.session.size + foundBySource.prompt.size;

    if (totalFound === 0) {
      // Probe other sources so callers can retry with the right prefix/source override.
      const queried = new Set(Object.entries(bySrc).filter(([, v]) => v.length > 0).map(([k]) => k));
      const allNumericIds = [...bySrc.obs, ...bySrc.session, ...bySrc.prompt];
      const probe = probeIdSources(db, allNumericIds, queried);
      const hints = [];
      if (probe.obs.length > 0)     hints.push(`#${probe.obs.join(', #')} (obs — use source='obs' or bare #N)`);
      if (probe.session.length > 0) hints.push(`S#${probe.session.join(', S#')} (session — use source='session' or S#N)`);
      if (probe.prompt.length > 0)  hints.push(`P#${probe.prompt.join(', P#')} (prompt — use source='prompt' or P#N)`);
      const hint = hints.length > 0 ? ` Try: ${hints.join('; ')}.` : '';
      const queriedList = [...queried].join(', ');
      const msg = `No records found in source(s) [${queriedList}] for the given ID(s).${hint}`;
      return { content: [{ type: 'text', text: fieldsNote ? `${msg}\n\n${fieldsNote}` : msg }] };
    }

    // Missing-ID note per bucket (mirrors mem_delete). Show missing IDs with their bucket prefix
    // so callers can tell which source returned nothing.
    const missingHints = [];
    const miss = (arr, found, prefix) => arr.filter(id => !found.has(id)).map(id => `${prefix}${id}`);
    missingHints.push(...miss(bySrc.obs, foundBySource.obs, '#'));
    missingHints.push(...miss(bySrc.session, foundBySource.session, 'S#'));
    missingHints.push(...miss(bySrc.prompt, foundBySource.prompt, 'P#'));

    const parts = [];
    if (fieldsNote) parts.push(fieldsNote);
    parts.push(...sections);
    if (missingHints.length > 0) {
      parts.push(`Note: ID(s) ${missingHints.join(', ')} not found.`);
    }

    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  })
);

// ─── Tool: mem_delete ────────────────────────────────────────────────────────

server.registerTool(
  'mem_delete',
  {
    description: descriptionOf('mem_delete'),
    inputSchema: memDeleteSchema,
  },
  safeHandler(async (args) => {
    const placeholders = args.ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, type, title, project FROM observations WHERE id IN (${placeholders})
    `).all(...args.ids);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No observations found for given IDs.' }] };
    }

    if (!args.confirm) {
      // Preview mode
      const lines = [`Preview: ${rows.length} observation(s) will be deleted:\n`];
      for (const r of rows) {
        lines.push(`  #${r.id} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${r.project}`);
      }
      lines.push(`\nCall mem_delete(ids=[...], confirm=true) to execute.`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Wrap cleanup + deletion in a transaction for consistency
    const deletedIds = new Set(args.ids);
    const deleteTx = db.transaction(() => {
      // Clean up stale references in other observations' related_ids
      // Use LIKE filter to avoid O(N) full-table scan — only fetch rows that may reference deleted IDs.
      // NOTE: LIKE %id% has false positives (e.g. %1% matches [10], [21]). This is intentional —
      // the LIKE is a coarse pre-filter; the JSON parse + Set.has below is the precise filter.
      // Acceptable because observation count per user is typically <10K.
      const likeConditions = args.ids.map(() => `related_ids LIKE ?`).join(' OR ');
      const likeParams = args.ids.map(id => `%${id}%`);
      const referencing = db.prepare(`
        SELECT id, related_ids FROM observations
        WHERE related_ids IS NOT NULL AND related_ids != '[]'
          AND (${likeConditions})
      `).all(...likeParams);
      for (const r of referencing) {
        let ids;
        try { ids = JSON.parse(r.related_ids); } catch (e) { debugCatch(e, 'deleteRelatedIds'); continue; }
        if (!Array.isArray(ids) || !ids.every(id => Number.isInteger(id))) continue;
        const filtered = ids.filter(id => !deletedIds.has(id));
        if (filtered.length !== ids.length) {
          db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(filtered), r.id);
        }
      }
      // Execute deletion (FTS5 cleanup handled by observations_ad trigger)
      return db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...args.ids);
    });
    const result = deleteTx();

    const missing = args.ids.filter(id => !rows.some(r => r.id === id));
    const msg = [`Deleted ${result.changes} observation(s).`];
    if (missing.length > 0) msg.push(`Note: ID(s) ${missing.join(', ')} not found.`);
    return { content: [{ type: 'text', text: msg.join(' ') }] };
  })
);

// ─── Tool: mem_save ─────────────────────────────────────────────────────────

server.registerTool(
  'mem_save',
  {
    description: descriptionOf('mem_save'),
    inputSchema: memSaveSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const project = args.project || inferProject();
    const result = saveObservation(db, {
      content: args.content,
      title: args.title,
      type: args.type || 'discovery',
      importance: args.importance,
      project,
      files: args.files || [],
      lesson_learned: args.lesson_learned,
    });

    if (result.kind === 'duplicate') {
      return { content: [{ type: 'text', text: `Skipped: similar to existing #${result.existingId} in project "${project}". Use mem_get(ids=[${result.existingId}]) to review.` }] };
    }

    const lessonNote = result.lessonCaptured ? ` 💡lesson captured` : '';
    return { content: [{ type: 'text', text: `Saved as observation #${result.id} [${result.type}] in project "${project}".${lessonNote}` }] };
  })
);

// ─── Tool: mem_stats ────────────────────────────────────────────────────────

server.registerTool(
  'mem_stats',
  {
    description: descriptionOf('mem_stats'),
    inputSchema: memStatsSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const days = args.days ?? 30;

    // Batch A CLI↔MCP alignment: quality:true → quality dashboard (lesson
    // rate, LOW_SIGNAL rate, per-type hit/lesson %, top lessons, R-2 watchdog).
    // Same computation + format as CLI `stats --quality` via lib/stats-quality.mjs.
    if (args.quality) {
      const { computeQualityStats, formatQualityReport } = await import('./lib/stats-quality.mjs');
      const data = computeQualityStats(db, { project: args.project, days });
      return { content: [{ type: 'text', text: formatQualityReport(data) }] };
    }

    const cutoff = Date.now() - days * 86400000;
    const projectFilter = args.project ? 'AND project = ?' : '';
    const baseParams = args.project ? [args.project] : [];

    // Total counts
    const obsTotal = db.prepare(`SELECT COUNT(*) as c FROM observations WHERE 1=1 ${projectFilter}`).get(...baseParams);
    const sessTotal = db.prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE 1=1 ${projectFilter}`).get(...baseParams);
    const promptTotal = args.project
      ? db.prepare(`SELECT COUNT(*) as c FROM user_prompts p JOIN sdk_sessions s ON p.content_session_id = s.content_session_id WHERE s.project = ?`).get(args.project)
      : db.prepare(`SELECT COUNT(*) as c FROM user_prompts`).get();

    // Recent counts
    const obsRecent = db.prepare(`SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`).get(cutoff, ...baseParams);
    const sessRecent = db.prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE created_at_epoch >= ? ${projectFilter}`).get(cutoff, ...baseParams);

    // Type distribution (recent)
    const types = db.prepare(`
      SELECT type, COUNT(*) as c FROM observations
      WHERE created_at_epoch >= ? ${projectFilter}
      GROUP BY type ORDER BY c DESC
    `).all(cutoff, ...baseParams);

    // Projects (global view — skipped when filtering by single project)
    const projects = args.project ? [] : db.prepare(`
      SELECT project, COUNT(*) as c FROM observations
      GROUP BY project ORDER BY c DESC
      LIMIT 20
    `).all();

    // Daily activity (last 7 days)
    const daily = db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as c FROM observations
      WHERE created_at_epoch >= ? ${projectFilter}
      GROUP BY day ORDER BY day DESC
      LIMIT 7
    `).all(Date.now() - 7 * 86400000, ...baseParams);

    // Health metrics
    const tokenEst = db.prepare(`
      SELECT SUM(LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(narrative,'')) + LENGTH(COALESCE(text,''))) / 4 as t
      FROM observations WHERE 1=1 ${projectFilter}
    `).get(...baseParams);

    const avgImp = db.prepare(`
      SELECT AVG(COALESCE(importance,1)) as v FROM observations WHERE 1=1 ${projectFilter}
    `).get(...baseParams);

    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const lowVal = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? ${projectFilter}
    `).get(thirtyDaysAgo, ...baseParams);

    const noiseRatio = obsTotal.c > 0 ? lowVal.c / obsTotal.c : 0;
    const compressedCount = db.prepare(`
      SELECT COUNT(*) as c FROM observations WHERE compressed_into IS NOT NULL ${projectFilter}
    `).get(...baseParams);
    const supersededOnlyCount = db.prepare(`
      SELECT COUNT(*) as c FROM observations WHERE superseded_at IS NOT NULL AND compressed_into IS NULL ${projectFilter}
    `).get(...baseParams);

    // Tier distribution
    const tierCtx = { now: Date.now(), currentProject: args.project || inferProject(), currentSessionId: '' };
    const tdParams = tierSqlParams(tierCtx);
    const tierDist = db.prepare(`
      SELECT tier, COUNT(*) as c FROM (
        SELECT ${TIER_CASE_SQL} as tier FROM observations
        WHERE COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
      ) GROUP BY tier ORDER BY tier
    `).all(...tdParams, ...baseParams);
    const tierMap = Object.fromEntries(tierDist.map(r => [r.tier, r.c]));

    const lines = [
      `Memory Statistics${args.project ? ` (project: ${args.project})` : ''}:`,
      '',
      `Total: ${obsTotal.c} observations | ${sessTotal.c} sessions | ${promptTotal.c} prompts`,
      `Last ${days}d: ${obsRecent.c} observations | ${sessRecent.c} sessions`,
      '',
      'Type distribution (recent):',
      ...types.map(t => `  ${typeIcon(t.type)} ${t.type}: ${t.c}`),
      '',
      ...(projects.length ? ['Top projects:', ...projects.map(p => `  ${p.project}: ${p.c}`)] : []),
      '',
      'Daily activity (last 7d):',
      ...daily.map(d => `  ${d.day}: ${d.c} observations`),
      '',
      'Data Health:',
      `  Est. tokens: ${tokenEst.t ?? 0}`,
      `  Avg importance: ${(avgImp.v ?? 1).toFixed(2)}`,
      `  Low-value (imp=1, never accessed, >30d): ${lowVal.c} (${(noiseRatio * 100).toFixed(1)}% noise)`,
      `  Compressed: ${compressedCount.c}`,
      ...(noiseRatio > 0.6 ? ['  ⚠️ High noise ratio — consider running mem_compress'] : []),
      '',
      // Tier counts only live (uncompressed, non-superseded) observations — surface
      // the full decomposition so live + compressed + superseded = Total adds up cleanly.
      `Tier distribution (live ${(tierMap.working ?? 0) + (tierMap.active ?? 0) + (tierMap.archive ?? 0)}, excludes ${compressedCount.c} compressed${supersededOnlyCount.c > 0 ? ` + ${supersededOnlyCount.c} superseded` : ''}):`,
      `  🔴 Working: ${tierMap.working ?? 0} | 🟡 Active: ${tierMap.active ?? 0} | 🔵 Archive: ${tierMap.archive ?? 0}`,
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_compress ──────────────────────────────────────────────────────

server.registerTool(
  'mem_compress',
  {
    description: descriptionOf('mem_compress'),
    inputSchema: memCompressSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const preview = args.preview !== false;
    const ageDays = args.age_days ?? 30;
    const cutoff = Date.now() - ageDays * 86400000;
    const projectFilter = args.project ? 'AND project = ?' : '';
    const baseParams = args.project ? [args.project] : [];

    // Find low-value candidates: importance=1, never accessed, old, not already compressed
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
      return { content: [{ type: 'text', text: 'No candidates for compression.' }] };
    }

    // Group by project + ISO week
    const groups = new Map();
    for (const c of candidates) {
      const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    // Filter groups with < 3 observations (not worth compressing)
    const compressableGroups = [...groups.entries()].filter(([, obs]) => obs.length >= 3);

    if (preview) {
      const totalCandidates = compressableGroups.reduce((s, [, obs]) => s + obs.length, 0);
      const lines = [
        `Compression preview:`,
        `  Total candidates: ${candidates.length}`,
        `  Compressable groups (≥3 obs): ${compressableGroups.length}`,
        `  Observations to compress: ${totalCandidates}`,
        '',
        'Groups:',
        ...compressableGroups.slice(0, 20).map(([key, obs]) => {
          const [proj, week] = key.split('::');
          const types = {};
          for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
          const typeStr = Object.entries(types).map(([t, c]) => `${c} ${t}`).join(', ');
          return `  ${proj} ${week}: ${obs.length} obs (${typeStr})`;
        }),
        '',
        `Call mem_compress(preview=false${args.age_days ? `, age_days=${args.age_days}` : ''}${args.project ? `, project="${args.project}"` : ''}) to execute.`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Execute compression
    let totalCompressed = 0;
    const insertSummary = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, '', ?, '', '', '[]', '[]', 2, ?, ?)
    `);
    const compress = db.transaction(() => {
      for (const [key, obs] of compressableGroups) {
        const [proj] = key.split('::');
        const types = {};
        for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
        const dominantType = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
        const title = `Weekly summary: ${obs.length} ${dominantType} observations`;
        const narrative = obs.map(o => `- ${o.title || '(untitled)'}`).join('\n');
        const sessionId = obs[0].project ? `compress-${obs[0].project}` : 'compress-manual';

        // Use median timestamp of compressed observations instead of now,
        // so the summary appears at the correct position in timeline/recency scoring.
        const sortedEpochs = obs.map(o => o.created_at_epoch).sort((a, b) => a - b);
        const medianEpoch = sortedEpochs[Math.floor(sortedEpochs.length / 2)];
        const medianDate = new Date(medianEpoch);

        // Ensure session exists (INSERT OR IGNORE avoids race condition)
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

        // Batch UPDATE instead of per-row loop
        const obsIds = obs.map(o => o.id);
        const obsPh = obsIds.map(() => '?').join(',');
        db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${obsPh})`).run(summaryId, ...obsIds);
        totalCompressed += obs.length;
      }
    });
    compress();

    return { content: [{ type: 'text', text: `Compressed ${totalCompressed} observations into ${compressableGroups.length} weekly summaries.` }] };
  })
);

// ─── Tool: mem_maintain ──────────────────────────────────────────────────────

server.registerTool(
  'mem_maintain',
  {
    description: descriptionOf('mem_maintain'),
    inputSchema: memMaintainSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const STALE_AGE_MS = 30 * 86400000;
    const SIMILARITY_THRESHOLD = 0.7;
    const SCAN_LIMIT = 500;
    const DUPLICATE_LIMIT = 50;
    const DUPLICATE_DISPLAY = 15;

    const action = args.action;
    const project = args.project;
    const projectFilter = project ? 'AND project = ?' : '';
    const baseParams = project ? [project] : [];

    if (action === 'scan') {
      // 1. Find near-duplicate titles (MinHash pre-filter → exact Jaccard on candidates)
      const recent = db.prepare(`
        SELECT id, title, project, importance, access_count, created_at_epoch
        FROM observations
        WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ${SCAN_LIMIT}
      `).all(...baseParams);

      const titles = recent.map(r => (r.title || '').trim());
      const minhashes = titles.map(t => t ? computeMinHash(t) : null);
      const MINHASH_PRE_THRESHOLD = 0.5; // loose pre-filter to catch candidates
      const duplicates = [];
      for (let i = 0; i < recent.length && duplicates.length < DUPLICATE_LIMIT; i++) {
        if (!titles[i] || !minhashes[i]) continue;
        for (let j = i + 1; j < recent.length; j++) {
          if (!titles[j] || !minhashes[j]) continue;
          // Fast MinHash estimate to skip obvious non-matches
          if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < MINHASH_PRE_THRESHOLD) continue;
          const sim = jaccardSimilarity(titles[i], titles[j]);
          if (sim > SIMILARITY_THRESHOLD) {
            duplicates.push({
              a: { id: recent[i].id, title: recent[i].title, importance: recent[i].importance },
              b: { id: recent[j].id, title: recent[j].title, importance: recent[j].importance },
              similarity: sim.toFixed(2),
            });
          }
          if (duplicates.length >= DUPLICATE_LIMIT) break;
        }
      }

      // 2. Consolidated stats query (single table scan instead of 4 separate COUNTs)
      const staleAge = Date.now() - STALE_AGE_MS;
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

      // Count pending-purge items (marked by idle cleanup)
      const pendingPurge = db.prepare(`
        SELECT COUNT(*) as count FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} ${projectFilter}
      `).get(...baseParams);

      const lines = [
        `Memory maintenance scan:`,
        `  Total active observations: ${stats.total}`,
        `  Near-duplicate pairs: ${duplicates.length}`,
        `  Stale (>30d, imp=1, no access): ${stats.stale}`,
        `  Broken (no title/narrative): ${stats.broken}`,
        `  Boostable (accessed>3, imp<3): ${stats.boostable}`,
        `  Pending purge (idle-marked): ${pendingPurge.count}`,
      ];
      if (duplicates.length > 0) {
        const AUTO_MERGE_THRESHOLD = 0.85;
        const autoMergeable = duplicates.filter(d => parseFloat(d.similarity) >= AUTO_MERGE_THRESHOLD);
        const manualReview = duplicates.filter(d => parseFloat(d.similarity) < AUTO_MERGE_THRESHOLD);

        if (autoMergeable.length > 0) {
          lines.push('', `Auto-mergeable pairs (similarity >= ${AUTO_MERGE_THRESHOLD}):`);
          for (const d of autoMergeable.slice(0, DUPLICATE_DISPLAY)) {
            // Keep the higher-importance or newer observation
            const keep = d.a.importance >= d.b.importance ? d.a : d.b;
            const remove = keep === d.a ? d.b : d.a;
            lines.push(`  [${keep.id}] "${truncate(keep.title, 40)}" <-> [${remove.id}] "${truncate(remove.title, 40)}" (${d.similarity})`);
          }
          // Build ready-to-use merge_ids for auto-mergeable pairs
          const mergeIds = autoMergeable.map(d => {
            const keep = d.a.importance >= d.b.importance ? d.a : d.b;
            const remove = keep === d.a ? d.b : d.a;
            return [keep.id, remove.id];
          });
          lines.push('', `Ready-to-use command:`, `  mem_maintain(action="execute", operations=["dedup"], merge_ids=${JSON.stringify(mergeIds)})`);
        }

        if (manualReview.length > 0) {
          lines.push('', 'Needs review:');
          for (const d of manualReview.slice(0, DUPLICATE_DISPLAY)) {
            lines.push(`  [${d.a.id}] "${truncate(d.a.title, 40)}" <-> [${d.b.id}] "${truncate(d.b.title, 40)}" (${d.similarity})`);
          }
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (action === 'execute') {
      const ops = args.operations && args.operations.length > 0
        ? args.operations
        : ['cleanup', 'decay', 'boost'];
      // T2-P1-A: reject explicit empty array (vs. omitted → defaults above). Empty-array
      // callers are almost always mistakes; silently running only FTS5 optimize hides the error.
      if (args.operations && args.operations.length === 0) {
        return { content: [{ type: 'text', text: 'operations array is empty. Pass a non-empty list (e.g. ["cleanup","decay","boost"]) or omit operations to use the default set.' }], isError: true };
      }
      const results = [];
      const staleAge = Date.now() - STALE_AGE_MS;
      const OP_ROW_CAP = 1000; // safety cap per operation

      // T2-P0-A: purge_stale is the only DELETE in this handler. Require confirm=true;
      // a first call without confirm returns a dry-run preview so callers know the blast radius.
      const purgeRequested = ops.includes('purge_stale');
      if (purgeRequested && args.confirm !== true) {
        const retainDays = args.retain_days ?? 30;
        const retainCutoff = Date.now() - retainDays * 86400000;
        const previewRow = db.prepare(`
          SELECT COUNT(*) AS candidates, MIN(created_at_epoch) AS oldest, MAX(created_at_epoch) AS newest
          FROM observations
          WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ? ${projectFilter}
        `).get(retainCutoff, ...baseParams);
        const lines = [
          'purge_stale preview (confirm=false):',
          `  Candidates (pending-purge, older than ${retainDays}d): ${previewRow.candidates}`,
        ];
        if (previewRow.candidates > 0) {
          lines.push(`  Oldest: ${new Date(previewRow.oldest).toISOString().slice(0, 10)}`);
          lines.push(`  Newest: ${new Date(previewRow.newest).toISOString().slice(0, 10)}`);
        }
        lines.push('');
        lines.push('Nothing was deleted. To execute, re-run with confirm=true:');
        lines.push(`  mem_maintain(action="execute", operations=${JSON.stringify(ops)}, confirm=true${args.retain_days ? `, retain_days=${args.retain_days}` : ''}${args.project ? `, project="${args.project}"` : ''})`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      db.transaction(() => {
        if (ops.includes('cleanup')) {
          const deleted = db.prepare(`
            DELETE FROM observations
            WHERE id IN (
              SELECT id FROM observations
              WHERE COALESCE(compressed_into, 0) = 0
                AND (title IS NULL OR title = '')
                AND (narrative IS NULL OR narrative = '')
                ${projectFilter}
              LIMIT ${OP_ROW_CAP}
            )
          `).run(...baseParams);
          results.push(`Cleaned up ${deleted.changes} broken observations` + (deleted.changes >= OP_ROW_CAP ? ' (cap reached, re-run for more)' : ''));
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
                ${projectFilter}
              LIMIT ${OP_ROW_CAP}
            )
          `).run(staleAge, ...baseParams);

          // Mark importance=1, never-accessed, old observations as pending-purge
          const idleMarked = db.prepare(`
            UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
            WHERE id IN (
              SELECT id FROM observations
              WHERE COALESCE(compressed_into, 0) = 0
                AND COALESCE(importance, 1) = 1
                AND COALESCE(access_count, 0) = 0
                AND created_at_epoch < ?
                ${projectFilter}
              LIMIT ${OP_ROW_CAP}
            )
          `).run(staleAge, ...baseParams);
          results.push(`Decayed ${decayed.changes} stale observations, marked ${idleMarked.changes} idle as pending-purge` + ((decayed.changes >= OP_ROW_CAP || idleMarked.changes >= OP_ROW_CAP) ? ' (cap reached, re-run for more)' : ''));
        }

        if (ops.includes('boost')) {
          const boosted = db.prepare(`
            UPDATE observations SET importance = MIN(3, COALESCE(importance, 1) + 1)
            WHERE id IN (
              SELECT id FROM observations
              WHERE COALESCE(compressed_into, 0) = 0
                AND COALESCE(access_count, 0) > 3
                AND COALESCE(importance, 1) < 3
                ${projectFilter}
              LIMIT ${OP_ROW_CAP}
            )
          `).run(...baseParams);
          results.push(`Boosted ${boosted.changes} frequently-accessed observations` + (boosted.changes >= OP_ROW_CAP ? ' (cap reached, re-run for more)' : ''));
        }

        if (ops.includes('dedup') && args.merge_ids) {
          let totalMerged = 0;
          const mergeStmt = db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ? AND COALESCE(compressed_into, 0) = 0');
          for (const group of args.merge_ids) {
            if (group.length < 2) continue;
            const [keepId, ...removeIds] = group;
            for (const removeId of removeIds) {
              const result = mergeStmt.run(keepId, removeId);
              totalMerged += result.changes;
            }
          }
          results.push(`Merged ${totalMerged} duplicate observations`);
        }

        if (!ops.includes('dedup') && args.merge_ids) {
          results.push('Warning: merge_ids provided but "dedup" not in operations — merge_ids ignored');
        }

        if (ops.includes('purge_stale')) {
          // Delete observations previously marked as pending-purge by idle cleanup.
          // Requires user confirmation via /mem:update or /mem:mem.
          const retainDays = args.retain_days ?? 30;
          const retainCutoff = Date.now() - retainDays * 86400000;
          const purged = db.prepare(`
            DELETE FROM observations
            WHERE id IN (
              SELECT id FROM observations
              WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ? ${projectFilter}
              LIMIT ${OP_ROW_CAP}
            )
          `).run(retainCutoff, ...baseParams);
          results.push(`Purged ${purged.changes} stale observations (retained last ${retainDays} days)` + (purged.changes >= OP_ROW_CAP ? ' (cap reached, re-run for more)' : ''));
        }
      })();

      // FTS5 optimize (outside transaction)
      db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
      results.push('FTS5 index optimized');

      // rebuild_vectors: outside main transaction (creates its own internal transaction)
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
            const now = Date.now();
            db.transaction(() => {
              db.prepare('DELETE FROM observation_vectors').run();
              for (const obs of allObs) {
                const text = [obs.title || '', obs.narrative || '', obs.concepts || ''].filter(Boolean).join(' ');
                const vec = computeVector(text, vocab);
                if (vec) {
                  insertStmt.run(obs.id, Buffer.from(vec.buffer), vocab.version, now);
                  updated++;
                }
              }
            })();
            results.push(`Vectors: rebuilt vocabulary (${vocab.terms.size} terms), updated ${updated}/${allObs.length} vectors`);
          }
        } catch (e) {
          debugCatch(e, 'rebuild_vectors');
          results.push(`Vectors: rebuild failed — ${e.message}`);
        }
      }

      return { content: [{ type: 'text', text: results.join('\n') }] };
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}. Use "scan" or "execute".` }], isError: true };
  })
);

// ─── Tool: mem_optimize ────────────────────────────────────────────────────

server.registerTool(
  'mem_optimize',
  {
    description: descriptionOf('mem_optimize'),
    inputSchema: memOptimizeSchema,
  },
  safeHandler(async (args) => {
    const action = args.action || 'preview';

    if (action === 'preview') {
      const preview = optimizePreview(db);
      const lines = [
        `🔍 LLM Optimization Preview:`,
        `  Re-enrich candidates: ${preview.reenrich}`,
        `  Normalize: ${preview.normalizeGateOpen ? `${preview.normalize} unique concepts` : 'gate closed (7-day interval)'}`,
        `  Cluster-merge candidates: ${preview.clusterMerge} clusters`,
        `  Smart-compress candidates: ${preview.smartCompress} clusters`,
        `  Total: ${preview.total} items`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const force = action === 'run_all';
    const results = await optimizeRun(db, {
      tasks: args.tasks,
      maxItems: args.max_items || 15,
      force,
      // T2-P0-B: scope parity with CLI (--scope wide). When omitted, optimizeRun defaults
      // to narrow via its own code; passing through keeps that fallback intact.
      reenrichScope: args.scope,
    });

    const lines = ['🔧 LLM Optimization Results:'];
    if (results.reenrich) lines.push(`  Re-enrich: ${results.reenrich.processed || 0} processed, ${results.reenrich.skipped || 0} skipped`);
    if (results.normalize) {
      if (results.normalize.skipped) lines.push(`  Normalize: skipped (${results.normalize.reason})`);
      else lines.push(`  Normalize: ${results.normalize.processed || 0} updated, ${results.normalize.groups || 0} synonym groups`);
    }
    if (results.clusterMerge) lines.push(`  Cluster-merge: ${results.clusterMerge.merged || 0} merged of ${results.clusterMerge.processed || 0} clusters`);
    if (results.smartCompress) lines.push(`  Smart-compress: ${results.smartCompress.compressed || 0} compressed of ${results.smartCompress.processed || 0} clusters`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_registry ─────────────────────────────────────────────────────

server.registerTool(
  'mem_registry',
  {
    description: descriptionOf('mem_registry'),
    inputSchema: memRegistrySchema,
  },
  safeHandler(async (args) => {
    const rdb = getRegistryDb();
    if (!rdb) {
      return { content: [{ type: 'text', text: 'Registry DB not available. Run install first.' }], isError: true };
    }

    const action = args.action;

    if (action === 'search') {
      if (!args.query) {
        return { content: [{ type: 'text', text: 'search requires a query parameter' }], isError: true };
      }
      let results = searchResources(rdb, args.query, {
        type: args.type || undefined,
        limit: args.category || args.quality ? 20 : 10, // fetch more for post-filtering
      });
      // Apply category/quality filters if provided
      if (args.category) results = results.filter(r => r.category === args.category);
      if (args.quality) results = results.filter(r => r.quality_tier === args.quality);
      // Prioritize directly invocable resources (with invocation_name) over community resources
      results.sort((a, b) => {
        const aInvocable = a.invocation_name ? 1 : 0;
        const bInvocable = b.invocation_name ? 1 : 0;
        if (aInvocable !== bInvocable) return bInvocable - aInvocable;
        return 0; // preserve FTS5 ranking within same tier
      });
      results = results.slice(0, 5);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No matching resources for: "${args.query}"` }] };
      }
      const home = homedir();
      const toPortable = (p) => p && p.startsWith(home) ? '~' + p.slice(home.length) : (p || '');
      const lines = results.map(r => {
        const qualityBadge = r.quality_tier === 'installed' ? '[✓]' : r.quality_tier === 'verified' ? '[★]' : '[○]';
        const categoryLabel = r.category ? ` [${r.category}]` : '';
        const isManaged = r.local_path && r.local_path.includes('/.claude-mem-lite/managed/');
        const portablePath = isManaged ? toPortable(r.local_path) : '';
        let howToUse;
        if (isManaged) {
          // Managed: use Read(path) or mem_use — Skill() won't work for managed resources
          // Agents always have complete .md paths (e.g., agents/group/agents/name.md)
          // Only skills can be directory paths (9 cases) — resolve to /SKILL.md
          const resolvedPath = portablePath.endsWith('.md') ? portablePath : `${portablePath}/SKILL.md`;
          howToUse = `Read("${resolvedPath}") or mem_use(name="${r.name}"${r.type === 'agent' ? ', type="agent"' : ''})`;
        } else if (r.invocation_name) {
          // Native plugin/user skill: Skill() with full invocation name
          howToUse = r.type === 'skill'
            ? `Skill("${r.invocation_name}")`
            : `Agent(subagent_type="${r.invocation_name}")`;
        } else {
          howToUse = `mem_use(name="${r.name}"${r.type === 'agent' ? ', type="agent"' : ''})`;
        }
        const pathLine = portablePath ? `\n  Path: ${portablePath}` : '';
        return `${qualityBadge} ${r.type === 'skill' ? 'S' : 'A'} **${r.name}**${categoryLabel} — ${truncate(r.capability_summary || '', 80)}${pathLine}\n  Use: ${howToUse}`;
      });
      return { content: [{ type: 'text', text: `Found ${results.length} resource(s) for "${args.query}":\n\n${lines.join('\n\n')}` }] };
    }

    if (action === 'list') {
      const typeFilter = args.type;
      const where = typeFilter ? 'WHERE type = ? AND status = ?' : 'WHERE status = ?';
      const params = typeFilter ? [typeFilter, 'active'] : ['active'];
      // T3-P2-A: order by adoption then recommendation (CLI parity), and coalesce NULL counts
      // so the output shows "adopt:0" rather than the jarring "adopt:null".
      const resources = rdb.prepare(`
        SELECT name, type, invocation_name, recommend_count, adopt_count, capability_summary
        FROM resources ${where}
        ORDER BY COALESCE(adopt_count, 0) DESC, COALESCE(recommend_count, 0) DESC, type, name
      `).all(...params);

      if (resources.length === 0) return { content: [{ type: 'text', text: 'No resources found.' }] };

      const lines = resources.map(r =>
        `${r.type === 'skill' ? 'S' : 'A'} ${r.name}${r.invocation_name ? ` (${r.invocation_name})` : ''} — rec:${r.recommend_count ?? 0} adopt:${r.adopt_count ?? 0} — ${truncate(r.capability_summary || '', 80)}`
      );
      return { content: [{ type: 'text', text: `Resources (${resources.length}):\n${lines.join('\n')}` }] };
    }

    if (action === 'stats') {
      const total = rdb.prepare('SELECT COUNT(*) as c FROM resources WHERE status = ?').get('active');
      const byType = rdb.prepare('SELECT type, COUNT(*) as c FROM resources WHERE status = ? GROUP BY type').all('active');
      const topAdopted = rdb.prepare(`
        SELECT name, type, adopt_count, recommend_count
        FROM resources WHERE status = ? AND adopt_count > 0
        ORDER BY adopt_count DESC LIMIT 10
      `).all('active');
      const zeroAdopt = rdb.prepare(`
        SELECT COUNT(*) as c FROM resources
        WHERE status = ? AND recommend_count > 0 AND adopt_count = 0
      `).get('active');
      const userAdded = rdb.prepare(`
        SELECT COUNT(*) as c FROM resources WHERE status = ? AND source = 'user'
      `).get('active');

      const lines = [
        `Registry Stats:`,
        `  Total active: ${total.c}`,
        ...byType.map(t => `  ${t.type}: ${t.c}`),
        `  User-added: ${userAdded.c}`,
        `  Zero adoption (recommended but never adopted): ${zeroAdopt.c}`,
      ];
      if (topAdopted.length > 0) {
        lines.push('', 'Top adopted:');
        for (const r of topAdopted) {
          lines.push(`  ${r.name} (${r.type}): ${r.adopt_count}/${r.recommend_count}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (action === 'import') {
      if (!args.name || !args.resource_type) {
        return { content: [{ type: 'text', text: 'import requires name and resource_type' }], isError: true };
      }
      const IMPORT_STRING_FIELDS = ['repo_url', 'local_path', 'invocation_name', 'intent_tags',
        'domain_tags', 'trigger_patterns', 'capability_summary', 'keywords', 'tech_stack', 'use_cases'];
      const fields = { name: args.name, type: args.resource_type, status: 'active', source: args.source || 'user' };
      for (const f of IMPORT_STRING_FIELDS) fields[f] = args[f] || '';
      const id = upsertResource(rdb, fields);
      return { content: [{ type: 'text', text: `Imported: ${args.resource_type}:${args.name} (id=${id})` }] };
    }

    if (action === 'remove') {
      if (!args.name || !args.resource_type) {
        return { content: [{ type: 'text', text: 'remove requires name and resource_type' }], isError: true };
      }
      const result = rdb.prepare('DELETE FROM resources WHERE type = ? AND name = ?').run(args.resource_type, args.name);
      return { content: [{ type: 'text', text: result.changes > 0 ? `Removed: ${args.resource_type}:${args.name}` : 'Not found.' }] };
    }

    if (action === 'reindex') {
      rdb.exec("INSERT INTO resources_fts(resources_fts) VALUES('rebuild')");
      const count = rdb.prepare('SELECT COUNT(*) as c FROM resources WHERE status = ?').get('active');
      return { content: [{ type: 'text', text: `FTS5 reindexed. ${count.c} active resources.` }] };
    }

    if (action === 'import_url') {
      if (!args.url) {
        return { content: [{ type: 'text', text: 'import_url requires a url parameter' }], isError: true };
      }
      const { importFromGitHub } = await import('./registry-importer.mjs');
      try {
        const results = await importFromGitHub(rdb, args.url);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No skills/agents found in: ${args.url}` }] };
        }

        let enrichMsg = '';
        if (args.enrich) {
          const { enrichResource } = await import('./registry-enricher.mjs');
          let ok = 0;
          for (const r of results) {
            const row = rdb.prepare('SELECT local_path FROM resources WHERE id = ?').get(r.id);
            if (!row?.local_path) continue;
            try {
              const content = readFileSync(row.local_path, 'utf8');
              if (await enrichResource(rdb, r.name, r.type, content)) ok++;
            } catch {}
          }
          enrichMsg = `\nEnriched: ${ok}/${results.length}`;
        }

        const lines = results.map(r => `${r.type === 'skill' ? 'S' : 'A'} ${r.name} (id=${r.id})`);
        return { content: [{ type: 'text', text: `Imported ${results.length} resource(s) from ${args.url}:\n${lines.join('\n')}${enrichMsg}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Import failed: ${e.message}` }], isError: true };
      }
    }

    if (action === 'enrich') {
      if (!args.name) {
        return { content: [{ type: 'text', text: 'enrich requires a name parameter' }], isError: true };
      }
      const row = rdb.prepare("SELECT name, type, local_path FROM resources WHERE name = ? AND status = 'active'").get(args.name);
      if (!row) {
        return { content: [{ type: 'text', text: `Resource not found: ${args.name}` }], isError: true };
      }
      if (!row.local_path) {
        return { content: [{ type: 'text', text: `No local_path for ${args.name}` }], isError: true };
      }
      const enrichBase = join(homedir(), '.claude-mem-lite');
      if (!isPathConfined(row.local_path, enrichBase)) {
        return { content: [{ type: 'text', text: `Access denied: path outside managed directory` }], isError: true };
      }

      const { enrichResource } = await import('./registry-enricher.mjs');
      try {
        const content = readFileSync(row.local_path, 'utf8');
        const ok = await enrichResource(rdb, row.name, row.type, content);
        return { content: [{ type: 'text', text: ok ? `Enriched: ${args.name}` : `Enrichment failed for ${args.name}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Enrich error: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}. Valid: search, list, stats, import, remove, reindex, import_url, enrich` }], isError: true };
  })
);

// ─── Tool: mem_use ──────────────────────────────────────────────────────────

server.registerTool(
  'mem_use',
  {
    description: descriptionOf('mem_use'),
    inputSchema: memUseSchema,
  },
  safeHandler(async (args) => {
    const rdb = getRegistryDb();
    if (!rdb) {
      return { content: [{ type: 'text', text: 'Registry DB not available.' }], isError: true };
    }

    const name = args.name.trim();
    const type = args.type || 'skill';

    // 1. Exact match by name or invocation_name
    let row = rdb.prepare(`
      SELECT id, name, type, local_path, invocation_name, capability_summary
      FROM resources
      WHERE status = 'active' AND type = ?
        AND (name = ? OR invocation_name = ?)
      LIMIT 1
    `).get(type, name, name);

    // 2. Fuzzy fallback: FTS5 search, take top result
    if (!row) {
      const results = searchResources(rdb, name, { type, limit: 1 });
      if (results.length > 0) {
        row = rdb.prepare(`SELECT id, name, type, local_path, invocation_name, capability_summary FROM resources WHERE name = ? AND type = ? AND status = 'active'`).get(results[0].name, results[0].type);
      }
    }

    if (!row) {
      return { content: [{ type: 'text', text: `No ${type} found for "${name}". Try mem_registry(action="search", query="${name}") to browse.` }] };
    }

    // 3. Resolve path: directory skills → SKILL.md (agents always have full .md paths)
    let skillPath = row.local_path || '';
    if (skillPath && !skillPath.endsWith('.md')) {
      for (const candidate of [
        join(skillPath, 'SKILL.md'),
        join(skillPath, `skills/${row.name}/SKILL.md`),
      ]) {
        if (existsSync(candidate)) { skillPath = candidate; break; }
      }
    }

    // 4. Path confinement check — prevent reading arbitrary files via crafted local_path
    const managedBase = join(homedir(), '.claude-mem-lite');
    if (skillPath && !isPathConfined(skillPath, managedBase)) {
      return { content: [{ type: 'text', text: `Access denied: path "${skillPath}" is outside managed directory` }], isError: true };
    }

    // 5. Read content
    let content;
    try {
      content = readFileSync(skillPath, 'utf8');
    } catch {
      const msg = skillPath.endsWith('.md')
        ? `Found ${type} "${row.name}" but cannot read file: ${skillPath}`
        : `Found ${type} "${row.name}" but no .md file in: ${skillPath}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }

    // 5. Record invocation
    try {
      rdb.prepare(`
        INSERT INTO invocations (resource_id, session_id, trigger, adopted, outcome)
        VALUES (?, ?, 'user_explicit', 1, 'success')
      `).run(row.id, process.env.CLAUDE_SESSION_ID || 'unknown');
    } catch { /* non-critical */ }

    const _home = homedir();
    const portablePath = skillPath && skillPath.startsWith(_home) ? '~' + skillPath.slice(_home.length) : (skillPath || '');
    const pathAttr = portablePath ? ` path="${portablePath}"` : '';
    const reloadHint = portablePath ? ` Reload: Read("${portablePath}")` : '';
    return { content: [{ type: 'text', text: `<skill-loaded name="${row.name}" type="${row.type}"${pathAttr}>\n${content}\n</skill-loaded>\n\nFollow the instructions above to execute this ${row.type}.${reloadHint}` }] };
  }),
);

// ─── Tool: mem_update ────────────────────────────────────────────────────────

server.registerTool(
  'mem_update',
  {
    description: descriptionOf('mem_update'),
    inputSchema: memUpdateSchema,
  },
  safeHandler(async (args) => {
    const obs = db.prepare('SELECT id, title FROM observations WHERE id = ?').get(args.id);
    if (!obs) return { content: [{ type: 'text', text: `Observation #${args.id} not found` }], isError: true };

    const updates = [];
    const params = [];
    for (const [key, col] of [['title','title'],['narrative','narrative'],['type','type'],['importance','importance'],['lesson_learned','lesson_learned'],['concepts','concepts']]) {
      if (args[key] !== undefined) {
        updates.push(`${col} = ?`);
        params.push(typeof args[key] === 'string' ? scrubSecrets(args[key]) : args[key]);
      }
    }
    if (updates.length === 0) return { content: [{ type: 'text', text: 'No fields to update' }], isError: true };

    params.push(args.id);

    // Atomic: update fields + rebuild FTS text + re-vectorize
    db.transaction(() => {
      db.prepare(`UPDATE observations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      // Rebuild FTS text field (must include CJK bigrams + search_aliases to match mem_save/hook-llm)
      const row = db.prepare('SELECT title, subtitle, narrative, concepts, facts, lesson_learned, search_aliases FROM observations WHERE id = ?').get(args.id);
      const base = [row.title, row.subtitle, row.narrative, row.concepts, row.facts, row.lesson_learned, row.search_aliases].filter(Boolean).join(' ');
      const bigrams = cjkBigrams((row.title || '') + ' ' + (row.narrative || ''));
      const textField = bigrams ? base + ' ' + bigrams : base;
      db.prepare('UPDATE observations SET text = ? WHERE id = ?').run(textField, args.id);

      // Re-vectorize (non-critical — catch to avoid rollback)
      try {
        const vocab = getVocabulary(db);
        if (vocab) {
          const vec = computeVector(textField, vocab);
          if (vec) {
            db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
              .run(args.id, Buffer.from(vec.buffer), vocab.version, Date.now());
          }
        }
      } catch (e) { debugCatch(e, 'mem_update-vector'); }
    })();

    return { content: [{ type: 'text', text: `Updated observation #${args.id}: ${updates.map(u => u.split(' =')[0]).join(', ')}` }] };
  })
);

// ─── Tool: mem_export ────────────────────────────────────────────────────────

server.registerTool(
  'mem_export',
  {
    description: descriptionOf('mem_export'),
    inputSchema: memExportSchema,
  },
  safeHandler(async (args) => {
    const wheres = [];
    const params = [];
    if (!args.include_compressed) wheres.push('COALESCE(compressed_into, 0) = 0');
    wheres.push('superseded_at IS NULL');
    if (args.project) { wheres.push('project = ?'); params.push(resolveProject(args.project)); }
    if (args.type) { wheres.push('type = ?'); params.push(args.type); }
    // T3-P1-A: surface invalid dates instead of silently dropping the filter — mirrors
    // mem_search, which threw. A dropped filter can quietly expand the export blast radius.
    if (args.date_from) {
      const epoch = new Date(args.date_from).getTime();
      if (isNaN(epoch)) throw new Error(`Invalid date_from: "${args.date_from}" (use ISO 8601 or YYYY-MM-DD)`);
      wheres.push('created_at_epoch >= ?');
      params.push(epoch);
    }
    if (args.date_to) {
      const d = args.date_to.length === 10 ? args.date_to + 'T23:59:59.999Z' : args.date_to;
      const epoch = new Date(d).getTime();
      if (isNaN(epoch)) throw new Error(`Invalid date_to: "${args.date_to}" (use ISO 8601 or YYYY-MM-DD)`);
      wheres.push('created_at_epoch <= ?');
      params.push(epoch);
    }

    const where = wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : '';
    const exportLimit = Math.min(args.limit ?? 200, 1000);
    // T3-P2-B: probe limit+1 so we can tell "user hit their own limit with more waiting" from
    // "user got exactly what existed". Trim to exportLimit before rendering.
    const probed = db.prepare(`SELECT id, project, type, title, subtitle, narrative, concepts, facts, lesson_learned, importance, files_modified, branch, access_count, memory_session_id, created_at, created_at_epoch FROM observations ${where} ORDER BY created_at_epoch DESC LIMIT ?`).all(...params, exportLimit + 1);
    const rows = probed.slice(0, exportLimit);
    const moreAvailable = probed.length > exportLimit;

    if (rows.length === 0) return { content: [{ type: 'text', text: 'No observations found matching the criteria.' }] };

    const output = args.format === 'jsonl'
      ? rows.map(r => JSON.stringify(r)).join('\n')
      : JSON.stringify(rows, null, 2);

    const cap = moreAvailable ? `\nNote: Results capped at ${exportLimit}. Use date_from/date_to or increase limit (max 1000) to export more.` : '';
    return { content: [{ type: 'text', text: `Exported ${rows.length} observations:${cap}\n${output}` }] };
  })
);

// ─── Tool: mem_recall ────────────────────────────────────────────────────────

server.registerTool(
  'mem_recall',
  {
    description: descriptionOf('mem_recall'),
    inputSchema: memRecallSchema,
  },
  safeHandler(async (args) => {
    const filename = basename(args.file);
    const limit = args.limit ?? 10;
    const includeNoise = args.include_noise === true;

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
      return { content: [{ type: 'text', text: `No history for "${filename}". This file hasn't been observed yet.` }] };
    }

    // Update access_count for recalled observations
    const recalledIds = rows.map(r => r.id);
    const ph = recalledIds.map(() => '?').join(',');
    try {
      db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${ph})`).run(Date.now(), ...recalledIds);
    } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }

    const lines = [`History for ${filename} (${rows.length} observation${rows.length !== 1 ? 's' : ''}):\n`];
    for (const r of rows) {
      const lesson = r.lesson_learned ? `\n     Lesson: ${truncate(r.lesson_learned, 100)}` : '';
      lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}${lesson}`);
    }
    lines.push(`\nWorkflow: mem_get(ids=[...]) for full details`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_fts_check ─────────────────────────────────────────────────────
// Handler extracted to server/fts-check.mjs (v2.41 split).
import { handleMemFtsCheck } from './server/fts-check.mjs';

server.registerTool(
  'mem_fts_check',
  {
    description: descriptionOf('mem_fts_check'),
    inputSchema: memFtsCheckSchema,
  },
  safeHandler(async (args) => handleMemFtsCheck(db, args))
);

// ─── Tool: mem_browse ────────────────────────────────────────────────────────

server.registerTool(
  'mem_browse',
  {
    description: descriptionOf('mem_browse'),
    inputSchema: memBrowseSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const project = args.project || inferProject();
    const tierFilter = args.tier || null;
    const limit = args.limit ?? (tierFilter ? 20 : 5);
    const now = Date.now();

    // Get active session for tier classification
    const activeSession = db.prepare(
      "SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND status = 'active' ORDER BY started_at_epoch DESC LIMIT 1"
    ).get(project);

    const ctx = { now, currentProject: project, currentSessionId: activeSession?.memory_session_id ?? '' };
    const params = tierSqlParams(ctx);

    const tiers = ['working', 'active', 'archive'];
    const tierLabels = { working: '🔴 Working Memory', active: '🟡 Active Memory', archive: '🔵 Archive' };
    const showTiers = tierFilter ? [tierFilter] : tiers;

    const lines = [`Memory Dashboard (${project})\n`];
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

      lines.push(`${tierLabels[tier]} (${count})`);

      if (tier === 'archive' && !tierFilter) {
        if (count > 0) lines.push('');
        continue;
      }

      if (count === 0) { lines.push(''); continue; }

      const rows = db.prepare(`
        SELECT * FROM (
          SELECT id, type, title, created_at, created_at_epoch, ${TIER_CASE_SQL} as tier
          FROM observations
          WHERE project = ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
        ) WHERE tier = ?
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `).all(...params, project, tier, limit);

      for (const r of rows) {
        lines.push(`  #${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${fmtDate(r.created_at)}`);
      }
      if (count > rows.length) lines.push(`  ... and ${count - rows.length} more`);
      lines.push('');
    }

    if (grandTotal === 0) {
      return { content: [{ type: 'text', text: 'No observations found. Start a coding session to build memory.' }] };
    }

    if (!tierFilter) {
      const parts = tiers.map(t => `${t[0].toUpperCase() + t.slice(1)}: ${tierCounts[t] ?? 0}`);
      lines.push(`Totals: ${grandTotal} observations | ${parts.join(' | ')}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Hidden tool filter ─────────────────────────────────────────────────────
// All 17 tools are registered (so `tools/call <name>` still resolves for
// scripts and direct MCP clients), but only the 6 core tools appear in the
// `tools/list` response. Hiding the 11 maintenance/admin tools keeps Claude
// Code's startup context small while preserving the contract that the plugin
// dogfoods (see CLAUDE.md §Mem usage contract and adopt-content.mjs).
//
// Safe because:
//   - Protocol-layer override: we replace the mcp.js default ListTools
//     handler on the underlying Server (setRequestHandler is a Map.set).
//   - `enabled` stays true, so `tools/call` keeps routing normally — per
//     mcp.js line 106, a `disabled` tool would reject calls too.

const HIDDEN_TOOL_NAMES = new Set(
  TOOL_DEFS.filter((t) => t.hidden === true).map((t) => t.name),
);

// Opt-out: setting CLAUDE_MEM_ALL_TOOLS=1 restores pre-v2.34.0 behavior where
// all 17 tools are visible in `tools/list`. Users who relied on Claude Code
// autonomously invoking the now-hidden maintenance tools can use this as an
// immediate escape hatch while adopting the CLI entry points documented in
// adopt-content.mjs / README.
const EXPOSE_ALL_TOOLS = process.env.CLAUDE_MEM_ALL_TOOLS === '1';

if (!EXPOSE_ALL_TOOLS) {
  // Force mcp.js to install its default ListTools/CallTools handlers before
  // we override; registerTool already did this, but keep the call explicit so
  // a future reorder of tool registration doesn't break the override.
  const originalHandler = server.server._requestHandlers.get('tools/list');
  if (typeof originalHandler !== 'function') {
    throw new Error('tools/list handler missing — server initialization order changed');
  }
  server.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const full = await originalHandler(req, extra);
    return { ...full, tools: full.tools.filter((t) => !HIDDEN_TOOL_NAMES.has(t.name)) };
  });
}

// One-time discoverability banner (stderr only — Claude Code surfaces it on
// session start). Skipped under MEM_QUIET_HOOKS=1 so CI / tests / hermeticity
// harnesses stay silent.
if (!effectiveQuiet()) {
  const status = EXPOSE_ALL_TOOLS
    ? 'all 17 tools exposed via CLAUDE_MEM_ALL_TOOLS=1'
    : `tools/list narrowed to ${TOOL_DEFS.length - HIDDEN_TOOL_NAMES.size} core tools (${HIDDEN_TOOL_NAMES.size} hidden but callable by exact name; unset CLAUDE_MEM_ALL_TOOLS to keep, set =1 to restore all)`;
  process.stderr.write(`[claude-mem-lite v${PKG_VERSION}] ${status}\n`);
}

// ─── WAL Checkpoint (periodic) ───────────────────────────────────────────────

// Checkpoint WAL every 5 minutes to prevent unbounded growth
const WAL_CHECKPOINT_INTERVAL = 5 * 60 * 1000;
const walTimer = setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { debugCatch(e, 'walCheckpoint'); }
}, WAL_CHECKPOINT_INTERVAL);
walTimer.unref(); // Don't keep process alive just for checkpoints

// ─── Idle-Time Memory Optimization ──────────────────────────────────────────
// When no MCP requests for 5 minutes, run lightweight DB maintenance.
// lastMcpRequestTime and idleCleanupRan are declared near safeHandler (which updates them).

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

const idleTimer = setInterval(() => {
  if (idleCleanupRan) return;
  if (Date.now() - lastMcpRequestTime < IDLE_THRESHOLD_MS) return;
  idleCleanupRan = true;

  try {
    // Type-differentiated cleanup: higher-value types survive longer
    const { marked, compressed } = runIdleCleanup(db);
    if (marked > 0) debugLog('INFO', 'idle-cleanup', `Marked ${marked} stale observations as pending-purge`);
    if (compressed > 0) debugLog('INFO', 'idle-cleanup', `Compressed ${compressed} old observations`);

    // FTS5 index optimization (outside transaction — WAL-friendly)
    db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
    debugLog('DEBUG', 'idle-cleanup', 'FTS5 optimize complete');
  } catch (e) {
    debugCatch(e, 'idle-cleanup');
  }
}, 60000); // Check every minute
idleTimer.unref();

// ─── Shutdown Cleanup ────────────────────────────────────────────────────────

function shutdown(exitCode = 0) {
  clearInterval(walTimer);
  clearInterval(idleTimer);
  try { if (db) db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { if (db) db.close(); } catch {}
  try { if (registryDb) registryDb.close(); } catch {}
  process.exit(exitCode);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => { debugCatch(err, 'uncaughtException'); shutdown(1); });
process.on('unhandledRejection', (err) => { debugCatch(err, 'unhandledRejection'); shutdown(1); });

// ─── Start Server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
