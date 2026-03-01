#!/usr/bin/env node
// claude-mem-lite MCP Server — All-in-one memory system
// FTS5 search, zero LLM calls, single process

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { jaccardSimilarity, truncate, typeIcon, sanitizeFtsQuery, relaxFtsQueryToOr, inferProject, computeMinHash, scrubSecrets, fmtDate, isoWeekKey, debugLog, debugCatch } from './utils.mjs';
import { ensureDb, DB_PATH } from './schema.mjs';
import { reRankWithContext, markSuperseded, extractPRFTerms, expandQueryByConcepts } from './server-internals.mjs';
import { memSearchSchema, memTimelineSchema, memGetSchema, memDeleteSchema, memSaveSchema, memStatsSchema, memCompressSchema } from './tool-schemas.mjs';

// ─── Database ───────────────────────────────────────────────────────────────

import { rmSync } from 'fs';

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

// inferProject, jaccardSimilarity, sanitizeFtsQuery, typeIcon, truncate, fmtDate imported from utils.mjs

// ─── Scoring Model Constants ────────────────────────────────────────────────
//
// Composite scoring: BM25(weights) × recency_decay × [project_boost] × [importance] × [access_bonus]
//
// BM25 column weights — higher weight = matches in that column score higher:
//   observations_fts:        title=10, subtitle=5, narrative=5, text=3, facts=3, concepts=2
//   session_summaries_fts:   request=5, investigated=3, learned=3, completed=3, next_steps=2, notes=1
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

const OBS_BM25 = 'bm25(observations_fts, 10, 5, 5, 3, 3, 2)';
const SESS_BM25 = 'bm25(session_summaries_fts, 5, 3, 3, 3, 2, 1)';
const RECENCY_HALF_LIFE_MS = 1209600000; // 14 days in milliseconds

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'claude-mem-lite', version: '2.0.0' },
  {
    instructions: [
      'Proactively search memory to leverage past experience. This is your long-term memory across sessions.',
      '',
      'WHEN TO SEARCH (mem_search):',
      '- Error/bug encountered → mem_search(query="<error keyword>", obs_type="bugfix")',
      '- Before modifying important files → mem_search(query="<filename>")',
      '- Architecture/design decisions → mem_search(query="<topic>", obs_type="decision")',
      '- Stuck or blocked → mem_search(query="<problem description>")',
      '- Starting work on a feature → mem_search(query="<feature name>")',
      '',
      'WHEN TO SAVE (mem_save):',
      '- Non-obvious debugging discovery → mem_save with type="bugfix"',
      '- Key architecture decision → mem_save with type="decision"',
      '- Important pattern or convention found → mem_save with type="discovery"',
      '',
      'WORKFLOW: mem_search → mem_timeline(anchor=ID) → mem_get(ids=[...]) for full context.',
    ].join('\n'),
  },
);

