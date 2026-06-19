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
// Behavior: try-import the target entry. On ERR_MODULE_NOT_FOUND originating
// from our install — either a missing relative module (e.url under the install
// dir) or a missing bare dependency like better-sqlite3 (e.url is undefined and
// the importer named in the message is under the install dir) — run
// `install.mjs repair` (rate-limited via a 6h marker file under runtime/) and
// retry the import once. If repair is unavailable or fails, degrade quietly:
// these are best-effort memory hooks, so a broken/missing dependency emits one
// clean recovery line and exits 0 rather than dumping a Node stack trace on
// every fire. On any other (foreign) exception, re-throw so Node's default
// error surface is preserved.
//
// HARD constraint: pure node: imports only. Importing anything from lib/ here
// would defeat the entire purpose — the launcher must survive a broken
// install.

import { existsSync, mkdirSync, writeFileSync, statSync, unlinkSync, readFileSync } from 'node:fs';
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
// Observable breakage state: written when the launcher degrades a broken install
// to exit 0, cleared once the install is confirmed healthy. `doctor` reads it so
// the intentional silence (no stack trace per fire) stays detectable. (#4/#8)
const BROKEN_MARKER = join(RUNTIME_DIR, 'hook-launcher-broken');

// Resolvable invocation of the bundled CLI's repair path. Absolute via
// INSTALL_DIR (import.meta.url) so it works on a plugin-only install, where
// bare `claude-mem-lite` is not on PATH and ~/.claude-mem-lite/ holds no source.
// cli.mjs routes `repair` → install.mjs. (review #3)
const CLI_REPAIR = `node ${join(INSTALL_DIR, 'cli.mjs')} repair`;

// Last-resort recovery string for users whose `cli.mjs repair` path
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

// Two ERR_MODULE_NOT_FOUND shapes reach here (both verified against Node 22):
//   • missing relative module → e.url = file://<missing-path> (under install)
//   • missing bare dependency (e.g. a half-installed better-sqlite3) → e.url is
//     UNDEFINED and the message is `Cannot find package '<name>' imported from
//     <importer>`. This is the shape that bricked the hooks: the old
//     file://INSTALL_DIR prefix test never matched it in a dev-dir install, so
//     a missing dependency was misread as a foreign error and re-thrown as a
//     Node stack trace on every hook fire.
// Anchor on any path the error exposes — the missing URL and/or the importer
// (present in both messages as "imported from <path>"). If it sits inside our
// install, a self-heal could fix it.
// package.json dependency set of THIS install — read lazily, best-effort. Lets
// isLocalModuleErr tell a genuinely-ours missing bare dependency (better-sqlite3,
// zod, …) apart from a foreign/mistyped package name that merely happens to be
// imported from an install-dir file. The former is self-healable; the latter is
// a real packaging bug that must surface a Node stack trace rather than be
// swallowed by an exit-0 self-heal. (review #5/#7)
function ownDependencies() {
  try {
    const pkg = JSON.parse(readFileSync(join(INSTALL_DIR, 'package.json'), 'utf8'));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);
  } catch {
    return null; // unreadable package.json → caller stays permissive
  }
}

function isLocalModuleErr(e) {
  if (!e || e.code !== 'ERR_MODULE_NOT_FOUND') return false;
  // Missing RELATIVE module: e.url is the missing file's URL. Ours iff it sits
  // under our install dir (the `.claude-mem-lite` substring also covers the
  // symlink-farm dev/direct-install case where INSTALL_DIR is the realpath).
  if (e.url) {
    const p = String(e.url).replace(/^file:\/\//, '');
    return p.startsWith(INSTALL_DIR) || p.includes('.claude-mem-lite');
  }
  // Missing BARE dependency: e.url is UNDEFINED; message is
  // `Cannot find package '<name>' imported from <importer>`. The (.+) capture
  // needs no `m` flag (`.` stops at a newline) and so tolerates a multi-line
  // message that appends a hint line after the importer path — the old
  // `(.+?)\s*$` returned undefined there and misclassified the dep. (review #11/#15)
  const msg = String(e.message || '');
  const importer = /imported from (.+)/.exec(msg)?.[1]?.trim();
  if (!importer) return false;
  const importerPath = importer.replace(/^file:\/\//, '');
  if (!(importerPath.startsWith(INSTALL_DIR) || importerPath.includes('.claude-mem-lite'))) return false;
  // Importer is ours — but only self-heal if the missing package is one we
  // actually declare. A foreign/typo'd name re-throws so the bug is visible.
  const pkgName = /Cannot find package '([^']+)'/.exec(msg)?.[1];
  const deps = ownDependencies();
  if (!deps || !pkgName) return true; // best-effort: can't verify → stay permissive
  // Normalize sub-path / scoped imports to the package root (better-sqlite3/x → better-sqlite3).
  const root = pkgName.startsWith('@') ? pkgName.split('/').slice(0, 2).join('/') : pkgName.split('/')[0];
  return deps.has(root);
}

