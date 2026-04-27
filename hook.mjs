#!/usr/bin/env node
// claude-mem-lite Hook v2 — Cognitive memory architecture
// Selective encoding, episodic batching, error-triggered recall
// Hooks (fast <100ms): post-tool-use, session-start, stop
// Background workers (slow): llm-episode, llm-summary
//
// ─── Session-id invariant (do not violate — see bf121aa / v2.33.2) ──────────
// Two session identifiers coexist in this codebase:
//   • mem-internal id: `hook-<project>-<hash>`, produced by getSessionId().
//     handleUserPrompt writes it into user_prompts / sdk_sessions.content_session_id
//     / observations.memory_session_id. Treat as the ONLY valid WHERE / JOIN key
//     for those three tables.
//   • CC UUID: `hookData.session_id` from stdin. Use ONLY for
//     session_handoffs.session_id (parallel-session scoping, per bf121aa).
// Mixing them silently breaks everything — UPDATE matches 0 rows, SELECT returns
// empty, buildAndSaveHandoff early-returns, no throw. Precedent: v2.33.1 shipped
// with the two mixed since 2026-04-12; 48 stale 'active' sessions + 0 handoffs
// for projects--mem went unnoticed for 4 days. Keep the split or document why
// you're changing it.

import { randomUUID } from 'crypto';
import { join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import {
  truncate, inferProject, detectBashSignificance,
  extractErrorKeywords, extractFilePaths, isRelatedToEpisode,
  makeEntryDesc, scrubSecrets, EDIT_TOOLS, debugCatch, debugLog,
  COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE, isoWeekKey, OBS_BM25,
  computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity,
} from './utils.mjs';
import {
  readEpisodeRaw, episodeFile,
  acquireLock, releaseLock, readEpisode, writeEpisode,
  createEpisode, addFileToEpisode,
  writePendingEntry, mergePendingEntries, episodeHasSignificantContent,
} from './hook-episode.mjs';
import { cleanupClaudeMdLegacyBlock, buildSessionContextLines } from './hook-context.mjs';
import {
  RUNTIME_DIR, EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS,
  SESSION_EXPIRY_MS, STALE_SESSION_MS, STALE_LOCK_MS,
  sessionFile, getSessionId, createSessionId, openDb,
  spawnBackground,
} from './hook-shared.mjs';
import { handleLLMEpisode, handleLLMSummary, saveObservation, buildImmediateObservation } from './hook-llm.mjs';
import { extractCitationsFromTranscript, bumpCitationAccess } from './lib/citation-tracker.mjs';
import { extractTailAssistantText, extractStructuredSummary } from './lib/summary-extractor.mjs';
import { searchRelevantMemories } from './hook-memory.mjs';
import { buildAndSaveHandoff, detectContinuationIntent, renderHandoffInjection, pickHandoffToInject, extractUnfinishedSummary } from './hook-handoff.mjs';
import { checkForUpdate } from './hook-update.mjs';
import { handleLLMOptimize } from './hook-optimize.mjs';
import { silentAutoAdopt, hasAutoAdoptMarker } from './adopt-cli.mjs';
// plugin-cache-guard.mjs loaded dynamically — pre-2.31.2 installs that auto-upgraded
// from an older hook-update.mjs SOURCE_FILES (which did not list this module) would
// crash on static import. Degrade gracefully to no-op when the module is absent.
let _cacheGuardCache = null;
async function loadCacheGuard() {
  if (_cacheGuardCache !== null) return _cacheGuardCache;
  try { _cacheGuardCache = await import('./plugin-cache-guard.mjs'); }
  catch { _cacheGuardCache = {}; }
  return _cacheGuardCache;
}
import { SKIP_TOOLS, SKIP_PREFIXES } from './skip-tools.mjs';
import { getVocabulary } from './tfidf.mjs';

// Prevent recursive hooks from background claude -p calls
// Background workers (llm-episode, llm-summary) are exempt — they're ours
const event = process.argv[2];
const BG_EVENTS = new Set(['llm-episode', 'llm-summary', 'auto-compress', 'llm-optimize']);

// Respect Claude Code plugin disable state even when legacy settings.json hooks remain.
// install.mjs writes direct hooks into ~/.claude/settings.json, so disabling the plugin
// in Claude UI does not automatically remove them. Exit early to make disable actually work.
const PLUGIN_KEY = 'claude-mem-lite@sdsrss';
function isPluginExplicitlyDisabled() {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return settings.enabledPlugins?.[PLUGIN_KEY] === false;
  } catch {
    return false;
  }
}

if (event && isPluginExplicitlyDisabled()) process.exit(0);
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

