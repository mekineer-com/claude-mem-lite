#!/usr/bin/env node
// claude-mem-lite Hook v2 — Cognitive memory architecture
// Selective encoding, episodic batching, error-triggered recall
// Hooks (fast <100ms): post-tool-use, session-start, stop
// Background workers (slow): llm-episode, llm-summary

import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, constants as fsConstants } from 'fs';

// Prevent recursive hooks from background claude -p calls
// Background workers (llm-episode, llm-summary) are exempt — they're ours
const event = process.argv[2];
const BG_EVENTS = new Set(['llm-episode', 'llm-summary']);
if (process.env.CLAUDE_MEM_HOOK_RUNNING && !BG_EVENTS.has(event)) process.exit(0);

const DB_DIR = join(homedir(), 'claude-mem-lite');
const DB_PATH = join(DB_DIR, 'claude-mem.db');
const RUNTIME_DIR = join(DB_DIR, 'runtime');
const SCRIPT_PATH = process.argv[1];

// Ensure runtime directory exists
try { if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}

if (!event) process.exit(0);

// ─── Session ID Management (Tier 1 A) ──────────────────────────────────────

function inferProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

function inferProject() {
  return basename(inferProjectDir());
}

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
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('synchronous = NORMAL');
  return db;
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

function parseJsonFromLLM(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) try { return JSON.parse(obj[0]); } catch {}
  return null;
}

// ─── Background Spawner ────────────────────────────────────────────────────

function spawnBackground(bgEvent, ...extraArgs) {
  const args = [SCRIPT_PATH, bgEvent, ...extraArgs];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
  });
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
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockFile(), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      closeSync(fd);
      return true;
    } catch {
      // Lock held by another process — spin briefly
      const wait = Math.ceil(Math.random() * 20);
      const start = Date.now();
      while (Date.now() - start < wait) { /* spin */ }
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
  writeFileSync(episodeFile(), JSON.stringify(episode));
}

function createEpisode(sessionId, project) {
  return {
    sessionId,
    project,
    startedAt: Date.now(),
    lastAt: Date.now(),
    files: [],
    entries: [],
  };
}

function addFileToEpisode(episode, files) {
  for (const f of files) {
    if (!episode.files.includes(f)) episode.files.push(f);
  }
}

function isRelatedToEpisode(episode, newFiles) {
  // No files (Bash, Grep without file context) → always related
  if (newFiles.length === 0) return true;
  if (episode.files.length === 0) return true;
  // Check file or directory overlap
  for (const nf of newFiles) {
    for (const ef of episode.files) {
      if (nf === ef) return true;
      if (dirname(nf) === dirname(ef)) return true;
    }
  }
  return false;
}

function episodeHasSignificantContent(episode) {
  return episode.entries.some(e =>
    ['Edit', 'Write', 'NotebookEdit'].includes(e.tool) ||
    (e.tool === 'Bash' && e.isError)
  );
}

function flushEpisode(episode) {
  if (!episode || episode.entries.length === 0) return;

  // Rename current buffer to prevent race conditions
  const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  try {
    writeFileSync(flushFile, JSON.stringify(episode));
    try { unlinkSync(episodeFile()); } catch {}
  } catch {
    return;
  }

  if (episodeHasSignificantContent(episode)) {
    spawnBackground('llm-episode', flushFile);
  } else {
    try { unlinkSync(flushFile); } catch {}
  }
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
  let input = '';
  try { input = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(input); } catch { return; }

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

  // Tier 2 G: Error-triggered recall
  if (bashSig?.isError) {
    triggerErrorRecall(toolInput, resp);
  }

  // Build episode entry
  const entry = {
    tool: tool_name,
    desc: makeEntryDesc(tool_name, toolInput, resp),
    files,
    ts: Date.now(),
    isError: bashSig?.isError || false,
    isSignificant: ['Edit', 'Write', 'NotebookEdit'].includes(tool_name) ||
                   bashSig?.isSignificant || false,
  };

  // Episode buffer management (locked to prevent TOCTOU race)
  const sessionId = getSessionId();
  const project = inferProject();

  if (!acquireLock()) return; // Another hook is writing — skip this entry
  try {
    let episode = readEpisode();

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
    }

    episode.entries.push(entry);
    episode.lastAt = Date.now();
    addFileToEpisode(episode, files);
    writeEpisode(episode);
  } finally {
    releaseLock();
  }
}

