// v2.79 install-ergonomics regression tests:
//   1. setup.sh's deps-broken flag round-trip — present-deps path clears stale flag
//   2. collectOrphanHookPaths detects dead settings.json hook entries
//   3. doctor surfaces "Orphan hooks: N entries reference missing files"

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { collectOrphanHookPaths } from '../install.mjs';

const INSTALL_PATH = resolve('install.mjs');
const SETUP_PATH = resolve('scripts/setup.sh');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-ergon-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('setup.sh deps-broken flag round-trip (v2.79)', () => {
  it('clears stale .deps-broken when node_modules/better-sqlite3 is already present (symlink path)', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });

      // Seed a stale flag from a previous failing session
      const flag = join(dataDir, 'runtime', '.deps-broken');
      writeFileSync(flag, '{"ts":"old","reason":"prev"}\n');
      expect(existsSync(flag)).toBe(true);

      // Symlink path: deps live in DATA_DIR/node_modules, setup.sh symlinks into pluginRoot
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      expect(existsSync(flag)).toBe(false);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it('clears stale .deps-broken when node_modules already exists at pluginRoot (no-op path)', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      // Place better-sqlite3 directly in pluginRoot so the entire setup #6 block short-circuits
      symlinkSync(resolve('node_modules'), join(pluginRoot, 'node_modules'));

      const flag = join(dataDir, 'runtime', '.deps-broken');
      writeFileSync(flag, '{"ts":"old","reason":"prev"}\n');

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      expect(existsSync(flag)).toBe(false);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('collectOrphanHookPaths (v2.79)', () => {
  it('returns empty for settings with no hooks', () => {
    expect(collectOrphanHookPaths({})).toEqual([]);
    expect(collectOrphanHookPaths({ hooks: {} })).toEqual([]);
  });

  it('returns empty for non-mem hooks even when paths are missing', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "/no/such/other/hook.mjs"' }],
        }],
      },
    };
    expect(collectOrphanHookPaths(settings)).toEqual([]);
  });

  it('flags mem hooks pointing at missing absolute paths', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "/tmp/nonexistent-claude-mem-lite/hook.mjs" session-start' }],
        }],
        PostToolUse: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'bash "/tmp/nonexistent-claude-mem-lite/scripts/post-tool-use.sh"' }],
        }],
      },
    };
    const orphans = collectOrphanHookPaths(settings);
    expect(orphans).toContain('/tmp/nonexistent-claude-mem-lite/hook.mjs');
    expect(orphans).toContain('/tmp/nonexistent-claude-mem-lite/scripts/post-tool-use.sh');
  });

  it('ignores ${CLAUDE_PLUGIN_ROOT}-templated hooks (those are plugin-owned, runtime-resolved)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" session-start' }],
        }],
      },
    };
    expect(collectOrphanHookPaths(settings)).toEqual([]);
  });

  it('skips hooks whose target path exists on disk', () => {
    // Use the install.mjs itself — we know it exists since the test is running.
    const real = INSTALL_PATH;
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: `node "${real}" session-start` }],
        }],
      },
    };
    expect(collectOrphanHookPaths(settings)).toEqual([]);
  });

  it('deduplicates repeated missing paths across hook events', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "/tmp/nonexistent-claude-mem-lite/hook.mjs" session-start' }],
        }],
        Stop: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "/tmp/nonexistent-claude-mem-lite/hook.mjs" stop' }],
        }],
      },
    };
    const orphans = collectOrphanHookPaths(settings);
    expect(orphans.filter(p => p === '/tmp/nonexistent-claude-mem-lite/hook.mjs')).toHaveLength(1);
  });
});

describe('doctor surfaces orphan hooks (v2.79)', () => {
  it('emits "Orphan hooks:" line with file count and repair hint', () => {
    const home = makeTmpDir();
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      // Seed settings.json with mem hooks pointing at a non-existent install root
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: '*',
            hooks: [{
              type: 'command',
              command: 'node "/tmp/nonexistent-claude-mem-lite-doctor/hook.mjs" session-start',
            }],
          }],
        },
      }, null, 2));

      let output = '';
      try {
        output = execFileSync(process.execPath, [INSTALL_PATH, 'doctor'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        // doctor exits non-zero on issues — capture stdout from the error object
        output = (e.stdout || '') + (e.stderr || '');
      }

      expect(output).toMatch(/Orphan hooks:.*settings\.json/);
      expect(output).toContain('/tmp/nonexistent-claude-mem-lite-doctor/hook.mjs');
      expect(output).toMatch(/Repair:.*install\.mjs uninstall/);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });
});
