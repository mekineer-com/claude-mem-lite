// claude-mem-lite: Shared infrastructure for hook.mjs and hook-llm.mjs
// Constants, session management, DB access, LLM calls, process utilities

import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync, chmodSync } from 'fs';
import { inferProject, debugCatch } from './utils.mjs';
import { ensureDbWithWalRecovery, DB_DIR } from './schema.mjs';
// Pure-`node:`/local module (it imports only binding-probe + native-binding-hint, and
// neither imports this file) — no cycle.
import { recordHookError } from './lib/hook-telemetry.mjs';
import { getClaudePath as getClaudePathShared, resolveModel as resolveModelShared, flattenForCLI as _flattenForCLI, detectMode as detectLLMMode, callHaiku } from './haiku-client.mjs';
// Phase D: invited-memory sentinel detection. memdir.mjs/claudemd.mjs only pull in
// fs/path/os/crypto; adopt-content.mjs is pure strings. No circular deps —
// neither imports hook-shared.
import { memdirPath as _memdirPath, isAdopted as _isAdoptedMemdir } from './memdir.mjs';
import { isAdopted as _isAdoptedClaudeMd } from './claudemd.mjs';
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

// Phase D (v2.32.1+) → v3.13: if the current project has adopted our steering,
// the contract is already loaded at system-prompt authority — so hook +
// MCP-instruction output can also go quiet. v3.13 moved that contract from the
// memory-dir MEMORY.md sentinel to the project CLAUDE.md managed block, so check
// the new scheme first and keep the legacy memdir sentinel as a fallback (an
// un-migrated project stays quiet through the transition). isQuietHooks (env)
// remains an independent, stronger override.
export function isAdoptedHere(cwd) {
  try {
    const resolved = cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
    return _isAdoptedClaudeMd(resolved, _PLUGIN_SLUG)
      || _isAdoptedMemdir(_memdirPath(resolved), _PLUGIN_SLUG);
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

// `reads-<project>.txt` (bash fast-path Read tracker) is consumed by flushEpisode's
// rename-collect on the next edit-flush, NOT by a background worker — so a project
// that reads but never triggers an edit-flush leaves it uncollected and unswept, and
// it grows without bound (the 1h episode threshold is far too eager: a long read-only
// investigation legitimately appends to it for hours). A dedicated 24h floor sweeps
// only genuinely-abandoned trackers (no append AND no flush in a day → its paths are
// stale to any current episode) while leaving every active session's file untouched.
export const ORPHAN_READS_AGE_MS = 24 * 60 * 60 * 1000;

// Sweep stale `ep-flush-*` / `pending-*` (older than `ageMs`, default 1h) and
// `reads-*.txt` (older than `readsAgeMs`, default 24h) files in `runtimeDir` by
// mtime. Returns the number of files removed. fs-only — no DB / no network. Used by
// handleSessionStart auto-maintain to prevent the doctor "Stale temp files" warning
// from accumulating across crashes; equivalent to the manual path in
// `node install.mjs cleanup` but age-gated so concurrent in-flight workers / active
// read sessions are never raced.
export function sweepOrphanEpisodeFiles(runtimeDir, { ageMs = ORPHAN_EPISODE_AGE_MS, readsAgeMs = ORPHAN_READS_AGE_MS, now = Date.now() } = {}) {
  let entries;
  try { entries = readdirSync(runtimeDir); } catch { return 0; }
  const cutoff = now - ageMs;
  const readsCutoff = now - readsAgeMs;
  let count = 0;
  for (const f of entries) {
    // `.claim-` = handleStop's lock-contended fallback claim file (ep-<project>.json.claim-<pid>-<ts>),
    // which leaks if the process dies between rename and unlink; sweep it on the same 1h cutoff.
    const isEpisode = f.startsWith('ep-flush-') || f.startsWith('pending-') || f.includes('.claim-');
    const isReads = f.startsWith('reads-') && f.endsWith('.txt');
    if (!isEpisode && !isReads) continue;
    const full = join(runtimeDir, f);
    try {
      if (statSync(full).mtimeMs < (isReads ? readsCutoff : cutoff)) {
        unlinkSync(full);
        count++;
      }
    } catch { /* concurrent unlink / permission — ignore */ }
  }
  return count;
}

// Ensure runtime directory exists AND is owner-only (0700), matching the DB dir
// (schema.mjs). Runtime aux files carry captured file paths + scrubbed activity; on a
// shared host a 0755 dir would let another local user read them. hardenRuntimeFiles()
// (server.mjs) sweeps at MCP-server startup, but hooks routinely run before any server
// exists, so harden here too: create 0700, and chmod a pre-existing dir a prior version
// created at the default umask. A 0700 dir blocks traversal to every file inside,
// current and future, regardless of individual file mode (audit sec P3-2 2026-07-24).
try {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  else chmodSync(RUNTIME_DIR, 0o700);
} catch {}

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
  writeFileSync(tmp, JSON.stringify({ id, startedAt: Date.now(), project }), { mode: 0o600 });
  renameSync(tmp, file);
  return id;
}

// ─── Database ────────────────────────────────────────────────────────────────

export function openDb() {
  try {
    // WAL-corruption self-heal (was server.mjs-only): without it, hooks stayed
    // silently dead (null DB) on a corrupt WAL until the next MCP server start.
    return ensureDbWithWalRecovery();
  } catch (e) {
    // Still null, still no throw — a hook must never crash the host session, and all
    // eight call sites in hook.mjs are written to no-op on null. But "returned null"
    // used to be the ONLY trace: nothing reached runtime/hook-errors/, so `stats`
    // reported 0 and doctor printed "no recent silent hook breakage" while every
    // capture path was dead (audit B1, 2026-08-14 — the same blindness that hid the
    // v3.60 binding outage for four days). recordHookError is the established sink;
    // scripts/pre-tool-recall.js already logs its own db-open failures this way, and
    // routing through it also flags the native-binding family for the session-start
    // self-heal. The recorder swallows its own errors, so this cannot throw.
    recordHookError('hook-shared:db-open', e, RUNTIME_DIR);
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
