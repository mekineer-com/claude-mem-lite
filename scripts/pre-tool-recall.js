#!/usr/bin/env node
// claude-mem-lite: PreToolUse file recall — injects lessons before Edit/Write
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os
// Safety: readonly DB, exit 0 always, 3s timeout

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';

// CLAUDE_MEM_DB_PATH / CLAUDE_MEM_RUNTIME_DIR env overrides allow tests and debug tools to
// point the hook at an isolated DB + cooldown dir without touching the user's real state.
const DB_PATH = process.env.CLAUDE_MEM_DB_PATH || join(homedir(), '.claude-mem-lite', 'claude-mem-lite.db');
const RUNTIME_DIR = process.env.CLAUDE_MEM_RUNTIME_DIR || join(homedir(), '.claude-mem-lite', 'runtime');
// v2.33.1: cooldown path is session-scoped so same-file-twice within one
// session never re-injects (was: global file, 5-min window). Cross-session:
// fresh file, fresh nudges — this is intended. No session_id → fall back to
// legacy global path so env-less test harnesses still behave.
const LEGACY_COOLDOWN_PATH = join(RUNTIME_DIR, 'pre-recall-cooldown.json');
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (used only for legacy fallback)
const STALE_MS = 10 * 60 * 1000;   // 10 minutes cleanup threshold for legacy file
const SESSION_COOLDOWN_STALE_MS = 24 * 60 * 60 * 1000; // 24h — drop session cooldown files older than this

function cooldownPathFor(sessionId) {
  if (!sessionId) return LEGACY_COOLDOWN_PATH;
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
  return join(RUNTIME_DIR, `pre-recall-cooldown-${safe}.json`);
}

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

function readCooldown(cooldownPath) {
  try { return JSON.parse(readFileSync(cooldownPath, 'utf8')); } catch { return {}; }
}

function writeCooldown(cooldownPath, data, isSessionScoped) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    // Legacy (no session_id): stale entries trimmed to 10m window.
    // Session-scoped: keep all entries for the session's lifetime — same-file-twice
    // in one session never re-injects. Old session files GC'd on next write.
    const now = Date.now();
    const cleaned = isSessionScoped ? data : {};
    if (!isSessionScoped) {
      for (const [k, v] of Object.entries(data)) {
        if (now - v < STALE_MS) cleaned[k] = v;
      }
    }
    writeFileSync(cooldownPath, JSON.stringify(cleaned));
  } catch { /* silent */ }
}

// Best-effort GC for session cooldown files older than 24h.
// Runs at most once per hook invocation, silent on any failure.
function gcOldSessionCooldowns() {
  try {
    const now = Date.now();
    for (const name of readdirSync(RUNTIME_DIR)) {
      if (!name.startsWith('pre-recall-cooldown-') || !name.endsWith('.json')) continue;
      try {
        const p = join(RUNTIME_DIR, name);
        const st = statSync(p);
        if (now - st.mtimeMs > SESSION_COOLDOWN_STALE_MS) unlinkSync(p);
      } catch { /* silent per-entry */ }
    }
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
  let sessionId;
  try {
    const event = JSON.parse(input);
    filePath = event.tool_input?.file_path;
    sessionId = event.session_id || null;
  } catch { process.exit(0); }

  if (!filePath) process.exit(0);

  // v2.33.1: session-scoped cooldown. Within one session, same file recalls
  // once; cross-session, each session gets fresh nudges. Legacy 5-min global
  // cooldown only applies when no session_id is present.
  const cooldownPath = cooldownPathFor(sessionId);
  const isSessionScoped = Boolean(sessionId);
  const cooldown = readCooldown(cooldownPath);
  const now = Date.now();
  if (isSessionScoped) {
    if (cooldown[filePath]) process.exit(0); // already recalled this file in-session
  } else {
    if (cooldown[filePath] && (now - cooldown[filePath]) < COOLDOWN_MS) process.exit(0);
  }
  // Best-effort GC of old session cooldown files (cheap, once per invocation)
  if (isSessionScoped) gcOldSessionCooldowns();

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

    // T9: also query the `events` table — after T9, bugfix/lesson/decision/etc.
    // route here instead of observations, so we must read both sources to keep
    // surfacing past lessons. `file_paths` is a JSON array string; the LIKE
    // patterns match both basename and full-path entries. JSON quoting
    // (`"<name>"`) prevents partial-match false positives like "foo.mjs"
    // matching "myfoo.mjs".
    const fnameEscaped = fname.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const filePathEscaped = filePath.replace(/%/g, '\\%').replace(/_/g, '\\_');
    let eventRows = [];
    try {
      eventRows = db.prepare(`
        SELECT id, event_type AS type, title, body AS lesson_learned
        FROM events
        WHERE project = ?
          AND importance >= 2
          AND superseded_at_epoch IS NULL
          AND created_at_epoch > ?
          AND (file_paths LIKE ? ESCAPE '\\' OR file_paths LIKE ? ESCAPE '\\')
        ORDER BY created_at_epoch DESC
        LIMIT 2
      `).all(project, cutoff, `%"${fnameEscaped}"%`, `%"${filePathEscaped}"%`);
    } catch { /* events table may not exist on pre-v2.31 DBs — silent */ }

    // Merge: observations first (they carry richer lesson_learned), then events,
    // capped at 3 total so the injected context stays small per Edit/Write.
    const allRows = [...rows, ...eventRows].slice(0, 3);

    // v2.31 T2: emit JSON with hookSpecificOutput.additionalContext so the message
    // reliably renders across CC variants (sdscc drops plain-text stdout from PreToolUse).
    // suppressOutput:true hides it from transcript mode per CC hook docs.
    const lines = [];
    if (allRows.length > 0) {
      lines.push(`[mem] Lessons for ${fname}:`);
      for (const r of allRows) {
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
    writeCooldown(cooldownPath, cooldown, isSessionScoped);
  } catch {
    // Silent failure — never block editing
  } finally {
    try { db.close(); } catch {}
  }
} catch {
  // Top-level catch — exit 0 no matter what
}
