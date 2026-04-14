#!/usr/bin/env node
// claude-mem-lite: PreToolUse file recall — injects lessons before Edit/Write
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os
// Safety: readonly DB, exit 0 always, 3s timeout

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';

// CLAUDE_MEM_DB_PATH / CLAUDE_MEM_RUNTIME_DIR env overrides allow tests and debug tools to
// point the hook at an isolated DB + cooldown dir without touching the user's real state.
const DB_PATH = process.env.CLAUDE_MEM_DB_PATH || join(homedir(), '.claude-mem-lite', 'claude-mem-lite.db');
const RUNTIME_DIR = process.env.CLAUDE_MEM_RUNTIME_DIR || join(homedir(), '.claude-mem-lite', 'runtime');
const COOLDOWN_PATH = join(RUNTIME_DIR, 'pre-recall-cooldown.json');
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const STALE_MS = 10 * 60 * 1000;   // 10 minutes cleanup threshold

// ─── Helpers ────────────────────────────────────────────────────────────────

function inferProject() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const base = basename(dir);
  const parent = basename(join(dir, '..'));
  let project = (parent && parent !== '.' && parent !== '/')
    ? `${parent}--${base}` : base;
  project = project.replace(/[^a-zA-Z0-9_.-]/g, '-') || 'unknown';
  return project;
}

function readCooldown() {
  try { return JSON.parse(readFileSync(COOLDOWN_PATH, 'utf8')); } catch { return {}; }
}

function writeCooldown(data) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    // Clean stale entries
    const now = Date.now();
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (now - v < STALE_MS) cleaned[k] = v;
    }
    writeFileSync(COOLDOWN_PATH, JSON.stringify(cleaned));
  } catch { /* silent */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  // Skip if recursive hook
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) process.exit(0);

  // Skip if DB doesn't exist
  if (!existsSync(DB_PATH)) process.exit(0);

  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  // Parse event
  let filePath;
  try {
    const event = JSON.parse(input);
    filePath = event.tool_input?.file_path;
  } catch { process.exit(0); }

  if (!filePath) process.exit(0);

  // Cooldown check (full path as key)
  const cooldown = readCooldown();
  const now = Date.now();
  if (cooldown[filePath] && (now - cooldown[filePath]) < COOLDOWN_MS) {
    process.exit(0);
  }

  // Open DB readonly
  const Database = (await import('better-sqlite3')).default;
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
  } catch { process.exit(0); }

  try {
    const project = inferProject();
    const fname = basename(filePath);
    // Escape LIKE wildcards
    const escaped = fname.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;
    // 60-day lookback to avoid surfacing ancient observations
    const cutoff = Date.now() - 60 * 86400000;

    // Surface actionable lessons first, then high-importance bugfix/decision observations.
    // Priority: 1) observations with lesson_learned (most actionable for preventing repeat bugs)
    //           2) bugfix/decision types with importance>=2 (contextual history)
    // Skip pure change/discovery without lessons — they add noise without actionable value.
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 2
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        AND (
          (o.lesson_learned IS NOT NULL AND o.lesson_learned != '')
          OR o.type IN ('bugfix', 'decision')
        )
      ORDER BY
        CASE WHEN o.lesson_learned IS NOT NULL AND o.lesson_learned != '' THEN 0 ELSE 1 END,
        o.created_at_epoch DESC
      LIMIT 2
    `).all(project, cutoff, filePath, likePattern);

    // v2.31 T2: emit JSON with hookSpecificOutput.additionalContext so the message
    // reliably renders across CC variants (sdscc drops plain-text stdout from PreToolUse).
    // suppressOutput:true hides it from transcript mode per CC hook docs.
    const lines = [];
    if (rows.length > 0) {
      lines.push(`[mem] Lessons for ${fname}:`);
      for (const r of rows) {
        if (r.lesson_learned) {
          const lesson = r.lesson_learned.length > 120
            ? r.lesson_learned.slice(0, 117) + '...'
            : r.lesson_learned;
          lines.push(`  #${r.id} [${r.type}] ${lesson}`);
        } else {
          const title = (r.title || '').length > 120
            ? r.title.slice(0, 117) + '...'
            : (r.title || '');
          lines.push(`  #${r.id} [${r.type}] ${title}`);
        }
      }
    } else {
      // R-4: emit a short backfill reminder instead of staying silent.
      // Two goals: (1) Claude sees that the system actually ran, (2) Claude is
      // nudged to save a lesson when solving a non-obvious bug. The reminder
      // is one line to minimize per-Edit context cost.
      lines.push(`[mem] No prior lessons for ${fname} — if you solve a non-obvious bug here, run: /lesson --file ${fname} "<root cause + fix>"`);
    }

    process.stdout.write(JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: lines.join('\n'),
      },
    }));
    // Cooldown applies to BOTH branches so the reminder doesn't spam every Edit.
    cooldown[filePath] = now;
    writeCooldown(cooldown);
  } catch {
    // Silent failure — never block editing
  } finally {
    try { db.close(); } catch {}
  }
} catch {
  // Top-level catch — exit 0 no matter what
}