function safeHandler(fn) {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

// ─── Tool: mem_search — helper functions ────────────────────────────────────

function searchObservations(ctx) {
  const { ftsQuery, args, epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject, limit } = ctx;
  const results = [];

  if (ftsQuery) {
    const now = Date.now();
    const projectBoost = args.project ? null : currentProject;
    const rows = db.prepare(`
      SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.importance,
             o.files_modified,
             snippet(observations_fts, 2, '»', '«', '…', 10) as match_snippet,
             ${OBS_BM25}
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${RECENCY_HALF_LIFE_MS}.0))
               * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
               * (0.5 + 0.5 * COALESCE(o.importance, 1))
               * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0))) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND COALESCE(o.compressed_into, 0) = 0
        AND (? IS NULL OR o.project = ?)
        AND (? IS NULL OR o.type = ?)
        AND (? IS NULL OR o.created_at_epoch >= ?)
        AND (? IS NULL OR o.created_at_epoch <= ?)
        AND (? IS NULL OR COALESCE(o.importance, 1) >= ?)
      ORDER BY score
      LIMIT ? OFFSET ?
    `).all(
      now,
      projectBoost, projectBoost,
      ftsQuery,
      args.project ?? null, args.project ?? null,
      args.obs_type ?? null, args.obs_type ?? null,
      epochFrom, epochFrom,
      epochTo, epochTo,
      args.importance ?? null, args.importance ?? null,
      perSourceLimit, perSourceOffset
    );
    for (const r of rows) {
      results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, score: r.score, files_modified: r.files_modified, importance: r.importance, snippet: r.match_snippet || '' });
    }

    // OR fallback: when AND query returns 0 results, retry with OR semantics
    if (rows.length === 0) {
      const orQuery = relaxFtsQueryToOr(ftsQuery);
      if (orQuery) {
        try {
          const orRows = db.prepare(`
            SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.importance,
                   o.files_modified,
                   snippet(observations_fts, 2, '»', '«', '…', 10) as match_snippet,
                   ${OBS_BM25}
                     * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${RECENCY_HALF_LIFE_MS}.0))
                     * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
                     * (0.5 + 0.5 * COALESCE(o.importance, 1))
                     * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
                     * 0.8 as score
            FROM observations_fts
            JOIN observations o ON observations_fts.rowid = o.id
            WHERE observations_fts MATCH ?
              AND COALESCE(o.compressed_into, 0) = 0
              AND (? IS NULL OR o.project = ?)
              AND (? IS NULL OR o.type = ?)
              AND (? IS NULL OR o.created_at_epoch >= ?)
              AND (? IS NULL OR o.created_at_epoch <= ?)
              AND (? IS NULL OR COALESCE(o.importance, 1) >= ?)
            ORDER BY score
            LIMIT ? OFFSET ?
          `).all(
            now,
            projectBoost, projectBoost,
            orQuery,
            args.project ?? null, args.project ?? null,
            args.obs_type ?? null, args.obs_type ?? null,
            epochFrom, epochFrom,
            epochTo, epochTo,
            args.importance ?? null, args.importance ?? null,
            perSourceLimit, perSourceOffset
          );
          for (const r of orRows) {
            results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, score: r.score, files_modified: r.files_modified, importance: r.importance, snippet: r.match_snippet || '' });
          }
        } catch (e) { debugCatch(e, 'searchObservations-or-fallback'); }
      }
    }

    // Two-phase query expansion for sparse results
    if (rows.length > 0 && results.length < limit) {
      const existingIds = new Set(results.map(r => r.id));
      expandObsByConceptCo(ctx, now, existingIds, results);
      expandObsByPRF(ctx, now, rows.length, existingIds, results);
    }
  } else {
    const params = [];
    const wheres = ['COALESCE(compressed_into, 0) = 0'];
    if (args.project) { wheres.push('project = ?'); params.push(args.project); }
    if (args.obs_type) { wheres.push('type = ?'); params.push(args.obs_type); }
    if (epochFrom !== null) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
    if (epochTo !== null) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
    if (args.importance) { wheres.push('COALESCE(importance, 1) >= ?'); params.push(args.importance); }
    const where = `WHERE ${wheres.join(' AND ')}`;
    params.push(perSourceLimit, perSourceOffset);
    const rows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at, created_at_epoch, files_modified, importance
      FROM observations ${where}
      ORDER BY created_at_epoch DESC
      LIMIT ? OFFSET ?
    `).all(...params);
    for (const r of rows) {
      results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, dateEpoch: r.created_at_epoch });
    }
  }

  return results;
}

function expandObsByConceptCo(ctx, now, existingIds, results) {
  const { ftsQuery, args, epochFrom, epochTo, limit } = ctx;
  if (results.length >= Math.ceil(limit / 2)) return;
  const expanded = expandQueryByConcepts(db, ftsQuery, args.project);
  if (expanded.length === 0) return;
  const expansionFts = expanded.map(c => `"${c.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const expRows = db.prepare(`
      SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.importance,
             o.files_modified,
             ${OBS_BM25}
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${RECENCY_HALF_LIFE_MS}.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1)) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND COALESCE(o.compressed_into, 0) = 0
        AND (? IS NULL OR o.project = ?)
        AND (? IS NULL OR o.type = ?)
        AND (? IS NULL OR o.created_at_epoch >= ?)
        AND (? IS NULL OR o.created_at_epoch <= ?)
        AND (? IS NULL OR COALESCE(o.importance, 1) >= ?)
      ORDER BY score
      LIMIT ?
    `).all(
      now, expansionFts,
      args.project ?? null, args.project ?? null,
      args.obs_type ?? null, args.obs_type ?? null,
      epochFrom, epochFrom,
      epochTo, epochTo,
      args.importance ?? null, args.importance ?? null,
      limit
    );
    for (const r of expRows) {
      if (!existingIds.has(r.id)) {
        existingIds.add(r.id);
        results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, score: r.score * 0.7, files_modified: r.files_modified, importance: r.importance, snippet: '' });
      }
    }
  } catch (e) { debugLog('WARN', 'mem_search', `concept expansion error: ${e.message}`); }
}

function expandObsByPRF(ctx, now, primaryCount, existingIds, results) {
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
    const prfRows = db.prepare(`
      SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.importance,
             o.files_modified,
             ${OBS_BM25}
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${RECENCY_HALF_LIFE_MS}.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1)) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND COALESCE(o.compressed_into, 0) = 0
        AND (? IS NULL OR o.project = ?)
        AND (? IS NULL OR o.type = ?)
        AND (? IS NULL OR o.created_at_epoch >= ?)
        AND (? IS NULL OR o.created_at_epoch <= ?)
        AND (? IS NULL OR COALESCE(o.importance, 1) >= ?)
      ORDER BY score
      LIMIT ?
    `).all(
      now, prfFts,
      args.project ?? null, args.project ?? null,
      args.obs_type ?? null, args.obs_type ?? null,
      epochFrom, epochFrom,
      epochTo, epochTo,
      args.importance ?? null, args.importance ?? null,
      limit
    );
    for (const r of prfRows) {
      if (!existingIds.has(r.id)) {
        existingIds.add(r.id);
        results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, score: r.score * 0.6, files_modified: r.files_modified, importance: r.importance, snippet: '' });
      }
    }
  } catch (e) { debugLog('WARN', 'mem_search', `PRF expansion error: ${e.message}`); }
}

function searchSessions(ctx) {
  const { ftsQuery, searchType, args, epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject } = ctx;
  const results = [];

  if (ftsQuery) {
    const now = Date.now();
    const sessionProjectBoost = args.project ? null : currentProject;
    const rows = db.prepare(`
      SELECT s.id, s.request, s.completed, s.project, s.created_at,
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
      results.push({ source: 'session', id: r.id, request: r.request, completed: r.completed, project: r.project, date: r.created_at, score: r.score });
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
      results.push({ source: 'session', id: r.id, request: r.request, completed: r.completed, project: r.project, date: r.created_at, dateEpoch: r.created_at_epoch });
    }
  }

  return results;
}

