import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
const mockedExecSync = vi.mocked(execSync);
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const trackedDirs = new Set();

function makeDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  trackedDirs.add(dir);
  return dir;
}

function makeDataDir(version = '1.0.0') {
  const dir = makeDir('mem-update-data');
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-mem-lite', lockfileVersion: 3 }, null, 2));
  writeFileSync(join(dir, 'server.mjs'), '// server');
  writeFileSync(join(dir, 'hook.mjs'), '// old hook');
  writeFileSync(join(dir, 'node_modules', 'old.txt'), 'old');
  return dir;
}

// Code/install dir is ALWAYS homedir-rooted (~/.claude-mem-lite), independent of
// CLAUDE_MEM_DIR relocation — Claude Code bakes absolute paths to server.mjs/hooks
// there. os.homedir() honors $HOME on POSIX, so HOME steers CODE_DIR in tests.
// A regular-file server.mjs (not a symlink) keeps isDevMode() false.
function makeCodeHome(version = '1.0.0') {
  const home = makeDir('mem-update-home');
  const codeDir = join(home, '.claude-mem-lite');
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(codeDir, 'server.mjs'), '// code server');
  return { home, codeDir };
}

function makeReleaseDir(version = '1.1.0') {
  const dir = makeDir('mem-update-release');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'registry'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-mem-lite', lockfileVersion: 3 }, null, 2));
  writeFileSync(join(dir, 'hook.mjs'), '// new hook');
  writeFileSync(join(dir, 'server.mjs'), '// new server');
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\n// new cli\n');
  writeFileSync(join(dir, 'scripts', 'post-tool-use.sh'), '#!/usr/bin/env bash\necho ok\n');
  writeFileSync(join(dir, 'registry', 'preinstalled.json'), '{"resources":[]}');
  return dir;
}

async function loadModule(env = {}) {
  vi.resetModules();
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_MEM_SKIP_UPDATE;
  process.env.CLAUDE_MEM_DIR = env.CLAUDE_MEM_DIR;
  if (env.HOME) process.env.HOME = env.HOME;
  if (env.CLAUDE_PLUGIN_ROOT) process.env.CLAUDE_PLUGIN_ROOT = env.CLAUDE_PLUGIN_ROOT;
  return await import('../hook-update.mjs');
}

afterEach(() => {
  mockedExecSync.mockReset();
  globalThis.fetch = originalFetch;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_MEM_SKIP_UPDATE;
  delete process.env.CLAUDE_MEM_DIR;
  process.env.HOME = originalHome;
  for (const dir of trackedDirs) rmSync(dir, { recursive: true, force: true });
  trackedDirs.clear();
});

