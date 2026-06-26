#!/usr/bin/env node
// claude-mem-lite: PreToolUse file recall — injects lessons before Edit/Write
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os,
// and the pure-data lib/low-signal-patterns.mjs (zero runtime deps, ~1ms overhead).
// Safety: readonly DB, exit 0 always, 3s timeout

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { buildNotLowSignalSql } from '../lib/low-signal-patterns.mjs';
import { recordHookError } from '../lib/hook-telemetry.mjs';
import { citeFactorClause } from '../scoring-sql.mjs';
import { fileIntelFor } from '../lib/file-intel.mjs';
import { shouldWarnReread, buildRereadWarning, readFileMeta } from '../lib/reread-guard.mjs';
import { recordMetric } from '../lib/metrics.mjs';
import { presentIdents } from '../lib/lesson-idents.mjs';

// CLAUDE_MEM_DIR matches schema.mjs / main CLI — one env var sandboxes the
// whole system. CLAUDE_MEM_DB_PATH / CLAUDE_MEM_RUNTIME_DIR remain as
// per-component overrides for tests that mix isolated + real paths.
const DATA_DIR = process.env.CLAUDE_MEM_DIR || join(homedir(), '.claude-mem-lite');
const DB_PATH = process.env.CLAUDE_MEM_DB_PATH || join(DATA_DIR, 'claude-mem-lite.db');
const RUNTIME_DIR = process.env.CLAUDE_MEM_RUNTIME_DIR || join(DATA_DIR, 'runtime');
// A3 (v2.83): cross-hook dedup window — must mirror DEDUP_STALE_MS in
// scripts/prompt-search-utils.mjs. UPS writes
// `runtime/.claude-mem-injected-<project>` after each inject; we read it to
// drop IDs the agent already saw in this 5-min window. Standalone fast-path
// (#8447) so we inline the constant rather than importing the helper.
const CROSS_HOOK_DEDUP_MS = 5 * 60 * 1000;
// v2.33.1: cooldown path is session-scoped so same-file-twice within one
// session never re-injects (was: global file, 5-min window). Cross-session:
// fresh file, fresh nudges — this is intended. No session_id → fall back to
// legacy global path so env-less test harnesses still behave.
const LEGACY_COOLDOWN_PATH = join(RUNTIME_DIR, 'pre-recall-cooldown.json');
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (used only for legacy fallback)
// v2.98 salience forcing-function (#8651: verified injection only moved
// bug-reintroduction 100%→50% — the agent sees lessons and ignores them; the
// bottleneck is ACTING). Default ON: Edit/Write lesson blocks end with an ack
// directive, and Read→Edit re-surfaces the Read-time lesson IDs as a one-line
// ack nudge at the actual action point. CLAUDE_MEM_SALIENCE=legacy (or 0)
// restores the pre-v2.98 passive behavior.
const SALIENCE_LEGACY = process.env.CLAUDE_MEM_SALIENCE === 'legacy'
  || process.env.CLAUDE_MEM_SALIENCE === '0';
const SALIENCE_BIND = process.env.CLAUDE_MEM_SALIENCE === 'bind';
const SALIENCE_BRIDGE = process.env.CLAUDE_MEM_SALIENCE === 'bridge';
const ACK_DIRECTIVE = "apply each lesson to this edit or rule it out — state '#NN applied' or '#NN n/a — <reason>' in your next user-facing message.";
// v-bind salience forcing-function (#8771 audit: ack ≠ act). Instead of a cheap
// '#NN applied / n/a' verdict, demand the model bind the lesson to the concrete
// line it's editing and quote the satisfying edit line. Selected by
// CLAUDE_MEM_SALIENCE=bind; default stays ACK_DIRECTIVE.
const BIND_DIRECTIVE = "For each lesson: state the one concrete check it forces on the line(s) you're editing, quote the edit line that satisfies it, then report '#NN: <check> — pass' or '#NN: n/a — <why this edit can't reach it>'.";
const ACTIVE_DIRECTIVE = SALIENCE_BIND ? BIND_DIRECTIVE : ACK_DIRECTIVE;
const STALE_MS = 10 * 60 * 1000;   // 10 minutes cleanup threshold for legacy file
// Feature ① (file intelligence): on the first Read of a file each session, inject
// its approximate token size + a one-line summary so the agent can decide to read
// fully, slice, or grep. Read-only (Edit/Write already commit to the file). Default
// ON; CLAUDE_MEM_FILE_INTEL=0 disables. Files below the token floor stay silent so
// small reads carry no noise. Env names mirror schema.mjs CLAUDE_MEM_* convention (#8447).
const FILE_INTEL_OFF = ['0', 'off', 'false', 'no'].includes(
  String(process.env.CLAUDE_MEM_FILE_INTEL || '').toLowerCase());
