// lib/binding-probe.mjs — better-sqlite3 native binding probe + auto-rebuild.
//
// Shared by install.mjs (verify after `npm install`) and scripts/launch.mjs
// (verify before launching the MCP server). `npm install` exits 0 even when
// the prebuilt .node binary mismatches the running Node ABI (e.g. ABI v137 on
// Node v24), and the presence of node_modules/better-sqlite3/ on disk is not
// sufficient — the binding can be present-but-stale after a Node upgrade.

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

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
  const exec = deps.exec || execSync;
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
      exec('npm rebuild better-sqlite3 --dangerously-allow-all-scripts', { cwd: installDir, stdio: 'pipe' });
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
