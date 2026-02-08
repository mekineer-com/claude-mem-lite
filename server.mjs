#!/usr/bin/env node
// claude-mem-lite MCP Server — All-in-one memory system
// FTS5 search, zero LLM calls, single process

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { jaccardSimilarity, truncate, typeIcon, sanitizeFtsQuery, inferProject, computeMinHash, scrubSecrets } from './utils.mjs';
import { ensureDb } from './schema.mjs';

// ─── Database ───────────────────────────────────────────────────────────────

const db = ensureDb();
// Server process uses longer busy_timeout for concurrent MCP requests
db.pragma('busy_timeout = 5000');

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${mon} ${day} ${h}:${m}`;
}

// inferProject, jaccardSimilarity, sanitizeFtsQuery, typeIcon, truncate imported from utils.mjs

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claude-mem-lite',
  version: '2.0.0',
});

function safeHandler(fn) {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

// ─── Search Re-ranking Helpers ────────────────────────────────────────────

function reRankWithContext(db, results, project) {
  if (!results || results.length === 0) return;
  // Get recently active files (last 2 hours, same project)
  const twoHoursAgo = Date.now() - 2 * 3600000;
  const recentObs = db.prepare(`
    SELECT files_modified FROM observations
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC LIMIT 10
  `).all(project, twoHoursAgo);

  const activeFiles = new Set();
  for (const r of recentObs) {
    try {
      const files = JSON.parse(r.files_modified || '[]');
      for (const f of files) activeFiles.add(f);
    } catch {}
  }
  if (activeFiles.size === 0) return;

  for (const result of results) {
    if (result.source !== 'obs' || !result.files_modified) continue;
    let resultFiles;
    try { resultFiles = JSON.parse(result.files_modified || '[]'); } catch { continue; }
    if (resultFiles.length === 0) continue;
    const commonFiles = resultFiles.filter(f => activeFiles.has(f));
    const fileOverlap = commonFiles.length / resultFiles.length;
    // BM25 scores are negative — multiply by >1 makes more negative = better rank
    if (result.score != null) {
      result.score *= (1.0 + 0.3 * fileOverlap);
    }
  }
  // Note: caller re-sorts the main results array after this — no sort needed here
}

function markSuperseded(results) {
  if (!results || results.length === 0) return;
  // Build map: file → [result objects], only for obs with files
  const fileMap = new Map();
  for (const r of results) {
    if (r.source !== 'obs' || !r.files_modified) continue;
    let files;
    try { files = JSON.parse(r.files_modified || '[]'); } catch { continue; }
    for (const f of files) {
      if (!fileMap.has(f)) fileMap.set(f, []);
      fileMap.get(f).push(r);
    }
  }
  // For each file with 2+ observations: mark older lower-importance as superseded
  for (const [, obsForFile] of fileMap) {
    if (obsForFile.length < 2) continue;
    obsForFile.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const newest = obsForFile[0];
    for (let i = 1; i < obsForFile.length; i++) {
      if ((obsForFile[i].importance ?? 1) <= (newest.importance ?? 1)) {
        obsForFile[i].superseded = true;
      }
    }
  }
}

// ─── Tool: mem_search ───────────────────────────────────────────────────────

server.registerTool(
  'mem_search',
  {
    description: 'FTS5 full-text search across observations, sessions, and prompts with BM25 ranking. Returns compact index (use mem_get for details).',
    inputSchema: {
      query: z.string().optional().describe('Search query (FTS5 syntax supported)'),
      type: z.enum(['observations', 'sessions', 'prompts']).optional().describe('Limit to one table'),
      obs_type: z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']).optional().describe('Filter observation type'),
      project: z.string().optional().describe('Filter by project name'),
      date_from: z.string().optional().describe('Start date (ISO 8601 or YYYY-MM-DD)'),
      date_to: z.string().optional().describe('End date (ISO 8601 or YYYY-MM-DD)'),
      importance: z.number().int().min(1).max(3).optional().describe('Minimum importance (1=routine, 2=notable, 3=critical)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
      offset: z.number().int().min(0).optional().describe('Offset for pagination'),
    },
  },
  safeHandler(async (args) => {
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    const ftsQuery = sanitizeFtsQuery(args.query);
    const searchType = args.type;
    const results = [];
    const currentProject = inferProject();

    // Cross-source: over-fetch per source to ensure enough results after merge+sort
    const isCrossSource = !searchType;
    const perSourceLimit = isCrossSource ? Math.max(limit * 3, offset + limit + 10) : limit;
    const perSourceOffset = isCrossSource ? 0 : offset;

    // Parse date bounds to epoch (with validation)
    const epochFrom = args.date_from ? new Date(args.date_from).getTime() : null;
    const epochTo = args.date_to ? new Date(args.date_to).getTime() : null;
    if (epochFrom !== null && isNaN(epochFrom)) throw new Error(`Invalid date_from: ${args.date_from}`);
    if (epochTo !== null && isNaN(epochTo)) throw new Error(`Invalid date_to: ${args.date_to}`);

    // Search observations
    if (!searchType || searchType === 'observations') {
      if (ftsQuery) {
        const now = Date.now();
        // Project boost: current project gets 2x ranking boost (not filtered, just prioritized)
        const projectBoost = args.project ? null : currentProject;
        const rows = db.prepare(`
          SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.importance,
                 o.files_modified,
                 bm25(observations_fts, 10, 5, 5, 3, 3, 2)
                   * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
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
          results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, score: r.score, files_modified: r.files_modified, importance: r.importance });
        }
      } else {
        // Structured filter (no FTS)
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
    }

    // Search session summaries
    if (!searchType || searchType === 'sessions') {
      if (ftsQuery) {
        const nowS = Date.now();
        const sessionProjectBoost = args.project ? null : currentProject;
        const rows = db.prepare(`
          SELECT s.id, s.request, s.completed, s.project, s.created_at,
                 bm25(session_summaries_fts, 5, 3, 3, 3, 2, 1)
                   * (1.0 + EXP(-0.693 * (? - s.created_at_epoch) / 1209600000.0))
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
          nowS,
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
    }

    // Search user prompts
    if (!searchType || searchType === 'prompts') {
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
    }

    // Global sort and pagination (cross-source)
    if (isCrossSource && results.length > 0) {
      if (ftsQuery) {
        // FTS mode: BM25 returns negative scores; more negative = better match
        results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
      } else {
        // Non-FTS mode: sort by date descending
        results.sort((a, b) => (b.dateEpoch ?? 0) - (a.dateEpoch ?? 0));
      }
    }

    // Re-rank observations by file context overlap and mark superseded
    if (ftsQuery && results.some(r => r.source === 'obs')) {
      reRankWithContext(db, results.filter(r => r.source === 'obs'), currentProject);
      markSuperseded(results.filter(r => r.source === 'obs'));
      // Re-sort main array after score adjustments from re-ranking
      results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    }

    const totalBeforePagination = results.length;
    const paginatedResults = isCrossSource ? results.slice(offset, offset + limit) : results;

    // Format compact output
    if (paginatedResults.length === 0) {
      return { content: [{ type: 'text', text: 'No results found.' }] };
    }

    const lines = [];
    const countLabel = isCrossSource && totalBeforePagination > paginatedResults.length
      ? `${paginatedResults.length} of ${totalBeforePagination}`
      : `${paginatedResults.length}`;
    lines.push(`Found ${countLabel} result(s)${args.query ? ` for "${args.query}"` : ''}:\n`);

    for (const r of paginatedResults) {
      if (r.source === 'obs') {
        const supersededTag = r.superseded ? ' [SUPERSEDED]' : '';
        lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.date)}${supersededTag}`);
      } else if (r.source === 'session') {
        lines.push(`S#${r.id} 📋 ${truncate(r.request || r.completed || '(no summary)')} | ${r.project} | ${fmtDate(r.date)}`);
      } else if (r.source === 'prompt') {
        lines.push(`P#${r.id} 💬 ${truncate(r.text)} | ${fmtDate(r.date)}`);
      }
    }

    lines.push(`\nUse mem_get(ids=[...]) for full details.`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_timeline ─────────────────────────────────────────────────────

server.registerTool(
  'mem_timeline',
  {
    description: 'Browse observations as a timeline around an anchor point. Use query to auto-find anchor, or specify anchor ID directly.',
    inputSchema: {
      anchor: z.number().int().optional().describe('Observation ID as center point'),
      query: z.string().optional().describe('FTS5 query to auto-find anchor'),
      before: z.number().int().min(0).max(50).optional().describe('Items before anchor (default 5)'),
      after: z.number().int().min(0).max(50).optional().describe('Items after anchor (default 5)'),
      project: z.string().optional().describe('Filter by project'),
    },
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
          ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2)
            * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
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
    inputSchema: {
      ids: z.array(z.number().int()).min(1).max(20).describe('Observation IDs to retrieve'),
      source: z.enum(['obs', 'session', 'prompt']).optional().describe('Record type: obs (default), session (S# from search), prompt (P# from search)'),
      fields: z.array(z.string()).optional().describe('Specific fields to return (default: all)'),
    },
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
      // Increment access_count for retrieved observations
      const updateStmt = db.prepare(
        'UPDATE observations SET access_count = COALESCE(access_count, 0) + 1 WHERE id = ?'
      );
      db.transaction(() => { for (const id of args.ids) updateStmt.run(id); })();
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
    inputSchema: {
      ids: z.array(z.number().int()).min(1).max(50).describe('Observation IDs to delete'),
      confirm: z.boolean().describe('false=preview what will be deleted, true=execute deletion'),
    },
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
      const referencing = db.prepare(`
        SELECT id, related_ids FROM observations
        WHERE related_ids IS NOT NULL AND related_ids != '[]'
      `).all();
      for (const r of referencing) {
        let ids;
        try { ids = JSON.parse(r.related_ids); } catch { continue; }
        if (!Array.isArray(ids)) continue;
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
    inputSchema: {
      content: z.string().min(1).describe('Memory content to save'),
      title: z.string().optional().describe('Short title'),
      type: z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']).optional().describe('Observation type (default: discovery)'),
      project: z.string().optional().describe('Project name (default: inferred from CWD)'),
      importance: z.number().int().min(1).max(3).optional().describe('Importance level: 1=routine, 2=notable, 3=critical (default: 1)'),
    },
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
    inputSchema: {
      project: z.string().optional().describe('Filter by project'),
      days: z.number().int().min(1).max(365).optional().describe('Look back N days (default 30)'),
    },
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
    inputSchema: {
      preview: z.boolean().optional().describe('true=count candidates, false=execute compression (default: true)'),
      age_days: z.number().int().min(30).max(365).optional().describe('Min age in days (default: 60)'),
      project: z.string().optional().describe('Filter by project'),
    },
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
      // Proper ISO 8601 week: week 1 contains Jan 4, weeks start on Monday
      const d = new Date(c.created_at_epoch);
      const tmp = new Date(d.getTime());
      tmp.setHours(0, 0, 0, 0);
      tmp.setDate(tmp.getDate() + 4 - (tmp.getDay() || 7));
      const yearStart = new Date(tmp.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
      const isoYear = tmp.getFullYear();
      const key = `${c.project}::${isoYear}-W${String(weekNum).padStart(2, '0')}`;
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
      VALUES (?, ?, ?, 'change', ?, '', ?, '', '', '[]', '[]', 2, ?, ?)
    `);
    const markCompressed = db.prepare(
      'UPDATE observations SET compressed_into = ? WHERE id = ?'
    );

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
          sessionId, proj, narrative, title, narrative,
          now.toISOString(), now.getTime()
        );
        const summaryId = Number(summaryResult.lastInsertRowid);

        for (const o of obs) {
          markCompressed.run(summaryId, o.id);
        }
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
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
}, WAL_CHECKPOINT_INTERVAL);
walTimer.unref(); // Don't keep process alive just for checkpoints

// ─── Shutdown Cleanup ────────────────────────────────────────────────────────

function shutdown() {
  clearInterval(walTimer);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start Server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