describe('hook update lifecycle', () => {
  it('plugin mode only reports available updates and never installs them', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    const result = await checkForUpdate({ force: true });
    expect(result).toMatchObject({ updateAvailable: true, updated: false, installDeferred: true, to: '1.1.0' });
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dataDir, 'runtime', 'update-state.json'), 'utf8')).latestVersion).toBe('1.1.0');
  });

  it('manual force check bypasses the throttle window', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, 'runtime', 'update-state.json'), JSON.stringify({ lastCheck: new Date().toISOString(), installedVersion: '1.0.0', updateAvailable: false }, null, 2));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });

    expect(await checkForUpdate()).toBeNull();
    const result = await checkForUpdate({ force: true, allowInstall: false });
    expect(result).toMatchObject({ updateAvailable: true, installDeferred: true, to: '1.1.0' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('staged install swaps files only after npm install succeeds', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
        writeFileSync(join(opts.cwd, 'node_modules', 'new.txt'), 'new');
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('new hook');
    expect(readFileSync(join(dataDir, 'package-lock.json'), 'utf8')).toContain('lockfileVersion');
    expect(existsSync(join(dataDir, 'node_modules', 'new.txt'))).toBe(true);
    expect(existsSync(join(dataDir, 'node_modules', 'old.txt'))).toBe(false);
  });

  // Regression v2.73.1: copyFileSync preserves source mode and git stores
  // cli.mjs as 100644 — without the chmod inside copyReleaseIntoStaging the
  // ~/.local/bin/claude-mem-lite → cli.mjs symlink target loses its +x bit
  // after every auto-update, dying with "Permission denied" on next CLI call.
  // POSIX-only: Windows has no chmod semantics, so the assertion is skipped.
  it.skipIf(process.platform === 'win32')('staged install marks cli.mjs executable after auto-update', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    const installedCli = join(dataDir, 'cli.mjs');
    expect(existsSync(installedCli)).toBe(true);
    // Any of owner/group/other execute bits proves chmod ran (POSIX mode mask)
    expect(statSync(installedCli).mode & 0o111).not.toBe(0);
  });

  it('staged install restores prior files when npm install fails', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd) => {
      if (String(cmd).startsWith('npm install')) throw new Error('npm failed');
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(false);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('old hook');
    expect(existsSync(join(dataDir, 'node_modules', 'old.txt'))).toBe(true);
    expect(readdirSync(dataDir).filter(name => name.startsWith('.update-'))).toHaveLength(0);
  });

  // Regression: scripts/ is curated to HOOK_SCRIPT_FILES only — dev-only
  // helpers (mock-claude.mjs, extract-repos.mjs, p0-forward-probe.mjs…) and
  // any future subdirectories MUST NOT leak into ~/.claude-mem-lite/scripts/.
  // Pre-v2.55 hook-update did a recursive copy of the whole scripts/ tree and
  // shipped every dev-only file from the GitHub Releases tarball.
  it('staged install curates scripts/ to HOOK_SCRIPT_FILES and skips dev-only files', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    // Add the rest of HOOK_SCRIPT_FILES so we can assert all five land
    writeFileSync(join(releaseDir, 'scripts', 'user-prompt-search.js'), '// search');
    writeFileSync(join(releaseDir, 'scripts', 'prompt-search-utils.mjs'), '// utils');
    writeFileSync(join(releaseDir, 'scripts', 'pre-tool-recall.js'), '// recall');
    writeFileSync(join(releaseDir, 'scripts', 'pre-skill-bridge.js'), '// bridge');
    // Dev-only file + nested helper subdir — neither should land in dataDir
    writeFileSync(join(releaseDir, 'scripts', 'mock-claude.mjs'), '// dev-only');
    mkdirSync(join(releaseDir, 'scripts', 'helpers'), { recursive: true });
    writeFileSync(join(releaseDir, 'scripts', 'helpers', 'tool.mjs'), '// nested');
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    // All five curated hook scripts land
    for (const name of ['post-tool-use.sh', 'user-prompt-search.js', 'prompt-search-utils.mjs', 'pre-tool-recall.js', 'pre-skill-bridge.js']) {
      expect(existsSync(join(dataDir, 'scripts', name))).toBe(true);
    }
    // Dev-only file + nested helper subdir do not land
    expect(existsSync(join(dataDir, 'scripts', 'mock-claude.mjs'))).toBe(false);
    expect(existsSync(join(dataDir, 'scripts', 'helpers'))).toBe(false);
  });

  // Regression v2.84: pre-fix, copyReleaseIntoStaging + SWITCHABLE_PATHS used
  // SOURCE_FILES imported from the *currently-installed* source-files.mjs (i.e.
  // the local module), so any file added to the manifest in a newer release got
  // silently dropped during the very auto-update that introduced it. Concrete
  // hit: v2.80.x → v2.81.0 auto-update copied the new hook.mjs (it was already
  // in the v2.80 manifest) but skipped lib/cite-back-hint.mjs (added in v2.81)
  // → hook.mjs ERR_MODULE_NOT_FOUND on first SessionStart, hook chain dead,
  // self-update can no longer run to repair itself. Fix: read the tarball's
  // own source-files.mjs and use its SOURCE_FILES / HOOK_SCRIPT_FILES.
  it('staged install honors the tarball-bundled source-files manifest, not the installed one', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();

    // A file the *installed* source-files.mjs has no knowledge of, but which
    // the *tarball* manifest declares ships with the release.
    const newRelPath = 'lib/added-after-installed.mjs';
    mkdirSync(join(releaseDir, 'lib'), { recursive: true });
    writeFileSync(join(releaseDir, newRelPath), '// added in newer release\n');
    writeFileSync(
      join(releaseDir, 'source-files.mjs'),
      "export const SOURCE_FILES = ['hook.mjs', 'server.mjs', 'cli.mjs', 'package.json', 'package-lock.json', 'source-files.mjs', '" +
        newRelPath +
        "'];\nexport const HOOK_SCRIPT_FILES = ['post-tool-use.sh'];\n",
    );

    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    expect(existsSync(join(dataDir, newRelPath))).toBe(true);
    expect(readFileSync(join(dataDir, newRelPath), 'utf8')).toContain('added in newer release');
  });

  // Regression: pre-v2.55 readdirSync + copyFileSync threw EISDIR on any
  // subdirectory under registry/, silently rolling back the entire update.
  // registry/ stays recursive so future subtrees ship intact.
  it('staged install recursively copies subdirectories under registry/', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mkdirSync(join(releaseDir, 'registry', 'fixtures'), { recursive: true });
    writeFileSync(join(releaseDir, 'registry', 'fixtures', 'sample.json'), '{}');
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    expect(existsSync(join(dataDir, 'registry', 'fixtures', 'sample.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'registry', 'preinstalled.json'))).toBe(true);
  });
});

