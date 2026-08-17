// doctor / status / rebuild-binding, driven as SUBPROCESSES against real install shapes.
//
// Why this file exists (pre-tag review, BLOCKER-1): the v3.70.0 change to the
// diagnose→repair chain is ~161 lines in install.mjs, and reverting install.mjs to
// its pre-fix state left the whole 4584-test suite green. tests/install-shape.test.mjs
// covers the extracted helper, but the helper was never the bug — install.mjs asking
// the WRONG helper was. That is exactly the shape of the v3.60 outage: shipped green,
// broken for four days. So these tests assert the user-visible verdicts:
//
//   plugin-only + healthy            → exit 0, no ✗
//   managed tree's binding stale     → exit 1, and the message names THAT tree
//   rebuild-binding, broken non-host → exit 1 (not "success" on the healthy tree)
//
// Each case builds a HOME with real, resolvable trees. `withRealDeps` re-exports the
// repo's compiled better-sqlite3 through a per-root shim so every root is a DISTINCT
// path (dedup keys on the binding's realpath, so sharing one tree would collapse the
// roots and make multi-root assertions pass for the wrong reason).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const INSTALL_PATH = resolve(import.meta.dirname, '../install.mjs');
const REPO = resolve(import.meta.dirname, '..');
let home;

function withRealDeps(root) {
  const pkgDir = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.10.0', main: 'index.js' }));
  writeFileSync(join(pkgDir, 'index.js'),
    `module.exports = require(${JSON.stringify(join(REPO, 'node_modules', 'better-sqlite3'))});\n`);
  return root;
}

/** Present but unloadable — the stale-ABI shape, reachable via a real require(). */
function withBrokenDeps(root) {
  const pkgDir = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.10.0', main: 'index.js' }));
  writeFileSync(join(pkgDir, 'index.js'),
    'throw new Error("Could not locate the bindings file. Tried: fixture-stale-abi");\n');
  return root;
}

function pluginCacheDir(version) {
  return join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', version);
}

function makePluginVersion(version, { deps = 'real' } = {}) {
  const root = pluginCacheDir(version);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'launch.mjs'), '// launcher\n');
  for (const f of ['cli.mjs', 'server.mjs', 'hook.mjs']) writeFileSync(join(root, f), '// x\n');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [] }] } }));
  if (deps === 'real') withRealDeps(root);
  else if (deps === 'broken') withBrokenDeps(root);
  else writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version }));
  return root;
}

function makeManagedInstall({ deps = 'real' } = {}) {
  const root = join(home, '.claude-mem-lite');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  for (const f of ['server.mjs', 'hook.mjs', 'cli.mjs', 'mem-cli.mjs', 'install.mjs']) {
    writeFileSync(join(root, f), '// x\n');
  }
  if (deps === 'real') withRealDeps(root);
  else if (deps === 'broken') withBrokenDeps(root);
  return root;
}

function enablePlugin() {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'claude-mem-lite@sdsrss': true },
  }, null, 2));
}

