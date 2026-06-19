// lib/native-binding-hint.mjs — friendly, rate-limited hint for an unloadable
// native DB binding (better-sqlite3 ERR_DLOPEN_FAILED, e.g. a Node version
// upgrade leaves the prebuilt .node ABI-stale).
//
// This is the SIBLING of the missing-dependency case handled in
// scripts/hook-launcher.mjs. The two fail on different paths:
//   • MISSING dependency (ERR_MODULE_NOT_FOUND) throws at IMPORT time, before
//     hook.mjs runs — caught by the launcher.
//   • UNLOADABLE binding (ERR_DLOPEN_FAILED) imports fine (better-sqlite3 loads
//     its .node lazily at the first `new Database()`), then throws inside a hook
//     handler — caught by hook.mjs's top-level dispatch try/catch. Pre-this,
//     that catch logged the raw multi-line NODE_MODULE_VERSION message on EVERY
//     hook fire. Here we collapse it to one short, actionable line, rate-limited
//     per cooldown. The actual rebuild is the MCP server launch path's job
//     (lib/binding-probe.mjs::ensureBetterSqlite3Working) — a hook must never
//     run `npm rebuild` itself (2–5s timeout + concurrent-fire races).
//
// Pure node: imports + injectable now/runtimeDir so it unit-tests without the
// hook dependency graph (no schema.mjs / better-sqlite3 import).

import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

export const NATIVE_BINDING_HINT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const MARKER_NAME = 'native-binding-hint-last';

/**
 * True at most once per cooldown window. Persists the last-hint timestamp as
 * file CONTENT (not mtime) under runtimeDir so callers can inject `now`
 * deterministically in tests. Best-effort: any fs error returns true — showing
 * the hint beats silently swallowing a real problem.
 *
 * @param {string} runtimeDir Directory for the marker file
 * @param {number} [now] Current epoch ms (injectable)
 * @param {number} [cooldownMs] Suppression window
 * @returns {boolean}
 */
export function nativeBindingHintDue(runtimeDir, now = Date.now(), cooldownMs = NATIVE_BINDING_HINT_COOLDOWN_MS) {
  const marker = join(runtimeDir, MARKER_NAME);
  try {
    const last = Number(readFileSync(marker, 'utf8'));
    if (Number.isFinite(last) && now - last < cooldownMs) return false;
  } catch { /* no/invalid marker → due */ }
  try {
    if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(marker, String(now));
  } catch { /* best-effort */ }
  return true;
}

/**
 * Single stderr line hook.mjs should log for a caught dispatch error, or null
 * to stay silent (ERR_DLOPEN_FAILED still within cooldown). ERR_DLOPEN_FAILED →
 * short rate-limited rebuild hint; everything else → the existing ungated
 * structured ERROR line. Pass runtimeDir to enable rate-limiting (omit it to
 * always format, e.g. in tests).
 *
 * @param {Error & {code?: string}} err
 * @param {string} event Hook event name (stop / session-start / …)
 * @param {{now?: number, runtimeDir?: string}} [opts]
 * @returns {string | null}
 */
export function formatHookError(err, event, { now = Date.now(), runtimeDir } = {}) {
  const ts = new Date(now).toISOString();
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    if (runtimeDir && !nativeBindingHintDue(runtimeDir, now)) return null;
    return `[claude-mem-lite] [${ts}] [WARN] ${event}: native DB binding can't load ` +
      `(likely a Node version change) — auto-heals on next MCP server start, or run: claude-mem-lite repair`;
  }
  return `[claude-mem-lite] [${ts}] [ERROR] ${event}: ${err && err.message}`;
}
