import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
const mockedExecSync = vi.mocked(execSync);
const originalFetch = globalThis.fetch;
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

function makeReleaseDir(version = '1.1.0') {
  const dir = makeDir('mem-update-release');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'registry'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-mem-lite', lockfileVersion: 3 }, null, 2));
  writeFileSync(join(dir, 'hook.mjs'), '// new hook');
  writeFileSync(join(dir, 'server.mjs'), '// new server');
  writeFileSync(join(dir, 'scripts', 'post-tool-use.sh'), '#!/usr/bin/env bash\necho ok\n');
  writeFileSync(join(dir, 'registry', 'preinstalled.json'), '{"resources":[]}');
  return dir;
}

async function loadModule(env = {}) {
  vi.resetModules();
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_MEM_SKIP_UPDATE;
  process.env.CLAUDE_MEM_DIR = env.CLAUDE_MEM_DIR;
  if (env.CLAUDE_PLUGIN_ROOT) process.env.CLAUDE_PLUGIN_ROOT = env.CLAUDE_PLUGIN_ROOT;
  return await import('../hook-update.mjs');
}

afterEach(() => {
  mockedExecSync.mockReset();
  globalThis.fetch = originalFetch;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_MEM_SKIP_UPDATE;
  delete process.env.CLAUDE_MEM_DIR;
  for (const dir of trackedDirs) rmSync(dir, { recursive: true, force: true });
  trackedDirs.clear();
});

describe('hook update lifecycle', () => {
  it('plugin mode only reports available updates and never installs them', async () => {
    const dataDir = makeDataDir();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root' });

    const result = await checkForUpdate({ force: true });
    expect(result).toMatchObject({ updateAvailable: true, updated: false, installDeferred: true, to: '1.1.0' });
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dataDir, 'runtime', 'update-state.json'), 'utf8')).latestVersion).toBe('1.1.0');
  });

  it('manual force check bypasses the throttle window', async () => {
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, 'runtime', 'update-state.json'), JSON.stringify({ lastCheck: new Date().toISOString(), installedVersion: '1.0.0', updateAvailable: false }, null, 2));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

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

    expect(installExtractedRelease(releaseDir, dataDir)).toBe(true);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('new hook');
    expect(readFileSync(join(dataDir, 'package-lock.json'), 'utf8')).toContain('lockfileVersion');
    expect(existsSync(join(dataDir, 'node_modules', 'new.txt'))).toBe(true);
    expect(existsSync(join(dataDir, 'node_modules', 'old.txt'))).toBe(false);
  });

  it('staged install restores prior files when npm install fails', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd) => {
      if (String(cmd).startsWith('npm install')) throw new Error('npm failed');
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(installExtractedRelease(releaseDir, dataDir)).toBe(false);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('old hook');
    expect(existsSync(join(dataDir, 'node_modules', 'old.txt'))).toBe(true);
    expect(readdirSync(dataDir).filter(name => name.startsWith('.update-'))).toHaveLength(0);
  });
});

