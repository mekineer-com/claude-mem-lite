#!/usr/bin/env node
// claude-mem-lite MCP Server — All-in-one memory system
// FTS5 search, zero LLM calls, single process

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { z } from 'zod';

// ─── Database ───────────────────────────────────────────────────────────────

const DB_DIR = join(homedir(), 'claude-mem-lite');
const DB_PATH = join(DB_DIR, 'claude-mem.db');

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Ensure core tables exist (for fresh installs)
db.exec(`
  CREATE TABLE IF NOT EXISTS sdk_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT NOT NULL UNIQUE,
    memory_session_id TEXT,
    project TEXT NOT NULL,
    user_prompt TEXT,
    started_at TEXT NOT NULL,
    started_at_epoch INTEGER NOT NULL,
    completed_at TEXT,
    completed_at_epoch INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    worker_port INTEGER,
    prompt_counter INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    text TEXT,
    type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
    title TEXT,
    subtitle TEXT,
    facts TEXT,
    narrative TEXT,
    concepts TEXT,
    files_read TEXT,
    files_modified TEXT,
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    files_read TEXT,
    files_edited TEXT,
    notes TEXT,
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT NOT NULL,
    prompt_text TEXT,
    prompt_number INTEGER,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );
`);

// Ensure FTS5 tables + triggers exist
ensureFTS('observations_fts', 'observations', ['title', 'subtitle', 'narrative', 'text', 'facts', 'concepts']);
ensureFTS('session_summaries_fts', 'session_summaries', ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes']);
ensureFTS('user_prompts_fts', 'user_prompts', ['prompt_text']);

function ensureFTS(ftsName, tableName, columns) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(ftsName);
  if (exists) return;

  // Validate identifiers to prevent SQL injection
  const idRe = /^[a-z_]+$/;
  if (!idRe.test(ftsName) || !idRe.test(tableName) || !columns.every(c => idRe.test(c))) {
    throw new Error(`Invalid identifier in ensureFTS: ${ftsName}, ${tableName}`);
  }

  const colList = columns.join(', ');
  const newVals = columns.map(c => `new.${c}`).join(', ');
  const oldVals = columns.map(c => `old.${c}`).join(', ');
  db.exec(`
    CREATE VIRTUAL TABLE ${ftsName} USING fts5(${colList}, content='${tableName}', content_rowid='id');

    CREATE TRIGGER ${tableName}_ai AFTER INSERT ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newVals});
    END;

    CREATE TRIGGER ${tableName}_ad AFTER DELETE ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES('delete', old.id, ${oldVals});
    END;

    CREATE TRIGGER ${tableName}_au AFTER UPDATE ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES('delete', old.id, ${oldVals});
      INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newVals});
    END;
  `);
}

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

function typeIcon(type) {
  const icons = { decision: '🟡', bugfix: '🔴', feature: '🟢', refactor: '🔵', discovery: '🔍', change: '📝' };
  return icons[type] || '⚪';
}

