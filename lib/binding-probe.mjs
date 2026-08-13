// lib/binding-probe.mjs — better-sqlite3 native binding probe + auto-rebuild.
//
// Shared by install.mjs (verify after `npm install`) and scripts/launch.mjs
// (verify before launching the MCP server). `npm install` exits 0 even when
// the prebuilt .node binary mismatches the running Node ABI (e.g. ABI v137 on
// Node v24), and the presence of node_modules/better-sqlite3/ on disk is not
// sufficient — the binding can be present-but-stale after a Node upgrade.

import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// npm >= 12 blocks lifecycle scripts by default, so a plain `npm rebuild` exits 0
// WITHOUT compiling — see the rebuild() comment below. Single home for the one
// command that actually works, so hints, docs and heal paths cannot drift apart.
export const NATIVE_BINDING_REBUILD_CMD = 'npm rebuild better-sqlite3 --dangerously-allow-all-scripts';

// Set on a re-exec'd child so one failed heal cannot fork-bomb the CLI.
export const BINDING_HEAL_GUARD_ENV = 'CLAUDE_MEM_BINDING_HEALED';

// The native-binding fault family, in the four shapes it actually reaches callers:
//   • ERR_DLOPEN_FAILED            — Node's code for a failed dlopen (ABI mismatch)
//   • NODE_MODULE_VERSION N vs M   — the ABI text itself (some throws carry no code)
//   • Could not locate the bindings file — build/Release missing or never compiled
//   • Module did not self-register — the .node was REPLACED under a process that
//     already dlopen'd the old one; only a fresh process recovers (hence the
//     re-exec in healAndReexec, not an in-process retry)
// Deliberately NARROW: a rebuild cannot fix DB corruption or a missing data dir,
// and misclassifying those would burn a 30s npm run on every fire.
const NATIVE_BINDING_PATTERNS = [
  /NODE_MODULE_VERSION/,
  /Could not locate the bindings file/i,
  /did not self-register/i,
  /invalid ELF header/i,
];

/**
 * True when `err` means "the better-sqlite3 native binding is unusable and a
 * rebuild is the right repair".
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNativeBindingError(err) {
  if (!err) return false;
  if (err.code === 'ERR_DLOPEN_FAILED') return true;
  // `err ?? ''` covers a thrown STRING: recordHookError accepts any thrown value
  // and already normalizes that shape for its log, so the classifier must not
  // silently read undefined and miss it.
  const msg = String(err.message ?? err ?? '');
  return NATIVE_BINDING_PATTERNS.some((re) => re.test(msg));
}

/**
 * Probe better-sqlite3's native binding by importing it from `installDir`'s
 * node_modules and opening an in-memory DB. Returns {ok, error?}.
 *
 * @param {string} installDir Directory containing node_modules/better-sqlite3
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function probeBetterSqlite3Binding(installDir) {
  try {
    const localRequire = createRequire(join(installDir, 'package.json'));
    const Database = localRequire('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Verify better-sqlite3 binding works in `installDir`; if not, run
 * `npm rebuild better-sqlite3` and re-probe. Returns
 * { ok: true, action: 'verified' | 'rebuilt' } on success or
 * { ok: false, error } if rebuild can't fix it. The `probe` and `rebuild`
 * deps are injectable so this can be unit-tested without a real npm
 * subprocess.
 *
 * @param {string} installDir Directory containing node_modules/better-sqlite3
 * @param {{probe?: () => Promise<{ok: boolean, error?: string}>, rebuild?: () => Promise<void>, exec?: (cmd: string, opts: object) => void}} [deps]
 * @returns {Promise<{ok: true, action: 'verified' | 'rebuilt'} | {ok: false, error: string}>}
 */