function searchPrompts(ctx) {
  const { ftsQuery, searchType, args, epochFrom, epochTo, perSourceLimit, perSourceOffset } = ctx;
  const results = [];

  if (ftsQuery) {
    const rows = db.prepare(`
      SELECT p.id, p.prompt_text, p.content_session_id, p.created_at,
             bm25(user_prompts_fts, 1) as score
      FROM user_prompts_fts
      JOIN user_prompts p ON user_prompts_fts.rowid = p.id
      JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE user_prompts_fts MATCH ?
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
    for (const r of rows) {
      results.push({ source: 'prompt', id: r.id, text: r.prompt_text, session: r.content_session_id, date: r.created_at, score: r.score });
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
      results.push({ source: 'prompt', id: r.id, text: r.prompt_text, session: r.content_session_id, date: r.created_at, dateEpoch: r.created_at_epoch });
    }
  }

  return results;
}

function formatSearchOutput(paginatedResults, args, ftsQuery, totalCount, isCrossSource) {
  if (paginatedResults.length === 0) {
    const hint = ['No results found.'];
    if (args.query) {
      const expanded = ftsQuery || args.query;
      if (expanded !== args.query) hint.push(`Searched as: ${expanded}`);
      hint.push('Tip: check spelling, try broader terms, or use mem_stats to see available data.');
    }
    return { content: [{ type: 'text', text: hint.join('\n') }] };
  }

  const lines = [];
  const countLabel = isCrossSource && totalCount > paginatedResults.length
    ? `${paginatedResults.length} of ${totalCount}`
    : `${paginatedResults.length}`;
  lines.push(`Found ${countLabel} result(s)${args.query ? ` for "${args.query}"` : ''}:\n`);

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
    description: 'FTS5 full-text search across observations, sessions, and prompts with BM25 ranking. Returns compact index (use mem_get for details).',
    inputSchema: memSearchSchema,
  },
  safeHandler(async (args) => {
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    const ftsQuery = sanitizeFtsQuery(args.query);
    const searchType = args.type;
    const currentProject = inferProject();

    const isCrossSource = !searchType;
    const perSourceLimit = isCrossSource ? Math.max(limit * 3, offset + limit + 10) : limit;
    const perSourceOffset = isCrossSource ? 0 : offset;

    // Parse date bounds to epoch (with validation)
    // date_to with date-only format (YYYY-MM-DD) extends to end-of-day (23:59:59.999Z)
    const epochFrom = args.date_from ? new Date(args.date_from).getTime() : null;
    let epochTo = args.date_to ? new Date(args.date_to).getTime() : null;
    if (epochTo !== null && args.date_to && /^\d{4}-\d{2}-\d{2}$/.test(args.date_to)) {
      epochTo += 86400000 - 1; // extend to 23:59:59.999
    }
    if (epochFrom !== null && isNaN(epochFrom)) throw new Error(`Invalid date_from: ${args.date_from}`);
    if (epochTo !== null && isNaN(epochTo)) throw new Error(`Invalid date_to: ${args.date_to}`);

    const ctx = { ftsQuery, searchType, args, epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject, limit };
    const results = [];

    if (!searchType || searchType === 'observations') results.push(...searchObservations(ctx));
    if (!searchType || searchType === 'sessions')     results.push(...searchSessions(ctx));
    if (!searchType || searchType === 'prompts')       results.push(...searchPrompts(ctx));

    // Global sort (cross-source)
    if (isCrossSource && results.length > 0) {
      if (ftsQuery) {
        results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
      } else {
        results.sort((a, b) => (b.dateEpoch ?? 0) - (a.dateEpoch ?? 0));
      }
    }

    // Re-rank observations by file context overlap and mark superseded
    if (ftsQuery && results.some(r => r.source === 'obs')) {
      const obsResults = results.filter(r => r.source === 'obs');
      reRankWithContext(db, obsResults, currentProject);
      markSuperseded(obsResults);
      results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    }

    const totalBeforePagination = results.length;
    const paginatedResults = isCrossSource ? results.slice(offset, offset + limit) : results;

    return formatSearchOutput(paginatedResults, args, ftsQuery, totalBeforePagination, isCrossSource);
  })
);

// ─── Tool: mem_timeline ─────────────────────────────────────────────────────

server.registerTool(
  'mem_timeline',
  {
    description: 'Browse observations as a timeline around an anchor point. Use query to auto-find anchor, or specify anchor ID directly.',
    inputSchema: memTimelineSchema,
  },
  safeHandler(async (args) => {
    const before = args.before ?? 5;
    const after = args.after ?? 5;
    let anchorId = args.anchor;

    // Auto-find anchor via FTS (with recency decay)
    if (!anchorId && args.query) {
      const ftsQuery = sanitizeFtsQuery(args.query);
      if (ftsQuery) {
        const nowT = Date.now();
        const row = db.prepare(`
          SELECT o.id
          FROM observations_fts
          JOIN observations o ON observations_fts.rowid = o.id
          WHERE observations_fts MATCH ?
            AND (? IS NULL OR o.project = ?)
            AND COALESCE(o.compressed_into, 0) = 0
          ORDER BY ${OBS_BM25}
            * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${RECENCY_HALF_LIFE_MS}.0))
          LIMIT 1
        `).get(ftsQuery, args.project ?? null, args.project ?? null, nowT);
        if (row) anchorId = row.id;
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

    const projectFilter = args.project ? 'AND project = ?' : '';
    const baseParams = args.project ? [args.project] : [];

    // Before anchor
    const beforeRows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at
      FROM observations
      WHERE created_at_epoch < ? AND COALESCE(compressed_into, 0) = 0 ${projectFilter}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(anchorRow.created_at_epoch, ...baseParams, before);

    // After anchor
    const afterRows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at
      FROM observations
      WHERE created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0 ${projectFilter}
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `).all(anchorRow.created_at_epoch, ...baseParams, after);

    // Anchor itself
    const anchor = db.prepare('SELECT id, type, title, subtitle, project, created_at FROM observations WHERE id = ?').get(anchorId);

    const all = [...beforeRows.reverse(), anchor, ...afterRows];
    const lines = [`Timeline around #${anchorId}:\n`];
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
    description: 'Get full details for one or more records by ID. Use after mem_search to drill into specific records.',
    inputSchema: memGetSchema,
  },
  safeHandler(async (args) => {
    const source = args.source || 'obs';
    const placeholders = args.ids.map(() => '?').join(',');

    let rows, allFields, prefix;
    if (source === 'session') {
      rows = db.prepare(`SELECT * FROM session_summaries WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...args.ids);
      allFields = ['id', 'request', 'investigated', 'learned', 'completed', 'next_steps', 'files_read', 'files_edited', 'notes', 'project', 'created_at', 'memory_session_id', 'prompt_number'];
      prefix = 'S#';
    } else if (source === 'prompt') {
      rows = db.prepare(`SELECT * FROM user_prompts WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...args.ids);
      allFields = ['id', 'prompt_text', 'content_session_id', 'prompt_number', 'created_at'];
      prefix = 'P#';
    } else {
      // Increment access_count for retrieved observations (batch UPDATE)
      db.prepare(
        `UPDATE observations SET access_count = COALESCE(access_count, 0) + 1 WHERE id IN (${placeholders})`
      ).run(...args.ids);
      rows = db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...args.ids);
      allFields = ['id', 'type', 'title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'files_read', 'files_modified', 'project', 'created_at', 'memory_session_id', 'prompt_number', 'importance', 'related_ids', 'access_count'];
      prefix = '#';
    }

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No ${source === 'session' ? 'sessions' : source === 'prompt' ? 'prompts' : 'observations'} found for given IDs.` }] };
    }

    const fields = args.fields?.length ? args.fields.filter(f => allFields.includes(f)) : allFields;

    const parts = [];
    for (const row of rows) {
      const lines = [`── ${prefix}${row.id} ──`];
      for (const f of fields) {
        const val = row[f];
        if (val === null || val === undefined || val === '') continue;
        lines.push(`${f}: ${typeof val === 'string' && val.length > 200 ? val.slice(0, 200) + '…' : val}`);
      }
      parts.push(lines.join('\n'));
    }

    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  })
);

// ─── Tool: mem_delete ────────────────────────────────────────────────────────

server.registerTool(
  'mem_delete',
  {
    description: 'Delete observations by ID. Use confirm=false to preview, confirm=true to execute. FTS5 cleanup is automatic via triggers.',
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
      // Use LIKE filter to avoid O(N) full-table scan — only fetch rows that may reference deleted IDs
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

    return { content: [{ type: 'text', text: `Deleted ${result.changes} observation(s).` }] };
  })
);

// ─── Tool: mem_save ─────────────────────────────────────────────────────────

server.registerTool(
  'mem_save',
  {
    description: 'Manually save a memory/observation. Use for important findings, decisions, or notes worth preserving.',
    inputSchema: memSaveSchema,
  },
  safeHandler(async (args) => {
    const now = new Date();
    const project = args.project || inferProject();
    const type = args.type || 'discovery';
    const title = args.title || args.content.slice(0, 100);
    const sessionId = `manual-${project}`;

    // Ensure session exists (INSERT OR IGNORE avoids race condition on concurrent calls)
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // Dedup: skip if a similar title or content was saved recently (5 min window)
    const fiveMinAgo = now.getTime() - 5 * 60 * 1000;
    const recent = db.prepare(`
      SELECT title, text FROM observations
      WHERE project = ? AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC LIMIT 50
    `).all(project, fiveMinAgo);

    if (title && recent.some(r =>
      jaccardSimilarity(r.title, title) > 0.7 ||
      jaccardSimilarity(r.text || '', args.content) > 0.7
    )) {
      return { content: [{ type: 'text', text: `Skipped: a similar observation already exists in project "${project}".` }] };
    }

    const safeContent = scrubSecrets(args.content);
    const safeTitle = scrubSecrets(title);
    const minhashSig = computeMinHash(safeTitle + ' ' + safeContent);

    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', ?, ?, ?, ?)
    `).run(sessionId, project, safeContent, type, safeTitle, safeContent, args.importance ?? 1, minhashSig, now.toISOString(), now.getTime());

    return { content: [{ type: 'text', text: `Saved as observation #${result.lastInsertRowid} [${type}] in project "${project}".` }] };
  })
);