// hookEventName serves two roles: it is written into the emitted receipt JSON
// AND it gates emission via RECEIPT_EVENTS. Callers MUST pass their triggering
// event name so both work — Stop falls outside the allowlist, so its receipt
// is skipped entirely (CC's Stop schema rejects hookSpecificOutput at the root,
// not just on event-name mismatch). The episode still flushes to DB and
// spawns llm-episode background enrichment; only the stdout receipt is gated.
// Regression chain: v2.33.1 introduced the receipt; v2.33.3 misdiagnosed the
// Stop rejection as event-name mismatch; v2.33.4 is the root-cause fix.
const RECEIPT_EVENTS = new Set(['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
function flushEpisode(episode, hookEventName = 'PostToolUse') {
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

    // v2.33.1: structured flush receipt so Claude sees what mem just captured
    // and the legacy error→fix nudge consolidates here. PostToolUse JSON with
    // hookSpecificOutput.additionalContext reliably renders across CC variants;
    // the old plain-text stdout write was invisible on some variants.
    // v2.33.4: Stop event rejects hookSpecificOutput entirely — skip receipt.
    if (RECEIPT_EVENTS.has(hookEventName)) {
      try {
        const entries = episode.entries || [];
        const hasError = entries.some(e => e.isError);
        const hasEdit = entries.some(e => EDIT_TOOLS.has(e.tool));
        const toolCounts = {};
        for (const e of entries) toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
        const toolSummary = Object.entries(toolCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t, n]) => `${t}×${n}`)
          .join(', ');
        const lines = [`[mem] episode flushed: ${entries.length} entries (${toolSummary})`];
        if (hasError && hasEdit && entries.length >= 3) {
          const editFiles = entries.filter(e => EDIT_TOOLS.has(e.tool)).flatMap(e => e.files || []);
          const uniqueFiles = [...new Set(editFiles)].slice(0, 3);
          const filesHint = uniqueFiles.length > 0 ? ` (${uniqueFiles.join(', ')})` : '';
          lines.push(`[mem] 💡 error→fix pattern${filesHint} — consider: mem_save(type="bugfix", lesson_learned="<root cause + fix>")`);
        }
        process.stdout.write(JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName,
            additionalContext: lines.join('\n'),
          },
        }));
      } catch { /* never block on receipt */ }
    }
  } else {
    try { unlinkSync(flushFile); } catch {}
  }

  // Remove episode buffer AFTER spawning background worker to prevent concurrent overwrites
  try { unlinkSync(episodeFile()); } catch {}
}

// ─── PostToolUse Handler ────────────────────────────────────────────────────