export async function ensureBetterSqlite3Working(installDir, deps = {}) {
  const probe = deps.probe || (() => probeBetterSqlite3Binding(installDir));
  // Bounded by default: a node-gyp fallback that stalls (no compiler, a hung
  // registry fetch) must not hang the caller forever — the CLI blocks a user at
  // the terminal, and scripts/setup.sh passes an even tighter 20s cap because it
  // runs under a hook timeout. Callers needing a different budget inject `exec`.
  const exec = deps.exec || ((cmd, opts) => execSync(cmd, { timeout: 240_000, ...opts }));
  const rebuild = deps.rebuild || (async () => {
    // npm >= 12 blocks install/lifecycle scripts by default (the `allow-scripts`
    // allowlist ships empty). better-sqlite3's install step
    // (`prebuild-install || node-gyp rebuild`) is what produces the native .node
    // binding, so a plain `npm rebuild better-sqlite3` exits 0 ("rebuilt
    // dependencies successfully") WITHOUT compiling it — the server then FATALs
    // opening the DB and dies before the MCP handshake (client reports -32000),
    // and THIS self-heal silently no-ops on every launch. Re-enable scripts for
    // just this rebuild of our own vetted dependency: `npm rebuild <pkg>` runs
    // only <pkg>'s scripts, so the blast radius is better-sqlite3 alone. Older
    // npm has no such gate and treats the unknown flag as an ignored config; if
    // it instead errors on the flag, fall back to the plain rebuild.
    try {
      exec(NATIVE_BINDING_REBUILD_CMD, { cwd: installDir, stdio: 'pipe' });
    } catch {
      exec('npm rebuild better-sqlite3', { cwd: installDir, stdio: 'pipe' });
    }
  });

  const first = await probe();
  if (first.ok) return { ok: true, action: 'verified' };

  try {
    await rebuild();
  } catch (e) {
    return { ok: false, error: `rebuild failed: ${e.message}` };
  }

  const second = await probe();
  if (second.ok) return { ok: true, action: 'rebuilt' };

  return { ok: false, error: second.error || first.error };
}

/**
 * Foreground heal for a user-invoked process (the CLI): rebuild the binding,
 * then RE-EXEC this process with its original argv and return the child's exit
 * code. The re-exec is not a convenience — better-sqlite3 dlopen's its .node
 * lazily and caches the handle, so a process that has already hit the stale
 * binary cannot use the fresh one: retrying in-process fails with "Module did
 * not self-register" (observed 2026-08-13 while healing this exact fault).
 *
 * Refuses to act when the guard env is already set, so a heal that does not
 * actually fix the binding cannot spawn an unbounded chain of children.
 *
 * @param {{installDir?: string, argv?: string[], env?: Record<string,string|undefined>, ensure?: () => Promise<{ok: boolean, action?: string, error?: string}>, reexec?: (argv: string[], env: Record<string,string|undefined>) => number, log?: (msg: string) => void}} opts
 * @returns {Promise<{healed: true, exitCode: number} | {healed: false, reason: string, error?: string}>}
 */
export async function healAndReexec(opts) {
  const {
    installDir,
    argv = process.argv,
    env = process.env,
    log = () => {},
  } = opts;
  const ensure = opts.ensure || (() => ensureBetterSqlite3Working(installDir));
  const reexec = opts.reexec || ((childArgv, childEnv) => {
    const r = spawnSync(childArgv[0], childArgv.slice(1), { stdio: 'inherit', env: childEnv });
    return typeof r.status === 'number' ? r.status : 1;
  });

  if (env[BINDING_HEAL_GUARD_ENV]) return { healed: false, reason: 'already-attempted' };

  log(`native DB binding unusable — rebuilding for this Node (${process.version})…`);
  let verify;
  try {
    verify = await ensure();
  } catch (e) {
    return { healed: false, reason: 'rebuild-failed', error: e.message };
  }
  if (!verify.ok) return { healed: false, reason: 'rebuild-failed', error: verify.error };

  log('binding rebuilt — retrying');
  const exitCode = reexec(argv, { ...env, [BINDING_HEAL_GUARD_ENV]: '1' });
  return { healed: true, exitCode };
}