function truncate(str, max = 80) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// Sanitize FTS5 query: escape special chars, wrap tokens in double quotes
function sanitizeFtsQuery(query) {
  if (!query) return null;
  // Remove FTS5 operators that could cause syntax errors
  const cleaned = query.replace(/[{}()\[\]^~*:]/g, ' ').trim();
  if (!cleaned) return null;
  // Split into tokens, quote each, join with space (implicit AND)
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

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

// ─── Tool: mem_search ───────────────────────────────────────────────────────

server.tool(
  'mem_search',
  'FTS5 full-text search across observations, sessions, and prompts with BM25 ranking. Returns compact index (use mem_get for details).',
  {
    query: z.string().optional().describe('Search query (FTS5 syntax supported)'),
    type: z.enum(['observations', 'sessions', 'prompts']).optional().describe('Limit to one table'),
    obs_type: z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']).optional().describe('Filter observation type'),
    project: z.string().optional().describe('Filter by project name'),
    date_from: z.string().optional().describe('Start date (ISO 8601 or YYYY-MM-DD)'),
    date_to: z.string().optional().describe('End date (ISO 8601 or YYYY-MM-DD)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    offset: z.number().int().min(0).optional().describe('Offset for pagination'),
  },
  safeHandler(async (args) => {
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    const ftsQuery = sanitizeFtsQuery(args.query);
    const searchType = args.type;
    const results = [];

    // Parse date bounds to epoch (with validation)
    const epochFrom = args.date_from ? new Date(args.date_from).getTime() : null;
    const epochTo = args.date_to ? new Date(args.date_to).getTime() : null;
    if (epochFrom !== null && isNaN(epochFrom)) throw new Error(`Invalid date_from: ${args.date_from}`);
    if (epochTo !== null && isNaN(epochTo)) throw new Error(`Invalid date_to: ${args.date_to}`);

    // Search observations
    if (!searchType || searchType === 'observations') {
      if (ftsQuery) {
        const rows = db.prepare(`
          SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at,
                 bm25(observations_fts, 10, 5, 5, 3, 3, 2) as score
          FROM observations_fts
          JOIN observations o ON observations_fts.rowid = o.id
          WHERE observations_fts MATCH ?
            AND (? IS NULL OR o.project = ?)
            AND (? IS NULL OR o.type = ?)
            AND (? IS NULL OR o.created_at_epoch >= ?)
            AND (? IS NULL OR o.created_at_epoch <= ?)
          ORDER BY score
          LIMIT ? OFFSET ?
        `).all(
          ftsQuery,
          args.project ?? null, args.project ?? null,
          args.obs_type ?? null, args.obs_type ?? null,
          epochFrom, epochFrom,
          epochTo, epochTo,
          limit, offset
        );
        for (const r of rows) {
          results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, score: r.score });
        }
      } else {
        // Structured filter (no FTS)
        const params = [];
        const wheres = [];
        if (args.project) { wheres.push('project = ?'); params.push(args.project); }
        if (args.obs_type) { wheres.push('type = ?'); params.push(args.obs_type); }
        if (epochFrom) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        params.push(limit, offset);
        const rows = db.prepare(`
          SELECT id, type, title, subtitle, project, created_at
          FROM observations ${where}
          ORDER BY created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) {
          results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at });
        }
      }
    }

    // Search session summaries
    if (!searchType || searchType === 'sessions') {
      if (ftsQuery) {
        const rows = db.prepare(`
          SELECT s.id, s.request, s.completed, s.project, s.created_at,
                 bm25(session_summaries_fts, 5, 3, 3, 3, 2, 1) as score
          FROM session_summaries_fts
          JOIN session_summaries s ON session_summaries_fts.rowid = s.id
          WHERE session_summaries_fts MATCH ?
            AND (? IS NULL OR s.project = ?)
            AND (? IS NULL OR s.created_at_epoch >= ?)
            AND (? IS NULL OR s.created_at_epoch <= ?)
          ORDER BY score
          LIMIT ? OFFSET ?
        `).all(
          ftsQuery,
          args.project ?? null, args.project ?? null,
          epochFrom, epochFrom,
          epochTo, epochTo,
          limit, offset
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
        if (epochFrom) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        params.push(limit, offset);
        const rows = db.prepare(`
          SELECT id, request, completed, project, created_at
          FROM session_summaries ${where}
          ORDER BY created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) {
          results.push({ source: 'session', id: r.id, request: r.request, completed: r.completed, project: r.project, date: r.created_at });
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
          WHERE user_prompts_fts MATCH ?
            AND (? IS NULL OR p.created_at_epoch >= ?)
            AND (? IS NULL OR p.created_at_epoch <= ?)
          ORDER BY score
          LIMIT ? OFFSET ?
        `).all(
          ftsQuery,
          epochFrom, epochFrom,
          epochTo, epochTo,
          limit, offset
        );
        for (const r of rows) {
          results.push({ source: 'prompt', id: r.id, text: r.prompt_text, session: r.content_session_id, date: r.created_at, score: r.score });
        }
      } else if (searchType === 'prompts') {
        const params = [];
        const wheres = [];
        if (epochFrom) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        params.push(limit, offset);
        const rows = db.prepare(`
          SELECT id, prompt_text, content_session_id, created_at
          FROM user_prompts ${where}
          ORDER BY created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) {
          results.push({ source: 'prompt', id: r.id, text: r.prompt_text, session: r.content_session_id, date: r.created_at });
        }
      }
    }

    // Format compact output
    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No results found.' }] };
    }

    const lines = [];
    lines.push(`Found ${results.length} result(s)${args.query ? ` for "${args.query}"` : ''}:\n`);

    for (const r of results) {
      if (r.source === 'obs') {
        lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.date)}`);
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

server.tool(
  'mem_timeline',
  'Browse observations as a timeline around an anchor point. Use query to auto-find anchor, or specify anchor ID directly.',
  {
    anchor: z.number().int().optional().describe('Observation ID as center point'),
    query: z.string().optional().describe('FTS5 query to auto-find anchor'),
    before: z.number().int().min(0).max(50).optional().describe('Items before anchor (default 5)'),
    after: z.number().int().min(0).max(50).optional().describe('Items after anchor (default 5)'),
    project: z.string().optional().describe('Filter by project'),
  },
  safeHandler(async (args) => {
    const before = args.before ?? 5;
    const after = args.after ?? 5;
    let anchorId = args.anchor;

    // Auto-find anchor via FTS
    if (!anchorId && args.query) {
      const ftsQuery = sanitizeFtsQuery(args.query);
      if (ftsQuery) {
        const row = db.prepare(`
          SELECT o.id
          FROM observations_fts
          JOIN observations o ON observations_fts.rowid = o.id
          WHERE observations_fts MATCH ?
            AND (? IS NULL OR o.project = ?)
          ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2)
          LIMIT 1
        `).get(ftsQuery, args.project ?? null, args.project ?? null);
        if (row) anchorId = row.id;
      }
    }

    // No anchor: return most recent
    if (!anchorId) {
      const projectFilter = args.project ? 'WHERE project = ?' : '';
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
      WHERE created_at_epoch < ? ${projectFilter}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(anchorRow.created_at_epoch, ...baseParams, before);

    // After anchor
    const afterRows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at
      FROM observations
      WHERE created_at_epoch > ? ${projectFilter}
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

server.tool(
  'mem_get',
  'Get full details for one or more observations by ID. Use after mem_search to drill into specific records.',
  {
    ids: z.array(z.number().int()).min(1).max(20).describe('Observation IDs to retrieve'),
    fields: z.array(z.string()).optional().describe('Specific fields to return (default: all)'),
  },
  safeHandler(async (args) => {
    const placeholders = args.ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC
    `).all(...args.ids);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No observations found for given IDs.' }] };
    }

    const allFields = ['id', 'type', 'title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'files_read', 'files_modified', 'project', 'created_at', 'memory_session_id', 'prompt_number'];
    const fields = args.fields?.length ? args.fields.filter(f => allFields.includes(f)) : allFields;

    const parts = [];
    for (const row of rows) {
      const lines = [`── #${row.id} ──`];
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

// ─── Tool: mem_save ─────────────────────────────────────────────────────────

server.tool(
  'mem_save',
  'Manually save a memory/observation. Use for important findings, decisions, or notes worth preserving.',
  {
    content: z.string().min(1).describe('Memory content to save'),
    title: z.string().optional().describe('Short title'),
    type: z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']).optional().describe('Observation type (default: discovery)'),
    project: z.string().optional().describe('Project name (default: inferred from CWD)'),
  },
  safeHandler(async (args) => {
    const now = new Date();
    const project = args.project || 'manual';
    const type = args.type || 'discovery';
    const title = args.title || args.content.slice(0, 100);
    const sessionId = `manual-${project}`;

    // Ensure session exists
    const existingSession = db.prepare('SELECT 1 FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    if (!existingSession) {
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());
    }

    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?)
    `).run(sessionId, project, args.content, type, title, args.content, now.toISOString(), now.getTime());

    return { content: [{ type: 'text', text: `Saved as observation #${result.lastInsertRowid} [${type}] in project "${project}".` }] };
  })
);