function run(cmd, extraEnv = {}) {
  const env = { ...process.env, HOME: home, CLAUDE_MEM_SKIP_REPOS: '1' };
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_PLUGIN_ROOT$/.test(k)) delete env[k];
  }
  Object.assign(env, extraEnv);
  try {
    const stdout = execFileSync(process.execPath, [INSTALL_PATH, cmd], {
      encoding: 'utf8', env, timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const failLines = (out) => out.split('\n').filter((l) => l.includes('✗'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-docsh-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
});
afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Each `it` here spawns install.mjs, and on a 2-core CI runner a pile of those
// starves the other vitest workers into 20s timeouts. So related assertions share
// ONE spawn per shape rather than re-running doctor for each claim.
describe('doctor: a healthy plugin-only install is not an error', () => {
  it('exits 0, flags nothing, and prescribes nothing that does not exist', () => {
    makePluginVersion('3.69.1');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('doctor');
    expect(failLines(r.stdout), `doctor flagged a healthy plugin-only install:\n${r.stdout}`).toEqual([]);
    expect(r.code, `doctor exited ${r.code}\n${r.stdout}`).toBe(0);
    // The managed layout is not this install shape's to satisfy.
    expect(r.stdout).not.toMatch(/✗ server\.mjs: missing/);
    expect(r.stdout).not.toMatch(/✗ hook\.mjs: missing/);
    expect(r.stdout).not.toMatch(/Managed files: \d+ missing/);
    // `update` is the observation editor; the self-updater is `self-update`.
    expect(r.stdout).not.toMatch(/claude-mem-lite update(?!\s*<)/);
  });

  it('still FAILS a plugin-only install whose cache entry point is gone', () => {
    const root = makePluginVersion('3.69.1');
    rmSync(join(root, 'server.mjs'));
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('doctor');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Plugin cache v3\.69\.1: server\.mjs missing/);
  });
});

describe('doctor: a stale binding is found in whichever install owns it', () => {
  it('exits 1, NAMES the managed tree, and points the repair at THAT tree', () => {
    // The CLI's own tree (the repo, where install.mjs runs from) is healthy, so a
    // single-root probe answers "verified" — the v3.60 false-green.
    const managed = makeManagedInstall({ deps: 'broken' });
    const r = run('doctor');
    expect(r.code, `doctor exited ${r.code} on a broken managed tree\n${r.stdout}`).toBe(1);
    expect(r.stdout).toMatch(/better-sqlite3 unusable in .*managed install/);
    expect(r.stdout).toMatch(/Native DB binding: unusable in .*managed install/);
    // Sending the user to rebuild the healthy tree is how the pre-fix repair
    // "succeeded" while the broken install stayed broken.
    expect(r.stdout).toContain(`cd ${managed}`);
    expect(r.stdout).not.toMatch(new RegExp(`cd ${REPO}\\b`));
  });

  it('exits 1 when a CERTIFIED code home has no node_modules at all', () => {
    // ERR_MODULE_NOT_FOUND on every hook fire, and it is not in
    // NATIVE_BINDING_PATTERNS, so nothing else records it.
    const root = join(home, '.claude-mem-lite');
    mkdirSync(join(root, 'runtime'), { recursive: true });
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(root, f), '// x\n');
    const r = run('doctor');
    expect(r.code, `doctor exited ${r.code} on a managed install with no deps\n${r.stdout}`).toBe(1);
    expect(r.stdout).toMatch(/node_modules\/better-sqlite3 is absent/);
  });

  it('ignores a stale NON-ACTIVE cache version instead of going red forever', () => {
    // Claude Code never prunes; a never-started old version stays stale after a Node
    // upgrade. Reporting it made doctor permanently red about a tree nothing loads.
    makePluginVersion('3.69.1');
    makePluginVersion('3.66.1', { deps: 'broken' });
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('doctor');
    expect(failLines(r.stdout), `a dead cache version made doctor red:\n${r.stdout}`).toEqual([]);
    expect(r.code).toBe(0);
  });
});

describe('status: the plugin manifest doing its job is not two failures', () => {
  it('reports MCP and hooks as provided by the manifest', () => {
    makePluginVersion('3.69.1');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('status');
    expect(r.stdout).not.toMatch(/✗ MCP server: not registered/);
    expect(r.stdout).not.toMatch(/✗ Hooks: not configured/);
    expect(r.stdout).toMatch(/provided by the plugin manifest/);
  });

  it('still FAILS when neither the plugin nor settings.json provides hooks', () => {
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({}));
    const r = run('status');
    expect(r.stdout).toMatch(/✗ Hooks: not configured/);
  });
});

describe('rebuild-binding: repairs every broken tree, and says so honestly', () => {
  // One spawn: this command shells out to npm, so it is the most expensive case in
  // the file. Generous timeout for a cold 2-core runner.
  it('exits NON-zero, names the broken root, and keeps the breakage marker', () => {
    // Pre-fix this rebuilt bindingHostDir() — the healthy tree — and printed
    // `✓ ... verified`, so the documented repair reported success while the broken
    // install stayed broken.
    const managed = makeManagedInstall({ deps: 'broken' });
    const runtimeDir = join(managed, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const marker = join(runtimeDir, 'native-binding-broken.json');
    writeFileSync(marker, JSON.stringify({ ts: Date.now(), reason: 'seeded', event: 'test' }));

    const r = run('rebuild-binding');
    expect(r.code, `rebuild-binding exited ${r.code}\n${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/still unusable in .*managed install/);
    expect(r.stdout + r.stderr).toContain(managed);
    // Clearing the marker while a live tree is broken is what made the launcher
    // re-spawn npm every 6h forever (2026-08-13).
    expect(existsSync(marker), 'marker cleared while a tree was still broken').toBe(true);
  }, 120_000);
});
