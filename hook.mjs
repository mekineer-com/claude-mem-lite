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
import { readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import {
  truncate, inferProject, detectBashSignificance,
  extractErrorKeywords, extractFilePaths, isRelatedToEpisode,
  makeEntryDesc, scrubSecrets, stripPrivate, EDIT_TOOLS, debugCatch, debugLog,
  COMPRESSED_AUTO, OBS_BM25, notLowSignalTitleClause, formatErrorRecallHints,
} from './utils.mjs';
import {
  readEpisodeRaw, episodeFile,
  acquireLock, releaseLock, readEpisode, writeEpisode,
  createEpisode, addFileToEpisode,
  writePendingEntry, mergePendingEntries, episodeHasSignificantContent,
} from './hook-episode.mjs';
import { cleanupClaudeMdLegacyBlock, buildSessionContextLines } from './hook-context.mjs';
import { entry as preCompactEntry } from './hook-precompact.mjs';
import {
  RUNTIME_DIR, EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS,
  SESSION_EXPIRY_MS, STALE_SESSION_MS, STALE_LOCK_MS,
  sessionFile, getSessionId, createSessionId, openDb,
  spawnBackground, sweepOrphanEpisodeFiles,
} from './hook-shared.mjs';
import { handleLLMEpisode, handleLLMSummary, saveObservation, buildImmediateObservation, saveEpisodeImmediate } from './hook-llm.mjs';
import { scrubRecord } from './lib/scrub-record.mjs';
import { formatHookError } from './lib/native-binding-hint.mjs';
import { selectCompressionCandidates, groupByProjectWeek, compressGroup } from './lib/compress-core.mjs';
import { cleanupBroken, decayAndMarkIdle, boostAccessed, selectFuzzyDedupeIds, hardDeleteCandidateCount, purgeStale } from './lib/maintain-core.mjs';
import { snapshotDb } from './lib/db-backup.mjs';
import {
  extractCitationsFromTranscript,
  extractAllInjected,
  bumpCitationAccess,
  computeCiteRecall,
  applyCitationDecay,
  recordCitationFunnel,
  hasMainThreadAssistantText,
} from './lib/citation-tracker.mjs';
import { extractTailAssistantText, extractStructuredSummary } from './lib/summary-extractor.mjs';
import { searchRelevantMemories, formatMemoryLine } from './hook-memory.mjs';
import { recordSkillAdoption, gcOldShadowShards } from './registry-recommend.mjs';
import { detectMemOverride } from './lib/mem-override.mjs';
import { buildAndSaveHandoff, detectContinuationIntent, renderHandoffInjection, pickHandoffToInject, extractUnfinishedSummary } from './hook-handoff.mjs';
import { checkForUpdate, getCachedUpdateBanner, isUpdateCheckDue } from './hook-update.mjs';
import { handleLLMOptimize } from './hook-optimize.mjs';
import { silentAutoAdopt } from './adopt-cli.mjs';
import { emitV270UpgradeBanner } from './lib/upgrade-banner.mjs';
import { loadCiteBackForEpisode, extractCiteBackSignals, buildUnsavedBugfixHint, countUnsavedBugfixShape, buildCiteRecallNudge as libBuildCiteRecallNudge, nextCiteLowStreak } from './lib/cite-back-hint.mjs';
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
          // Persist a rule-based observation synchronously BEFORE writing the flush
          // file — that file has no consumer, so this is the only thing that prevents
          // the in-flight episode being lost on abnormal termination (audit #6).
          saveEpisodeImmediate(ep);
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
        const toolCounts = {};
        for (const e of entries) toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
        const toolSummary = Object.entries(toolCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t, n]) => `${t}×${n}`)
          .join(', ');
        const lines = [`[mem] episode flushed: ${entries.length} entries (${toolSummary})`];
        // v2.83: error→fix nudge lifted to lib/cite-back-hint.mjs::buildUnsavedBugfixHint
        // so the wording (count + "Save now" verb) stays in sync with cite-back.
        const bugfixHint = buildUnsavedBugfixHint(episode);
        if (bugfixHint) lines.push(bugfixHint);
        // v2.81: cite-back hint — fires when this episode edits a file that
        // PreToolUse:Read/Edit nudged earlier in the same session. Precision
        // signal (we know the file was warned about); orthogonal to the
        // bugfix-shape nudge above and may co-fire.
        const citeBack = loadCiteBackForEpisode(episode, RUNTIME_DIR);
        if (citeBack) lines.push(citeBack);
        // Trailing newline is REQUIRED: when this receipt flushes at SessionStart
        // (leftover episode after /clear or /compact), the startup dashboard writes a
        // second hookSpecificOutput object right after. Without the '\n' the two land
        // back-to-back as `}{` on one line and Claude Code's line-based JSON parser
        // drops both — losing the episode-flush / cite-back context exactly at the
        // session boundary. Every other hookSpecificOutput write appends '\n'; this
        // was the lone exception.
        process.stdout.write(JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName,
            additionalContext: lines.join('\n'),
          },
        }) + '\n');
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

  // Shadow skill-adoption telemetry. mem_use is pre-filtered above, so the Skill tool is
  // the only visible adoption signal (v1). Placed before the resp-length gate because a
  // skill load's response shape varies. Never throws.
  if (tool_name === 'Skill') {
    const ti = typeof tool_input === 'string' ? tryParseJson(tool_input) : (tool_input || {});
    // hookData.session_id (CC UUID) pairs this adoption to the would-be reco from the
    // UserPromptSubmit hook earlier in the same session (matched precision, B1).
    try { recordSkillAdoption('Skill', ti, inferProject(), hookData.session_id); } catch {}
  }

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
      SELECT o.id, o.type, o.title, o.lesson_learned
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.project = ?
        AND ${notLowSignalTitleClause('o')}
      ORDER BY ${OBS_BM25}
        * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
      LIMIT 3
    `).all(ftsQuery, project, nowR);

    const out = formatErrorRecallHints(rows);
    if (out) process.stdout.write(out);
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
          // Raw values flow into scrubRecord below; truncation at .run() site
          // so secrets straddling the boundary still match scrubSecrets's
          // length floors.
          const fastRequestRaw = firstPrompt?.prompt_text || '';
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

          if (fastRequestRaw || finalCompleted || finalRemaining) {
            const now = new Date();
            const safe = scrubRecord('session_summaries', {
              request: fastRequestRaw,
              completed: finalCompleted,
              remaining_items: finalRemaining,
              notes: finalNotes,
            });
            db.prepare(`
              INSERT INTO session_summaries
              (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
              VALUES (?, ?, ?, '', '', ?, '', ?, '[]', '[]', ?, ?, ?)
            `).run(
              sessionId, project, truncate(safe.request, 200),
              truncate(safe.completed, 600),
              truncate(safe.remaining_items, 600),
              truncate(safe.notes, 400),
              now.toISOString(), now.getTime()
            );
          }
        }
      } catch (e) { debugCatch(e, 'handleStop-fast-summary'); }

      // P4: scan transcript for `#NN` observation citations in assistant text
      // and bump access_count for matched rows. Closes the loop on the "cite #NN"
      // contract — before P4 this was a one-way obligation with no feedback.
      //
      // CLAUDE_MEM_NO_CITATION_TRACK=1 disables BOTH the P4 access_count bump
      // AND the v32 citation-decay loop nested below — anything that needs the
      // transcript scan lives inside this guard. To disable just the decay
      // loop (keep access_count bumps), use MEM_DISABLE_CITATION_DECAY=1 which
      // applyCitationDecay checks separately.
      try {
        if (transcriptPath && !process.env.CLAUDE_MEM_NO_CITATION_TRACK) {
          const ids = extractCitationsFromTranscript(transcriptPath);
          if (ids.size > 0) {
            const n = bumpCitationAccess(db, ids, project);
            debugLog('DEBUG', 'handleStop', `citations: ${ids.size} ids scanned, ${n} obs bumped`);
          }

          // v32 citation-decay: tighter feedback loop on top of P4. Re-scan
          // transcript with main-thread filter, extract injected IDs from BOTH
          // surfaces (PTR + UserPromptSubmit <memory-context>) via extractAllInjected,
          // then mutate importance/streak per applyCitationDecay's contract.
          // Cheap (file still in OS cache).
          //
          // v34.x: pre-v34 this only saw pre-tool-recall injections, leaving the
          // UPS surface (highest-volume — all decision-type FTS hits) starved.
          // Union closed by extractAllInjected — one integration point so the
          // contract test in tests/citation-tracker-userprompt.test.mjs covers it.
          try {
            // mainOnly: the injected denominator must use the same thread
            // filter as citedMain (the numerator, below) — an obs injected only
            // inside a subagent (sidechain) would otherwise enter the denominator
            // but never the numerator and streak-demote despite being used there.
            const injected = extractAllInjected(transcriptPath, { mainOnly: true });
            // P5 ①: cite-back signals — observations whose warned file the agent
            // edited this session. Union into injected so they're resolved (they
            // were injected via pre-tool-recall) and, below, into cited so the
            // edit promotes them even without a literal #NN in text.
            const citeBackIds = extractCiteBackSignals(transcriptPath);
            for (const id of citeBackIds) injected.add(id);
            if (injected.size > 0) {
              // Text-floor gate: skip decay on tool-only Stops. Without this,
              // a turn that ends on tool_use locks every injected obs as
              // uncited (last_decided_session_id set), so a later turn that
              // cites correctly can't undo the verdict. Per CLAUDE.md the
              // contract is "NEXT time you produce user-facing text," so a
              // session with zero main-thread text gets a free pass — the
              // next Stop in the same session will re-evaluate.
              if (!hasMainThreadAssistantText(transcriptPath)) {
                debugLog('DEBUG', 'handleStop', `citation-decay: skipped (no main-thread assistant text yet, injected=${injected.size})`);
              } else {
                const citedMain = extractCitationsFromTranscript(transcriptPath, { mainOnly: true });
                for (const id of citeBackIds) citedMain.add(id);
                const r = applyCitationDecay(db, project, injected, citedMain, sessionId);
                debugLog('DEBUG', 'handleStop', `citation-decay: touched=${r.touched} promoted=${r.promoted} demoted=${r.demoted}`);
                // R1: persist this session's invocation→cite funnel row. touched =
                // obs resolved this run (denominator), promoted = obs cited this run
                // (numerator). Idempotent (touched is 0 on re-fire) + best-effort.
                recordCitationFunnel(db, project, sessionId, r.touched, r.promoted);
              }
            }
          } catch (e) { debugCatch(e, 'handleStop-citation-decay'); }

          // Persist cite-recall ratio for the next SessionStart to surface as
          // feedback. We deliberately scan the transcript a second time here
          // (cheap; the file is already in OS cache) rather than threading the
          // count through `extractCitationsFromTranscript` so the bump path stays
          // unchanged.
          try {
            const stats = computeCiteRecall(transcriptPath);
            // B2 (v2.83.1): also persist the bugfix-shape nudge/save delta so
            // the next SessionStart can surface "N unsaved bugfix-shape edits"
            // alongside cite-recall. Same scan target (transcript already in OS
            // cache); same persistence file; one extra line in buildCiteRecallNudge.
            const bugfixStats = countUnsavedBugfixShape(transcriptPath);
            const dest = join(RUNTIME_DIR, `cite-recall-${project.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64)}.json`);
            // Carry the consecutive-low-cite streak forward so the SessionStart
            // nag can self-silence after the project has ignored it N times.
            let priorStreak = 0;
            try { priorStreak = JSON.parse(readFileSync(dest, 'utf8')).lowStreak || 0; } catch {}
            const lowStreak = nextCiteLowStreak(priorStreak, stats);
            const payload = { ...stats, ...bugfixStats, lowStreak, project, savedAt: Date.now() };
            writeFileSync(dest, JSON.stringify(payload), { mode: 0o600 });
          } catch (e) { debugCatch(e, 'handleStop-cite-recall-persist'); }
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

// Build the SessionStart nudge line shown when the prior session's cite-recall
// fell below threshold. Empty string = no surface (insufficient signal, recall
// already healthy, or feature opted-out via env). Default threshold 0.6,
// min injected 5 — both env-overridable for ops tuning + tests.
// Thin wrapper: lib/cite-back-hint.mjs owns the logic so it stays unit-tested.
// Passing module-level RUNTIME_DIR keeps the call site identical to pre-v2.83.1.
function buildCiteRecallNudge(project) {
  return libBuildCiteRecallNudge(project, RUNTIME_DIR);
}

// GC pre-recall cooldown files older than 24h. Pulled out of pre-tool-recall.js
// (where it ran on every Edit, costing 15-30 disk stats per call on long-lived
// projects) and consolidated here — once per SessionStart is enough to keep
// RUNTIME_DIR from growing unbounded across stale sessions.
const PRE_RECALL_COOLDOWN_STALE_MS = 24 * 60 * 60 * 1000;
function gcStalePreRecallCooldowns() {
  try {
    const now = Date.now();
    for (const name of readdirSync(RUNTIME_DIR)) {
      if (!name.startsWith('pre-recall-cooldown-') || !name.endsWith('.json')) continue;
      try {
        const p = join(RUNTIME_DIR, name);
        const st = statSync(p);
        if (now - st.mtimeMs > PRE_RECALL_COOLDOWN_STALE_MS) unlinkSync(p);
      } catch { /* silent per-entry */ }
    }
  } catch { /* silent — RUNTIME_DIR may not exist on first run */ }
}

// ─── SessionStart phase helpers ──────────────────────────────────────────────
// Extracted verbatim from handleSessionStart (audit P1-10) so the dispatcher
// reads as a sequence of named phases. Each is a self-contained side-effect unit
// (db / fs / stdout / background spawns) with a narrow input contract and no
// return-state coupling; behavior is byte-identical to the prior inline blocks.

function runSessionStartDbMutations(db, { sessionId, project, prevSessionId, now }) {
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
    // v2.56.0 #4: protect injection_count > 0 obs (proven contextually relevant
    // via hook-memory injection, even if user never explicitly fetched). Same
    // protection applied symmetrically in auto-maintain decay/mark-idle below.
    const compressed = db.prepare(`
      UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
      WHERE COALESCE(compressed_into, 0) = 0
        AND importance = 1
        AND COALESCE(injection_count, 0) = 0
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
}

function runSessionStartAutoMaintain(db) {
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
      // Shared maintenance context (whole-DB, cap 500) — used by every maintain-core
      // op below AND the MED-2 snapshot guard. injection_count>0 protection lives in
      // decayAndMarkIdle.
      const mctx = { projectFilter: '', baseParams: [], staleAge: STALE_AGE, opCap: OP_CAP };

      // MED-2: snapshot the DB before the irreversible purge/cleanup hard-deletes
      // below, but only when rows will actually be removed (cheap COUNT). Must run
      // here, outside any transaction — VACUUM cannot run inside one. Best-effort:
      // snapshotDb never throws, so a backup failure cannot block auto-maintain.
      if (hardDeleteCandidateCount(db, mctx, { cleanup: true, purge: true }) > 0) {
        snapshotDb(db, { tag: 'pre-maintain' });
      }

      // Purge FIRST via the SHARED purgeStale — was an inline DELETE that skipped
      // recoverChildrenOf, so purging a keeper that had absorbed dups orphaned its
      // children (compressed_into dangling at a deleted id). purgeStale recovers them
      // first and caps at opCap. Schema has no marked_at_epoch, so retention anchors on
      // created_at_epoch: 30d marking gate + 7d grace = 37d.
      const purged = purgeStale(db, mctx, Date.now() - 37 * 86400000);
      if (purged > 0) debugLog('DEBUG', 'auto-maintain', `purged ${purged} stale observations`);

      const cleaned = cleanupBroken(db, mctx);
      if (cleaned > 0) debugLog('DEBUG', 'auto-maintain', `cleaned ${cleaned} broken observations`);

      const { decayed, idleMarked } = decayAndMarkIdle(db, mctx);
      if (decayed > 0) debugLog('DEBUG', 'auto-maintain', `decayed ${decayed} stale observations`);
      if (idleMarked > 0) debugLog('DEBUG', 'auto-maintain', `marked ${idleMarked} idle as pending-purge`);

      const boosted = boostAccessed(db, mctx);
      if (boosted > 0) debugLog('DEBUG', 'auto-maintain', `boosted ${boosted} frequently-accessed observations`);

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
        const recent = db.prepare(`
          SELECT id, title, importance, created_at_epoch, narrative, text
          FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND superseded_at IS NULL
            AND created_at_epoch > ?
            AND title IS NOT NULL AND title != ''
          ORDER BY created_at_epoch DESC LIMIT ${SCAN_LIMIT}
        `).all(STALE_AGE);
        if (recent.length >= 2) {
          // audit #8: supersede only when title AND body match — title-only (a word-SET
          // metric) collapsed distinct observations sharing a title token-set. The
          // selection is the shared pure core in lib/maintain-core (unit-tested there).
          const rows = recent.map(r => ({
            id: r.id, title: r.title, importance: r.importance,
            body: (r.narrative && r.narrative.trim()) || (r.text && r.text.trim()) || '',
          }));
          const fuzzyRemoveIds = selectFuzzyDedupeIds(rows, { maxMerges: FUZZY_MAX_MERGES });
          if (fuzzyRemoveIds.length > 0) {
            const ph = fuzzyRemoveIds.map(() => '?').join(',');
            db.prepare(`UPDATE observations SET superseded_at = ?, superseded_by = 'auto-dedup-fuzzy' WHERE id IN (${ph})`)
              .run(Date.now(), ...fuzzyRemoveIds);
            debugLog('DEBUG', 'auto-maintain', `fuzzy auto-deduped ${fuzzyRemoveIds.length} near-identical observations`);
          }
        }
      }

      // Orphan sweep: remove `ep-flush-*` / `pending-*` runtime files older
      // than 1h. handleLLMEpisode normally unlinks its own tmpFile on every
      // exit path, but a crashed worker (OOM, host reboot, kill -9) leaves
      // the file behind, and the doctor "Stale temp files" warning then
      // accumulates indefinitely. fs-only; runs inside the 24h gate so it
      // shares cadence with the rest of auto-maintain.
      try {
        const swept = sweepOrphanEpisodeFiles(RUNTIME_DIR);
        if (swept > 0) debugLog('DEBUG', 'auto-maintain', `swept ${swept} orphan ep-flush/pending file(s)`);
      } catch (e) { debugCatch(e, 'auto-maintain-orphan-sweep'); }

      // Mark maintenance as done (24h gate) — even though compression runs in background
      writeFileSync(maintainFile, JSON.stringify({ epoch: Date.now() }));
      // Weekly summary grouping runs in background to avoid blocking SessionStart
      if (!process.env.CLAUDE_MEM_SKIP_COMPRESS) spawnBackground('auto-compress');
      if (!process.env.CLAUDE_MEM_SKIP_OPTIMIZE) spawnBackground('llm-optimize');
    } catch (e) { debugCatch(e, 'auto-maintain'); }
  }
}

function saveHandoffAndFastSummary(db, { prevSessionId, prevProject, project, ccSessionId, episodeSnapshot, now }) {
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

      // Raw values flow into scrubRecord; truncation deferred to .run() so
      // secrets straddling the truncation boundary still match scrubSecrets
      // regex length floors.
      const fastRequestRaw = firstPrompt?.prompt_text || '';
      const fastCompletedRaw = prevObs.map(o => o.title).filter(Boolean).join('; ');

      // Infer remaining_items from handoff unfinished (already built above at line 476)
      let fastRemainingRaw = '';
      if (prevClearHandoff?.unfinished) {
        fastRemainingRaw = extractUnfinishedSummary(prevClearHandoff.unfinished, 0);
      }
      // Fallback: episode errors
      if (!fastRemainingRaw && episodeSnapshot?.entries) {
        const errors = episodeSnapshot.entries.filter(e => e.isError).map(e => e.desc).filter(Boolean);
        if (errors.length > 0) fastRemainingRaw = errors.join('; ');
      }

      if (fastRequestRaw || fastCompletedRaw) {
        const safe = scrubRecord('session_summaries', {
          request: fastRequestRaw,
          completed: fastCompletedRaw,
          remaining_items: fastRemainingRaw,
        });
        db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
          VALUES (?, ?, ?, '', '', ?, '', ?, '[]', '[]', 'fast', ?, ?)
        `).run(prevSessionId, prevProject || project, truncate(safe.request, 200), truncate(safe.completed, 300), truncate(safe.remaining_items, 200), now.toISOString(), now.getTime());
      }
    } catch (e) { debugCatch(e, 'session-start-fast-summary'); }
  }
}

