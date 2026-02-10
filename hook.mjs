#!/usr/bin/env node
// claude-mem-lite Hook v2 — Cognitive memory architecture
// Selective encoding, episodic batching, error-triggered recall
// Hooks (fast <100ms): post-tool-use, session-start, stop
// Background workers (slow): llm-episode, llm-summary

import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join, basename } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, readdirSync, writeSync, statSync, renameSync, constants as fsConstants } from 'fs';
import {
  jaccardSimilarity, truncate, typeIcon, clampImportance, computeRuleImportance,
  inferProject, detectBashSignificance, extractErrorKeywords, extractFilePaths,
  parseJsonFromLLM, isRelatedToEpisode, makeEntryDesc, scrubSecrets,
  estimateTokens, computeMinHash, estimateJaccardFromMinHash, debugCatch,
  fmtTime,
} from './utils.mjs';
import { ensureDb, DB_DIR } from './schema.mjs';

// Prevent recursive hooks from background claude -p calls
// Background workers (llm-episode, llm-summary) are exempt — they're ours
const event = process.argv[2];
const BG_EVENTS = new Set(['llm-episode', 'llm-summary']);
if (process.env.CLAUDE_MEM_HOOK_RUNNING && !BG_EVENTS.has(event)) process.exit(0);

const RUNTIME_DIR = join(DB_DIR, 'runtime');
const SCRIPT_PATH = process.argv[1];

// Ensure runtime directory exists
try { if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}

// Crash-safe: flush episode buffer on unexpected termination to prevent data loss
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try {
      const ep = readEpisodeRaw();
      if (ep && ep.entries && ep.entries.length > 0) {
        const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
        writeFileSync(flushFile, JSON.stringify(ep));
        try { unlinkSync(join(RUNTIME_DIR, `ep-${inferProject()}.json`)); } catch {}
      }
    } catch {}
    process.exit(0);
  });
}

// Raw episode read (no lock needed, for signal handlers only)
function readEpisodeRaw() {
  try {
    return JSON.parse(readFileSync(join(RUNTIME_DIR, `ep-${inferProject()}.json`), 'utf8'));
  } catch { return null; }
}

if (!event) process.exit(0);

// ─── Session ID Management (Tier 1 A) ──────────────────────────────────────

function inferProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

// inferProject imported from utils.mjs

function sessionFile() {
  return join(RUNTIME_DIR, `session-${inferProject()}`);
}

function getSessionId() {
  try {
    const data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (Date.now() - data.startedAt < 12 * 60 * 60 * 1000) return data.id;
  } catch {}
  // Fallback: create a new one (shouldn't happen if SessionStart ran)
  return createSessionId();
}

function createSessionId() {
  const project = inferProject();
  const id = `hook-${project}-${randomUUID().slice(0, 8)}`;
  writeFileSync(sessionFile(), JSON.stringify({ id, startedAt: Date.now(), project }));
  return id;
}

// ─── Database ───────────────────────────────────────────────────────────────

function openDb() {
  try {
    return ensureDb();
  } catch {
    return null;
  }
}

// ─── LLM via claude CLI ────────────────────────────────────────────────────

function getClaudePath() {
  try {
    const s = JSON.parse(readFileSync(join(DB_DIR, 'settings.json'), 'utf8'));
    if (s.CLAUDE_CODE_PATH) return s.CLAUDE_CODE_PATH;
  } catch {}
  return process.env.CLAUDE_CODE_PATH || 'claude';
}

