#!/usr/bin/env node
// claude-mem-lite: Auto-search memory on user prompt
// Runs as UserPromptSubmit hook — injects relevant memories before Claude sees the prompt
// Lightweight: only imports schema.mjs and utils.mjs, no MCP SDK

import { ensureDb, DB_DIR } from '../schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, OBS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE } from '../utils.mjs';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { shouldSkip, detectIntent, shouldSkipByDedup, extractFiles, DEDUP_STALE_MS } from './prompt-search-utils.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────

const INJECTED_IDS_FILE = join(DB_DIR, 'runtime', `.claude-mem-injected-${inferProject()}`);
const MAX_RESULTS = 5;
const LOOKBACK_MS = 60 * 86400000; // 60 days

// ─── DB Query Functions ─────────────────────────────────────────────────────

function searchByFts(db, queryText, project, limit, typeFilter) {
  const ftsQuery = sanitizeFtsQuery(queryText);
  if (!ftsQuery) return [];

  const cutoff = Date.now() - LOOKBACK_MS;

  const typeClause = typeFilter ? 'AND o.type = ?' : '';
  const now = Date.now();
  const sql = `
    SELECT o.id, o.type, o.title, o.lesson_learned,
           ${OBS_BM25}
             * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${TYPE_DECAY_CASE}))
             * ${TYPE_QUALITY_CASE}
             * (0.5 + 0.5 * COALESCE(o.importance, 1)) as relevance
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ?
      AND o.project = ?
      AND o.importance >= 1
      AND o.created_at_epoch > ?
      AND COALESCE(o.compressed_into, 0) = 0
      ${typeClause}
    ORDER BY relevance
    LIMIT ?
  `;

  const params = [now, ftsQuery, project, cutoff];
  if (typeFilter) params.push(typeFilter);
  params.push(limit);

  let rows = db.prepare(sql).all(...params);

  // OR fallback if AND query returned nothing
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      params[1] = orQuery;
      rows = db.prepare(sql).all(...params);
    }
  }

  return rows;
}

function searchByFile(db, files, project, limit) {
  if (files.length === 0) return [];

  const cutoff = Date.now() - LOOKBACK_MS;
  const results = [];

  for (const file of files.slice(0, 3)) {
    const basename = file.split('/').pop();
    if (!basename || basename.length < 2) continue;
    const escaped = basename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;

    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 1
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(project, cutoff, file, likePattern, limit);

    results.push(...rows);
  }

  // Deduplicate by id
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

function searchRecent(db, project, limit) {
  const cutoff = Date.now() - LOOKBACK_MS;
  return db.prepare(`
    SELECT id, type, title, lesson_learned
    FROM observations
    WHERE project = ?
      AND importance >= 1
      AND COALESCE(compressed_into, 0) = 0
      AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, cutoff, limit);
}

// ─── stdin Reader ───────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      reject(new Error('timeout'));
    }, 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      // Cap at 64KB — user prompts shouldn't be huge
      if (data.length > 65536) {
        process.stdin.destroy();
        clearTimeout(timeout);
        resolve(data.slice(0, 65536));
      }
    });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
    process.stdin.on('error', err => { clearTimeout(timeout); reject(err); });
    process.stdin.resume();
  });
}

// ─── Format Output ──────────────────────────────────────────────────────────

function formatResults(rows) {
  if (!rows || rows.length === 0) return null;

  const lines = ['[mem] Related memories:'];
  for (const r of rows) {
    const icon = typeIcon(r.type);
    const title = truncate(r.title || '', 70);
    const lesson = r.lesson_learned ? ` — ${truncate(r.lesson_learned, 50)}` : '';
    lines.push(`#${r.id} ${icon} ${title}${lesson}`);
  }
  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Prevent recursion from background claude -p calls
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) return;

  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw); } catch { return; }

  const promptText = hookData.prompt || hookData.user_prompt;
  if (!promptText || typeof promptText !== 'string') return;

  // Skip internal protocol messages
  if (promptText.startsWith('<task-notification>')) return;

  // Skip short/confirmation/slash-command/simple-op prompts
  if (shouldSkip(promptText)) return;

  let db;
  try {
    db = ensureDb();
  } catch { return; }

  try {
    const project = inferProject();
    const intent = detectIntent(promptText);
    let rows = [];

    if (intent?.useRecent) {
      // Recall intent: show recent observations
      rows = searchRecent(db, project, intent.limit);
    } else {
      // FTS search: use the prompt as query, optionally type-filtered
      const files = extractFiles(promptText);
      let ftsRows = searchByFts(db, promptText, project, intent?.limit || MAX_RESULTS, intent?.type || null);
      // Fallback: if typed search returned nothing, retry without type filter
      if (ftsRows.length === 0 && intent?.type) {
        ftsRows = searchByFts(db, promptText, project, intent.limit || MAX_RESULTS, null);
      }
      const fileRows = files.length > 0 ? searchByFile(db, files, project, 2) : [];

      // Merge: FTS results first, then file results, deduplicated
      const seen = new Set(ftsRows.map(r => r.id));
      rows = [...ftsRows];
      for (const r of fileRows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          rows.push(r);
        }
      }
      rows = rows.slice(0, MAX_RESULTS);
    }

    const candidateIds = rows.map(r => r.id);
    if (shouldSkipByDedup(candidateIds, INJECTED_IDS_FILE)) return;

    const output = formatResults(rows);
    if (output) {
      process.stdout.write(output + '\n');
      // Write injected IDs for dedup with hook.mjs handleUserPrompt + self-dedup
      try {
        let prevCount = 0;
        try {
          const prev = JSON.parse(readFileSync(INJECTED_IDS_FILE, 'utf8'));
          if (prev.ts && Date.now() - prev.ts < DEDUP_STALE_MS) prevCount = prev.count || 0;
        } catch {}
        writeFileSync(INJECTED_IDS_FILE, JSON.stringify({
          ids: candidateIds,
          ts: Date.now(),
          count: prevCount + 1,
        }));
      } catch {}
    }
  } catch {
    // Hooks must never break Claude Code — swallow all errors
  } finally {
    try { db.close(); } catch {}
  }
}

main();