// ─── Error-Triggered Recall (Tier 2 G) ─────────────────────────────────────

function triggerErrorRecall(toolInput, response) {
  const db = openDb();
  if (!db) return;

  try {
    // Extract error keywords
    const cmd = toolInput.command || '';
    const keywords = extractErrorKeywords(cmd, response);
    if (!keywords || keywords.length === 0) return;

    // FTS5 OR query for broader recall
    const ftsQuery = keywords.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    if (!ftsQuery) return;

    const rows = db.prepare(`
      SELECT o.id, o.type, o.title
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
      ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2)
      LIMIT 3
    `).all(ftsQuery);

    if (rows.length > 0) {
      const hints = rows.map(r => `  #${r.id} [${r.type}] ${truncate(r.title, 60)}`).join('\n');
      process.stdout.write(`[claude-mem] Related memories found for this error:\n${hints}\n  → Use mem_get(ids=[${rows.map(r => r.id).join(',')}]) for details.\n`);
    }
  } catch {} finally {
    db.close();
  }
}

function extractErrorKeywords(cmd, response) {
  const STOP_WORDS = new Set([
    'error', 'failed', 'cannot', 'could', 'with', 'from', 'that', 'this',
    'have', 'been', 'were', 'does', 'will', 'would', 'should', 'must',
    'true', 'false', 'null', 'undefined', 'function', 'return', 'const',
    'node', 'require', 'stack', 'trace',
  ]);
  const words = new Set();
  // Extract meaningful tokens from command
  const cmdParts = cmd.split(/[\s/\\|&;]+/).filter(w => w.length > 2 && !/^-/.test(w));
  for (const w of cmdParts.slice(0, 3)) {
    const lw = w.toLowerCase();
    if (!STOP_WORDS.has(lw)) words.add(lw);
  }
  // Extract error-specific tokens from response
  const errLines = response.split('\n').filter(l =>
    /error|fail|exception|cannot|not found|undefined|null/i.test(l)
  ).slice(0, 3);
  for (const line of errLines) {
    const tokens = line.replace(/[^a-zA-Z0-9_.-]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !/^\d+$/.test(w));
    for (const t of tokens.slice(0, 5)) {
      const lt = t.toLowerCase();
      if (!STOP_WORDS.has(lt)) words.add(lt);
    }
  }
  const result = [...words].slice(0, 6);
  return result.length >= 1 ? result : null;
}

// ─── Bash Significance Detection (Tier 1 B) ────────────────────────────────

function detectBashSignificance(input, response) {
  const cmd = (input.command || '').toLowerCase();
  const isError = /\berror\b|fail(ed|ure)?|exception|panic|traceback|errno|enoent|command not found/i.test(response)
    && response.length > 30;
  const isTest = /\b(test|jest|pytest|vitest|mocha|spec|cypress|playwright)\b/i.test(cmd);
  const isBuild = /\b(build|compile|tsc|webpack|vite|rollup|esbuild|make|cargo)\b/i.test(cmd);
  const isGit = /\bgit\s+(commit|merge|rebase|cherry-pick|push)\b/i.test(cmd);
  const isDeploy = /\b(deploy|docker|kubectl|terraform)\b/i.test(cmd);
  return {
    isError, isTest, isBuild, isGit, isDeploy,
    isSignificant: isError || isTest || isBuild || isGit || isDeploy,
  };
}