// Tier 1 D: Skip low-value tools entirely (source of truth: skip-tools.mjs)
// Consistency enforced by tests/skip-tools.test.mjs

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

  // Skip noise (source of truth: skip-tools.mjs)
  if (SKIP_TOOLS.has(tool_name)) return;
  if (SKIP_PREFIXES.some(p => tool_name.startsWith(p))) return;

  const resp = normalizeToolResponse(tool_response);
  if (!resp || resp.length < 10) return;

  const toolInput = typeof tool_input === 'string' ? tryParseJson(tool_input) : (tool_input || {});
  const files = extractFilePaths(toolInput);

  // Tier 1 B: Detect significant Bash commands
  const bashSig = (tool_name === 'Bash') ? detectBashSignificance(toolInput, resp) : null;

  // Build episode entry
  const entry = {
    tool: tool_name,
    desc: scrubSecrets(makeEntryDesc(tool_name, toolInput, resp, bashSig)),
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

    // File history injection moved to PreToolUse hook (scripts/pre-tool-recall.js)

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
      ORDER BY ${OBS_BM25}
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
  // Read Claude Code's real session_id from hook stdin for parallel-session scoping.
  // This is the stable CC identifier — the mem plugin's file-based getSessionId()
  // collides across parallel sessions for the same project (see docs/bug.txt).
  let ccSessionId = null;
  let transcriptPath = null;
  try {
    const raw = await readStdin();
    const hookData = JSON.parse(raw.text);
    if (typeof hookData?.session_id === 'string' && hookData.session_id.length > 0) {
      ccSessionId = hookData.session_id;
    }
    if (typeof hookData?.transcript_path === 'string' && hookData.transcript_path.length > 0) {
      transcriptPath = hookData.transcript_path;
    }
  } catch { /* stdin unavailable — fall back to local session id */ }

  // Capture session info BEFORE cleanup. All DB lookups use the mem-internal id
  // (that's what handleUserPrompt wrote into user_prompts / sdk_sessions / observations
  // via getSessionId()). `ccSessionId` is used only to tag session_handoffs rows
  // for parallel-session scoping — it must not be used as a query key, otherwise
  // queries miss and UPDATE sdk_sessions becomes a no-op (v2.33.2 regression fix).
  const sessionId = getSessionId();
  const project = inferProject();

  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

  // Flush remaining episode buffer (locked to prevent race with handlePostToolUse)
  if (acquireLock(1000)) {
    try {
      const episode = readEpisode();
      if (episode) {
        flushEpisode(episode, 'Stop');
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
      // Save handoff snapshot for cross-session continuity.
      // sessionId = mem-internal (query key); ccSessionId = CC UUID (scope key for
      // parallel-safe row identity). Without the split, CC UUID-based queries miss
      // user_prompts and the handoff row is silently skipped (see hook-handoff.mjs).
      try { buildAndSaveHandoff(db, sessionId, project, 'exit', episodeSnapshot, ccSessionId || sessionId); }
      catch (e) { debugCatch(e, 'handleStop-handoff'); }

      // Fast summary baseline — ensures summary exists even if background LLM fails.
      // T4-P2-B: guard against Stop firing twice for the same session (rare but possible;
      // mirrors handleSessionStart line 795 hasSummary guard). Uses mem-internal sessionId
      // as the WHERE key per the top-of-file dual-id invariant (#7789).
      try {
        const existingSummary = db.prepare(
          'SELECT 1 FROM session_summaries WHERE memory_session_id = ? LIMIT 1'
        ).get(sessionId);
        if (!existingSummary) {
          const firstPrompt = db.prepare(`
            SELECT prompt_text FROM user_prompts
            WHERE content_session_id = ?
            ORDER BY prompt_number ASC LIMIT 1
          `).get(sessionId);
          const recentObs = db.prepare(`
            SELECT title FROM observations
            WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
            ORDER BY created_at_epoch DESC LIMIT 5
          `).all(sessionId);
          const fastRequest = truncate(firstPrompt?.prompt_text || '', 200);
          const obsCompleted = recentObs.map(o => o.title).filter(Boolean).join('; ');

          // Structural extraction from the assistant's tail message.
          // CLAUDE.md §10 mandates Done/Not done/Failed/Uncertain markers, so the
          // tail is deterministically parseable without Haiku. Prior baseline left
          // remaining_items=='' for every session whose Haiku pass failed (≈66%
          // in prod data), losing the user-visible "Not done" list.
          let structuredCompleted = '';
          let structuredNotDone = '';
          let structuredNotes = '';
          try {
            const tail = transcriptPath ? extractTailAssistantText(transcriptPath) : null;
            if (tail) {
              const s = extractStructuredSummary(tail);
              structuredCompleted = s.done;
              structuredNotDone = s.notDone;
              const notesParts = [];
              if (s.failed) notesParts.push(`Failed: ${s.failed}`);
              if (s.uncertain) notesParts.push(`Uncertain: ${s.uncertain}`);
              structuredNotes = notesParts.join('\n');
            }
          } catch (e) { debugCatch(e, 'handleStop-structured-extract'); }

          const finalCompleted = structuredCompleted || obsCompleted;
          const finalRemaining = structuredNotDone;
          const finalNotes = structuredNotes || 'fast';

          if (fastRequest || finalCompleted || finalRemaining) {
            const now = new Date();
            db.prepare(`
              INSERT INTO session_summaries
              (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
              VALUES (?, ?, ?, '', '', ?, '', ?, '[]', '[]', ?, ?, ?)
            `).run(
              sessionId, project, fastRequest,
              truncate(finalCompleted, 600),
              truncate(finalRemaining, 600),
              truncate(finalNotes, 400),
              now.toISOString(), now.getTime()
            );
          }
        }
      } catch (e) { debugCatch(e, 'handleStop-fast-summary'); }

      // P4: scan transcript for `#NN` observation citations in assistant text
      // and bump access_count for matched rows. Closes the loop on the "cite #NN"
      // contract — before P4 this was a one-way obligation with no feedback.
      try {
        if (transcriptPath && !process.env.CLAUDE_MEM_NO_CITATION_TRACK) {
          const ids = extractCitationsFromTranscript(transcriptPath);
          if (ids.size > 0) {
            const n = bumpCitationAccess(db, ids, project);
            debugLog('DEBUG', 'handleStop', `citations: ${ids.size} ids scanned, ${n} obs bumped`);
          }
        }
      } catch (e) { debugCatch(e, 'handleStop-citation-track'); }
    } finally {
      db.close();
    }
  }

  // Spawn background for session summary (pass sessionId and project)
  spawnBackground('llm-summary', sessionId, project);

  // Clean session file AFTER spawning background
  try { unlinkSync(sessionFile()); } catch {}
}

// ─── SessionStart Handler + CLAUDE.md Persistence (Tier 1 A, E) ─────────────

async function handleSessionStart() {
  // Plugin cache self-heal: Claude Code auto-updates the marketplace plugin can
  // re-populate cache/<ver>/hooks/hooks.json, reintroducing duplicate hook
  // registration alongside install.mjs-managed settings.json entries. Silently
  // clear — gated by hasInstallManagedHooks to avoid breaking plugin-only users.
  // Dynamic-import fallback: if plugin-cache-guard.mjs is missing (pre-2.31.2
  // auto-upgrade install), skip self-heal instead of crashing the entire hook.
  try {
    const guard = await loadCacheGuard();
    if (guard.hasInstallManagedHooks && guard.hasInstallManagedHooks()) {
      const cleared = guard.clearPluginCacheHooks({
        reason: 'Auto-healed by hook.mjs session-start — install.mjs-managed hooks active in settings.json',
      });
      if (cleared.length > 0) {
        debugLog('DEBUG', 'session-start', `auto-healed stale plugin cache hooks.json in version(s): ${cleared.join(', ')}`);
      }
    }
  } catch (e) { debugCatch(e, 'session-start-cache-heal'); }

  // v2.33.0: plugin-mode first-run auto-adopt. /plugin install IS consent to
  // integration — writing the MEMORY.md sentinel once per project on first
  // SessionStart avoids the opt-in friction. Scope is narrow:
  //   - gated by CLAUDE_PLUGIN_ROOT (npm/npx installs stay opt-in)
  //   - gated by !MEM_NO_AUTO_ADOPT (explicit escape hatch)
  //   - gated by !MEM_QUIET_HOOKS (quiet = no side-effects semantics)
  //   - first-attempt marker persists in RUNTIME_DIR so a subsequent /unadopt
  //     is respected (no re-adopt loop).
  // Failures (user-edited sentinel, budget exceeded, FS errors) are swallowed;
  // the marker is still written so we don't retry on every SessionStart.
  try {
    if (
      process.env.CLAUDE_PLUGIN_ROOT
      && process.env.MEM_NO_AUTO_ADOPT !== '1'
      && process.env.MEM_QUIET_HOOKS !== '1'
    ) {
      const project = inferProject();
      if (!hasAutoAdoptMarker(RUNTIME_DIR, project)) {
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const r = silentAutoAdopt({ cwd, markerDir: RUNTIME_DIR, markerKey: project });
        if (r.ok) {
          debugLog('DEBUG', 'session-start-auto-adopt', `action=${r.action} project=${project}`);
        } else {
          debugLog('DEBUG', 'session-start-auto-adopt', `skipped project=${project} reason=${r.reason}`);
        }
      }
    }
  } catch (e) { debugCatch(e, 'session-start-auto-adopt'); }

  // Read CC real session_id from hook stdin — used to scope handoff rows so parallel
  // sessions for the same project don't clobber each other (see docs/bug.txt).
  let ccSessionId = null;
  try {
    const raw = await readStdin();
    const hookData = JSON.parse(raw.text);
    if (typeof hookData?.session_id === 'string' && hookData.session_id.length > 0) {
      ccSessionId = hookData.session_id;
    }
  } catch { /* stdin unavailable — legacy behavior */ }

  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

  // Flush any leftover episode buffer from previous session (e.g. after /clear)
  if (acquireLock()) {
    try {
      const prevEpisode = readEpisode();
      if (prevEpisode && prevEpisode.entries && prevEpisode.entries.length > 0) {
        flushEpisode(prevEpisode, 'SessionStart');
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
        UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
        WHERE COALESCE(compressed_into, 0) = 0
          AND importance = 1
          AND created_at_epoch < ?
          AND project = ?
      `).run(autoCompressAge, project);
      if (compressed.changes > 0) {
        debugLog('DEBUG', 'session-start', `auto-compressed ${compressed.changes} old observations`);
      }

      // v2.47 P0-3: accelerated compress for LOW_SIGNAL + no-signal noise.
      // 7-day window instead of 30. The write-side capNoiseImportance forces
      // imp=1 on these already; this just shrinks the GC latency so the
      // projected 32.5% corpus reduction materializes within a week on live
      // DBs instead of bleeding into the 30-day tier.
      const noiseCompressAge = Date.now() - 7 * 86400000;
      const noiseCompressed = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
        WHERE COALESCE(compressed_into, 0) = 0
          AND importance = 1
          AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
          AND (facts IS NULL OR facts = '' OR facts = '[]')
          AND (
            title LIKE 'Modified %' OR title LIKE 'Worked on %'
            OR title LIKE 'Reviewed %' OR title LIKE 'Error%'
          )
          AND created_at_epoch < ?
          AND project = ?
      `).run(noiseCompressAge, project);
      if (noiseCompressed.changes > 0) {
        debugLog('DEBUG', 'session-start', `auto-compressed ${noiseCompressed.changes} LOW_SIGNAL noise (7d window)`);
      }
    })();

    // Auto-maintain: cleanup + decay + boost + purge, gated to once per 24h
    const maintainFile = join(RUNTIME_DIR, 'last-auto-maintain.json');
    let shouldMaintain = true;
    try {
      const last = JSON.parse(readFileSync(maintainFile, 'utf8'));
      if (Date.now() - last.epoch < 24 * 3600000) shouldMaintain = false;
    } catch {}
    if (shouldMaintain) {
      try {
        const STALE_AGE = Date.now() - 30 * 86400000;
        const OP_CAP = 500;

        // Purge FIRST: delete pending-purge entries. Schema has no marked_at_epoch, so we
        // anchor retention on created_at_epoch instead: 30d marking gate + 7d grace = 37d.
        // Older cutoffs (e.g. 7d) were always redundant with the 30d marking filter and
        // made purge effectively immediate on the next maintenance cycle — fix for T4-P1-A.
        const purged = db.prepare(`
          DELETE FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE}
            AND created_at_epoch < ?
        `).run(Date.now() - 37 * 86400000);
        if (purged.changes > 0) debugLog('DEBUG', 'auto-maintain', `purged ${purged.changes} stale observations`);

        // Cleanup: remove broken observations (no title AND no narrative)
        const cleaned = db.prepare(`
          DELETE FROM observations WHERE id IN (
            SELECT id FROM observations
            WHERE COALESCE(compressed_into, 0) = 0
              AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
            LIMIT ${OP_CAP}
          )
        `).run();
        if (cleaned.changes > 0) debugLog('DEBUG', 'auto-maintain', `cleaned ${cleaned.changes} broken observations`);

        // Decay: reduce importance of old, never-accessed observations
        const decayed = db.prepare(`
          UPDATE observations SET importance = MAX(1, COALESCE(importance, 1) - 1)
          WHERE id IN (
            SELECT id FROM observations
            WHERE COALESCE(compressed_into, 0) = 0
              AND COALESCE(importance, 1) > 1
              AND COALESCE(access_count, 0) = 0
              AND created_at_epoch < ?
            LIMIT ${OP_CAP}
          )
        `).run(STALE_AGE);
        if (decayed.changes > 0) debugLog('DEBUG', 'auto-maintain', `decayed ${decayed.changes} stale observations`);

        // Mark idle: importance=1, never-accessed, old → pending-purge (will be purged next cycle)
        const idleMarked = db.prepare(`
          UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
          WHERE id IN (
            SELECT id FROM observations
            WHERE COALESCE(compressed_into, 0) = 0
              AND COALESCE(importance, 1) = 1
              AND COALESCE(access_count, 0) = 0
              AND created_at_epoch < ?
            LIMIT ${OP_CAP}
          )
        `).run(STALE_AGE);
        if (idleMarked.changes > 0) debugLog('DEBUG', 'auto-maintain', `marked ${idleMarked.changes} idle as pending-purge`);

        // Boost: increase importance of frequently-accessed observations
        const boosted = db.prepare(`
          UPDATE observations SET importance = MIN(3, COALESCE(importance, 1) + 1)
          WHERE id IN (
            SELECT id FROM observations
            WHERE COALESCE(compressed_into, 0) = 0
              AND COALESCE(access_count, 0) > 3
              AND COALESCE(importance, 1) < 3
            LIMIT ${OP_CAP}
          )
        `).run();
        if (boosted.changes > 0) debugLog('DEBUG', 'auto-maintain', `boosted ${boosted.changes} frequently-accessed observations`);

        // Auto-dedup (exact): merge identical-title observations within 1h.
        // Catches rapid duplicate writes (same hook firing twice, race conditions).
        const dupPairs = db.prepare(`
          SELECT a.id as keep_id, b.id as remove_id
          FROM observations a
          JOIN observations b ON a.title = b.title AND a.project = b.project
            AND a.id < b.id
            AND ABS(a.created_at_epoch - b.created_at_epoch) < 3600000
            AND COALESCE(a.compressed_into, 0) = 0
            AND COALESCE(b.compressed_into, 0) = 0
          LIMIT 20
        `).all();
        if (dupPairs.length > 0) {
          const removeIds = dupPairs.map(p => p.remove_id);
          const ph = removeIds.map(() => '?').join(',');
          db.prepare(`UPDATE observations SET superseded_at = ?, superseded_by = 'auto-dedup' WHERE id IN (${ph})`).run(Date.now(), ...removeIds);
          debugLog('DEBUG', 'auto-maintain', `auto-deduped ${dupPairs.length} near-identical observations`);
        }

        // Auto-dedup (fuzzy): catches near-identical titles that exact-match
        // misses across larger time windows — e.g. episode-batch titles like
        // "Modified A.mjs, B.mjs" vs "Modified B.mjs, A.mjs" written days apart.
        // MinHash pre-filter (≥0.7) cuts the O(N²) scan; Jaccard ≥0.95 stays
        // well clear of legit "two updates same area" pairs (those typically
        // score 0.7–0.85, surfaced via `maintain scan` for manual review).
        // Bounded by ${SCAN_LIMIT} recent rows × ${FUZZY_MAX_MERGES}-merge cap.
        if (!process.env.CLAUDE_MEM_SKIP_AUTO_DEDUP_FUZZY) {
          const SCAN_LIMIT = 500;
          const FUZZY_MAX_MERGES = 20;
          const FUZZY_THRESHOLD = 0.95;
          const MINHASH_PREFILTER = 0.7;
          const recent = db.prepare(`
            SELECT id, title, importance, created_at_epoch
            FROM observations
            WHERE COALESCE(compressed_into, 0) = 0
              AND superseded_at IS NULL
              AND created_at_epoch > ?
              AND title IS NOT NULL AND title != ''
            ORDER BY created_at_epoch DESC LIMIT ${SCAN_LIMIT}
          `).all(STALE_AGE);
          if (recent.length >= 2) {
            const titles = recent.map(r => r.title.trim());
            const minhashes = titles.map(t => t ? computeMinHash(t) : null);
            const fuzzyRemoveIds = [];
            const removed = new Set();
            outer: for (let i = 0; i < recent.length; i++) {
              if (!minhashes[i] || removed.has(recent[i].id)) continue;
              for (let j = i + 1; j < recent.length; j++) {
                if (!minhashes[j] || removed.has(recent[j].id)) continue;
                if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < MINHASH_PREFILTER) continue;
                if (jaccardSimilarity(titles[i], titles[j]) < FUZZY_THRESHOLD) continue;
                // Keep the higher-importance row; tiebreak by older (lower id wins access history)
                const keep = (recent[i].importance ?? 1) >= (recent[j].importance ?? 1) ? recent[i] : recent[j];
                const remove = keep === recent[i] ? recent[j] : recent[i];
                fuzzyRemoveIds.push(remove.id);
                removed.add(remove.id);
                if (fuzzyRemoveIds.length >= FUZZY_MAX_MERGES) break outer;
              }
            }
            if (fuzzyRemoveIds.length > 0) {
              const ph = fuzzyRemoveIds.map(() => '?').join(',');
              db.prepare(`UPDATE observations SET superseded_at = ?, superseded_by = 'auto-dedup-fuzzy' WHERE id IN (${ph})`)
                .run(Date.now(), ...fuzzyRemoveIds);
              debugLog('DEBUG', 'auto-maintain', `fuzzy auto-deduped ${fuzzyRemoveIds.length} near-identical observations`);
            }
          }
        }

        // Mark maintenance as done (24h gate) — even though compression runs in background
        writeFileSync(maintainFile, JSON.stringify({ epoch: Date.now() }));
        // Weekly summary grouping runs in background to avoid blocking SessionStart
        if (!process.env.CLAUDE_MEM_SKIP_COMPRESS) spawnBackground('auto-compress');
        if (!process.env.CLAUDE_MEM_SKIP_OPTIMIZE) spawnBackground('llm-optimize');
      } catch (e) { debugCatch(e, 'auto-maintain'); }
    }

    // ── Non-transactional operations (side effects, background work) ──

    // Shared clear handoff reference — queried once, used by fast summary + working state
    let prevClearHandoff = null;

    if (prevSessionId) {
      // Save handoff for cross-session continuity (/clear or /compact).
      // prevSessionId is the mem-internal id — use it to look up the finished session's
      // user_prompts / observations. ccSessionId (same CC session across /clear) scopes
      // the stored row so UserPromptSubmit can read its own handoff back.
      // Legacy/test paths (no stdin) fall back to prevSessionId for both.
      const handoffScopeId = ccSessionId || prevSessionId;
      try { buildAndSaveHandoff(db, prevSessionId, prevProject || project, 'clear', episodeSnapshot, handoffScopeId); }
      catch (e) { debugCatch(e, 'session-start-handoff'); }

      // Read the just-saved handoff for downstream consumers (fast summary remaining, working state).
      // Session-scoped read to avoid picking up a parallel session's clear handoff.
      try {
        prevClearHandoff = db.prepare(
          'SELECT working_on, unfinished, key_files FROM session_handoffs WHERE project = ? AND type = ? AND session_id = ?'
        ).get(prevProject || project, 'clear', handoffScopeId);
      } catch {}

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

        // Infer remaining_items from handoff unfinished (already built above at line 476)
        let fastRemaining = '';
        if (prevClearHandoff?.unfinished) {
          fastRemaining = truncate(extractUnfinishedSummary(prevClearHandoff.unfinished, 0), 200);
        }
        // Fallback: episode errors
        if (!fastRemaining && episodeSnapshot?.entries) {
          const errors = episodeSnapshot.entries.filter(e => e.isError).map(e => e.desc).filter(Boolean);
          if (errors.length > 0) fastRemaining = truncate(errors.join('; '), 200);
        }

        if (fastRequest || fastCompleted) {
          db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
            VALUES (?, ?, ?, '', '', ?, '', ?, '[]', '[]', 'fast', ?, ?)
          `).run(prevSessionId, prevProject || project, fastRequest, truncate(fastCompleted, 300), fastRemaining, now.toISOString(), now.getTime());
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
                (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
                VALUES (?, ?, ?, '', '', ?, '', '', '[]', '[]', 'fast', ?, ?)
              `).run(recentSession.content_session_id, project, fr, truncate(fc, 300), now.toISOString(), now.getTime());
            }
          }
        }
      } catch (e) { debugCatch(e, 'session-start-exit-fast-summary'); }
    }

    // T10c: Startup dashboard — aggregate git/tasks/plans/handoff/events into a
    // structured JSON hookSpecificOutput block. Emitted BEFORE the plain-text
    // <claude-mem-context> so both surfaces coexist. Empty string → skip.
    try {
      const { buildDashboard } = await import('./lib/startup-dashboard.mjs');
      const dashboardText = buildDashboard({ db, project, projectPath: process.cwd() });
      if (dashboardText) {
        process.stdout.write(JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: dashboardText,
          },
        }) + '\n');
      }
    } catch (e) { debugCatch(e, 'session-start-dashboard'); }

    // Build the full context body via shared helper (also used by `mem-cli context`).
    // Queries session_summaries, key observations, clear handoff, and the
    // token-budgeted observation pool directly from the DB.
    // Pass CC session id so the Working State block is scoped to this session,
    // preventing parallel sessions from seeing each other's /clear handoff.
    const fullContext = buildSessionContextLines(db, project, now, ccSessionId);

    // Stdout is the sole context-delivery channel. The SessionStart hook output
    // is injected as a <system-reminder> at session start, giving Claude the
    // full summary + handoff state + observations table fresh from the DB.
    process.stdout.write(`<claude-mem-context>\n${fullContext}\n</claude-mem-context>\n`);

    // One-time migration: remove any stale <claude-mem-context> block left in
    // CLAUDE.md by pre-v2.30 installs. Idempotent no-op afterwards.
    cleanupClaudeMdLegacyBlock();

    // Pre-load TF-IDF vocabulary cache for this session (from DB, ~1ms)
    try { getVocabulary(db); } catch (e) { debugCatch(e, 'session-start-vocab'); }

    // Auto-update check (24h throttle, 3s timeout, silent on failure)
    // Awaited so process.exit(0) doesn't kill the promise before notification
    try {
      const updateResult = await checkForUpdate();
      if (updateResult?.updated) {
        process.stdout.write(`\n🔄 claude-mem-lite: v${updateResult.from} → v${updateResult.to} updated\n`);
      } else if (updateResult?.updateAvailable) {
        const hint = updateResult.installDeferred
          ? ' — plugin mode only checks for updates; reinstall/update the plugin to apply it'
          : '';
        process.stdout.write(`\n📦 claude-mem-lite: v${updateResult.to} available (current: v${updateResult.from})${hint}\n`);
      }
    } catch (e) { debugCatch(e, 'session-start-update'); }

  } finally {
    db.close();
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

  // Skip internal Claude Code protocol messages — not real user input
  if (promptText.startsWith('<task-notification>')) return;

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

    // T4-P2-D: atomic increment+read via UPDATE ... RETURNING (SQLite 3.35+).
    // Previously UPDATE + SELECT as two statements; parallel prompts could read a stale
    // counter and emit duplicate prompt_number values. better-sqlite3 ships a modern SQLite.
    const bumped = db.prepare(
      'UPDATE sdk_sessions SET prompt_counter = COALESCE(prompt_counter, 0) + 1 WHERE content_session_id = ? RETURNING prompt_counter'
    ).get(sessionId);
    const promptNumber = bumped?.prompt_counter || 1;

    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      scrubSecrets(promptText.slice(0, 10000)),
      promptNumber,
      now.toISOString(), now.getTime()
    );

    // Cross-session handoff injection (first 3 prompts window, before semantic memory).
    // Use Claude Code's real session_id from hook stdin to scope handoffs to this CC
    // session — prevents cross-session bleed when running parallel sessions for the
    // same project (see docs/bug.txt). Falls back to null (legacy behavior) if the
    // hook input does not carry session_id.
    const ccSessionId = typeof hookData.session_id === 'string' && hookData.session_id.length > 0
      ? hookData.session_id
      : null;
    if (promptNumber <= 3) {
      try {
        if (detectContinuationIntent(db, promptText, project, ccSessionId)) {
          const picked = pickHandoffToInject(db, project, ccSessionId);
          if (picked) {
            const injection = renderHandoffInjection(db, project, ccSessionId);
            if (injection) process.stdout.write(injection + '\n');
            // Consume ONLY the row we just injected — leave other projects' exit
            // handoffs intact so future sessions can still resume from them.
            // Pre-v2.46 wiped every exit handoff for the project on any continuation
            // intent, which made the DB effectively forgetful: 115 completed sessions
            // produced 1 persisted handoff.
            try {
              db.prepare(
                'DELETE FROM session_handoffs WHERE project = ? AND type = ? AND session_id = ?'
              ).run(project, picked.type, picked.session_id);
            } catch {}
          }
        }
      } catch (e) { debugCatch(e, 'handleUserPrompt-handoff'); }
    }

    // Semantic memory injection: search past observations for the user's prompt
    try {
      const keyObs = db.prepare(`
        SELECT id FROM observations
        WHERE project = ? AND COALESCE(compressed_into, 0) = 0
          AND COALESCE(importance, 1) >= 2
        ORDER BY created_at_epoch DESC LIMIT 5
      `).all(project);
      const keyContextIds = keyObs.map(o => o.id);

      // Read IDs already injected by user-prompt-search.js to avoid duplicate injection
      try {
        const injectedFile = join(RUNTIME_DIR, `.claude-mem-injected-${project}`);
        const raw = readFileSync(injectedFile, 'utf8');
        const { ids, ts } = JSON.parse(raw);
        // Only use if written within last 10 seconds (same prompt cycle)
        if (ts && Date.now() - ts < 10000 && Array.isArray(ids)) {
          for (const id of ids) keyContextIds.push(id);
        }
      } catch { /* file may not exist — that's fine */ }

      const memories = searchRelevantMemories(db, promptText, project, keyContextIds);
      if (memories.length > 0) {
        const lines = ['<memory-context relevance="high">'];
        for (const m of memories) {
          const lessonTag = m.lesson_learned ? ` | Lesson: ${m.lesson_learned}` : '';
          lines.push(`- [${m.type}] ${truncate(m.title, 80)}${lessonTag} (#${m.id})`);
        }
        lines.push('</memory-context>');
        process.stdout.write(lines.join('\n') + '\n');
      }
    } catch (e) { debugCatch(e, 'handleUserPrompt-memory'); }
  } finally {
    db.close();
  }
}

