#!/usr/bin/env node
// claude-mem-lite: PreToolUse file recall — injects lessons before Edit/Write
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os,
// and the pure-data lib/low-signal-patterns.mjs (zero runtime deps, ~1ms overhead).
// Safety: readonly DB, exit 0 always, 3s timeout

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { buildNotLowSignalSql } from '../lib/low-signal-patterns.mjs';

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
// Stale-cooldown GC moved to hook.mjs::handleSessionStart — running it on every
// Edit cost 15-30 disk stats per call. SessionStart fires once at session boot,
// which is enough to keep RUNTIME_DIR from growing unbounded.

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
  let toolName;
  try {
    const event = JSON.parse(input);
    filePath = event.tool_input?.file_path;
    sessionId = event.session_id || null;
    toolName = event.tool_name || null;
  } catch { process.exit(0); }

  if (!filePath) process.exit(0);

  // v2.34.6 Gap 3: Read-side recall with asymmetric quiet-mode. Reads have
  // lower per-event information value than Edits (passive observation, may
  // not lead to action), so inject less per Read. Cooldown is shared with
  // Edit via per-filePath session state — Read→Edit in the same session is
  // not double-injected. See CHANGELOG v2.34.6 for the data behind 120/1/no-nudge.
  const isRead = toolName === 'Read';

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
    //
    // v2.34.6: Read tightens the filter to require lesson_learned (drops type-OR
    // fallback — decision/bugfix WITHOUT lesson add context noise to passive Reads
    // where the agent isn't committed to a change). Edit/Write keep the wider
    // filter for decision-point context.
    // LOW_SIGNAL title patterns — auto-generated hook-llm fallback titles carry
    // no actionable guidance. β refactor (#7877 applied): derived from
    // lib/low-signal-patterns.mjs so this cold-start script, utils.mjs regex,
    // and scoring-sql.mjs SQL share one authoritative list.
    const notLowSignalSql = buildNotLowSignalSql('o');
    // Edit: bugfix/decision without lesson_learned is admitted only when the
    // title isn't a LOW_SIGNAL auto-fallback (those carry pipe-delimited raw
    // output or filename-stubs, no guidance value for the about-to-Edit agent).
    const typeFallback = isRead
      ? 'AND o.lesson_learned IS NOT NULL AND o.lesson_learned != \'\''
      : `AND (
          (o.lesson_learned IS NOT NULL AND o.lesson_learned != '')
          OR (o.type IN ('bugfix', 'decision') AND ${notLowSignalSql})
        )`;
    const obsLimit = isRead ? 1 : 2;
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
        ${typeFallback}
      ORDER BY
        CASE WHEN o.lesson_learned IS NOT NULL AND o.lesson_learned != '' THEN 0 ELSE 1 END,
        o.created_at_epoch DESC
      LIMIT ${obsLimit}
    `).all(project, cutoff, filePath, likePattern);

    // T9: also query the `events` table — after T9, bugfix/lesson/decision/etc.
    // route here instead of observations, so we must read both sources to keep
    // surfacing past lessons. `file_paths` is a JSON array string; the LIKE
    // patterns match both basename and full-path entries. JSON quoting
    // (`"<name>"`) prevents partial-match false positives like "foo.mjs"
    // matching "myfoo.mjs".
    const fnameEscaped = fname.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const filePathEscaped = filePath.replace(/%/g, '\\%').replace(/_/g, '\\_');
    // v2.34.6: Read also tightens the events query — only rows with a non-empty
    // body (= lesson equivalent). Edit path keeps the wider net since the agent
    // is about to change the file and benefits from any contextual signal.
    const eventsBodyFilter = isRead ? "AND body IS NOT NULL AND body != ''" : '';
    const eventsLimit = isRead ? 1 : 2;
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
          ${eventsBodyFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ${eventsLimit}
      `).all(project, cutoff, `%"${fnameEscaped}"%`, `%"${filePathEscaped}"%`);
    } catch { /* events table may not exist on pre-v2.31 DBs — silent */ }

    // Merge: observations first (they carry richer lesson_learned), then events.
    // Edit/Write caps at 3 total; Read caps at 1 (single most-actionable hit).
    const mergeCap = isRead ? 1 : 3;
    const allRows = [...rows, ...eventRows].slice(0, mergeCap);

    // v2.31 T2: emit JSON with hookSpecificOutput.additionalContext so the message
    // reliably renders across CC variants (sdscc drops plain-text stdout from PreToolUse).
    // suppressOutput:true hides it from transcript mode per CC hook docs.
    const lines = [];
    // v2.34.6: Read mode uses 120-char truncation (Edit mode keeps the 240-char
    // cap from R3-UX). Rationale: Read is a one-shot nudge with 1 lesson max;
    // Edit is a 3-lesson decision-support injection where the fuller lesson tail
    // carries the actionable "Fix:" guidance — short enough per-lesson at 240,
    // but the total payload is bounded by the 3-row limit and the cooldown.
    const LESSON_MAX = isRead ? 120 : 240;
    if (allRows.length > 0) {
      // Framing line mirrors #7758 handoff-injection fix: without an explicit
      // "system-injected, continue" disclaimer, observed turn-end after Edit+reminder
      // when the model misreads passive lesson context as a closing note.
      lines.push(`[mem] PreToolUse recall — system-injected context, continue your planned action:`);
      lines.push(`[mem] Lessons for ${fname}:`);
      for (const r of allRows) {
        if (r.lesson_learned) {
          const lesson = r.lesson_learned.length > LESSON_MAX
            ? r.lesson_learned.slice(0, LESSON_MAX - 3) + '...'
            : r.lesson_learned;
          lines.push(`  #${r.id} [${r.type}] ${lesson}`);
        } else {
          const title = (r.title || '').length > LESSON_MAX
            ? r.title.slice(0, LESSON_MAX - 3) + '...'
            : (r.title || '');
          lines.push(`  #${r.id} [${r.type}] ${title}`);
        }
      }
    } else if (!isRead) {
      // R-4: Edit/Write empty → short backfill reminder. Two goals: (1) Claude
      // sees that the system actually ran, (2) Claude is nudged to save a lesson
      // after a non-obvious bug. Reminder is one line to keep per-Edit cost low.
      //
      // v2.34.6: Read does NOT emit this nudge. Read is passive — the agent
      // isn't necessarily about to solve anything, so /lesson prompts are noise.
      // Empty Reads exit silently, saving ~60 tokens × (every empty-file Read).
      lines.push(`[mem] PreToolUse recall — system-injected context, continue your planned action:`);
      lines.push(`[mem] No prior lessons for ${fname} — if you solve a non-obvious bug here, run: /lesson --file ${fname} "<root cause + fix>"`);
    }

    if (lines.length > 0) {
      process.stdout.write(JSON.stringify({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: lines.join('\n'),
        },
      }));
    }
    // Cooldown applies on ALL branches (including silent-Read) so subsequent
    // calls on the same file in the same session don't re-query — preserving
    // the per-filePath invariant that underpins Read→Edit dedup.
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