// Regression D#27: hook-update.mjs:19 set INSTALL_DIR = DB_DIR, conflating the
// plugin CODE location (server.mjs / package.json / install target — always
// homedir-rooted because Claude Code bakes absolute paths there) with the DATA
// location (runtime/update-state — env-aware via CLAUDE_MEM_DIR). Under
// relocation (CLAUDE_MEM_DIR set ≠ homedir) auto-update read the version from
// and switched files into the *data* dir, so it never found/updated the real
// server.mjs. State, by contrast, correctly belongs in the data dir (install.mjs
// doctor reads MEM_DATA_DIR/runtime/update-state.json). Fix: INSTALL_DIR = CODE_DIR
// (homedir), STATE_DIR = DB_DIR (data).
describe('code/data dir separation under relocation (D#27)', () => {
  it('getCurrentVersion reads the homedir code dir, not the relocated CLAUDE_MEM_DIR data dir', async () => {
    const { home } = makeCodeHome('2.0.0');          // real code install → 2.0.0
    const dataDir = makeDataDir('1.0.0');            // relocated data dir holds a 1.0.0 decoy package.json
    const { getCurrentVersion } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    // Pre-fix INSTALL_DIR = DB_DIR = dataDir → would read the 1.0.0 decoy.
    expect(getCurrentVersion()).toBe('2.0.0');
  });

  it('installExtractedRelease defaults its target to the homedir code dir, not CLAUDE_MEM_DIR', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    writeFileSync(join(codeDir, 'hook.mjs'), '// old hook');
    mkdirSync(join(codeDir, 'node_modules'), { recursive: true });
    const dataDir = makeDataDir('1.0.0');            // data dir keeps its own hook.mjs that must stay untouched
    const releaseDir = makeReleaseDir('1.1.0');
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });

    // No explicit targetDir → must default to the code dir, not the relocated data dir.
    expect(await installExtractedRelease(releaseDir)).toBe(true);
    expect(readFileSync(join(codeDir, 'hook.mjs'), 'utf8')).toContain('new hook');   // code dir updated
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('old hook');   // data dir untouched
  });

  it('update state still lands in the CLAUDE_MEM_DIR data dir, not the code dir', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir('1.0.0');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    await checkForUpdate({ force: true });
    // State path mirrors hook-shared RUNTIME_DIR (= DB_DIR/runtime) and install.mjs
    // doctor's MEM_DATA_DIR/runtime/update-state.json — it must NOT follow the code dir.
    expect(existsSync(join(dataDir, 'runtime', 'update-state.json'))).toBe(true);
    expect(existsSync(join(codeDir, 'runtime', 'update-state.json'))).toBe(false);
  });
});

