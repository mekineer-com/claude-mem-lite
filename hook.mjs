#!/usr/bin/env node
// claude-mem-lite Hook v2 — Cognitive memory architecture
// Selective encoding, episodic batching, error-triggered recall
// Hooks (fast <100ms): post-tool-use, session-start, stop
// Background workers (slow): llm-episode, llm-summary

import { randomUUID } from 'crypto';
import { join, basename } from 'path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync } from 'fs';
import {
  truncate, typeIcon, inferProject, detectBashSignificance,
  extractErrorKeywords, extractFilePaths, isRelatedToEpisode,
  makeEntryDesc, scrubSecrets, debugCatch, debugLog, fmtTime,
} from './utils.mjs';
import {
  readEpisodeRaw, episodeFile,
  acquireLock, releaseLock, readEpisode, writeEpisode,
  createEpisode, addFileToEpisode,
  writePendingEntry, mergePendingEntries, episodeHasSignificantContent,
} from './hook-episode.mjs';
import { selectWithTokenBudget, updateClaudeMd } from './hook-context.mjs';
import { dispatchOnSessionStart, dispatchOnPreToolUse } from './dispatch.mjs';
import { collectFeedback } from './dispatch-feedback.mjs';
import {
  RUNTIME_DIR, EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS,
  STALE_SESSION_MS, STALE_LOCK_MS, FALLBACK_OBS_WINDOW_MS,
  sessionFile, getSessionId, createSessionId, openDb, getRegistryDb,
  closeRegistryDb, spawnBackground,
} from './hook-shared.mjs';
import { handleLLMEpisode, handleLLMSummary } from './hook-llm.mjs';

// Prevent recursive hooks from background claude -p calls
// Background workers (llm-episode, llm-summary) are exempt — they're ours
const event = process.argv[2];
const BG_EVENTS = new Set(['llm-episode', 'llm-summary']);
if (process.env.CLAUDE_MEM_HOOK_RUNNING && !BG_EVENTS.has(event)) process.exit(0);

// Crash-safe: flush episode buffer on unexpected termination to prevent data loss
// Uses flag-based approach to avoid calling file I/O inside signal handlers,
// which can deadlock if the signal fires during a main-thread file operation.
let _shutdownRequested = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (_shutdownRequested) process.exit(0); // Double-signal = force exit
    _shutdownRequested = true;
    // Schedule flush on next tick to avoid re-entering file I/O
    setTimeout(() => {
      try {
        const ep = readEpisodeRaw();
        if (ep && ep.entries && ep.entries.length > 0) {
          const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          writeFileSync(flushFile, JSON.stringify(ep));
          try { unlinkSync(join(RUNTIME_DIR, `ep-${inferProject()}.json`)); } catch {}
        }
      } catch {}
      process.exit(0);
    });
  });
}

if (!event) process.exit(0);

// ─── Episode Flush ──────────────────────────────────────────────────────────

function flushEpisode(episode) {
  if (!episode || episode.entries.length === 0) return;

  // Collect Read file paths tracked by post-tool-use.sh
  // Use rename to atomically collect — prevents losing concurrent appends
  const readsFile = join(RUNTIME_DIR, `reads-${episode.project || inferProject()}.txt`);
  const readsCollect = readsFile + `.collect-${Date.now()}`;
  try {
    renameSync(readsFile, readsCollect);
    const raw = readFileSync(readsCollect, 'utf8');
    const paths = [...new Set(raw.split('\n').filter(Boolean))];
    episode.filesRead = paths;
    try { unlinkSync(readsCollect); } catch {}
  } catch {
    episode.filesRead = episode.filesRead || [];
  }

  // Write episode to flush file, then remove buffer AFTER spawn to prevent race
  const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  try {
    writeFileSync(flushFile, JSON.stringify(episode));
  } catch {
    return;
  }

  if (episodeHasSignificantContent(episode)) {
    spawnBackground('llm-episode', flushFile);
  } else {
    try { unlinkSync(flushFile); } catch {}
  }

  // Remove episode buffer AFTER spawning background worker to prevent concurrent overwrites
  try { unlinkSync(episodeFile()); } catch {}
}

// ─── PostToolUse Handler ────────────────────────────────────────────────────

