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
 * @param {{probe?: () => Promise<{ok: boolean, error?: string}>, rebuild?: () => Promise<void>}} [deps]
 * @returns {Promise<{ok: true, action: 'verified' | 'rebuilt'} | {ok: false, error: string}>}
 */
export async function ensureBetterSqlite3Working(installDir, deps = {}) {
  const probe = deps.probe || (() => probeBetterSqlite3Binding(installDir));
  const rebuild = deps.rebuild || (async () => {
    execSync('npm rebuild better-sqlite3', { cwd: installDir, stdio: 'pipe' });
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