// ─── Auto-Compress (Background Worker) ───────────────────────────────────────

/**
 * Background worker: group old low-value observations into weekly summaries.
 * Spawned by SessionStart daily after the fast purge DELETE.
 * Iterates 60-day-old observations, groups by project+week, creates summary per group.
 */
function handleAutoCompress() {
  const db = openDb();
  if (!db) return;

  try {
    const compressCutoff = Date.now() - 60 * 86400000; // 60 days
    const compressCandidates = db.prepare(`
      SELECT id, project, type, title, created_at_epoch
      FROM observations
      WHERE COALESCE(importance, 1) = 1 AND COALESCE(access_count, 0) = 0
        AND created_at_epoch < ?
        AND (compressed_into IS NULL OR compressed_into = ${COMPRESSED_AUTO})
      ORDER BY project, created_at_epoch
    `).all(compressCutoff);
    if (compressCandidates.length < 3) return;

    const groups = new Map();
    for (const c of compressCandidates) {
      const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    // Transact each group to prevent orphan summaries on crash
    const compressGroup = db.transaction((proj, obs) => {
      const types = {};
      for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
      const dominantType = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
      const title = `Weekly summary: ${obs.length} ${dominantType} observations`;
      const narrative = obs.map(o => `- ${o.title || '(untitled)'}`).join('\n');
      const sortedEpochs = obs.map(o => o.created_at_epoch).sort((a, b) => a - b);
      const medianEpoch = sortedEpochs[Math.floor(sortedEpochs.length / 2)];
      const sessionId = `compress-${proj}`;
      const now = new Date();
      db.prepare(`INSERT OR IGNORE INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?,?,?,?,?,'active')`
      ).run(sessionId, sessionId, proj, now.toISOString(), now.getTime());
      const summaryResult = db.prepare(`INSERT INTO observations
        (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
         files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?,?,?,?,?,'',?,'','','[]','[]',2,?,?)`
      ).run(sessionId, proj, narrative, dominantType, title, narrative, new Date(medianEpoch).toISOString(), medianEpoch);
      const summaryId = Number(summaryResult.lastInsertRowid);
      const obsIds = obs.map(o => o.id);
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${obsIds.map(() => '?').join(',')})`)
        .run(summaryId, ...obsIds);
      return obs.length;
    });
    let totalCompressed = 0;
    for (const [key, obs] of groups) {
      if (obs.length < 3) continue;
      const [proj] = key.split('::');
      totalCompressed += compressGroup(proj, obs);
    }
    if (totalCompressed > 0) {
      debugLog('DEBUG', 'auto-compress', `auto-compressed ${totalCompressed} observations into weekly summaries`);
    }
  } catch (e) {
    debugCatch(e, 'auto-compress');
  } finally {
    db.close();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function readStdin() {
  const MAX_STDIN = 256 * 1024; // 256KB — large tool responses are truncated
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => { debugLog('WARN', 'readStdin', 'stdin timeout after 3s — event dropped'); process.stdin.destroy(); reject(new Error('timeout')); }, 3000);
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

// Strip ANSI escape codes and extract readable text from tool responses.
// Bash responses come as {stdout, stderr} objects or JSON strings — extract the text content
// instead of producing noisy `{"stdout":"\u001b[1m..."}` in episode descriptions.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
function extractStdio(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const { stdout, stderr } = obj;
  if (typeof stdout === 'string' || typeof stderr === 'string') {
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stderr);
    return parts.join('\n');
  }
  return null;
}
function normalizeToolResponse(toolResponse) {
  if (typeof toolResponse === 'string') {
    // Try to parse JSON strings like '{"stdout":"...","stderr":"..."}'
    if (toolResponse.startsWith('{"stdout"') || toolResponse.startsWith('{"stderr"')) {
      try {
        const parsed = JSON.parse(toolResponse);
        const extracted = extractStdio(parsed);
        if (extracted) return extracted.replace(ANSI_RE, '');
      } catch {}
    }
    return toolResponse.replace(ANSI_RE, '');
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const extracted = extractStdio(toolResponse);
    if (extracted) return extracted.replace(ANSI_RE, '');
    return JSON.stringify(toolResponse).replace(ANSI_RE, '');
  }
  return '';
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  switch (event) {
    case 'post-tool-use':    await handlePostToolUse(); break;
    case 'session-start':    await handleSessionStart(); break;
    case 'stop':             await handleStop(); break;
    case 'user-prompt':      await handleUserPrompt(); break;
    case 'llm-episode':      await handleLLMEpisode(); break;
    case 'llm-summary':      await handleLLMSummary(); break;
    case 'auto-compress':    handleAutoCompress(); break;
    case 'llm-optimize':   await handleLLMOptimize(); break;
  }
} catch (err) {
  // Always log fatal errors (ungated) with structured format
  const ts = new Date().toISOString();
  console.error(`[claude-mem-lite] [${ts}] [ERROR] ${event}: ${err.message}`);
}

process.exit(0);
