import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { clearPluginDisabledMarkerForDirectInstall, hasOtherMarketplacePlugins } from '../install.mjs';

const INSTALL_PATH = resolve('install.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-install-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runInstall(command, home, args = []) {
  return execFileSync(process.execPath, [INSTALL_PATH, command, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('install lifecycle checks', () => {
  it('status reports stale hooks when plugin is disabled', () => {
    const home = makeTmpDir();
    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
        enabledPlugins: { 'claude-mem-lite@sdsrss': false },
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/tmp/.claude-mem-lite/hook.mjs" session-start' }] }],
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash "/tmp/.claude-mem-lite/scripts/post-tool-use.sh"' }] }]
        }
      }, null, 2));

      const output = runInstall('status', home);
      expect(output).toContain('Plugin: disabled in settings');
      expect(output).toContain('Hooks: still configured in settings.json while plugin is disabled');
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it('cleanup-hooks removes only claude-mem-lite hooks and preserves other settings', () => {
    const home = makeTmpDir();
    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        enabledPlugins: { 'claude-mem-lite@sdsrss': false, 'other@vendor': true },
        hooks: {
          SessionStart: [
            { matcher: '*', hooks: [{ type: 'command', command: 'node "/tmp/.claude-mem-lite/hook.mjs" session-start' }] },
            { matcher: '*', hooks: [{ type: 'command', command: 'node "/tmp/other-plugin/hook.mjs" startup' }] }
          ],
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: 'bash "/tmp/.claude-mem-lite/scripts/post-tool-use.sh"' }] }
          ]
        }
      }, null, 2));

      const output = runInstall('cleanup-hooks', home);
      expect(output).toContain('Removed 2 claude-mem-lite hook configurations');

      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(settings.enabledPlugins['claude-mem-lite@sdsrss']).toBe(false);
      expect(settings.enabledPlugins['other@vendor']).toBe(true);
      expect(settings.hooks.PostToolUse).toBeUndefined();
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('other-plugin');
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  it('direct install clears stale disabled plugin flag without touching other plugin flags', () => {
    const settings = {
      enabledPlugins: {
        'claude-mem-lite@sdsrss': false,
        'other@vendor': true,
      }
    };

    expect(clearPluginDisabledMarkerForDirectInstall(settings)).toBe(true);
    expect(settings.enabledPlugins['claude-mem-lite@sdsrss']).toBeUndefined();
    expect(settings.enabledPlugins['other@vendor']).toBe(true);
  });

  it('marketplace cleanup detection preserves shared publisher caches when other plugins remain', () => {
    expect(hasOtherMarketplacePlugins({
      plugins: {
        'claude-mem-lite@sdsrss': {},
        'other-tool@sdsrss': {},
      }
    })).toBe(true);

    expect(hasOtherMarketplacePlugins({
      plugins: {
        'claude-mem-lite@sdsrss': {},
        'other-tool@vendor': {},
      }
    })).toBe(false);
  });
});