const FILE_INTEL_MIN_TOKENS = Math.max(1,
  parseInt(process.env.CLAUDE_MEM_FILE_INTEL_MIN_TOKENS, 10) || 800);
// Feature ② (repeated-read guard): when the agent does a FULL re-read of a file
// it already read this session and the file is unchanged (mtime), nudge it to
// reuse context instead of re-slurping. Read-only; only fires above the floor and
// never on offset/limit paging. Default ON; CLAUDE_MEM_REREAD_GUARD=0 disables.
const REREAD_GUARD_OFF = ['0', 'off', 'false', 'no'].includes(
  String(process.env.CLAUDE_MEM_REREAD_GUARD || '').toLowerCase());
const REREAD_MIN_TOKENS = Math.max(1,
  parseInt(process.env.CLAUDE_MEM_REREAD_MIN_TOKENS, 10) || 600);
// Stale-cooldown GC moved to hook.mjs::handleSessionStart — running it on every
// Edit cost 15-30 disk stats per call. SessionStart fires once at session boot,
// which is enough to keep RUNTIME_DIR from growing unbounded.

function cooldownPathFor(sessionId) {
  if (!sessionId) return LEGACY_COOLDOWN_PATH;
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
  return join(RUNTIME_DIR, `pre-recall-cooldown-${safe}.json`);
}

// Comprehension-bridge (CLAUDE_MEM_SALIENCE=bridge): rewrite the top bound lesson
// into a check naming a symbol in THIS change. Dynamic import keeps the LLM stack
// out of the default fast path (#8447). Fail-open: null → caller uses ACK line.
async function bridgeTopLesson(rows, changeText) {
  if (!SALIENCE_BRIDGE || !changeText) return null;
  const fake = process.env.CLAUDE_MEM_BRIDGE_FAKE;
  let extractIdents, bridgeLesson;
  try {
    ({ extractIdents } = await import('../lib/lesson-idents.mjs'));
    if (!fake) ({ bridgeLesson } = await import('../lib/lesson-bridge.mjs'));
  } catch { return null; }
  for (const r of rows) {
    const lesson = r.lesson_learned;
    if (!lesson) continue;
    if (!extractIdents(lesson).some((id) => changeText.includes(id))) continue;
    let res;
    if (fake) res = /^n\s*\/?\s*a$/i.test(fake.trim()) ? { ok: false } : { ok: true, check: fake.trim().slice(0, 200) };
    else res = await bridgeLesson({ lesson, hunk: changeText });
    if (res.ok) return { id: r.id, check: res.check };
    return null; // top bound lesson abstained → fall back to ACK, don't scan further
  }
  return null;
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

// v2.81: cooldown entries are {ts, lessonIds} objects so the PostToolUse
// cite-back hint can name the lessons that were nudged. Legacy entries
// (pre-v2.81) are bare numbers — entryTimestamp() reads both shapes.
function entryTimestamp(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v.ts === 'number') return v.ts;
  return 0;
}

// A3 (v2.83): cross-hook injected-IDs store. UPS writes
// `runtime/.claude-mem-injected-<project>` with {ids, ts, count}. We read
// inside the staleness window, filter overlaps from PreToolUse output, then
// merge back so the next UPS sees what we emitted too.
function crossHookInjectedFile(project) {
  return join(RUNTIME_DIR, `.claude-mem-injected-${project}`);
}

function readCrossHookInjected(project) {
  try {
    const raw = readFileSync(crossHookInjectedFile(project), 'utf8');
    const { ids, ts } = JSON.parse(raw);
    if (!ts || Date.now() - ts > CROSS_HOOK_DEDUP_MS) return new Set();
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.map(String));
  } catch { return new Set(); }
}

