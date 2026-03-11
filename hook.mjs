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
  makeEntryDesc, scrubSecrets, EDIT_TOOLS, debugCatch, debugLog, fmtTime,
} from './utils.mjs';
import {
  readEpisodeRaw, episodeFile,
  acquireLock, releaseLock, readEpisode, writeEpisode,
  createEpisode, addFileToEpisode,
  writePendingEntry, mergePendingEntries, episodeHasSignificantContent,
} from './hook-episode.mjs';
import { selectWithTokenBudget, updateClaudeMd } from './hook-context.mjs';
import { dispatchOnSessionStart, dispatchOnPreToolUse, dispatchOnUserPrompt } from './dispatch.mjs';
import { collectFeedback } from './dispatch-feedback.mjs';
import {
  RUNTIME_DIR, EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS,
  SESSION_EXPIRY_MS, STALE_SESSION_MS, STALE_LOCK_MS, FALLBACK_OBS_WINDOW_MS,
  RESOURCE_RESCAN_INTERVAL_MS,
  sessionFile, getSessionId, createSessionId, openDb, getRegistryDb,
  closeRegistryDb, spawnBackground, appendToolEvent, readAndClearToolEvents,
  resetInjectionBudget, hasInjectionBudget, incrementInjection,
} from './hook-shared.mjs';
import { handleLLMEpisode, handleLLMSummary, saveObservation, buildImmediateObservation } from './hook-llm.mjs';
import { searchRelevantMemories } from './hook-memory.mjs';
import { buildAndSaveHandoff, detectContinuationIntent, renderHandoffInjection } from './hook-handoff.mjs';

// Prevent recursive hooks from background claude -p calls
// Background workers (llm-episode, llm-summary, resource-scan) are exempt — they're ours
const event = process.argv[2];
const BG_EVENTS = new Set(['llm-episode', 'llm-summary', 'resource-scan']);
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

  const isSignificant = episodeHasSignificantContent(episode);

  // Immediate save: create rule-based observation for instant visibility.
  // LLM background worker will upgrade title/narrative/importance later.
  if (isSignificant) {
    try {
      const obs = buildImmediateObservation(episode);
      const id = saveObservation(obs, episode.project, episode.sessionId);
      if (id) episode.savedId = id;
    } catch (e) { debugCatch(e, 'flushEpisode-immediateSave'); }
  }

  // Write episode to flush file, then remove buffer AFTER spawn to prevent race
  const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  try {
    writeFileSync(flushFile, JSON.stringify(episode));
  } catch {
    return;
  }

  if (isSignificant) {
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
  if (tool_name.startsWith('mem_') || tool_name.startsWith('mcp__mem__') || tool_name.startsWith('mcp__plugin_claude-mem-lite')) return;
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
    isSignificant: EDIT_TOOLS.has(tool_name) ||
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
    if (EDIT_TOOLS.has(tool_name) && files.length > 0) {
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

    // Track feedback-relevant tool events for dispatch adoption detection.
    // Skill/Agent: adoption detection checks these tool names.
    // Edit/Write/NotebookEdit: outcome detection checks for edits.
    // Bash errors: outcome detection checks for error signals.
    if (['Skill', 'Agent', 'Edit', 'Write', 'NotebookEdit'].includes(tool_name) ||
        (tool_name === 'Bash' && bashSig?.isError)) {
      appendToolEvent({
        tool_name,
        tool_input: toolInput,
        tool_response: (tool_name === 'Bash' && bashSig?.isError) ? resp.slice(0, 500) : '',
      });
    }
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

  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

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
          // Immediate save: persist rule-based observation to DB before spawning background worker.
          // Without this, data is lost if the background worker fails.
          try {
            const obs = buildImmediateObservation(episode);
            const id = saveObservation(obs, episode.project, episode.sessionId);
            if (id) episode.savedId = id;
          } catch (e) { debugCatch(e, 'handleStop-fallback-immediateSave'); }
          const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          writeFileSync(flushFile, JSON.stringify(episode));
          spawnBackground('llm-episode', flushFile);
        }
      } finally {
        try { unlinkSync(claimFile); } catch {}
      }
    } catch (e) { debugCatch(e, 'handleStop-fallback'); }
  }

  // Mark session completed + save handoff (sync, instant)
  const db = openDb();
  if (db) {
    try {
      db.prepare(`
        UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
        WHERE content_session_id = ? AND status = 'active'
      `).run(new Date().toISOString(), Date.now(), sessionId);
      // Save handoff snapshot for cross-session continuity
      try { buildAndSaveHandoff(db, sessionId, project, 'exit', episodeSnapshot); }
      catch (e) { debugCatch(e, 'handleStop-handoff'); }
    } finally {
      db.close();
    }
  }

  // Dispatch: collect feedback on recommendations using actual tool events
  // PostToolUse tracks Skill/Task/Edit/Write/Bash events in a JSONL file.
  // These events drive adoption detection (Skill/Task) and outcome detection (Edit/Bash errors).
  // Always clear event file to prevent stale events accumulating if registry DB is unavailable.
  try {
    const sessionEvents = readAndClearToolEvents();
    // Skip feedback for zero-interaction sessions (no tool events = no meaningful signal)
    if (sessionEvents.length > 0) {
      const rdb = getRegistryDb();
      if (rdb) {
        await collectFeedback(rdb, sessionId, sessionEvents);
      }
    }
  } catch (e) { debugCatch(e, 'handleStop-feedback'); }

  // Spawn background for session summary (pass sessionId and project)
  spawnBackground('llm-summary', sessionId, project);

  // Clean session file AFTER spawning background
  try { unlinkSync(sessionFile()); } catch {}
}

