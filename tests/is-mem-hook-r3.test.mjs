// R3 I-H1 (HIGH): isMemHook must not over-match a user's own hooks. The old
// `hook.mjs` + event-word clause classified `node ~/.config/hook.mjs session-start`
// (a user's generic hook) as ours → install/uninstall silently deleted it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMemHook, stripMemHooks } from '../lib/hook-prune.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const mk = (command) => ({ hooks: [{ type: 'command', command }] });

describe('isMemHook classifies real mem hooks (R3 I-H1)', () => {
  it('matches launcher-routed, install-path, and prefilter commands', () => {
    expect(
      isMemHook(mk('node "/home/me/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs session-start')),
    ).toBe(true);
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/hook.mjs" session-start'))).toBe(true); // legacy direct (install path)
    expect(isMemHook(mk('bash "/home/me/.claude-mem-lite/scripts/post-tool-use.sh"'))).toBe(true);
    expect(isMemHook(mk('node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" hook.mjs stop'))).toBe(true);
  });
});

describe("isMemHook must NOT delete a user's foreign hooks (R3 I-H1)", () => {
  it("does not match a user's own hook.mjs carrying an event arg", () => {
    expect(isMemHook(mk('node /home/me/.config/hook.mjs session-start'))).toBe(false);
    expect(isMemHook(mk('node /home/me/scripts/hook.mjs stop-daemon'))).toBe(false); // \bstop\b false-matched before
    expect(isMemHook(mk('node "/tmp/other-plugin/hook.mjs" user-prompt'))).toBe(false);
  });
  it('does not match an unrelated foreign command', () => {
    expect(isMemHook(mk('/usr/bin/my-linter'))).toBe(false);
    expect(isMemHook(mk('bash "/opt/tools/backup.sh" --daily'))).toBe(false);
  });
});

// E2E round 2026-09-29: the product-name clause was a bare substring and the test ran per
// GROUP, so `uninstall` deleted a user's `SessionEnd` hook that runs `claude-mem-lite export`,
// reinstall deleted a user's `~/tools/claude-mem-lite-prompt-audit.py` group, and a hook the
// user appended into OUR Stop group went with the group. settings.json.bak did not hold them.
describe('isMemHook leaves user hooks that merely mention the product', () => {
  it('does not match a user command that runs or names claude-mem-lite', () => {
    expect(isMemHook(mk('claude-mem-lite export > ~/backups/mem-$(date +%F).jsonl'))).toBe(false);
    expect(isMemHook(mk('python3 ~/tools/claude-mem-lite-prompt-audit.py'))).toBe(false);
    expect(isMemHook(mk('npx claude-mem-lite search "$PROMPT"'))).toBe(false);
  });
  it('still matches every command shape an install has written', () => {
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/hook.mjs" stop'))).toBe(true);
    expect(isMemHook(mk('node /home/me/.claude-mem-lite/hook.mjs post-tool-use'))).toBe(true);
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/scripts/user-prompt-search.js"'))).toBe(true);
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/scripts/pre-skill-bridge.js"'))).toBe(true);
    expect(isMemHook(mk('node "/home/me/claude-mem-lite/hook.mjs" session-start'))).toBe(true); // pre-v0.5 dir
    expect(isMemHook(mk('node "/home/me/src/claude-mem-lite-main/hook.mjs" stop'))).toBe(true); // zip checkout
    expect(isMemHook(mk('node "C:\\Users\\me\\.claude-mem-lite\\hook.mjs" stop'))).toBe(true);
    expect(isMemHook(mk('bash "/home/me/.claude-mem-lite/scripts/pre-tool-recall-bash.sh"'))).toBe(true);
  });
});

