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
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NATIVE_BINDING_HINT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const MARKER_NAME = 'native-binding-hint-last';

// Resolvable invocation of the bundled CLI's repair path. Absolute via
// import.meta.url (cli.mjs is one dir up from lib/) so it works on a plugin-only
// install, where bare `claude-mem-lite` is not on PATH. cli.mjs routes `repair`
// → install.mjs. (review #3)
const CLI_REPAIR = `node ${fileURLToPath(new URL('../cli.mjs', import.meta.url))} repair`;

// Stable-ish identity of a fault so DISTINCT failures get DISTINCT cooldown
// windows: the same fault → same key (suppressed within the window), a different
// fault → different key → surfaces even within the window. djb2 over the message
// keeps it dependency-free (no node:crypto). (review #8/#15)
function errKey(message = '') {
  const m = String(message);
  let h = 5381;
  for (let i = 0; i < m.length; i++) h = ((h * 33) ^ m.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * True at most once per cooldown window FOR A GIVEN `key`. Persists
 * "<epochMs>\t<key>" as file CONTENT (not mtime) under runtimeDir so callers can
 * inject `now` deterministically in tests. A different `key` (a distinct fault)
 * resets the window, so a new problem is never silenced by an earlier, unrelated
 * one. Best-effort: any fs error returns true — showing the hint beats silently
 * swallowing a real problem.
 *
 * @param {string} runtimeDir Directory for the marker file
 * @param {number} [now] Current epoch ms (injectable)
 * @param {number} [cooldownMs] Suppression window
 * @param {string} [key] Fault identity; same key within the window → suppressed
 * @returns {boolean}
 */
export function nativeBindingHintDue(runtimeDir, now = Date.now(), cooldownMs = NATIVE_BINDING_HINT_COOLDOWN_MS, key = '') {
  const marker = join(runtimeDir, MARKER_NAME);
  try {
    const raw = readFileSync(marker, 'utf8');
    // Format "<epochMs>\t<key>"; a legacy bare "<epochMs>" parses with key ''.
    const tab = raw.indexOf('\t');
    const last = Number(tab === -1 ? raw : raw.slice(0, tab));
    const lastKey = tab === -1 ? '' : raw.slice(tab + 1);
    if (Number.isFinite(last) && lastKey === key && now - last < cooldownMs) return false;
  } catch { /* no/invalid marker → due */ }
  try {
    mkdirSync(runtimeDir, { recursive: true });
    // Atomic write (tmp + rename) so a concurrent reader sees the old or the new
    // COMPLETE value, never a torn timestamp that parses NaN → spurious "due" →
    // duplicate hint. The residual read-then-decide race can still emit twice, but
    // the hint is cosmetic and 6h-rate-limited, so that is acceptable. (#7/#10)
    const tmp = `${marker}.tmp-${process.pid}`;
    writeFileSync(tmp, `${now}\t${key}`);
    renameSync(tmp, marker);
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
    // Key the cooldown on the fault identity so a DISTINCT native failure within
    // the window still surfaces (a second ABI mismatch after a partial rebuild, a
    // corrupt .node) instead of being silenced by a prior, different DLOPEN. (#8/#15)
    if (runtimeDir && !nativeBindingHintDue(runtimeDir, now, NATIVE_BINDING_HINT_COOLDOWN_MS, errKey(err.message))) return null;
    return `[claude-mem-lite] [${ts}] [WARN] ${event}: native DB binding can't load ` +
      `(likely a Node version change) — auto-heals on next MCP server start, or run: ${CLI_REPAIR}`;
  }
  return `[claude-mem-lite] [${ts}] [ERROR] ${event}: ${err && err.message}`;
}