// Tier 1 D: Skip low-value tools entirely
// SYNC: Skip list must match scripts/post-tool-use.sh
const SKIP_TOOLS = new Set([
  'Read', 'Glob',  // noise — just opening/finding files
  'TodoRead', 'TodoWrite', 'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'mcp__claude-in-chrome__screenshot', 'mcp__claude-in-chrome__read_page',
  'mcp__claude-in-chrome__tabs_context_mcp', 'mcp__claude-in-chrome__computer',
  'mcp__claude-in-chrome__find', 'mcp__claude-in-chrome__navigate',
]);

async function handlePostToolUse() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch {
    // Truncated JSON — try to salvage tool_name from the prefix
    if (raw.truncated) {
      debugLog('WARN', 'postToolUse', 'stdin truncated at 256KB, attempting salvage');
      const m = raw.text.match(/"tool_name"\s*:\s*"([^"]+)"/);
      if (m) hookData = { tool_name: m[1], tool_input: {}, tool_response: '(truncated)' };
    }
    if (!hookData) return;
  }

  const { tool_name, tool_input, tool_response } = hookData;
  if (!tool_name) return;

  // Skip noise
  if (SKIP_TOOLS.has(tool_name)) return;
  if (tool_name.startsWith('mem_') || tool_name.startsWith('mcp__mem__')) return;
  if (tool_name.startsWith('mcp__sequential') || tool_name.startsWith('mcp__plugin_context7')) return;

  const resp = typeof tool_response === 'string' ? tool_response : JSON.stringify(tool_response || '');
  if (!resp || resp.length < 10) return;

  const toolInput = typeof tool_input === 'string' ? tryParseJson(tool_input) : (tool_input || {});
  const files = extractFilePaths(toolInput);

  // Tier 1 B: Detect significant Bash commands
  const bashSig = (tool_name === 'Bash') ? detectBashSignificance(toolInput, resp) : null;

  // Build episode entry
  const entry = {
    tool: tool_name,
    desc: scrubSecrets(makeEntryDesc(tool_name, toolInput, resp)),
    files,
    ts: Date.now(),
    isError: bashSig?.isError || false,
    isSignificant: ['Edit', 'Write', 'NotebookEdit'].includes(tool_name) ||
                   bashSig?.isSignificant || false,
    bashSig: bashSig || null,
  };

  // Episode buffer management (locked to prevent TOCTOU race)
  const sessionId = getSessionId();
  const project = inferProject();

  // Lazy DB: only opened when needed (error recall or file history)
  let db = null;
  const getDb = () => { if (!db) db = openDb(); return db; };

  // Tier 2 G: Error-triggered recall
  if (bashSig?.isError) {
    const d = getDb();
    if (d) triggerErrorRecall(d, toolInput, resp);
  }

  if (!acquireLock()) {
    if (db) try { db.close(); } catch {}
    writePendingEntry(entry, sessionId, project);
    return;
  }
  try {
    let episode = readEpisode();

    // Merge any pending entries from previous lock failures
    if (episode) mergePendingEntries(episode);

    if (episode) {
      const timeSinceLastEntry = Date.now() - episode.lastAt;
      const fileRelated = isRelatedToEpisode(episode, files);
      const bufferFull = episode.entries.length >= EPISODE_BUFFER_SIZE;
      const timeGap = timeSinceLastEntry > EPISODE_TIME_GAP_MS;

      // Phase transition → flush current episode, start new
      if (bufferFull || timeGap || (!fileRelated && episode.entries.length >= 2)) {
        flushEpisode(episode);
        episode = null;
      }
    }

    if (!episode) {
      episode = createEpisode(sessionId, project);
      mergePendingEntries(episode);
    }

    episode.entries.push(entry);
    episode.lastAt = Date.now();
    addFileToEpisode(episode, files);

    // Proactive file history: show past observations for files being edited
    if (['Edit', 'Write', 'NotebookEdit'].includes(tool_name) && files.length > 0) {
      const d = getDb();
      if (d) {
        for (const f of files) {
          if (episode.fileHistoryShown?.includes(f)) continue;
          try {
            const fname = basename(f);
            const ftsQ = `"${fname.replace(/"/g, '""')}"`;
            const rows = d.prepare(`
              SELECT o.id, o.type, o.title
              FROM observations_fts
              JOIN observations o ON observations_fts.rowid = o.id
              WHERE observations_fts MATCH ? AND o.project = ?
              ORDER BY o.created_at_epoch DESC
              LIMIT 3
            `).all(ftsQ, project);
            if (rows.length > 0) {
              const hints = rows.map(r => `  #${r.id} [${r.type}] ${truncate(r.title, 60)}`).join('\n');
              process.stdout.write(`[claude-mem-lite] File history for ${fname}:\n${hints}\n`);
            }
          } catch (e) { debugCatch(e, 'fileHistory'); }
          if (!episode.fileHistoryShown) episode.fileHistoryShown = [];
          episode.fileHistoryShown.push(f);
        }
      }
    }

    writeEpisode(episode);
  } finally {
    releaseLock();
    if (db) try { db.close(); } catch {}
  }
}