function callLLM(prompt, timeoutMs = 15000) {
  try {
    const result = execFileSync(getClaudePath(), ['-p', '--model', 'haiku'], {
      input: prompt,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e) {
    const out = e.stdout?.toString?.()?.trim() || e.output?.[1]?.toString?.()?.trim();
    if (out) return out;
    return null;
  }
}

// parseJsonFromLLM imported from utils.mjs

// ─── LLM Concurrency Semaphore (max 2 concurrent claude -p calls) ────────────

const LLM_SEM_MAX = 2;
const LLM_SEM_TIMEOUT = 30000; // 30s max wait
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

async function acquireLLMSlot() {
  const deadline = Date.now() + LLM_SEM_TIMEOUT;
  const slotFile = join(RUNTIME_DIR, `llm-sem-${process.pid}`);

  while (Date.now() < deadline) {
    // Acquire-then-verify: atomically create our slot first, then check total count
    let created = false;
    try {
      let fd;
      try {
        fd = openSync(slotFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
        writeSync(fd, payload);
        created = true;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    } catch {
      // Slot file already exists for this PID — update timestamp
      try { writeFileSync(slotFile, JSON.stringify({ pid: process.pid, ts: Date.now() })); created = true; } catch {}
    }

    if (!created) { await sleepMs(200 + Math.random() * 800); continue; }

    // Count all active semaphore files (including ours) and clean stale ones
    let active = 0;
    try {
      for (const f of readdirSync(RUNTIME_DIR)) {
        if (!f.startsWith('llm-sem-')) continue;
        const fp = join(RUNTIME_DIR, f);
        try {
          const raw = readFileSync(fp, 'utf8');
          const info = JSON.parse(raw);
          const age = Date.now() - (info.ts || 0);
          if (age > 60000) {
            try { unlinkSync(fp); } catch {}
            continue;
          }
          if (info.pid) {
            try { process.kill(info.pid, 0); active++; } catch {
              try { unlinkSync(fp); } catch {}
            }
          } else {
            active++;
          }
        } catch {
          active++;
        }
      }
    } catch {}

    if (active <= LLM_SEM_MAX) return true; // Slot acquired

    // Too many concurrent — release our slot and back off
    try { unlinkSync(slotFile); } catch {}
    await sleepMs(200 + Math.random() * 800);
  }
  return false; // Timed out
}

function releaseLLMSlot() {
  try { unlinkSync(join(RUNTIME_DIR, `llm-sem-${process.pid}`)); } catch {}
}

// ─── Background Spawner ────────────────────────────────────────────────────

function spawnBackground(bgEvent, ...extraArgs) {
  const args = [SCRIPT_PATH, bgEvent, ...extraArgs];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
  });
  // Reap child on exit to prevent zombie processes
  child.on('exit', () => {});
  child.unref();
}

// ─── Episode Buffer (Tier 2 F) ─────────────────────────────────────────────

function episodeFile() {
  return join(RUNTIME_DIR, `ep-${inferProject()}.json`);
}

function lockFile() {
  return episodeFile() + '.lock';
}

function acquireLock(maxWaitMs = 500) {
  const lf = lockFile();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      let fd;
      try {
        fd = openSync(lf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
        writeSync(fd, payload);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      return true;
    } catch {
      // Lock exists — check if stale or orphaned
      try {
        const raw = readFileSync(lf, 'utf8');
        const info = JSON.parse(raw);
        const age = Date.now() - (info.ts || 0);
        let stale = age > 30000; // >30s = stale
        if (!stale && info.pid) {
          try { process.kill(info.pid, 0); } catch { stale = true; } // PID dead = orphan
        }
        if (stale) { try { unlinkSync(lf); } catch {} continue; }
      } catch {
        // Can't read lock — try removing if old by mtime
        try {
          const st = statSync(lf);
          if (Date.now() - st.mtimeMs > 30000) { try { unlinkSync(lf); } catch {} continue; }
        } catch {}
      }
      const wait = Math.ceil(Math.random() * 20);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  return false;
}

function releaseLock() {
  try { unlinkSync(lockFile()); } catch {}
}

function readEpisode() {
  try {
    return JSON.parse(readFileSync(episodeFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writeEpisode(episode) {
  const target = episodeFile();
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(episode));
  renameSync(tmp, target);
}

function createEpisode(sessionId, project) {
  return {
    sessionId,
    project,
    startedAt: Date.now(),
    lastAt: Date.now(),
    files: [],
    entries: [],
    filesRead: [],
    fileHistoryShown: [],
  };
}

function addFileToEpisode(episode, files) {
  for (const f of files) {
    if (!episode.files.includes(f)) episode.files.push(f);
  }
}

// ─── Pending Entry Recovery (concurrency safety) ────────────────────────────

function writePendingEntry(entry, sessionId, project) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const pendingFile = join(RUNTIME_DIR, `pending-${ts}-${rand}.json`);
  const tmp = pendingFile + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify({ entry, sessionId, project, ts }));
    renameSync(tmp, pendingFile);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

function mergePendingEntries(episode) {
  const oneHourAgo = Date.now() - 3600000;
  let files;
  try {
    files = readdirSync(RUNTIME_DIR).filter(f => f.startsWith('pending-')).sort();
  } catch { return; }

  for (const f of files) {
    const fp = join(RUNTIME_DIR, f);
    try {
      const raw = readFileSync(fp, 'utf8');
      const pending = JSON.parse(raw);
      if (pending.ts < oneHourAgo) { try { unlinkSync(fp); } catch {} continue; }
      // Only merge entries belonging to the same project
      if (pending.project && episode.project && pending.project !== episode.project) continue;
      unlinkSync(fp);
      if (pending.entry) {
        episode.entries.push(pending.entry);
        episode.lastAt = Math.max(episode.lastAt, pending.entry.ts || pending.ts);
        addFileToEpisode(episode, pending.entry.files || []);
      }
    } catch {
      // Corrupt pending file — remove
      try { unlinkSync(fp); } catch {}
    }
  }
}

// isRelatedToEpisode imported from utils.mjs

function episodeHasSignificantContent(episode) {
  return episode.entries.some(e =>
    ['Edit', 'Write', 'NotebookEdit'].includes(e.tool) ||
    (e.tool === 'Bash' && e.isError)
  );
}

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
  const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
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
      if (process.env.CLAUDE_MEM_DEBUG) console.error(`[claude-mem-lite] stdin truncated at 256KB, attempting salvage`);
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
      const bufferFull = episode.entries.length >= 10;
      const timeGap = timeSinceLastEntry > 5 * 60 * 1000;

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

// extractErrorKeywords, detectBashSignificance, computeRuleImportance, clampImportance imported from utils.mjs

// ─── Background: LLM Episode Extraction (Tier 2 F) ─────────────────────────

async function handleLLMEpisode() {
  const tmpFile = process.argv[3];
  if (!tmpFile) return;

  let episode;
  try {
    episode = JSON.parse(readFileSync(tmpFile, 'utf8'));
  } catch {
    // Can't read flush file — delete it to unblock handleLLMSummary polling
    try { unlinkSync(tmpFile); } catch {}
    return;
  }

  if (!episode.entries || episode.entries.length === 0) {
    try { unlinkSync(tmpFile); } catch {}
    return;
  }

  // Rate-limit background LLM calls to avoid competing with active sessions
  // Skip delay in test mode for deterministic timing
  if (!process.env.CLAUDE_MEM_NO_DELAY) {
    const sessionActive = existsSync(sessionFile());
    const delayMs = sessionActive
      ? 2000 + Math.random() * 3000   // 2-5s when user session is active
      : 500 + Math.random() * 1000;   // 0.5-1.5s after session ends
    if (process.env.CLAUDE_MEM_DEBUG) console.error(`[claude-mem-lite] llm-episode delay: ${Math.round(delayMs)}ms (session ${sessionActive ? 'active' : 'ended'})`);
    await sleep(delayMs);
  }

  const fileList = episode.files.map(f => basename(f)).join(', ') || '(multiple)';

  let prompt;
  if (episode.entries.length === 1) {
    // Single entry: extract as individual observation
    const e = episode.entries[0];
    prompt = `Extract a structured observation from this code change. Return ONLY valid JSON, no markdown fences.

Tool: ${e.tool}
File: ${episode.files.join(', ') || 'unknown'}
Action: ${e.desc}
Error: ${e.isError ? 'yes' : 'no'}

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"concise ≤80 char description","narrative":"what changed, why, and outcome (2-3 sentences)","concepts":["kw1","kw2"],"facts":["fact1","fact2"],"importance":1}
Facts: each MUST be (1) atomic—one claim, (2) self-contained—no pronouns, include file/function name, (3) specific—"refreshToken() in auth.ts:45 uses 1h TTL" not "handles tokens"
importance: 1=routine, 2=notable (error fix, arch decision, config change), 3=critical (breaking change, security fix, data migration)`;
  } else {
    // Multiple entries: batch episode summary
    const actionList = episode.entries.map((e, i) =>
      `${i + 1}. [${e.tool}] ${e.desc}${e.isError ? ' (ERROR)' : ''}`
    ).join('\n');

    prompt = `Summarize this coding episode as ONE coherent observation. Return ONLY valid JSON, no markdown fences.

Project: ${episode.project}
Files: ${fileList}
Actions (${episode.entries.length} total):
${actionList}

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"coherent ≤80 char summary","narrative":"what was done, why, and outcome (3-5 sentences)","concepts":["keyword1","keyword2"],"facts":["specific fact 1","specific fact 2"],"importance":1}
Facts: each MUST be (1) atomic—one claim, (2) self-contained—no pronouns, include file/function name, (3) specific—"refreshToken() in auth.ts:45 uses 1h TTL" not "handles tokens"
importance: 1=routine, 2=notable (error fix, arch decision, config change), 3=critical (breaking change, security fix, data migration)`;
  }

  // Compute deterministic importance from rules before LLM call
  const ruleImportance = computeRuleImportance(episode);

  let obs;
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

  // Acquire LLM semaphore to limit concurrent claude -p calls
  const gotSlot = await acquireLLMSlot();
  if (gotSlot) {
    let raw, parsed;
    try {
      raw = callLLM(prompt);
      parsed = parseJsonFromLLM(raw);
    } finally {
      releaseLLMSlot();
    }

    if (parsed && parsed.title) {
      obs = {
        type: validTypes.has(parsed.type) ? parsed.type : 'change',
        title: truncate(parsed.title, 120),
        subtitle: fileList,
        narrative: truncate(parsed.narrative || '', 500),
        concepts: Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [],
        facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [],
        files: episode.files,
        filesRead: episode.filesRead || [],
        importance: Math.max(ruleImportance, clampImportance(parsed.importance)),
      };
    }
  }

  if (!obs) {
    // Degraded storage: LLM unavailable or failed, but never lose data
    if (!gotSlot && process.env.CLAUDE_MEM_DEBUG) console.error('[claude-mem-lite] llm-episode: semaphore timeout, using degraded storage');
    const hasError = episode.entries.some(e => e.isError);
    const hasEdit = episode.entries.some(e => ['Edit', 'Write', 'NotebookEdit'].includes(e.tool));
    const inferredType = hasError ? 'bugfix' : hasEdit ? 'change' : 'discovery';
    const firstDesc = episode.entries[0]?.desc || '(no description)';
    obs = {
      type: inferredType,
      title: truncate(firstDesc, 120),
      subtitle: fileList,
      narrative: episode.entries.map(e => e.desc).join('; '),
      concepts: [],
      facts: [],
      files: episode.files,
      filesRead: episode.filesRead || [],
      importance: ruleImportance,
    };
  }

  // Single DB connection for save + related linking (avoids double open/close)
  const db = openDb();
  if (!db) { try { unlinkSync(tmpFile); } catch {} return; }

  try {
    const savedId = saveObservation(obs, episode.project, episode.sessionId, db);

    // Link related observations via FTS5 semantic matching + file overlap (cross-session)
    if (savedId) {
      try {
        const newObs = db.prepare(`
          SELECT id, title, files_modified, related_ids FROM observations WHERE id = ?
        `).get(savedId);
        if (!newObs) return;

        const candidates = new Set();

        // Strategy 1: FTS5 title similarity (cross-session)
        if (obs.title) {
          const titleTokens = obs.title.replace(/[^a-zA-Z0-9_\s-]/g, ' ').split(/\s+/)
            .filter(t => t.length > 2).slice(0, 5);
          if (titleTokens.length > 0) {
            const ftsQuery = titleTokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
            try {
              const ftsMatches = db.prepare(`
                SELECT o.id FROM observations_fts
                JOIN observations o ON observations_fts.rowid = o.id
                WHERE observations_fts MATCH ? AND o.id != ? AND o.project = ?
                ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2)
                LIMIT 5
              `).all(ftsQuery, newObs.id, episode.project);
              for (const m of ftsMatches) candidates.add(m.id);
            } catch {}
          }
        }

        // Strategy 2: file overlap (any session, recent observations)
        let newFiles;
        try { newFiles = JSON.parse(newObs.files_modified || '[]'); } catch { newFiles = []; }
        if (newFiles.length > 0) {
          const recentObs = db.prepare(`
            SELECT id, files_modified FROM observations
            WHERE id != ? AND created_at_epoch > ? AND project = ?
            ORDER BY created_at_epoch DESC LIMIT 50
          `).all(newObs.id, Date.now() - 7 * 86400000, episode.project);
          for (const r of recentObs) {
            let rFiles;
            try { rFiles = JSON.parse(r.files_modified || '[]'); } catch { rFiles = []; }
            if (rFiles.some(f => newFiles.includes(f))) candidates.add(r.id);
          }
        }

        // Apply bidirectional links (max 5 related)
        if (candidates.size > 0) {
          let newRelated;
          try { newRelated = JSON.parse(newObs.related_ids || '[]'); } catch { newRelated = []; }

          for (const relId of [...candidates].slice(0, 5)) {
            if (newRelated.includes(relId)) continue;
            newRelated.push(relId);

            // Add reverse link
            const rel = db.prepare('SELECT related_ids FROM observations WHERE id = ?').get(relId);
            if (rel) {
              let relRelated;
              try { relRelated = JSON.parse(rel.related_ids || '[]'); } catch { relRelated = []; }
              if (!relRelated.includes(newObs.id)) {
                relRelated.push(newObs.id);
                db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(relRelated.slice(-10)), relId);
              }
            }
          }

          db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(newRelated.slice(-10)), newObs.id);
        }
      } catch (e) { debugCatch(e, 'relatedObsLinking'); }
    }
  } finally {
    db.close();
  }

  // Delete flush file AFTER all DB writes — signals completion to handleLLMSummary
  try { unlinkSync(tmpFile); } catch {}
}

// ─── Background: LLM Session Summary ────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleLLMSummary() {
  // Poll for llm-episode flush files to be processed (instead of fixed 20s wait)
  // llm-episode reads and deletes ep-flush-*.json files when done
  const parsed = parseInt(process.env.CLAUDE_MEM_FLUSH_TIMEOUT, 10);
  const flushTimeout = Number.isNaN(parsed) ? 15 : parsed;
  for (let i = 0; i < flushTimeout; i++) {
    try {
      const files = readdirSync(RUNTIME_DIR).filter(f => f.startsWith('ep-flush-'));
      if (files.length === 0) break; // All episodes processed
    } catch { break; }
    if (process.env.CLAUDE_MEM_DEBUG) console.error(`[claude-mem-lite] llm-summary waiting for flush files (${i + 1}/15)`);
    await sleep(1000);
  }

  const db = openDb();
  if (!db) return;

  try {
    // Session ID and project passed as args from handleStop
    const sessionId = process.argv[3] || getSessionId();
    const project = process.argv[4] || inferProject();

    // Flush file polling above guarantees all llm-episode DB writes are complete
    const recentObs = db.prepare(`
      SELECT id, type, title, narrative
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 30
    `).all(sessionId);

    if (recentObs.length < 1) return;

    const obsList = recentObs.map((o, i) =>
      `${i + 1}. [${o.type}] ${o.title}${o.narrative ? ': ' + truncate(o.narrative, 80) : ''}`
    ).join('\n');

    const prompt = `Summarize this coding session. Return ONLY valid JSON, no markdown fences.

Project: ${project}
Observations (${recentObs.length} total):
${obsList}

JSON: {"request":"what the user was working on","investigated":"what was explored/analyzed","learned":"key findings","completed":"what was accomplished","next_steps":"suggested follow-up"}`;

    // Acquire LLM semaphore
    if (!(await acquireLLMSlot())) {
      if (process.env.CLAUDE_MEM_DEBUG) console.error('[claude-mem-lite] llm-summary: semaphore timeout, skipping summary');
      return;
    }

    let raw, parsed;
    try {
      raw = callLLM(prompt, 20000);
      parsed = parseJsonFromLLM(raw);
    } finally {
      releaseLLMSlot();
    }

    if (parsed && parsed.request) {
      const now = new Date();
      db.prepare(`
        INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '', ?, ?)
      `).run(
        sessionId, project,
        parsed.request || '', parsed.investigated || '', parsed.learned || '',
        parsed.completed || '', parsed.next_steps || '',
        now.toISOString(), now.getTime()
      );
    }
  } finally {
    db.close();
  }
}

// ─── Stop Handler ───────────────────────────────────────────────────────────

function handleStop() {
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
      const episode = JSON.parse(readFileSync(claimFile, 'utf8'));
      if (episode && episode.entries && episode.entries.length > 0 && episodeHasSignificantContent(episode)) {
        if (!episode.sessionId) episode.sessionId = sessionId;
        if (!episode.project) episode.project = project;
        const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
        writeFileSync(flushFile, JSON.stringify(episode));
        spawnBackground('llm-episode', flushFile);
      }
      try { unlinkSync(claimFile); } catch {}
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

  // Spawn background for session summary (pass sessionId and project)
  spawnBackground('llm-summary', sessionId, project);

  // Clean session file AFTER spawning background
  try { unlinkSync(sessionFile()); } catch {}
}

// ─── Adaptive Time Windows ───────────────────────────────────────────────────
// Adjusts recall windows based on project activity velocity:
// High activity → shorter windows (recent data more relevant)
// Low activity → longer windows (older data stays relevant)

function computeAdaptiveWindows(db, project) {
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM observations
    WHERE project = ? AND created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0
  `).get(project, sevenDaysAgo);
  const velocity = (row?.c || 0) / 7; // observations per day

  if (velocity > 10) {
    // High velocity: tighter windows, focus on very recent
    return { tier1: 12 * 3600000, tier2: 3 * 86400000, tier3: 14 * 86400000, sessWindow: 3 * 86400000 };
  } else if (velocity >= 3) {
    // Medium velocity: default windows
    return { tier1: 24 * 3600000, tier2: 7 * 86400000, tier3: 30 * 86400000, sessWindow: 7 * 86400000 };
  } else {
    // Low velocity: wider windows, older data still relevant
    return { tier1: 48 * 3600000, tier2: 14 * 86400000, tier3: 60 * 86400000, sessWindow: 14 * 86400000 };
  }
}

// ─── Token Budget Optimizer ──────────────────────────────────────────────────

function selectWithTokenBudget(db, project, budget = 2000) {
  const now_ms = Date.now();
  const windows = computeAdaptiveWindows(db, project);
  const tier1Ago = now_ms - windows.tier1;
  const tier2Ago = now_ms - windows.tier2;
  const tier3Ago = now_ms - windows.tier3;

  // Candidate pool: tiered time windows by importance (adaptive)
  const obsPool = db.prepare(`
    SELECT id, type, title, narrative, importance, created_at_epoch, files_modified
    FROM observations
    WHERE project = ? AND COALESCE(compressed_into, 0) = 0
      AND (
        (created_at_epoch > ? AND importance >= 1)
        OR (created_at_epoch > ? AND importance >= 2)
        OR (created_at_epoch > ? AND importance >= 3)
      )
    ORDER BY created_at_epoch DESC
    LIMIT 50
  `).all(project, tier1Ago, tier2Ago, tier3Ago);

  const sessPool = db.prepare(`
    SELECT id, request, completed, next_steps, created_at_epoch
    FROM session_summaries
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC
    LIMIT 10
  `).all(project, now_ms - windows.sessWindow);

  const now = Date.now();
  const selectedObs = [];
  const selectedSess = [];
  let totalTokens = 0;

  // Score each candidate: value = recency * importance, cost = tokens
  const scoredObs = obsPool.map(o => {
    const ageDays = (now - o.created_at_epoch) / 86400000;
    const recency = 1 / (1 + ageDays);
    const impBoost = 0.5 + 0.5 * (o.importance || 1);
    const value = recency * impBoost;
    const cost = estimateTokens((o.title || '') + (o.narrative || ''));
    return { ...o, value, cost, valueDensity: cost > 0 ? value / Math.sqrt(cost) : 0 };
  });

  const scoredSess = sessPool.map(s => {
    const ageDays = (now - s.created_at_epoch) / 86400000;
    const recency = 1 / (1 + ageDays);
    const value = recency * 1.5; // Session summaries slightly boosted
    const cost = estimateTokens((s.request || '') + (s.completed || '') + (s.next_steps || ''));
    return { ...s, value, cost, valueDensity: cost > 0 ? value / Math.sqrt(cost) : 0 };
  });

  // Combine and sort by value density (greedy knapsack)
  const allCandidates = [
    ...scoredObs.map(o => ({ ...o, _kind: 'obs' })),
    ...scoredSess.map(s => ({ ...s, _kind: 'sess' })),
  ].sort((a, b) => b.valueDensity - a.valueDensity);

  const selectedFiles = new Set();

  for (const c of allCandidates) {
    if (totalTokens + c.cost > budget) continue;

    // Diversity penalty: reduce value for file overlap with already-selected
    if (c._kind === 'obs' && c.files_modified) {
      let cFiles;
      try { cFiles = JSON.parse(c.files_modified || '[]'); } catch { cFiles = []; }
      if (cFiles.length > 0 && selectedFiles.size > 0) {
        const overlap = cFiles.filter(f => selectedFiles.has(f)).length;
        const overlapRatio = overlap / cFiles.length;
        const penalizedValue = c.valueDensity * (1 - 0.3 * overlapRatio);
        if (penalizedValue < 0.001) continue; // Skip if too redundant
      }
      for (const f of cFiles) selectedFiles.add(f);
    }

    totalTokens += c.cost;
    if (c._kind === 'obs') {
      selectedObs.push({ id: c.id, type: c.type, title: c.title, created_at: new Date(c.created_at_epoch).toISOString() });
    } else {
      selectedSess.push({ id: c.id, request: c.request, completed: c.completed, next_steps: c.next_steps, created_at: new Date(c.created_at_epoch).toISOString() });
    }
  }

  return { observations: selectedObs, summaries: selectedSess, totalTokens };
}

// ─── SessionStart Handler + CLAUDE.md Persistence (Tier 1 A, E) ─────────────

function handleSessionStart() {
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
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
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
          let stale = age > 30000;
          if (!stale && info.pid) {
            try { process.kill(info.pid, 0); } catch { stale = true; }
          }
          if (stale) unlinkSync(lp);
        } catch {
          // Unreadable lock — check mtime
          try {
            const st = statSync(lp);
            if (Date.now() - st.mtimeMs > 30000) unlinkSync(lp);
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
      const fbSevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
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

  } finally {
    db.close();
  }
}

// ─── CLAUDE.md Persistence (Tier 1 E) ──────────────────────────────────────

function updateClaudeMd(contextBlock) {
  const claudeMdPath = join(inferProjectDir(), 'CLAUDE.md');
  let content = '';
  try { content = readFileSync(claudeMdPath, 'utf8'); } catch {}

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';
  const hintComment = '<!-- claude-mem-lite: auto-updated context. To avoid git noise, add CLAUDE.md to .gitignore -->';
  const newSection = `${startTag}\n${contextBlock}\n${endTag}`;

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section in-place — preserves surrounding content (including hint if present)
    content = content.slice(0, startIdx) + newSection + content.slice(endIdx + endTag.length);
  } else if (content.length > 0) {
    // Append to end — never disturb existing CLAUDE.md structure
    const hint = content.includes(hintComment) ? '' : hintComment + '\n';
    content = content.trimEnd() + '\n\n' + hint + newSection + '\n';
  } else {
    content = hintComment + '\n' + newSection + '\n';
  }

  try {
    const tmp = claudeMdPath + '.mem-tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, claudeMdPath);
  } catch (e) {
    if (process.env.CLAUDE_MEM_DEBUG) console.error(`[claude-mem-lite] CLAUDE.md write failed: ${e.message}`);
  }
}

// ─── Save Observation to DB ─────────────────────────────────────────────────

function saveObservation(obs, projectOverride, sessionIdOverride, externalDb) {
  const db = externalDb || openDb();
  if (!db) return null;

  try {
    const now = new Date();
    const project = projectOverride || inferProject();
    const sessionId = sessionIdOverride || getSessionId();

    // INSERT OR IGNORE avoids race condition on concurrent calls
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // Two-tier dedup
    // Tier 1 (fast): 5-min Jaccard on titles (existing logic)
    const fiveMinAgo = now.getTime() - 5 * 60 * 1000;
    const recent = db.prepare(`
      SELECT title FROM observations
      WHERE project = ? AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC LIMIT 10
    `).all(project, fiveMinAgo);

    if (obs.title && recent.some(r => jaccardSimilarity(r.title, obs.title) > 0.7)) {
      return null; // Duplicate — skip
    }

    // Tier 2 (slow): MinHash cross-session dedup (7-day window)
    const minhashSig = computeMinHash((obs.title || '') + ' ' + (obs.narrative || ''));
    if (minhashSig) {
      const sevenDaysAgo = now.getTime() - 7 * 86400000;
      const recentSigs = db.prepare(`
        SELECT minhash_sig FROM observations
        WHERE project = ? AND created_at_epoch > ? AND minhash_sig IS NOT NULL
        ORDER BY created_at_epoch DESC LIMIT 100
      `).all(project, sevenDaysAgo);

      if (recentSigs.some(r => estimateJaccardFromMinHash(minhashSig, r.minhash_sig) > 0.8)) {
        return null; // Cross-session duplicate — skip
      }
    }

    // text: expanded concepts+facts as plain text (distinct from narrative for better FTS coverage)
    // concepts/facts: space-separated plain text (not JSON arrays) for clean FTS matching
    const conceptsText = Array.isArray(obs.concepts) ? obs.concepts.join(' ') : '';
    const factsText = Array.isArray(obs.facts) ? obs.facts.join(' ') : '';
    const textField = [conceptsText, factsText].filter(Boolean).join(' ');

    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, project,
      textField, obs.type, obs.title, obs.subtitle || '',
      obs.narrative || '',
      conceptsText,
      factsText,
      JSON.stringify(obs.filesRead || []),
      JSON.stringify(obs.files || []),
      obs.importance ?? 1,
      minhashSig,
      now.toISOString(), now.getTime()
    );
    return Number(result.lastInsertRowid);
  } finally {
    if (!externalDb) db.close();
  }
}

// makeEntryDesc, extractFilePaths, jaccardSimilarity imported from utils.mjs

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

// typeIcon, truncate, fmtTime, etc. imported from utils.mjs

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

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  switch (event) {
    case 'post-tool-use':    await handlePostToolUse(); break;
    case 'session-start':    handleSessionStart(); break;
    case 'stop':             handleStop(); break;
    case 'user-prompt':      await handleUserPrompt(); break;
    case 'llm-episode':      await handleLLMEpisode(); break;
    case 'llm-summary':      await handleLLMSummary(); break;
  }
} catch (err) {
  if (process.env.CLAUDE_MEM_DEBUG) {
    console.error(`[claude-mem-lite] ${event} error:`, err.message);
  }
}

process.exit(0);