function mergeCrossHookInjected(project, newIds) {
  if (!newIds || newIds.length === 0) return;
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const file = crossHookInjectedFile(project);
    let prev = { ids: [], ts: 0, count: 0 };
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      // Within the staleness window: union. Outside: replace (fresh session).
      if (parsed.ts && Date.now() - parsed.ts < CROSS_HOOK_DEDUP_MS) {
        prev = parsed;
      }
    } catch { /* fresh file */ }
    const ids = [...new Set([
      ...(Array.isArray(prev.ids) ? prev.ids.map(String) : []),
      ...newIds.map(String),
    ])];
    writeFileSync(file, JSON.stringify({
      ids,
      ts: Date.now(),
      count: (prev.count || 0) + 1,
    }));
  } catch { /* silent — dedup is best-effort */ }
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
        const ts = entryTimestamp(v);
        if (ts && now - ts < STALE_MS) cleaned[k] = v;
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
  let toolInput;
  // isFullRead: a Read with no offset/limit reads the whole file. The reread
  // guard only flags full-vs-full re-reads, so paging never trips it.
  let isFullRead = true;
  try {
    const event = JSON.parse(input);
    toolInput = event.tool_input;
    filePath = event.tool_input?.file_path;
    sessionId = event.session_id || null;
    toolName = event.tool_name || null;
    const off = event.tool_input?.offset;
    const lim = event.tool_input?.limit;
    isFullRead = (off === undefined || off === null) && (lim === undefined || lim === null);
  } catch (e) {
    recordHookError('pre-recall:json', e, RUNTIME_DIR, { inputLen: input.length });
    process.exit(0);
  }

  // Upstream-shape probe: hook ran but neither field nor input shape matches the
  // contract we encode (event.tool_input.file_path, event.tool_name in
  // Edit|Write|NotebookEdit|Read). Distinguishes "Claude Code renamed the field"
  // from "event genuinely has no file_path" — without this trace, a CC upstream
  // rename silently zeroes injection like code-graph's matcher bug.
  if (!filePath) {
    if (toolName && !['Edit', 'Write', 'NotebookEdit', 'Read'].includes(toolName)) {
      recordHookError('pre-recall:unknown-tool', new Error(`tool_name=${toolName}`), RUNTIME_DIR, { toolName });
    } else if (!toolName) {
      recordHookError('pre-recall:no-toolname', new Error('event missing tool_name'), RUNTIME_DIR);
    }
    process.exit(0);
  }

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
    const entry = cooldown[filePath];
    if (entry) {
      // v2.98 salience: the old full-dedup meant a Read-injected lesson left the
      // actual Edit with ZERO context at the action point — the most likely spot
      // for #8651's "saw it, ignored it". When this Edit/Write follows a
      // Read-mode injection that surfaced lessons, emit a one-line ack nudge
      // naming the IDs (no lesson bodies — token cost stays minimal), then mark
      // the entry handled so the next Edit is silent again. Entries without a
      // mode field (pre-v2.98) are treated as already handled.
      const seenIds = (typeof entry === 'object' && Array.isArray(entry.lessonIds))
        ? entry.lessonIds : [];
      const wasReadMode = typeof entry === 'object' && entry.mode === 'read';
      if (!isRead && wasReadMode && seenIds.length > 0 && !SALIENCE_LEGACY) {
        const idList = seenIds.map(id => `#${id}`).join(', ');
        process.stdout.write(JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: [
              '[mem] PreToolUse recall — system-injected context, continue your planned action:',
              `[mem] ⚠ Lessons ${idList} were shown when you Read ${basename(filePath)} — ${ACTIVE_DIRECTIVE}`,
            ].join('\n'),
          },
        }));
        cooldown[filePath] = { ...entry, mode: 'edit' };
        writeCooldown(cooldownPath, cooldown, isSessionScoped);
      } else if (isRead && !REREAD_GUARD_OFF && typeof entry === 'object' && entry.reread) {
        // ② repeated-read guard: a full re-read of an unchanged, sizable file —
        // nudge to reuse what's already in context. Read-only; never throws.
        const meta = readFileMeta(filePath);
        if (shouldWarnReread(entry.reread, meta ? meta.mtimeMs : null, isFullRead, REREAD_MIN_TOKENS)) {
          process.stdout.write(JSON.stringify({
            suppressOutput: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: [
                '[mem] PreToolUse recall — system-injected context, continue your planned action:',
                buildRereadWarning(basename(filePath), entry.reread.tokens),
              ].join('\n'),
            },
          }));
          recordMetric(DATA_DIR, { event: 'reread_warn' }); // tier-1 firing counter (②)
        }
      }
      process.exit(0); // already recalled this file in-session
    }
  } else {
    const ts = entryTimestamp(cooldown[filePath]);
    if (ts && (now - ts) < COOLDOWN_MS) process.exit(0);
  }

  // Open DB readonly
  const Database = (await import('better-sqlite3')).default;
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
  } catch (e) {
    recordHookError('pre-recall:db-open', e, RUNTIME_DIR);
    process.exit(0);
  }

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
    // A1.5 (v2.83.2): cite_factor as a tertiary sort key. When multiple file-
    // matching lessons exist, the one with proven cite history outranks the
    // merely-most-recent one. Single-match files unchanged (obsLimit=1 Read /
    // 2 Edit). Composes with v2.83.0 A1 to extend the citation-decay feedback
    // loop to the 85%-recall PreToolUse:Read/Edit path.
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
        ${citeFactorClause('o')} DESC,
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

    // A3 (v2.83): cross-hook dedup. UPS may have already injected some of
    // these obs ids this prompt — re-emitting wastes the PreToolUse slot
    // (and inflates context). Drop ids found in the cross-hook injected file
    // inside the staleness window; keep file-cooldown unchanged (the same
    // file might also re-warrant a different lesson next session).
    const crossHookSeen = readCrossHookInjected(project);
    const dedupedRows = crossHookSeen.size > 0
      ? [...rows, ...eventRows].filter(r => !crossHookSeen.has(String(r.id)))
      : [...rows, ...eventRows];

    // Merge: observations first (they carry richer lesson_learned), then events.
    // Edit/Write caps at 3 total; Read caps at 1 (single most-actionable hit).
    const mergeCap = isRead ? 1 : 3;
    const allRows = dedupedRows.slice(0, mergeCap);

    // v2.31 T2: emit JSON with hookSpecificOutput.additionalContext so the message
    // reliably renders across CC variants (sdscc drops plain-text stdout from PreToolUse).
    // suppressOutput:true hides it from transcript mode per CC hook docs.
    // Feature ①: file intelligence (size + summary) for the first Read of this
    // file this session. Read-only; opt out via CLAUDE_MEM_FILE_INTEL=0. Never
    // throws — fileIntelFor returns null on unreadable/below-threshold files.
    let fileIntelLine = null;
    if (isRead && !FILE_INTEL_OFF) {
      try { fileIntelLine = fileIntelFor(filePath, { minTokens: FILE_INTEL_MIN_TOKENS }); } catch {}
    }
    // Tier-1 firing counter (①). recordMetric no-ops unless CLAUDE_MEM_METRICS=1,
    // so default users pay nothing; observers see counts in `doctor` / `stats`.
    if (fileIntelLine) recordMetric(DATA_DIR, { event: 'file_intel' });
    const lines = [];
    // v2.34.6: Read mode uses 120-char truncation (Edit mode keeps the 240-char
    // cap from R3-UX). Rationale: Read is a one-shot nudge with 1 lesson max;
    // Edit is a 3-lesson decision-support injection where the fuller lesson tail
    // carries the actionable "Fix:" guidance — short enough per-lesson at 240,
    // but the total payload is bounded by the 3-row limit and the cooldown.
    const LESSON_MAX = isRead ? 120 : 240;
    // Feature ① (file-intel): null on Edit/Write and on below-threshold or
    // unreadable files. When present (first Read of a sizable file this session),
    // it leads the injection, above any lessons.
    const hasLessons = allRows.length > 0;
    const showFraming = hasLessons || Boolean(fileIntelLine)
      || (!isRead && process.env.CLAUDE_MEM_PRETOOL_NUDGE === '1');
    if (showFraming) {
      // Framing line mirrors #7758 handoff-injection fix: without an explicit
      // "system-injected, continue" disclaimer, observed turn-end after Edit+reminder
      // when the model misreads passive lesson context as a closing note.
      lines.push(`[mem] PreToolUse recall — system-injected context, continue your planned action:`);
    }
    if (fileIntelLine) lines.push(fileIntelLine);
    if (hasLessons) {
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
      // v2.98 salience: Edit/Write is the action point — close the block with an
      // explicit ack directive instead of leaving the lessons as passive FYI
      // (#8651: passive framing was ignored ~half the time even when on-topic).
      // Read keeps the quiet form; its forcing-function fires at the later Edit
      // via the Read→Edit ack nudge above.
      if (!isRead && !SALIENCE_LEGACY) {
        const changeText = [toolInput?.old_string, toolInput?.new_string, toolInput?.content]
          .filter(Boolean).join('\n');
        const bridged = await bridgeTopLesson(allRows, changeText);
        if (bridged) lines.push(`[mem] ⚠ #${bridged.id} → this edit must: ${bridged.check}. Confirm your new code satisfies it.`);
        else lines.push(`[mem] ⚠ Before this edit: ${ACTIVE_DIRECTIVE}`);
      }
    } else if (!isRead && process.env.CLAUDE_MEM_PRETOOL_NUDGE === '1') {
      // R-4: Edit/Write empty → short backfill reminder. OPT-IN (default off) as
      // of the cross-project audit: this "no prior lessons, remember to /lesson"
      // reminder fired on ~70% of Edit/Write recalls and drove zero observed
      // /lesson calls — pure context noise, mostly on brand-new files that by
      // definition can't have a lesson. Save-nudging now lives at Stop time
      // (buildCiteRecallNudge's unsaved-bugfix line + the cite-back hint), which
      // has the full episode to judge whether a real fix happened. Set
      // CLAUDE_MEM_PRETOOL_NUDGE=1 to restore the per-Edit reminder.
      //
      // Read never emitted this (passive). The cooldown write below still runs on
      // every branch, so Read→Edit dedup + cite-back lessonId tracking are intact.
      // (Framing line already pushed above via showFraming.)
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
    // v2.81: record the emitted lesson IDs so flushEpisode (hook.mjs) can
    // build the PostToolUse cite-back hint when the user actually edits the
    // file. Empty array on no-lesson branches keeps the schema uniform.
    // v2.98: mode records WHERE the injection happened so the Read→Edit ack
    // nudge can distinguish "lessons seen passively at Read" from "already
    // surfaced at an action point".
    // ② repeated-read guard: record file metadata on the first Read so a later
    // full re-read of the unchanged file can be flagged. Read-only, session-scoped;
    // one stat + bounded read, first-read only.
    const rereadMeta = (isRead && !REREAD_GUARD_OFF && isSessionScoped) ? readFileMeta(filePath) : null;
    // bind salience (component 2): record the identifiers each lesson NAMES that
    // ALSO appear in the current (pre-edit) file, so post-tool-recall.js can flag
    // an edit that drops one. Only under =bind with lessons — keeps the default
    // path free of the extra file read. Bounded read; never throws.
    let lessonIdents;
    if (SALIENCE_BIND && allRows.length > 0) {
      try {
        const pre = readFileSync(filePath, 'utf8').slice(0, 256 * 1024);
        const acc = {};
        for (const r of allRows) {
          const present = presentIdents(`${r.lesson_learned || ''} ${r.title || ''}`, pre);
          if (present.length) acc[r.id] = present;
        }
        if (Object.keys(acc).length) lessonIdents = acc;
      } catch { /* unreadable pre-edit file — skip the diff check */ }
    }
    cooldown[filePath] = {
      ts: now,
      lessonIds: allRows.map(r => r.id),
      mode: isRead ? 'read' : 'edit',
      ...(lessonIdents ? { lessonIdents } : {}),
      ...(rereadMeta ? { reread: { mtimeMs: rereadMeta.mtimeMs, tokens: rereadMeta.tokens, full: isFullRead } } : {}),
    };
    writeCooldown(cooldownPath, cooldown, isSessionScoped);
    // A3 (v2.83): merge our newly-emitted IDs into the cross-hook injected
    // file so the next UPS prompt skips them too. Always write, even on
    // empty allRows, so the file's ts stays fresh for the no-op case where
    // we'd otherwise drift outside the dedup window.
    mergeCrossHookInjected(project, allRows.map(r => r.id));
  } catch (e) {
    // Silent failure — never block editing, but record for self-observation.
    recordHookError('pre-recall:query', e, RUNTIME_DIR, { filePath });
  } finally {
    try { db.close(); } catch {}
  }
} catch (e) {
  // Top-level catch — exit 0 no matter what, but record what slipped past.
  try { recordHookError('pre-recall:top', e, RUNTIME_DIR); } catch {}
}
