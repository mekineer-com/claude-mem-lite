// claude-mem-lite: Shared infrastructure for hook.mjs and hook-llm.mjs
// Constants, session management, DB access, LLM calls, process utilities

import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { inferProject, debugCatch } from './utils.mjs';
import { ensureDb, DB_DIR, REGISTRY_DB_PATH } from './schema.mjs';
import { ensureRegistryDb } from './registry.mjs';
import { getClaudePath as getClaudePathShared, resolveModel as resolveModelShared } from './haiku-client.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

export const RUNTIME_DIR = join(DB_DIR, 'runtime');
export const SCRIPT_PATH = process.argv[1];

// Timing constants
export const EPISODE_BUFFER_SIZE = 10;
export const EPISODE_TIME_GAP_MS = 5 * 60 * 1000;       // 5 min
export const SESSION_EXPIRY_MS = 12 * 60 * 60 * 1000;    // 12h
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000;     // 24h
export const STALE_LOCK_MS = 30000;                       // 30s
export const DEDUP_WINDOW_MS = 5 * 60 * 1000;            // 5 min (title dedup)
export const RELATED_OBS_WINDOW_MS = 7 * 86400000;       // 7 days
export const FALLBACK_OBS_WINDOW_MS = RELATED_OBS_WINDOW_MS; // same window
export const RESOURCE_RESCAN_INTERVAL_MS = 60 * 60 * 1000;    // 1 hour

// Handoff system constants
export const HANDOFF_EXPIRY_CLEAR = 6 * 3600000;                // 6 hours (covers lunch/meeting breaks)
export const HANDOFF_EXPIRY_EXIT = 7 * 24 * 60 * 60 * 1000;   // 7 days
export const HANDOFF_MATCH_THRESHOLD = 3;                       // min weighted score
export const CONTINUE_KEYWORDS = /继续|接着|上次|之前的|前面的|刚才|\bcontinue\b|\bresume\b|\bwhere[\s-]+we[\s-]+left\b|\bpick[\s-]+up\b|\bcarry[\s-]+on\b/i;

// Ensure runtime directory exists
try { if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}

// ─── Session ID Management ───────────────────────────────────────────────────

export function sessionFile() {
  return join(RUNTIME_DIR, `session-${inferProject()}`);
}

export function getSessionId() {
  try {
    const data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (Date.now() - data.startedAt < SESSION_EXPIRY_MS) return data.id;
  } catch {}
  return createSessionId();
}

export function createSessionId() {
  const project = inferProject();
  const id = `hook-${project}-${randomUUID().slice(0, 8)}`;
  const file = sessionFile();
  const tmp = file + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ id, startedAt: Date.now(), project }));
  renameSync(tmp, file);
  return id;
}

// ─── Database ────────────────────────────────────────────────────────────────

export function openDb() {
  try {
    return ensureDb();
  } catch {
    return null;
  }
}

// ─── Registry Database (dispatch system) ─────────────────────────────────────
let _registryDb = null;

export function getRegistryDb() {
  if (_registryDb) return _registryDb;
  try { _registryDb = ensureRegistryDb(REGISTRY_DB_PATH); } catch (e) { debugCatch(e, 'getRegistryDb'); }
  return _registryDb;
}

export function closeRegistryDb() {
  if (_registryDb) try { _registryDb.close(); } catch {}
  _registryDb = null;
}

// ─── LLM via claude CLI ─────────────────────────────────────────────────────

export function callLLM(prompt, timeoutMs = 15000) {
  const { cli: modelName } = resolveModelShared();
  try {
    const result = execFileSync(getClaudePathShared(), ['-p', '--model', modelName], {
      input: prompt,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp', // Prevent ghost sessions in user's /resume list
    });
    return result.trim();
  } catch (e) {
    const out = _extractResponseFromError(e);
    if (out) return out;
    debugCatch(e, 'callLLM');
    return null;
  }
}

// ─── Background Spawner ─────────────────────────────────────────────────────

export function spawnBackground(bgEvent, ...extraArgs) {
  const args = [SCRIPT_PATH, bgEvent, ...extraArgs];
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
    });
    child.on('error', (err) => { debugCatch(err, 'spawnBackground'); });
    child.on('exit', () => {});
    child.unref();
  } catch (err) {
    debugCatch(err, 'spawnBackground');
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Injection Budget (per hook invocation, in-memory) ───────────────────────
// Limits context injections within a single hook process to prevent context bloat.
// Note: each hook event runs in a separate process, so this is per-invocation,
// not per-session. Session-level dedup is handled by cooldown/sessionId checks.

export const MAX_INJECTIONS_PER_SESSION = 3;
let _injectionCount = 0;

export function getInjectionCount() { return _injectionCount; }
export function incrementInjection() { _injectionCount++; }
export function resetInjectionBudget() { _injectionCount = 0; }
export function hasInjectionBudget() { return _injectionCount < MAX_INJECTIONS_PER_SESSION; }

// ─── Previous Session Context (for user-prompt dispatch enrichment) ──────────
// Session-start caches next_steps; first user-prompt reads+clears for richer dispatch.

// ─── Tool Event Tracking (for dispatch feedback) ────────────────────────────
// PostToolUse appends feedback-relevant tool events (Skill, Task, Edit, Write, Bash errors).
// Stop handler reads them and passes to collectFeedback for adoption/outcome detection.

export function toolEventsFile() {
  return join(RUNTIME_DIR, `tool-events-${inferProject()}.jsonl`);
}

/**
 * Append a tool event for feedback tracking.
 * Only call for feedback-relevant events (Skill, Task, Edit, Write, Bash).
 * @param {object} event { tool_name, tool_input, tool_response }
 */
export function appendToolEvent(event) {
  try {
    appendFileSync(toolEventsFile(), JSON.stringify(event) + '\n');
  } catch {}
}

/**
 * Read all tracked tool events and remove the file.
 * Uses rename→read→delete for atomicity.
 * @returns {object[]} Array of tool event objects
 */
export function readAndClearToolEvents() {
  const file = toolEventsFile();
  const claimFile = file + `.claim-${process.pid}-${Date.now()}`;
  try {
    renameSync(file, claimFile);
    const raw = readFileSync(claimFile, 'utf8');
    try { unlinkSync(claimFile); } catch {}
    return raw.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read tracked tool events WITHOUT clearing the file.
 * Used by dispatch to detect active suites mid-session.
 * @returns {object[]} Array of tool event objects
 */
export function peekToolEvents() {
  try {
    const raw = readFileSync(toolEventsFile(), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * Extract partial response from CLI error output (timeout/error recovery).
 * @param {Error} error The caught error from execFileSync
 * @returns {string|null} Extracted JSON string or null
 */
export function _extractResponseFromError(error) {
  const out = error.stdout?.toString?.()?.trim() || error.output?.[1]?.toString?.()?.trim() || '';
  if (out && out.startsWith('{') && out.endsWith('}')) {
    try {
      const parsed = JSON.parse(out);
      // Reject structurally incomplete responses (e.g. truncated mid-output)
      if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length === 0) return null;
      return out;
    } catch { return null; }
  }
  return null;
}