// ─── Error-Triggered Recall (Tier 2 G) ─────────────────────────────────────

function triggerErrorRecall(db, toolInput, response) {
  try {
    const project = inferProject();

    // Extract error keywords
    const cmd = toolInput.command || '';
    const keywords = extractErrorKeywords(cmd, response);
    if (!keywords || keywords.length === 0) return;

    // FTS5 OR query for broader recall
    const ftsQuery = keywords.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    if (!ftsQuery) return;

    const nowR = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.type, o.title
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.project = ?
      ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2)
        * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
      LIMIT 3
    `).all(ftsQuery, project, nowR);

    if (rows.length > 0) {
      const hints = rows.map(r => `  #${r.id} [${r.type}] ${truncate(r.title, 60)}`).join('\n');
      process.stdout.write(`[claude-mem-lite] Related memories found for this error:\n${hints}\n  → Use mem_get(ids=[${rows.map(r => r.id).join(',')}]) for details.\n`);
    }
  } catch (e) { debugCatch(e, 'triggerErrorRecall'); }
}

// ─── Stop Handler ───────────────────────────────────────────────────────────

async function handleStop() {
  // Capture session info BEFORE cleanup
  const sessionId = getSessionId();
  const project = inferProject();

  // Flush remaining episode buffer (locked to prevent race with handlePostToolUse)
  if (acquireLock(1000)) {
    try {
      const episode = readEpisode();
      if (episode) {
        flushEpisode(episode);
      }
    } finally {
      releaseLock();
    }
  } else {
    // Fallback: lock contended — atomically rename episode file to claim ownership.
    // Prevents data loss from concurrent PostToolUse writes between read and delete.
    const epFile = episodeFile();
    const claimFile = epFile + `.claim-${process.pid}-${Date.now()}`;
    try {
      renameSync(epFile, claimFile);
      try {
        const episode = JSON.parse(readFileSync(claimFile, 'utf8'));
        if (episode && episode.entries && episode.entries.length > 0 && episodeHasSignificantContent(episode)) {
          if (!episode.sessionId) episode.sessionId = sessionId;
          if (!episode.project) episode.project = project;
          const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          writeFileSync(flushFile, JSON.stringify(episode));
          spawnBackground('llm-episode', flushFile);
        }
      } finally {
        try { unlinkSync(claimFile); } catch {}
      }
    } catch (e) { debugCatch(e, 'handleStop-fallback'); }
  }

  // Mark session completed (sync, instant)
  const db = openDb();
  if (db) {
    try {
      db.prepare(`
        UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
        WHERE content_session_id = ? AND status = 'active'
      `).run(new Date().toISOString(), Date.now(), sessionId);
    } finally {
      db.close();
    }
  }

  // Dispatch: collect feedback on recommendations
  try {
    const rdb = getRegistryDb();
    if (rdb) {
      const memDb = openDb();
      const sessionEvents = [];
      if (memDb) {
        try {
          const prompts = memDb.prepare(
            'SELECT prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY created_at_epoch'
          ).all(sessionId);
          for (const p of prompts) {
            if (p.prompt_text) {
              sessionEvents.push({ tool_name: '_user_prompt', tool_input: { text: p.prompt_text }, tool_response: '' });
            }
          }
        } catch {} finally { memDb.close(); }
      }
      await collectFeedback(rdb, sessionId, sessionEvents);
    }
  } catch (e) { debugCatch(e, 'handleStop-feedback'); }

  // Spawn background for session summary (pass sessionId and project)
  spawnBackground('llm-summary', sessionId, project);

  // Clean session file AFTER spawning background
  try { unlinkSync(sessionFile()); } catch {}
}

