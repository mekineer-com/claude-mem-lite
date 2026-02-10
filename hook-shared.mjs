// claude-mem-lite: Shared infrastructure for hook.mjs and hook-llm.mjs
// Constants, session management, DB access, LLM calls, process utilities

import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { inferProject, debugCatch } from './utils.mjs';
import { ensureDb, DB_DIR } from './schema.mjs';
import { ensureRegistryDb } from './registry.mjs';
import { getClaudePath as getClaudePathShared } from './haiku-client.mjs';

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
export const FALLBACK_OBS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  writeFileSync(sessionFile(), JSON.stringify({ id, startedAt: Date.now(), project }));
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

const REGISTRY_DB_PATH = join(DB_DIR, 'resource-registry.db');
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
  try {
    const result = execFileSync(getClaudePathShared(), ['-p', '--model', 'haiku'], {
      input: prompt,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e) {
    const out = e.stdout?.toString?.()?.trim() || e.output?.[1]?.toString?.()?.trim();
    if (out && out.startsWith('{') && out.endsWith('}')) return out;
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
