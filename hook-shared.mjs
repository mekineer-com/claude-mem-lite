// claude-mem-lite: Shared infrastructure for hook.mjs and hook-llm.mjs
// Constants, session management, DB access, LLM calls, process utilities

import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from 'fs';
import { inferProject, debugCatch } from './utils.mjs';
import { ensureDb, DB_DIR } from './schema.mjs';
import { getClaudePath as getClaudePathShared, resolveModel as resolveModelShared, flattenForCLI as _flattenForCLI, detectMode as detectLLMMode, callHaiku } from './haiku-client.mjs';
// Phase D: invited-memory sentinel detection. memdir.mjs only pulls in fs/path/os/crypto;
// adopt-content.mjs is pure strings. No circular deps — memdir doesn't import hook-shared.
import { memdirPath as _memdirPath, isAdopted as _isAdopted } from './memdir.mjs';
import { PLUGIN_SLUG as _PLUGIN_SLUG } from './adopt-content.mjs';

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

// Phase A (v2.31.3+): MEM_QUIET_HOOKS=1 drops descriptive hook/MCP-instruction
// bodies (File Lessons / Key Context headers, MCP WHEN-TO-USE & decision rules,
// related-memory lesson suffix). Intended for users who adopted invited-memory
// (MEMORY.md sentinel) or who otherwise want minimal hook noise. Function form
// (not const) so modules importing at load time still respect later env sets
// in-process, and tests can toggle per-call. See docs/plans/2026-04-16-invited-memory-pattern.md.
export function isQuietHooks() {
  return process.env.MEM_QUIET_HOOKS === '1';
}

// Phase D (v2.32.1+): if the current project has adopted our invited-memory
// sentinel, MEMORY.md already carries the triggers at system-prompt authority
// — so hook + MCP-instruction output can also go quiet. isQuietHooks (env)
// remains an independent, stronger override.
export function isAdoptedHere(cwd) {
  try {
    const resolved = cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
    return _isAdopted(_memdirPath(resolved), _PLUGIN_SLUG);
  } catch {
    return false;
  }
}

export function effectiveQuiet(cwd) {
  return isQuietHooks() || isAdoptedHere(cwd);
}

// Handoff system constants
export const HANDOFF_EXPIRY_CLEAR = 6 * 3600000;                // 6 hours (covers lunch/meeting breaks)
export const HANDOFF_EXPIRY_EXIT = 7 * 24 * 60 * 60 * 1000;   // 7 days
export const HANDOFF_ANCHOR_MAX_AGE = 72 * 3600000;             // 72h cap on git_sha anchor — avoids stale-HEAD false positives
export const HANDOFF_MATCH_THRESHOLD = 3;                       // min weighted score
export const CONTINUE_KEYWORDS = /继续|接着|上次|之前的|前面的|刚才|\bcontinue\b|\bresume\b|\bwhere[\s-]+we[\s-]+left\b|\bpick[\s-]+up\b|\bcarry[\s-]+on\b/i;

// Orphan-sweep threshold for `ep-flush-*` / `pending-*` runtime artifacts.
// handleLLMEpisode's worst-case round-trip is ~60s (delay + LLM call + DB
// write); 1h leaves a wide safety margin against deleting an in-flight file.
// Older orphans are crashed workers or pre-shutdown buffers that no live
// caller will ever pick up, so sweeping them on SessionStart is safe.
export const ORPHAN_EPISODE_AGE_MS = 60 * 60 * 1000;

// Sweep stale `ep-flush-*` and `pending-*` files in `runtimeDir` whose mtime
// is older than `ageMs` (default 1h). Returns the number of files removed.
// fs-only — no DB / no network. Used by handleSessionStart auto-maintain to
// prevent the doctor "Stale temp files" warning from accumulating across
// crashes; equivalent to the manual path in `node install.mjs cleanup` but
// age-gated so concurrent in-flight workers are never raced.
export function sweepOrphanEpisodeFiles(runtimeDir, { ageMs = ORPHAN_EPISODE_AGE_MS, now = Date.now() } = {}) {
  let entries;
  try { entries = readdirSync(runtimeDir); } catch { return 0; }
  const cutoff = now - ageMs;
  let count = 0;
  for (const f of entries) {
    if (!(f.startsWith('ep-flush-') || f.startsWith('pending-'))) continue;
    const full = join(runtimeDir, f);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        count++;
      }
    } catch { /* concurrent unlink / permission — ignore */ }
  }
  return count;
}

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

// ─── LLM (provider-routed: Anthropic API → OpenRouter → claude CLI) ─────────

// Accepts either a plain string (legacy) or {system, user} (defense-in-depth
// against prompt injection from poisoned user_prompts content — cso F#4 fix).
// Provider priority mirrors haiku-client (ANTHROPIC_API_KEY > OPENROUTER_API_KEY
// > CLI): when a key is present, delegate to callHaiku — it owns the Anthropic
// Messages / OpenRouter chat-completions request shapes, uses the system role
// natively, AND degrades to the `claude -p` CLI internally if the keyed provider
// fails (so a region-blocked / out-of-credit key still yields a summary). The
// keyless case shells out to `claude -p` directly here, where flattenForCLI
// renders {system, user} with an explicit data-boundary marker. Returns the raw
// response string (callers run parseJsonFromLLM themselves) or null.
// maxTokens is sized for session-summary / episode JSON (larger than the
// registry/optimize callers' budgets).
export async function callLLM(prompt, timeoutMs = 15000) {
  if (detectLLMMode() !== 'cli') {
    const result = await callHaiku(prompt, { timeout: timeoutMs, maxTokens: 2000 });
    return result?.text ?? null;
  }

  const { cli: modelName } = resolveModelShared();
  try {
    const result = execFileSync(getClaudePathShared(), ['-p', '--model', modelName], {
      input: _flattenForCLI(prompt),
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