// ─── Background: LLM Episode Extraction (Tier 2 F) ─────────────────────────

async function handleLLMEpisode() {
  const tmpFile = process.argv[3];
  if (!tmpFile) return;

  let episode;
  try {
    episode = JSON.parse(readFileSync(tmpFile, 'utf8'));
    unlinkSync(tmpFile);
  } catch { return; }

  if (!episode.entries || episode.entries.length === 0) return;

  // Rate-limit background LLM calls to avoid competing with active sessions
  const sessionActive = existsSync(sessionFile());
  const delayMs = sessionActive
    ? 2000 + Math.random() * 3000   // 2-5s when user session is active
    : 500 + Math.random() * 1000;   // 0.5-1.5s after session ends
  if (process.env.CLAUDE_MEM_DEBUG) console.error(`[claude-mem-lite] llm-episode delay: ${Math.round(delayMs)}ms (session ${sessionActive ? 'active' : 'ended'})`);
  await sleep(delayMs);

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

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"concise description","narrative":"2-3 sentences on what and why","concepts":["kw1","kw2"],"facts":["fact1","fact2"]}`;
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

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"coherent summary of the episode","narrative":"what was done, why, and outcome (3-5 sentences)","concepts":["keyword1","keyword2"],"facts":["specific fact 1","specific fact 2"]}`;
  }

  const raw = callLLM(prompt);
  const parsed = parseJsonFromLLM(raw);
  if (!parsed || !parsed.title) return;

  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  const obs = {
    type: validTypes.has(parsed.type) ? parsed.type : 'change',
    title: truncate(parsed.title, 120),
    subtitle: fileList,
    narrative: truncate(parsed.narrative || '', 500),
    concepts: Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [],
    facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [],
    files: episode.files,
    filesRead: [],
  };

  saveObservation(obs, episode.project, episode.sessionId);
}