// ─── SessionStart Handler + CLAUDE.md Persistence (Tier 1 A, E) ─────────────

async function handleSessionStart() {
  // Flush any leftover episode buffer from previous session (e.g. after /clear)
  if (acquireLock()) {
    try {
      const prevEpisode = readEpisode();
      if (prevEpisode && prevEpisode.entries && prevEpisode.entries.length > 0) {
        flushEpisode(prevEpisode);
      }
    } finally {
      releaseLock();
    }
  }

  // Tier 1 A: Create unique session ID
  const sessionId = createSessionId();
  const project = inferProject();

  const db = openDb();
  if (!db) return;

  try {
    // Ensure session exists in DB (INSERT OR IGNORE avoids race condition)
    const now = new Date();
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // Stale session cleanup: mark 24h+ active sessions as abandoned
    const oneDayAgo = Date.now() - STALE_SESSION_MS;
    db.prepare(`
      UPDATE sdk_sessions SET status = 'abandoned'
      WHERE status = 'active' AND started_at_epoch < ?
    `).run(oneDayAgo);

    // Clean stale lock files in runtime dir
    try {
      for (const f of readdirSync(RUNTIME_DIR)) {
        if (!f.endsWith('.lock')) continue;
        const lp = join(RUNTIME_DIR, f);
        try {
          const raw = readFileSync(lp, 'utf8');
          const info = JSON.parse(raw);
          const age = Date.now() - (info.ts || 0);
          let stale = age > STALE_LOCK_MS;
          if (!stale && info.pid) {
            try { process.kill(info.pid, 0); } catch (killErr) {
              stale = killErr.code === 'ESRCH';
            }
          }
          if (stale) unlinkSync(lp);
        } catch {
          try {
            const st = statSync(lp);
            if (Date.now() - st.mtimeMs > STALE_LOCK_MS) unlinkSync(lp);
          } catch {}
        }
      }
    } catch {}

    // Token-budgeted observation selection (replaces flat LIMIT 15)
    const selected = selectWithTokenBudget(db, project, 2000);
    const observations = selected.observations;

    // Fallback: recent across all projects with tiered windows
    let fallbackObs = [];
    if (observations.length < 3) {
      const fbSevenDaysAgo = Date.now() - FALLBACK_OBS_WINDOW_MS;
      fallbackObs = db.prepare(`
        SELECT id, type, title, project, created_at
        FROM observations
        WHERE COALESCE(compressed_into, 0) = 0
          AND (
            (created_at_epoch > ? AND importance >= 1)
            OR (created_at_epoch > ? AND importance >= 2)
          )
        ORDER BY created_at_epoch DESC
        LIMIT 5
      `).all(oneDayAgo, fbSevenDaysAgo);
    }

    // Latest session summary
    const latestSummary = db.prepare(`
      SELECT request, completed, next_steps, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(project);

    // Build summary lines (shared by stdout and CLAUDE.md)
    const summaryLines = [];
    if (latestSummary) {
      summaryLines.push('### Last Session');
      if (latestSummary.request) summaryLines.push(`Request: ${truncate(latestSummary.request, 120)}`);
      if (latestSummary.completed) summaryLines.push(`Completed: ${truncate(latestSummary.completed, 120)}`);
      if (latestSummary.next_steps) summaryLines.push(`Next: ${truncate(latestSummary.next_steps, 120)}`);
      summaryLines.push('');
    }

    // Build observations table (stdout only — not persisted to CLAUDE.md)
    const obsLines = [];
    const obsToShow = observations.length >= 3 ? observations : fallbackObs;
    if (obsToShow.length > 0) {
      const today = now.toISOString().slice(0, 10);
      obsLines.push(`### Recent (${today})`);
      obsLines.push('');
      obsLines.push('| ID | Time | T | Title |');
      obsLines.push('|----|------|---|-------|');
      for (const o of obsToShow) {
        const proj = o.project ? ` (${o.project})` : '';
        obsLines.push(`| #${o.id} | ${fmtTime(o.created_at)} | ${typeIcon(o.type)} | ${truncate(o.title || '(untitled)', 60)}${proj} |`);
      }
    }

    // Stdout: full context (summary + observations table)
    const fullContext = [...summaryLines, ...obsLines].join('\n');
    process.stdout.write(`<claude-mem-context>\n${fullContext}\n</claude-mem-context>\n`);

    // CLAUDE.md: slim (summary only — observations already in stdout)
    updateClaudeMd(summaryLines.join('\n'));

    // Dispatch: recommend skill/agent based on session context
    try {
      const rdb = getRegistryDb();
      if (rdb) {
        const promptCtx = latestSummary?.next_steps || '';
        const dispatchResult = await dispatchOnSessionStart(rdb, promptCtx, sessionId);
        if (dispatchResult) {
          process.stdout.write(dispatchResult + '\n');
        }
      }
    } catch (e) { debugCatch(e, 'handleSessionStart-dispatch'); }

  } finally {
    db.close();
  }
}

