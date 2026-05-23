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
const REPO_NODE_MODULES = resolve('node_modules');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-ergon-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// v2.80 test hygiene: doctor-style tests inherit user env by default; an
// outer CLAUDE_PLUGIN_ROOT (e.g. running tests inside a plugin-mode harness)
// would change doctor's plugin-detection branch and break assumptions.
// Strip it explicitly per call so the test environment is hermetic.
function envWithoutPluginRoot(extra = {}) {
  const { CLAUDE_PLUGIN_ROOT: _stripped, ...rest } = process.env;
  return { ...rest, ...extra };
}

describe('setup.sh deps-broken flag round-trip (v2.79)', () => {
  // v2.80: each test asserts existsSync(REPO_NODE_MODULES) at entry so the
  // symlink-from-data-dir path can't silently fall back to the slow
  // npm-install branch when the test runner lacks node_modules (test-only
  // Docker stage, etc.). A dangling symlink would otherwise exercise the
  // wrong code path and report a false pass.
  it('clears stale .deps-broken when node_modules/better-sqlite3 is already present (symlink path)', () => {
    expect(existsSync(REPO_NODE_MODULES)).toBe(true);
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
      symlinkSync(REPO_NODE_MODULES, join(dataDir, 'node_modules'));

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
    expect(existsSync(REPO_NODE_MODULES)).toBe(true);
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      // Place better-sqlite3 directly in pluginRoot so the entire setup #6 block short-circuits
      symlinkSync(REPO_NODE_MODULES, join(pluginRoot, 'node_modules'));

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

  it('picks the path-shaped quoted token even when an earlier non-path quoted token comes first (v2.80)', () => {
    // Footgun guard: wrapper commands like `bash -c "do stuff" "/real/path.sh"`
    // pre-v2.80 picked "do stuff", existsSync()'d false, and false-flagged
    // the wrapper as an orphan. v2.80 scans all quoted tokens and prefers
    // ones that look like a hook path; falls back to unquoted only if none qualify.
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{
            type: 'command',
            command: 'bash -c "claude-mem-lite tracer; exec bash" "/tmp/nonexistent-claude-mem-lite/scripts/wrapped.sh"',
          }],
        }],
      },
    };
    const orphans = collectOrphanHookPaths(settings);
    expect(orphans).toEqual(['/tmp/nonexistent-claude-mem-lite/scripts/wrapped.sh']);
    expect(orphans).not.toContain('claude-mem-lite tracer; exec bash');
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
          env: envWithoutPluginRoot({ HOME: home }),
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