describe('stripMemHooks removes our entries, not the groups they sit in', () => {
  const ours = {
    type: 'command',
    command: 'node "/h/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop',
  };
  const user = { type: 'command', command: '/home/u/bin/log-stop.sh' };
  it("keeps a user's hook appended into our group", () => {
    const { kept, removed } = stripMemHooks([{ matcher: '*', hooks: [ours, user] }]);
    expect(kept).toEqual([{ matcher: '*', hooks: [user] }]);
    expect(removed).toBe(1);
  });
  it('drops a group that held only our hooks and counts hook entries, not groups', () => {
    const { kept, removed } = stripMemHooks([
      { matcher: '*', hooks: [ours, ours] },
      { hooks: [{ type: 'command', command: 'claude-mem-lite export > /tmp/x' }] },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].hooks[0].command).toMatch(/export/);
    expect(removed).toBe(2);
  });
  it('passes malformed entries through untouched', () => {
    const { kept, removed } = stripMemHooks([null, { matcher: 'x' }]);
    expect(kept).toEqual([null, { matcher: 'x' }]);
    expect(removed).toBe(0);
  });
});

// Wiring: the settings.json writer shared by `uninstall` and `cleanup-hooks` goes through
// stripMemHooks. Sandboxed HOME; no `claude` call is made by cleanup-hooks.
describe('cleanup-hooks keeps user hooks in and around our groups', () => {
  it('removes only our entries from a real settings.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-hookprune-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, '.claude'), { recursive: true });
      const p = join(home, '.claude', 'settings.json');
      const ours = 'node "/h/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop';
      writeFileSync(
        p,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                matcher: '*',
                hooks: [
                  { type: 'command', command: ours },
                  { type: 'command', command: '/u/log.sh' },
                ],
              },
            ],
            SessionEnd: [{ hooks: [{ type: 'command', command: 'claude-mem-lite export > ~/b.jsonl' }] }],
          },
        }),
      );
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'cleanup-hooks'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(root, 'data'), MEM_NO_AUTO_ADOPT: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Removed 1 claude-mem-lite hook configuration from/);
      const after = JSON.parse(readFileSync(p, 'utf8'));
      expect(after.hooks.Stop).toEqual([
        { matcher: '*', hooks: [{ type: 'command', command: '/u/log.sh' }] },
      ]);
      expect(after.hooks.SessionEnd[0].hooks[0].command).toMatch(/export/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// E2E round 2026-09-29 (install P1-8): with the plugin installed AND a direct install, the
// direct `install` empties the plugin's hooks.json so hooks do not fire twice. A later
// `cleanup-hooks` then removed the settings.json copy too, printed "Removed N …", and left
// the enabled plugin with no hooks at all — capture silently stopped. It now says so.
describe('cleanup-hooks warns when it leaves an enabled plugin with no hooks', () => {
  function pluginHome({ manifestHooks }) {
    const root = mkdtempSync(join(tmpdir(), 'cml-hookprune-plugin-'));
    const home = join(root, 'home');
    const cache = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '6.20.0');
    mkdirSync(join(cache, 'hooks'), { recursive: true });
    mkdirSync(join(cache, 'scripts'), { recursive: true });
    writeFileSync(join(cache, 'scripts', 'launch.mjs'), '// stub'); // what marks a cache dir startable
    writeFileSync(join(cache, 'package.json'), '{"name":"claude-mem-lite","version":"6.20.0"}');
    writeFileSync(join(cache, 'hooks', 'hooks.json'), JSON.stringify({ hooks: manifestHooks }));
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'claude-mem-lite@sdsrss': [{ installPath: cache, version: '6.20.0' }] },
      }),
    );
    const ours = 'node "/h/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop';
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'claude-mem-lite@sdsrss': true },
        hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: ours }] }] },
      }),
    );
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'cleanup-hooks'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(root, 'data'), MEM_NO_AUTO_ADOPT: '1' },
    });
    rmSync(root, { recursive: true, force: true });
    return r;
  }

  it('an emptied plugin manifest gets a warning and the repair', () => {
    const r = pluginHome({ manifestHooks: {} });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Removed 1 claude-mem-lite hook configuration/);
    expect(r.stdout).toMatch(/plugin's hooks\/hooks\.json registers none — every hook is now unregistered/);
    expect(r.stdout).toMatch(/reinstall the plugin|cp /);
  });

  it('a working plugin manifest needs no warning', () => {
    const r = pluginHome({ manifestHooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    expect(r.stdout).toMatch(/Removed 1/);
    expect(r.stdout).not.toMatch(/every hook is now unregistered/);
  });
});