// Human-readable label for the "Detected broken install (<reason>)" line:
// prefer the missing dependency/module name over a raw path fragment.
function describeFailure(e) {
  const pkg = /Cannot find package '([^']+)'/.exec(String(e.message || ''))?.[1];
  if (pkg) return pkg;
  if (e.url) return String(e.url).split('/').pop();
  return String(e.message || 'unknown').split('/').slice(-2).join('/');
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

// Drop the 6h cooldown once a heal fully resolves. The marker is written BEFORE
// spawn (rate-limits concurrent fires), but a SUCCESSFUL heal must not keep
// blocking an unrelated later breakage that happens within the window. (#6/#9)
function clearHealMarker() {
  try { unlinkSync(HEAL_MARKER); } catch { /* already gone — fine */ }
}

function recordBreakage(reason) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(BROKEN_MARKER, JSON.stringify({ reason, ts: Date.now() }));
  } catch { /* best-effort */ }
}

function clearBreakage() {
  try { if (existsSync(BROKEN_MARKER)) unlinkSync(BROKEN_MARKER); } catch { /* best-effort */ }
}

async function attemptHeal(reason) {
  if (recentHealAttempt()) {
    process.stderr.write(
      `[claude-mem-lite] Self-heal skipped (last attempt < 6h ago).\n` +
      `[claude-mem-lite] Manual recovery: ${CLI_REPAIR}\n` +
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

// Defense-in-depth for plugin-mode version drift: the plugin-cache MCP server
// (kept current by Claude Code) migrates the shared DB schema forward, while
// this data-dir code (the standalone CLI + these hooks) is only advanced by the
// GitHub-tarball auto-update, which plugin mode disables — so it can lag the
// schema and fail to open the DB. syncDataDirFromCache copies the current cache
// source files locally to close that gap. launch.mjs (MCP start) is the primary
// healer; this is a backup that also covers the case where the MCP server never
// starts. Gated to session-start (once per session, OFF the per-tool hot path)
// and fully best-effort: a stale module without the fn, or any error, just
// falls through to the normal entry import. The dynamic import keeps this
// launcher's pure-`node:` static-import charter intact (it must survive a broken
// install even if hook-update.mjs is unimportable).
async function trySyncDataDirFromCache() {
  try {
    const { syncDataDirFromCache } = await import(
      pathToFileURL(join(INSTALL_DIR, 'hook-update.mjs')).href
    );
    if (typeof syncDataDirFromCache === 'function') await syncDataDirFromCache();
  } catch { /* best-effort — proceed to the normal entry regardless */ }
}

if (rest.includes('session-start')) {
  await trySyncDataDirFromCache();
}

try {
  await runEntry();
  // A clean session-start fire confirms the install is healthy → clear any stale
  // breakage marker. Gated to session-start so the per-tool hot path pays nothing.
  if (rest.includes('session-start')) clearBreakage();
} catch (e) {
  if (!isLocalModuleErr(e)) throw e;
  const reason = describeFailure(e);
  const healed = await attemptHeal(reason);
  if (!healed) {
    // Broken/missing dependency we can't repair right now (repair failed, or
    // was skipped within the 6h cooldown). attemptHeal already wrote actionable
    // guidance — degrade quietly instead of re-throwing the original import
    // error, which would spew a Node stack trace on every hook fire. Record the
    // breakage so the exit-0 silence stays observable to `doctor`. (#4/#8)
    recordBreakage(reason);
    process.exit(0);
  }
  try {
    await runEntry({ bustCache: true });
    // Fully healed: drop the cooldown so an UNRELATED later break can heal
    // immediately (#6/#9), and clear the breakage marker.
    clearHealMarker();
    clearBreakage();
  } catch (retryErr) {
    recordBreakage(`retry-failed: ${retryErr.message}`);
    process.stderr.write(
      `[claude-mem-lite] Hook still failing after self-heal: ${retryErr.message}\n` +
      `[claude-mem-lite] Manual recovery: ${TARBALL_FALLBACK}\n`,
    );
    process.exit(0);
  }
}