// ─── Background: LLM Session Summary ────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleLLMSummary() {
  // Wait for concurrent llm-episode processes to finish writing
  await sleep(20000);

  const db = openDb();
  if (!db) return;

  try {
    // Session ID and project passed as args from handleStop
    const sessionId = process.argv[3] || getSessionId();
    const project = process.argv[4] || inferProject();

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

    const raw = callLLM(prompt, 20000);
    const parsed = parseJsonFromLLM(raw);

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

  // Flush remaining episode buffer
  const episode = readEpisode();
  if (episode) {
    flushEpisode(episode);
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

// ─── SessionStart Handler + CLAUDE.md Persistence (Tier 1 A, E) ─────────────

function handleSessionStart() {
  // Tier 1 A: Create unique session ID
  const sessionId = createSessionId();
  const project = inferProject();

  const db = openDb();
  if (!db) return;

  try {
    // Ensure session exists in DB
    const now = new Date();
    const existing = db.prepare('SELECT 1 FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    if (!existing) {
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());
    }

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    // Recent observations for this project
    const observations = db.prepare(`
      SELECT id, type, title, created_at
      FROM observations
      WHERE project = ? AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC
      LIMIT 15
    `).all(project, oneDayAgo);

    // Fallback: recent across all projects (small — avoid context bloat)
    let fallbackObs = [];
    if (observations.length < 3) {
      fallbackObs = db.prepare(`
        SELECT id, type, title, project, created_at
        FROM observations
        WHERE created_at_epoch > ?
        ORDER BY created_at_epoch DESC
        LIMIT 5
      `).all(oneDayAgo);
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
        obsLines.push(`| #${o.id} | ${fmtDate(o.created_at)} | ${typeIcon(o.type)} | ${truncate(o.title || '(untitled)', 60)}${proj} |`);
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

  try { writeFileSync(claudeMdPath, content); } catch (e) {
    if (process.env.CLAUDE_MEM_DEBUG) console.error(`[claude-mem-lite] CLAUDE.md write failed: ${e.message}`);
  }
}

// ─── Save Observation to DB ─────────────────────────────────────────────────

function saveObservation(obs, projectOverride, sessionIdOverride) {
  const db = openDb();
  if (!db) return;

  try {
    const now = new Date();
    const project = projectOverride || inferProject();
    const sessionId = sessionIdOverride || getSessionId();

    const existing = db.prepare('SELECT 1 FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    if (!existing) {
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());
    }

    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, project,
      obs.narrative || '', obs.type, obs.title, obs.subtitle || '',
      obs.narrative || '',
      JSON.stringify(obs.concepts),
      JSON.stringify(obs.facts),
      JSON.stringify(obs.filesRead),
      JSON.stringify(obs.files),
      now.toISOString(), now.getTime()
    );
  } finally {
    db.close();
  }
}

// ─── Entry Description Generators ───────────────────────────────────────────

function makeEntryDesc(toolName, input, resp) {
  switch (toolName) {
    case 'Edit':
      return `${basename(input.file_path || '')}: "${truncate(input.old_string || '', 40)}" → "${truncate(input.new_string || '', 40)}"`;
    case 'Write':
      return `Created ${basename(input.file_path || '')} (${(input.content || '').length} chars)`;
    case 'NotebookEdit':
      return `Notebook cell: ${truncate(input.new_source || '', 60)}`;
    case 'Bash': {
      const cmd = truncate(input.command || '', 50);
      const isErr = /error|fail|exception|panic/i.test(resp) && resp.length > 30;
      const snippet = truncate(resp, 60);
      return isErr ? `${cmd} → ERROR: ${snippet}` : `${cmd} → ${snippet}`;
    }
    case 'Grep':
      return `Search "${truncate(input.pattern || '', 20)}" → ${truncate(resp, 60)}`;
    case 'LSP':
      return `${input.operation || ''} ${basename(input.filePath || '')}`;
    case 'Task':
      return truncate(input.description || '', 60);
    case 'WebSearch':
      return `Web: ${truncate(input.query || '', 50)}`;
    case 'WebFetch':
      return `Fetch: ${truncate(input.url || '', 50)}`;
    default:
      return `${toolName}: ${truncate(resp, 50)}`;
  }
}

// ─── File Path Extraction ───────────────────────────────────────────────────

function extractFilePaths(input) {
  const paths = [];
  if (input.file_path) paths.push(input.file_path);
  if (input.path) paths.push(input.path);
  if (input.filePath) paths.push(input.filePath);
  if (input.command) {
    const match = input.command.match(/(?:^|\s)(\/[\w./-]+(?:\.\w+))/g);
    if (match) {
      for (const m of match) {
        const p = m.trim();
        if (!p.startsWith('/dev/') && !p.startsWith('/proc/') && !p.startsWith('/tmp/')) {
          paths.push(p);
        }
      }
    }
  }
  return [...new Set(paths)];
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
      if (data.length > MAX_STDIN) { process.stdin.destroy(); clearTimeout(timeout); resolve(data.slice(0, MAX_STDIN)); }
    });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
    process.stdin.on('error', err => { clearTimeout(timeout); reject(err); });
    process.stdin.resume();
  });
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function typeIcon(type) {
  const icons = { decision: '🟡', bugfix: '🔴', feature: '🟢', refactor: '🔵', discovery: '🔍', change: '📝' };
  return icons[type] || '⚪';
}

function truncate(str, max = 80) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  switch (event) {
    case 'post-tool-use':    await handlePostToolUse(); break;
    case 'session-start':    handleSessionStart(); break;
    case 'stop':             handleStop(); break;
    case 'llm-episode':      await handleLLMEpisode(); break;
    case 'llm-summary':      await handleLLMSummary(); break;
  }
} catch (err) {
  if (process.env.CLAUDE_MEM_DEBUG) {
    console.error(`[claude-mem-lite] ${event} error:`, err.message);
  }
}

process.exit(0);