describe('rate-limit handling + malformed-response robustness', () => {
  it('persists rateLimited=true on a 403 instead of clobbering it (regression)', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir('1.0.0');
    const statePath = join(dataDir, 'runtime', 'update-state.json');
    writeFileSync(statePath, JSON.stringify({ lastCheck: new Date(0).toISOString(), rateLimited: false }));
    // GitHub 403 → fetchWithTimeout writes rateLimited:true; the !latest branch must not
    // clobber it back to false with a stale in-memory snapshot.
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    const result = await checkForUpdate({ force: true });
    expect(result).toBeNull();
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.rateLimited).toBe(true);
  });

  it('falls through to the tags API when releases/latest returns 200 with no tag_name (no crash)', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir('1.0.0');
    // 1st call (releases/latest): 200 OK but malformed body {}. 2nd call (tags): valid.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([{ name: 'v1.1.0' }]) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    const result = await checkForUpdate({ force: true });
    expect(result).toMatchObject({ updateAvailable: true, to: '1.1.0' });
  });
});

describe('cache hook residue clearing', () => {
  it('clears populated hooks.json in every remaining cache version', async () => {
    const home = makeDir('mem-cache-residue');
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    for (const v of ['2.28.0', '2.31.0']) {
      mkdirSync(join(cacheBase, v, 'hooks'), { recursive: true });
      writeFileSync(join(cacheBase, v, 'hooks', 'hooks.json'), JSON.stringify({
        description: 'original', hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] },
      }));
    }
    // A third version with already-empty hooks.json should be untouched.
    mkdirSync(join(cacheBase, '2.30.0', 'hooks'), { recursive: true });
    writeFileSync(join(cacheBase, '2.30.0', 'hooks', 'hooks.json'), JSON.stringify({ description: 'empty', hooks: {} }));

    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { clearCacheHookResidue } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      expect(clearCacheHookResidue()).toBe(2);

      for (const v of ['2.28.0', '2.31.0']) {
        const after = JSON.parse(readFileSync(join(cacheBase, v, 'hooks', 'hooks.json'), 'utf8'));
        expect(after.hooks).toEqual({});
        expect(after._note).toMatch(/hook-update\.mjs post-install/);
      }
      const empty = JSON.parse(readFileSync(join(cacheBase, '2.30.0', 'hooks', 'hooks.json'), 'utf8'));
      expect(empty._note).toBeUndefined();
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('returns 0 when cache base does not exist', async () => {
    const home = makeDir('mem-cache-residue-empty');
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { clearCacheHookResidue } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      expect(clearCacheHookResidue()).toBe(0);
    } finally {
      process.env.HOME = origHome;
    }
  });
});