// ─── Tool: mem_stats ────────────────────────────────────────────────────────

server.tool(
  'mem_stats',
  'Get statistics about stored memories: counts, types, projects, recent activity.',
  {
    project: z.string().optional().describe('Filter by project'),
    days: z.number().int().min(1).max(365).optional().describe('Look back N days (default 30)'),
  },
  safeHandler(async (args) => {
    const days = args.days ?? 30;
    const cutoff = Date.now() - days * 86400000;
    const projectFilter = args.project ? 'AND project = ?' : '';
    const baseParams = args.project ? [args.project] : [];

    // Total counts
    const obsTotal = db.prepare(`SELECT COUNT(*) as c FROM observations WHERE 1=1 ${projectFilter}`).get(...baseParams);
    const sessTotal = db.prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE 1=1 ${projectFilter}`).get(...baseParams);
    const promptTotal = db.prepare(`SELECT COUNT(*) as c FROM user_prompts`).get();

    // Recent counts
    const obsRecent = db.prepare(`SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`).get(cutoff, ...baseParams);
    const sessRecent = db.prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE created_at_epoch >= ? ${projectFilter}`).get(cutoff, ...baseParams);

    // Type distribution (recent)
    const types = db.prepare(`
      SELECT type, COUNT(*) as c FROM observations
      WHERE created_at_epoch >= ? ${projectFilter}
      GROUP BY type ORDER BY c DESC
    `).all(cutoff, ...baseParams);

    // Projects
    const projects = db.prepare(`
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

    const lines = [
      `Memory Statistics${args.project ? ` (project: ${args.project})` : ''}:`,
      '',
      `Total: ${obsTotal.c} observations | ${sessTotal.c} sessions | ${promptTotal.c} prompts`,
      `Last ${days}d: ${obsRecent.c} observations | ${sessRecent.c} sessions`,
      '',
      'Type distribution (recent):',
      ...types.map(t => `  ${typeIcon(t.type)} ${t.type}: ${t.c}`),
      '',
      'Top projects:',
      ...projects.map(p => `  ${p.project}: ${p.c}`),
      '',
      'Daily activity (last 7d):',
      ...daily.map(d => `  ${d.day}: ${d.c} observations`),
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Shutdown Cleanup ────────────────────────────────────────────────────────

function shutdown() {
  try { db.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start Server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