// ─── SessionStart Handler + CLAUDE.md Persistence (Tier 1 A, E) ─────────────

async function handleSessionStart() {
  resetInjectionBudget();

  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

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

  // Detect mid-session restart (/clear or /compact): if a recent session file exists,
  // the previous session ended without Stop hook firing. Read BEFORE createSessionId()
  // overwrites the session file. Normal /exit deletes the file, so this only triggers
  // for /clear, /compact, or crash recovery.
  let prevSessionId = null;
  let prevProject = null;
  try {
    const data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (Date.now() - data.startedAt < SESSION_EXPIRY_MS) {
      prevSessionId = data.id;
      prevProject = data.project;
    }
  } catch {} // No session file = fresh startup, nothing to recover

  // Tier 1 A: Create unique session ID
  const sessionId = createSessionId();
  const project = inferProject();

  const db = openDb();
  if (!db) return;

  try {
    const now = new Date();

    // ── DB mutations in a transaction (crash-safe consistency) ──
    const staleSessionCutoff = Date.now() - STALE_SESSION_MS;
    const autoCompressAge = Date.now() - 30 * 86400000; // 30 days (accelerated from 90)

    db.transaction(() => {
      // Ensure session exists in DB (INSERT OR IGNORE avoids race condition)
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

      // Complete previous session if this is a mid-session restart (/clear, /compact, crash)
      if (prevSessionId) {
        db.prepare(`
          UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
          WHERE content_session_id = ? AND status = 'active'
        `).run(now.toISOString(), now.getTime(), prevSessionId);
      }

      // Stale session cleanup: mark 24h+ active sessions as abandoned
      db.prepare(`
        UPDATE sdk_sessions SET status = 'abandoned'
        WHERE status = 'active' AND started_at_epoch < ?
      `).run(staleSessionCutoff);

      // Auto-compress: mark old low-importance observations as compressed (30+ days, importance=1)
      // Lightweight: only marks rows, doesn't create summaries (full compression via mem_compress)
      const compressed = db.prepare(`
        UPDATE observations SET compressed_into = -1
        WHERE COALESCE(compressed_into, 0) = 0
          AND importance = 1
          AND created_at_epoch < ?
          AND project = ?
      `).run(autoCompressAge, project);
      if (compressed.changes > 0) {
        debugLog('DEBUG', 'session-start', `auto-compressed ${compressed.changes} old observations`);
      }
    })();

    // ── Non-transactional operations (side effects, background work) ──

    if (prevSessionId) {
      // Save handoff for cross-session continuity (/clear or /compact)
      try { buildAndSaveHandoff(db, prevSessionId, prevProject || project, 'clear', episodeSnapshot); }
      catch (e) { debugCatch(e, 'session-start-handoff'); }

      // Collect dispatch feedback for previous session
      try {
        const rdb = getRegistryDb();
        if (rdb) {
          const sessionEvents = readAndClearToolEvents();
          await collectFeedback(rdb, prevSessionId, sessionEvents);
        }
      } catch (e) { debugCatch(e, 'session-start-prev-feedback'); }

      // Generate session summary for previous session (background Haiku — richer version)
      spawnBackground('llm-summary', prevSessionId, prevProject || project);

      // Build fast synchronous summary for immediate context availability.
      // Background llm-summary will produce a richer Haiku version later;
      // context injection query (ORDER BY created_at_epoch DESC) auto-prefers latest.
      try {
        const firstPrompt = db.prepare(`
          SELECT prompt_text FROM user_prompts
          WHERE content_session_id = ?
          ORDER BY prompt_number ASC LIMIT 1
        `).get(prevSessionId);

        const prevObs = db.prepare(`
          SELECT title FROM observations
          WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
          ORDER BY created_at_epoch DESC LIMIT 5
        `).all(prevSessionId);

        const fastRequest = truncate(firstPrompt?.prompt_text || '', 200);
        const fastCompleted = prevObs.map(o => o.title).filter(Boolean).join('; ');

        if (fastRequest || fastCompleted) {
          db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
            VALUES (?, ?, ?, '', '', ?, '', '[]', '[]', 'fast', ?, ?)
          `).run(prevSessionId, prevProject || project, fastRequest, truncate(fastCompleted, 300), now.toISOString(), now.getTime());
        }
      } catch (e) { debugCatch(e, 'session-start-fast-summary'); }
    }

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

    // Fallback: recent across all projects with tiered windows (M7: local variable for clarity)
    let fallbackObs = [];
    if (observations.length < 3) {
      const fbOneDayAgo = Date.now() - STALE_SESSION_MS;
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
      `).all(fbOneDayAgo, fbSevenDaysAgo);
    }

    // Fallback fast summary: if a recently completed session has no summary yet
    // (e.g. /exit → fast restart before Haiku finishes), build one synchronously.
    // Skipped when prevSessionId is set (already handled above).
    if (!prevSessionId) {
      try {
        const recentSession = db.prepare(`
          SELECT content_session_id, project FROM sdk_sessions
          WHERE project = ? AND status = 'completed' AND completed_at_epoch > ?
          ORDER BY completed_at_epoch DESC LIMIT 1
        `).get(project, Date.now() - 120000); // within last 2 minutes

        if (recentSession) {
          const hasSummary = db.prepare(`
            SELECT 1 FROM session_summaries WHERE memory_session_id = ? LIMIT 1
          `).get(recentSession.content_session_id);

          if (!hasSummary) {
            const fp = db.prepare(`
              SELECT prompt_text FROM user_prompts
              WHERE content_session_id = ? ORDER BY prompt_number ASC LIMIT 1
            `).get(recentSession.content_session_id);
            const po = db.prepare(`
              SELECT title FROM observations
              WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
              ORDER BY created_at_epoch DESC LIMIT 5
            `).all(recentSession.content_session_id);

            const fr = truncate(fp?.prompt_text || '', 200);
            const fc = po.map(o => o.title).filter(Boolean).join('; ');
            if (fr || fc) {
              db.prepare(`
                INSERT INTO session_summaries
                (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
                VALUES (?, ?, ?, '', '', ?, '', '[]', '[]', 'fast', ?, ?)
              `).run(recentSession.content_session_id, project, fr, truncate(fc, 300), now.toISOString(), now.getTime());
            }
          }
        }
      } catch (e) { debugCatch(e, 'session-start-exit-fast-summary'); }
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

    // Key context: top high-importance observations for CLAUDE.md persistence
    const keyObs = db.prepare(`
      SELECT id, type, title FROM observations
      WHERE project = ? AND COALESCE(compressed_into, 0) = 0
        AND COALESCE(importance, 1) >= 2
      ORDER BY created_at_epoch DESC LIMIT 5
    `).all(project);
    if (keyObs.length > 0) {
      summaryLines.push('### Key Context');
      for (const o of keyObs) {
        // Strip raw JSON output from degraded Bash-style titles
        const clean = (o.title || '(untitled)')
          .replace(/ → (?:ERROR: )?\{".*$/, '')
          .replace(/ → (?:ERROR: )?\{[^}]*\.{3}$/, '');
        summaryLines.push(`- [${o.type || 'discovery'}] ${truncate(clean, 80)} (#${o.id})`);
      }
      summaryLines.push('');
    } else if (!latestSummary) {
      // Fallback: no summary AND no key observations — show recent activity
      const recentObs = (observations.length >= 3 ? observations : fallbackObs).slice(0, 3);
      if (recentObs.length > 0) {
        summaryLines.push('### Recent Activity');
        for (const o of recentObs) {
          summaryLines.push(`- ${truncate(o.title || '(untitled)', 80)}`);
        }
        summaryLines.push('');
      }
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
      if (rdb && hasInjectionBudget()) {
        // Build prompt context with fallbacks: next_steps → request → completed (empty = no dispatch)
        const promptCtx = latestSummary?.next_steps || latestSummary?.request || latestSummary?.completed || '';
        const hasHandoff = !!prevSessionId;  // prevSessionId set when /clear or rapid restart detected
        const dispatchResult = await dispatchOnSessionStart(rdb, promptCtx, sessionId, { hasHandoff });
        if (dispatchResult) {
          process.stdout.write(dispatchResult + '\n');
          incrementInjection();
        }
      }
    } catch (e) { debugCatch(e, 'handleSessionStart-dispatch'); }

    // Background rescan: detect changed/new managed resources since last scan.
    // TTL-based (1h) — avoids redundant filesystem scans on every session.
    // Non-blocking: spawns detached worker, results available before first user prompt.
    if (needsResourceRescan()) {
      spawnBackground('resource-scan');
    }

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

  // Quick session context from user prompts DB + episode buffer
  const sessionId = getSessionId();
  const sessionCtx = { sessionId };
  const db = openDb();
  if (db) {
    try {
      const latest = db.prepare(
        'SELECT prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY created_at_epoch DESC LIMIT 1'
      ).get(sessionId);
      if (latest) sessionCtx.userPrompt = latest.prompt_text;
    } catch (e) { debugCatch(e, 'handlePreToolUse-queryPrompt'); } finally { db.close(); }
  }
  // Collect recent file paths from episode buffer for tech stack inference
  try {
    const episode = readEpisodeRaw();
    if (episode?.entries) {
      const files = new Set();
      for (const e of episode.entries) {
        if (e.files) for (const f of e.files) files.add(f);
      }
      if (files.size > 0) sessionCtx.recentFiles = [...files].slice(-10);
    }
  } catch {}

  if (hasInjectionBudget()) {
    const injection = await dispatchOnPreToolUse(rdb, hookData, sessionCtx);
    if (injection) {
      process.stdout.write(injection + '\n');
      incrementInjection();
    }
  }
}

// ─── UserPromptSubmit Handler ────────────────────────────────────────────────

async function handleUserPrompt() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch { return; }

  const promptText = hookData.prompt || hookData.user_prompt;
  if (!promptText || typeof promptText !== 'string') return;

  const sessionId = getSessionId();
  const db = openDb();
  if (!db) return;

  const project = inferProject();

  try {
    const now = new Date();

    // Ensure session exists (INSERT OR IGNORE avoids race condition)
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

    // Cross-session handoff injection (first prompt only, before semantic memory)
    if (counter?.prompt_counter === 1 && hasInjectionBudget()) {
      try {
        if (detectContinuationIntent(db, promptText, project)) {
          const injection = renderHandoffInjection(db, project);
          if (injection) {
            process.stdout.write(injection + '\n');
            incrementInjection();
          }
        }
      } catch (e) { debugCatch(e, 'handleUserPrompt-handoff'); }
    }

    // Semantic memory injection: search past observations for the user's prompt
    if (hasInjectionBudget()) {
      try {
        const keyObs = db.prepare(`
          SELECT id FROM observations
          WHERE project = ? AND COALESCE(compressed_into, 0) = 0
            AND COALESCE(importance, 1) >= 2
          ORDER BY created_at_epoch DESC LIMIT 5
        `).all(project);
        const keyContextIds = keyObs.map(o => o.id);

        const memories = searchRelevantMemories(db, promptText, project, keyContextIds);
        if (memories.length > 0) {
          const lines = ['<memory-context relevance="high">'];
          for (const m of memories) {
            lines.push(`- [${m.type}] ${truncate(m.title, 80)} (#${m.id})`);
          }
          lines.push('</memory-context>');
          process.stdout.write(lines.join('\n') + '\n');
          incrementInjection();
        }
      } catch (e) { debugCatch(e, 'handleUserPrompt-memory'); }
    }
  } finally {
    db.close();
  }

  // Dispatch: recommend skill/agent based on user's actual prompt.
  // This is the ideal dispatch point — fires when the user submits their prompt,
  // before Claude starts working. SessionStart uses stale next_steps from previous session;
  // PreToolUse fires too late (after Claude committed to an approach via read-only tools).
  // Cooldown + session dedup (invocations table) prevents double-recommending with SessionStart.
  try {
    const rdb = getRegistryDb();
    if (rdb && hasInjectionBudget()) {
      const result = await dispatchOnUserPrompt(rdb, promptText, sessionId);
      if (result) {
        process.stdout.write(result + '\n');
        incrementInjection();
      }
    }
  } catch (e) { debugCatch(e, 'handleUserPrompt-dispatch'); }
}

// ─── Resource Rescan (Background Worker) ─────────────────────────────────────

const RESCAN_MARKER = join(RUNTIME_DIR, 'last-resource-scan');

/**
 * Check if resource rescan is needed (marker older than RESOURCE_RESCAN_INTERVAL_MS).
 * @returns {boolean}
 */
function needsResourceRescan() {
  try {
    const marker = statSync(RESCAN_MARKER);
    return (Date.now() - marker.mtimeMs) > RESOURCE_RESCAN_INTERVAL_MS;
  } catch {
    return true; // No marker = never scanned
  }
}

/**
 * Background worker: scan filesystem for changed resources, upsert any diffs.
 * Spawned by SessionStart when marker is stale. Non-blocking to the hook caller.
 */
async function handleResourceScan() {
  const rdb = getRegistryDb();
  if (!rdb) return;

  try {
    const { scanAllResources, diffResources } = await import('./registry-scanner.mjs');
    const { upsertResource } = await import('./registry.mjs');

    const scanned = scanAllResources();
    const { toIndex, toDisable } = diffResources(rdb, scanned);

    if (toIndex.length === 0 && toDisable.length === 0) {
      // Touch marker even if nothing changed — avoids rescanning every session
      writeFileSync(RESCAN_MARKER, String(Date.now()));
      return;
    }

    // Upsert changed resources with fallback metadata (no Haiku)
    let firstErr = true;
    for (const res of toIndex) {
      try {
        upsertResource(rdb, {
          name: res.name,
          type: res.type,
          status: 'active',
          source: res.source,
          repo_url: res.repoUrl || null,
          local_path: res.localPath,
          file_hash: res.fileHash,
          intent_tags: res.name.replace(/-/g, ' ').replace(/\//g, ' '),
          trigger_patterns: `when user needs ${res.name.replace(/-/g, ' ').replace(/\//g, ' ')}`,
          capability_summary: `${res.type}: ${res.name.replace(/-/g, ' ')}`,
        });
      } catch (e) { if (firstErr) { debugCatch(e, 'handleResourceScan-upsert'); firstErr = false; } }
    }

    // Disable resources no longer on filesystem
    for (const row of toDisable) {
      try {
        rdb.prepare("UPDATE resources SET status = 'disabled', updated_at = datetime('now') WHERE id = ?").run(row.id);
      } catch {}
    }

    debugLog('DEBUG', 'resource-scan', `indexed ${toIndex.length}, disabled ${toDisable.length}`);
    writeFileSync(RESCAN_MARKER, String(Date.now()));
  } catch (e) {
    debugCatch(e, 'handleResourceScan');
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
    case 'resource-scan':    await handleResourceScan(); break;
  }
} catch (err) {
  // Always log fatal errors (ungated) with structured format
  const ts = new Date().toISOString();
  console.error(`[claude-mem-lite] [${ts}] [ERROR] ${event}: ${err.message}`);
}

// Close singleton registry DB to prevent WAL residue
closeRegistryDb();

process.exit(0);
