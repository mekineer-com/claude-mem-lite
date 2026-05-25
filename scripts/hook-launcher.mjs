#!/usr/bin/env node
// scripts/hook-launcher.mjs — Self-healing wrapper for Node hook entry points.
//
// Why: pre-v2.84 a stale-manifest bug in hook-update.mjs could leave the
// install with a hook.mjs that imports lib/cite-back-hint.mjs (or any other
// newly-added module) while the file itself was never copied. The resulting
// ERR_MODULE_NOT_FOUND killed every hook fire, including the next auto-update
// that would have healed the install. v2.84.0 fixes the root cause; this
// launcher is defense-in-depth for similar future drift (corrupt download,
// half-applied install, manual file deletion).
//
// Behavior: try-import the target entry. On ERR_MODULE_NOT_FOUND whose URL
// points under the install dir, run `install.mjs repair` (rate-limited via a
// 6h marker file under runtime/) and retry the import once. On any other
// exception, re-throw so Node's default error surface is preserved.
//
// HARD constraint: pure node: imports only. Importing anything from lib/ here
// would defeat the entire purpose — the launcher must survive a broken
// install.

import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = join(__dirname, '..');
const RUNTIME_DIR = process.env.CLAUDE_MEM_DIR
  ? join(process.env.CLAUDE_MEM_DIR, 'runtime')
  : join(homedir(), '.claude-mem-lite', 'runtime');
const HEAL_MARKER = join(RUNTIME_DIR, 'hook-launcher-lastheal');
const HEAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Last-resort recovery string for users whose `claude-mem-lite repair` path
// itself failed (install.mjs missing / repair errored / retry still drifting).
// Duplicated in install.mjs::repair() catch; both are reachable when local
// scripts are broken, so neither can import a shared constant.
const TARBALL_FALLBACK =
  'T=$(mktemp -d) && curl -sL https://api.github.com/repos/sdsrss/claude-mem-lite/tarball | tar xz -C "$T" --strip-components=1 && node "$T/install.mjs" install';

const [, , entryArg, ...rest] = process.argv;
if (!entryArg) {
  process.stderr.write('[claude-mem-lite] hook-launcher: missing entry argument\n');
  process.exit(1);
}

const entryAbs = entryArg.startsWith('/') ? entryArg : join(INSTALL_DIR, entryArg);

async function runEntry({ bustCache = false } = {}) {
  // Mirror direct invocation: process.argv[1] is the entry, [2..] are its args.
  process.argv = [process.argv[0], entryAbs, ...rest];
  // Node ESM caches resolution outcomes (success AND failure) by URL. On the
  // post-self-heal retry the freshly-written module file lives at the same
  // path the first import already cached as ERR_MODULE_NOT_FOUND — without a
  // cache-buster query the second await import() returns the cached rejection
  // and the heal looks like it did nothing.
  const url = pathToFileURL(entryAbs).href + (bustCache ? `?t=${Date.now()}` : '');
  await import(url);
}

function isLocalModuleErr(e) {
  if (!e || e.code !== 'ERR_MODULE_NOT_FOUND') return false;
  const where = String(e.url || e.message || '');
  return where.includes('.claude-mem-lite') || where.startsWith(`file://${INSTALL_DIR}`);
}

function recentHealAttempt() {
  try {
    return Date.now() - statSync(HEAL_MARKER).mtimeMs < HEAL_COOLDOWN_MS;
  } catch { return false; }
}

function recordHealAttempt() {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(HEAL_MARKER, String(Date.now()));
  } catch { /* best-effort */ }
}

async function attemptHeal(reason) {
  if (recentHealAttempt()) {
    process.stderr.write(
      `[claude-mem-lite] Self-heal skipped (last attempt < 6h ago).\n` +
      `[claude-mem-lite] Manual recovery: claude-mem-lite repair\n` +
      `[claude-mem-lite] If that fails, run: ${TARBALL_FALLBACK}\n`,
    );
    return false;
  }
  recordHealAttempt();
  process.stderr.write(`[claude-mem-lite] Detected broken install (${reason}) — running self-heal\n`);
  const installer = join(INSTALL_DIR, 'install.mjs');
  if (!existsSync(installer)) {
    process.stderr.write(
      `[claude-mem-lite] install.mjs missing at ${installer} — cannot self-heal\n` +
      `[claude-mem-lite] Manual recovery: ${TARBALL_FALLBACK}\n`,
    );
    return false;
  }
  const result = spawnSync(process.execPath, [installer, 'repair'], {
    stdio: 'inherit',
    timeout: 300000,
  });
  return result.status === 0;
}

try {
  await runEntry();
} catch (e) {
  if (!isLocalModuleErr(e)) throw e;
  const reason = String(e.url || e.message).split('/').slice(-2).join('/');
  const healed = await attemptHeal(reason);
  if (!healed) throw e;
  try {
    await runEntry({ bustCache: true });
  } catch (retryErr) {
    process.stderr.write(
      `[claude-mem-lite] Hook still failing after self-heal: ${retryErr.message}\n` +
      `[claude-mem-lite] Manual recovery: ${TARBALL_FALLBACK}\n`,
    );
    process.exit(1);
  }
}