// ─── Tool: mem_stats ────────────────────────────────────────────────────────

server.registerTool(
  'mem_stats',
  {
    description: 'Get statistics about stored memories: counts, types, projects, recent activity.',
    inputSchema: memStatsSchema,
  },
  safeHandler(async (args) => {
    const days = args.days ?? 30;
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
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_compress ──────────────────────────────────────────────────────

server.registerTool(
  'mem_compress',
  {
    description: 'Compress old low-value observations into weekly summaries. Use preview=true to see candidates first.',
    inputSchema: memCompressSchema,
  },
  safeHandler(async (args) => {
    const preview = args.preview !== false;
    const ageDays = args.age_days ?? 60;
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

        // Ensure session exists (INSERT OR IGNORE avoids race condition)
        const now = new Date();
        db.prepare(`
          INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
          VALUES (?, ?, ?, ?, ?, 'active')
        `).run(sessionId, sessionId, proj, now.toISOString(), now.getTime());

        const summaryResult = insertSummary.run(
          sessionId, proj, narrative, dominantType, title, narrative,
          now.toISOString(), now.getTime()
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

// ─── WAL Checkpoint (periodic) ───────────────────────────────────────────────

// Checkpoint WAL every 5 minutes to prevent unbounded growth
const WAL_CHECKPOINT_INTERVAL = 5 * 60 * 1000;
const walTimer = setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { debugCatch(e, 'walCheckpoint'); }
}, WAL_CHECKPOINT_INTERVAL);
walTimer.unref(); // Don't keep process alive just for checkpoints

// ─── Shutdown Cleanup ────────────────────────────────────────────────────────

function shutdown(exitCode = 0) {
  clearInterval(walTimer);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
  process.exit(exitCode);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => { debugCatch(err, 'uncaughtException'); shutdown(1); });
process.on('unhandledRejection', (err) => { debugCatch(err, 'unhandledRejection'); shutdown(1); });

// ─── Start Server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