describe('plugin cache pruning', () => {
  it('removes old versions and keeps the latest 3', async () => {
    const home = makeDir('mem-prune-home');
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    const versions = ['1.0.0', '1.1.0', '2.0.0', '2.1.0', '2.5.0'];
    for (const v of versions) {
      mkdirSync(join(cacheBase, v), { recursive: true });
      writeFileSync(join(cacheBase, v, 'server.mjs'), `// v${v}`);
    }

    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { prunePluginCache } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      const removed = prunePluginCache();
      expect(removed).toBe(2);

      const remaining = readdirSync(cacheBase).sort();
      expect(remaining).toEqual(['2.0.0', '2.1.0', '2.5.0']);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('does nothing when 3 or fewer versions exist', async () => {
    const home = makeDir('mem-prune-home2');
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    for (const v of ['1.0.0', '2.0.0']) {
      mkdirSync(join(cacheBase, v), { recursive: true });
    }

    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { prunePluginCache } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      expect(prunePluginCache()).toBe(0);
      expect(readdirSync(cacheBase)).toHaveLength(2);
    } finally {
      process.env.HOME = origHome;
    }
  });
});

describe('validateExtractedTarball', () => {
  function makeTarballDir({ name = 'claude-mem-lite', version = '2.57.0', entries = ['cli.mjs', 'server.mjs', 'hook.mjs'], skipPkg = false } = {}) {
    const dir = makeDir('mem-tarball-validate');
    if (!skipPkg) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
    }
    for (const f of entries) {
      writeFileSync(join(dir, f), `// ${f}`);
    }
    return dir;
  }

  it('accepts a well-formed tarball when version matches', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ version: '2.57.0' });
    expect(validateExtractedTarball(dir, '2.57.0')).toEqual({ ok: true });
  });

  it('rejects when package.json is missing', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ skipPkg: true });
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/package\.json missing/);
  });

  it('rejects when package.json is unparseable', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ skipPkg: true });
    writeFileSync(join(dir, 'package.json'), '{not valid json');
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unparseable/);
  });

  it('rejects when name is wrong (repo squatter / rename)', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ name: 'malicious-clone' });
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/name "malicious-clone"/);
  });

  it('rejects when version does not match the resolved tag', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ version: '2.50.0' });
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/version "2\.50\.0".*"2\.57\.0"/);
  });

  it('rejects when an entry-point file is missing', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ entries: ['cli.mjs', 'server.mjs'] }); // no hook.mjs
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/entry-point file missing: hook\.mjs/);
  });

  it('skips version match when expectedVersion is not provided (release-resolution shortcut)', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ version: '99.99.99' });
    expect(validateExtractedTarball(dir)).toEqual({ ok: true });
  });

  it('honors expectedName override (for fork installs)', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ name: 'forked-mem-lite', version: '1.0.0' });
    expect(validateExtractedTarball(dir, '1.0.0', 'forked-mem-lite')).toEqual({ ok: true });
  });
});

describe('non-blocking SessionStart helpers (P3d)', () => {
  function seedState(dataDir, state) {
    writeFileSync(join(dataDir, 'runtime', 'update-state.json'), JSON.stringify(state, null, 2));
  }

  it('getCachedUpdateBanner returns the available banner from cached state — no network', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    seedState(dataDir, { lastCheck: new Date().toISOString(), installedVersion: '1.0.0', latestVersion: '1.2.0', updateAvailable: true });
    globalThis.fetch = vi.fn(); // must NOT be called
    const { getCachedUpdateBanner } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });
    const banner = getCachedUpdateBanner();
    expect(banner).toContain('v1.2.0 available');
    expect(banner).toContain('current: v1.0.0');
    expect(banner).toContain('plugin mode'); // plugin-mode hint
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('getCachedUpdateBanner returns null when no update is cached', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    seedState(dataDir, { lastCheck: new Date().toISOString(), installedVersion: '1.0.0', updateAvailable: false });
    const { getCachedUpdateBanner } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    expect(getCachedUpdateBanner()).toBeNull();
  });

  it('isUpdateCheckDue is true with no prior check and false right after one', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    const { isUpdateCheckDue } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    expect(isUpdateCheckDue()).toBe(true); // no state file → never checked
    seedState(dataDir, { lastCheck: new Date().toISOString(), installedVersion: '1.0.0', updateAvailable: false });
    const { isUpdateCheckDue: due2 } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    expect(due2()).toBe(false); // just checked → throttled
  });

  it('isUpdateCheckDue is false when CLAUDE_MEM_SKIP_UPDATE is set', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    const mod = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    process.env.CLAUDE_MEM_SKIP_UPDATE = '1';
    expect(mod.isUpdateCheckDue()).toBe(false);
    expect(mod.getCachedUpdateBanner()).toBeNull();
  });
});