function cleanStaleLockFiles() {
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
}

function buildFallbackFastSummary(db, { project, now, prevSessionId }) {
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

          // Raw values into scrubRecord; truncation at .run() preserves
          // straddling-secret detection (per privacy review).
          const frRaw = fp?.prompt_text || '';
          const fcRaw = po.map(o => o.title).filter(Boolean).join('; ');
          if (frRaw || fcRaw) {
            const safe = scrubRecord('session_summaries', {
              request: frRaw,
              completed: fcRaw,
            });
            db.prepare(`
              INSERT INTO session_summaries
              (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
              VALUES (?, ?, ?, '', '', ?, '', '', '[]', '[]', 'fast', ?, ?)
            `).run(recentSession.content_session_id, project, truncate(safe.request, 200), truncate(safe.completed, 300), now.toISOString(), now.getTime());
          }
        }
      }
    } catch (e) { debugCatch(e, 'session-start-exit-fast-summary'); }
  }
}

async function emitStartupDashboard(db, project) {
  // T10c: Startup dashboard — aggregate git/tasks/plans/handoff/events into a
  // structured JSON hookSpecificOutput block. Emitted BEFORE the plain-text
  // <claude-mem-context> so both surfaces coexist. Empty string → skip.
  try {
    const { buildDashboard } = await import('./lib/startup-dashboard.mjs');
    let dashboardText = buildDashboard({ db, project, projectPath: process.cwd() });
    const citeNudge = buildCiteRecallNudge(project);
    if (citeNudge) {
      dashboardText = dashboardText ? `${citeNudge}\n${dashboardText}` : citeNudge;
    }
    // v2.79: surface setup.sh dependency-install failure as a high-visibility
    // line at the very top of the dashboard. setup.sh writes runtime/.deps-broken
    // (JSON: ts/reason/root/repair) on failure and removes it on success — so
    // a stale flag self-heals on the next clean SessionStart. Without this
    // surface, hook degradation looks identical to "nothing happening" until
    // the user notices missing context days later.
    try {
      const depsFlag = join(RUNTIME_DIR, '.deps-broken');
      if (existsSync(depsFlag)) {
        let detail = 'unknown';
        let repair = '';
        try {
          const raw = readFileSync(depsFlag, 'utf8').trim();
          const parsed = JSON.parse(raw);
          detail = parsed.reason || detail;
          repair = parsed.repair || '';
        } catch { /* corrupt flag — surface the fact only */ }
        const nudgeLines = [
          '⚠️ [claude-mem-lite] Hook dependencies failed to install on the last SessionStart.',
          `   Reason: ${detail}`,
        ];
        if (repair) nudgeLines.push(`   Repair: ${repair}`);
        nudgeLines.push('   Until fixed, PreToolUse / PostToolUse / memory injection are degraded.');
        const nudge = nudgeLines.join('\n');
        dashboardText = dashboardText ? `${nudge}\n${dashboardText}` : nudge;
      }
    } catch (e) { debugCatch(e, 'session-start-deps-flag'); }
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
}

async function handleSessionStart() {
  // GC stale per-session cooldown files. Cheap (<5ms typical) and idempotent;
  // moved here from pre-tool-recall.js's hot path.
  gcStalePreRecallCooldowns();
  // Bound the shadow-recommendation log (daily JSONL shards, no GC at write time).
  try { gcOldShadowShards(); } catch { /* best-effort, never blocks SessionStart */ }

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

  // Auto-adopt + migrate (v3.13 CLAUDE.md-steering). silentAutoAdopt is now an
  // IDEMPOTENT per-session sync, so it runs on EVERY SessionStart — not gated by
  // the one-shot RUNTIME_DIR marker. That gate is deliberately gone: existing
  // users whose marker predates v3.13 must still get migrated (legacy memory-dir
  // sentinel stripped, CLAUDE.md managed block written) on their next session.
  // The sync short-circuits cheaply once a project is already on the new scheme.
  // ANY install path — `/plugin install`, `npm install -g`, `npx`, manual — is
  // consent to integration. Scope:
  //   - gated by !MEM_NO_AUTO_ADOPT (explicit global escape hatch)
  //   - per-project opt-out via `<memdir>/.mem-no-auto-adopt` sentinel (managed
  //     by `claude-mem-lite adopt --disable / --enable`; checked inside
  //     silentAutoAdopt).
  //   - CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 freezes the block against drift refresh.
  // Note v2.82.0: removed MEM_QUIET_HOOKS gate. That env var suppresses stdout
  // noise; it must NOT also disable side-effect work (PostToolUse writes the
  // DB unconditionally — auto-adopt follows the same rule). Failures are
  // swallowed; the marker is still written for telemetry/back-compat.
  try {
    if (process.env.MEM_NO_AUTO_ADOPT !== '1') {
      const project = inferProject();
      const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const r = silentAutoAdopt({ cwd, markerDir: RUNTIME_DIR, markerKey: project });
      if (r.ok) {
        debugLog('DEBUG', 'session-start-auto-adopt', `action=${r.action} project=${project}`);
      } else {
        debugLog('DEBUG', 'session-start-auto-adopt', `skipped project=${project} reason=${r.reason}`);
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

    runSessionStartDbMutations(db, { sessionId, project, prevSessionId, now });

    runSessionStartAutoMaintain(db);

    // ── Non-transactional operations (side effects, background work) ──

    saveHandoffAndFastSummary(db, { prevSessionId, prevProject, project, ccSessionId, episodeSnapshot, now });

    cleanStaleLockFiles();

    buildFallbackFastSummary(db, { project, now, prevSessionId });

    await emitStartupDashboard(db, project);

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

    // v2.70.0 one-shot upgrade banner: notify users on first SessionStart per
    // project that the `### Deferred Work` block now reads from the
    // deferred_work table (was: high-importance observations in v2.69.x).
    // Idempotent via marker file; subsequent SessionStarts are silent.
    try {
      // Gate on prior data: a brand-new install never had v2.69.x deferred-block
      // semantics, so the migration notice is wrong noise (it fired for every
      // fresh install since v2.70). Only genuine upgraders with observations see it.
      const obsCount = db.prepare('SELECT COUNT(*) AS c FROM observations WHERE project = ?').get(project)?.c || 0;
      emitV270UpgradeBanner({ project, runtimeDir: RUNTIME_DIR, hasPriorData: obsCount > 0 });
    } catch (e) { debugCatch(e, 'session-start-v270-banner'); }

    // Pre-load TF-IDF vocabulary cache for this session (from DB, ~1ms)
    try { getVocabulary(db); } catch (e) { debugCatch(e, 'session-start-vocab'); }

    // Auto-update check (audit P3d): NON-BLOCKING. Emit the banner from cached
    // state (zero network) and, if the 24h check is due, refresh in a detached
    // background worker so SessionStart never blocks on a GitHub fetch (was an
    // inline `await checkForUpdate()` that could stall the session 3-6s).
    try {
      const banner = getCachedUpdateBanner();
      if (banner) process.stdout.write(banner);
      if (isUpdateCheckDue()) spawnBackground('update-check');
    } catch (e) { debugCatch(e, 'session-start-update'); }

  } finally {
    db.close();
  }
}

// ─── PreCompact Handler ──────────────────────────────────────────────────────
// Fires immediately before Claude Code auto-compaction begins. Re-emits the
// memory context block on stdout so the summarizer sees it during compaction.
// SessionStart's "compact" matcher fires AFTER compaction — by then the
// previous-turn injection has already been collapsed. Pure read; no DB writes.

async function handlePreCompactDispatch() {
  let hookData = {};
  try {
    const raw = await readStdin();
    hookData = JSON.parse(raw.text);
  } catch { /* stdin unavailable — emit anyway with whatever we can infer */ }

  const db = openDb();
  if (!db) return;
  try {
    await preCompactEntry(db, hookData);
  } finally {
    try { db.close(); } catch {}
  }
}

// ─── UserPromptSubmit Handler ────────────────────────────────────────────────

async function handleUserPrompt() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch { return; }

  const rawPrompt = hookData.prompt || hookData.user_prompt;
  if (!rawPrompt || typeof rawPrompt !== 'string') return;

  // Skip internal Claude Code protocol messages — not real user input.
  // Check on raw text BEFORE stripPrivate (the marker is a literal sentinel,
  // wrapping it in <private> would never make sense, but order matters: a
  // future <task-notification> with embedded <private> blocks should still
  // be classified as protocol first.)
  if (rawPrompt.startsWith('<task-notification>')) return;

  // Strip user-marked <private>...</private> blocks at the input boundary so
  // every downstream consumer (user_prompts INSERT, FTS query, continuation
  // detection, semantic-memory injection) sees the redacted text — single
  // source of truth for the privacy primitive.
  // Strip NUL / C0 control chars (keep \t \n \r) before any downstream use: an
  // embedded NUL terminates SQLite's C string, silently truncating the stored
  // prompt_text at the first NUL (and breaking FTS). Single source of truth, so the
  // user_prompts INSERT, FTS query, and continuation detection all see clean text.
  // eslint-disable-next-line no-control-regex -- intentional: NUL/C0 strip prevents SQLite C-string truncation
  const promptText = stripPrivate(rawPrompt).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

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

    // Claude Code's real session_id (CC UUID) from hook stdin. Persisted on the
    // prompt row (cc_session_id) so buildAndSaveHandoff can scope working_on to ONE
    // CC session — getSessionId() is project-scoped (no CC-UUID), so without this
    // concurrent/within-TTL same-project sessions merge each other's prompts (D#26).
    // Also scopes handoff-row injection below. Null (legacy) when stdin lacks session_id.
    const ccSessionId = typeof hookData.session_id === 'string' && hookData.session_id.length > 0
      ? hookData.session_id
      : null;

    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      scrubSecrets(promptText.slice(0, 10000)),
      promptNumber,
      ccSessionId,
      now.toISOString(), now.getTime()
    );

    // Cross-session handoff injection (first 3 prompts window, before semantic memory).
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

    // Semantic memory injection: search past observations for the user's prompt.
    // P0 short-circuit on user-explicit "ignore memory" / "不要用记忆" override
    // (mirrors CC built-in memoryTypes.ts:215). Skip both Key Context lookup
    // and the <memory-context> emission for this turn.
    if (!detectMemOverride(promptText)) try {
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
        for (const m of memories) lines.push(formatMemoryLine(m));
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
    const compressCandidates = selectCompressionCandidates(db, { cutoff: compressCutoff, includeAutoMarked: true });
    if (compressCandidates.length < 3) return;

    const groups = groupByProjectWeek(compressCandidates);
    // Transact each group to prevent orphan summaries on crash (CLI/MCP wrap all groups in one).
    const compressGroupTxn = db.transaction((proj, obs) => compressGroup(db, proj, obs).compressed);
    let totalCompressed = 0;
    for (const [key, obs] of groups) {
      const [proj] = key.split('::');
      totalCompressed += compressGroupTxn(proj, obs);
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
    case 'pre-compact':      await handlePreCompactDispatch(); break;
    case 'stop':             await handleStop(); break;
    case 'user-prompt':      await handleUserPrompt(); break;
    case 'llm-episode':      await handleLLMEpisode(); break;
    case 'llm-summary':      await handleLLMSummary(); break;
    case 'auto-compress':    handleAutoCompress(); break;
    case 'llm-optimize':   await handleLLMOptimize(); break;
    // Detached update refresh spawned by handleSessionStart (audit P3d) — does the
    // GitHub fetch + (non-plugin) install off the SessionStart critical path,
    // writing update-state.json so the NEXT session's cached banner is fresh.
    case 'update-check':     await checkForUpdate(); break;
  }
} catch (err) {
  // Log fatal errors (ungated) with structured format. ERR_DLOPEN_FAILED (an
  // unloadable native DB binding, e.g. ABI-stale after a Node upgrade) is
  // collapsed to one short, rate-limited rebuild hint instead of the raw
  // multi-line NODE_MODULE_VERSION message on every fire — see
  // lib/native-binding-hint.mjs.
  const line = formatHookError(err, event, { runtimeDir: RUNTIME_DIR });
  if (line) console.error(line);
}

process.exit(0);