// ─── PreToolUse Handler (Dispatch) ──────────────────────────────────────────

async function handlePreToolUse() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch { return; }

  const rdb = getRegistryDb();
  if (!rdb) return;

  // Quick session context from user prompts DB
  const sessionId = getSessionId();
  const sessionCtx = { sessionId };
  const db = openDb();
  if (db) {
    try {
      const latest = db.prepare(
        'SELECT prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY created_at_epoch DESC LIMIT 1'
      ).get(sessionId);
      if (latest) sessionCtx.userPrompt = latest.prompt_text;
    } catch {} finally { db.close(); }
  }

  const injection = await dispatchOnPreToolUse(rdb, hookData, sessionCtx);
  if (injection) {
    process.stdout.write(injection + '\n');
  }
}

// ─── UserPromptSubmit Handler ────────────────────────────────────────────────

async function handleUserPrompt() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch { return; }

  const promptText = hookData.user_prompt;
  if (!promptText || typeof promptText !== 'string') return;

  const db = openDb();
  if (!db) return;

  try {
    const sessionId = getSessionId();
    const now = new Date();

    // Ensure session exists (INSERT OR IGNORE avoids race condition)
    const project = inferProject();
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // Increment prompt counter
    db.prepare('UPDATE sdk_sessions SET prompt_counter = COALESCE(prompt_counter, 0) + 1 WHERE content_session_id = ?').run(sessionId);
    const counter = db.prepare('SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);

    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      scrubSecrets(promptText.slice(0, 10000)),
      counter?.prompt_counter || 1,
      now.toISOString(), now.getTime()
    );
  } finally {
    db.close();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function readStdin() {
  const MAX_STDIN = 256 * 1024; // 256KB — large tool responses are truncated
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => { process.stdin.destroy(); reject(new Error('timeout')); }, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_STDIN) {
        process.stdin.destroy(); clearTimeout(timeout);
        resolve({ text: data.slice(0, MAX_STDIN), truncated: true });
      }
    });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve({ text: data, truncated: false }); });
    process.stdin.on('error', err => { clearTimeout(timeout); reject(err); });
    process.stdin.resume();
  });
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  switch (event) {
    case 'pre-tool-use':     await handlePreToolUse(); break;
    case 'post-tool-use':    await handlePostToolUse(); break;
    case 'session-start':    await handleSessionStart(); break;
    case 'stop':             await handleStop(); break;
    case 'user-prompt':      await handleUserPrompt(); break;
    case 'llm-episode':      await handleLLMEpisode(); break;
    case 'llm-summary':      await handleLLMSummary(); break;
  }
} catch (err) {
  // Always log fatal errors (ungated) with structured format
  const ts = new Date().toISOString();
  console.error(`[claude-mem-lite] [${ts}] [ERROR] ${event}: ${err.message}`);
}

// Close singleton registry DB to prevent WAL residue
closeRegistryDb();

process.exit(0);
