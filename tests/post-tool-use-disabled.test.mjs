// Audit P3-4: a plugin disabled in the Claude UI must stop growing runtime state.
//
// Pre-fix symptom: install.mjs writes DIRECT hook entries into ~/.claude/settings.json,
// so disabling the plugin in the UI (enabledPlugins["claude-mem-lite@sdsrss"] = false)
// leaves those hooks wired. hook.mjs:114 makes the Node side exit(0) when disabled, but
// the bash pre-filter's Read fast-path never reaches Node — it appended the read path to
// runtime/reads-<project>.txt on EVERY Read. The 24h sweep that reaps those files
// (sweepOrphanEpisodeFiles, called from runSessionStartAutoMaintain) lives behind that
// same exit(0), so nothing ever collected them: unbounded growth for a disabled plugin.
//
// The bash guard must agree with hook.mjs isPluginExplicitlyDisabled() — same key, same
// file, same fail-open-on-unreadable semantics. The drift guard at the bottom pins that.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-use.sh');
const HOOK_MJS = resolve(import.meta.dirname, '../hook.mjs');
const PLUGIN_KEY = 'claude-mem-lite@sdsrss';

const sandboxes = [];
function sandbox(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(d);
  return d;
}
afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop();
    try { chmodSync(join(d, '.claude', 'settings.json'), 0o600); } catch { /* not every sandbox has one */ }
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Run the bash pre-filter on a Read event against an isolated HOME.
 * `settings` === null writes no settings.json at all.
 */
function readEvent(settings, { filePath = '/home/user/secret-project/plan.md' } = {}) {
  const home = sandbox('mem-disabled-home-');
  const memDir = sandbox('mem-disabled-data-');
  if (settings !== null) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), settings);
  }
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify({
      session_id: 'disabled-guard-test',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: memDir,
      CLAUDE_PROJECT_DIR: '/tmp/org/proj',
      CLAUDE_MEM_HOOK_RUNNING: '',
    },
    encoding: 'utf8',
  });
  return { r, home, readsFile: join(memDir, 'runtime', 'reads-org--proj.txt') };
}

const settingsWith = (value) =>
  JSON.stringify({
    model: 'opus',
    enabledPlugins: { 'some-other@vendor': true, [PLUGIN_KEY]: value },
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash post-tool-use.sh' }] }] },
  }, null, 2);

describe('P3-4 disabled plugin stops appending reads-<project>.txt', () => {
  it('skips the append when the plugin is explicitly disabled', () => {
    const { r, readsFile } = readEvent(settingsWith(false));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(existsSync(readsFile), 'reads file must NOT be created while the plugin is disabled').toBe(false);
  });

  it('still appends when the plugin is enabled (no false positive)', () => {
    const { r, readsFile } = readEvent(settingsWith(true));
    expect(r.status).toBe(0);
    expect(existsSync(readsFile)).toBe(true);
    expect(readFileSync(readsFile, 'utf8')).toBe('/home/user/secret-project/plan.md\n');
  });

  it('still appends when the key is absent from enabledPlugins', () => {
    const { readsFile } = readEvent(JSON.stringify({ enabledPlugins: { 'other@vendor': false } }));
    expect(existsSync(readsFile)).toBe(true);
  });

  it('fails open when settings.json does not exist', () => {
    const { r, readsFile } = readEvent(null);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(existsSync(readsFile)).toBe(true);
  });

  it('fails open when settings.json is unreadable', () => {
    const home = sandbox('mem-disabled-home-');
    const memDir = sandbox('mem-disabled-data-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const sp = join(home, '.claude', 'settings.json');
    writeFileSync(sp, settingsWith(false));
    chmodSync(sp, 0o000);
    const r = spawnSync('bash', [SCRIPT], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x/y.mjs' } }),
      env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: memDir, CLAUDE_PROJECT_DIR: '/tmp/org/proj', CLAUDE_MEM_HOOK_RUNNING: '' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    // Unreadable settings === "cannot prove disabled" — hook.mjs's try/catch returns
    // false in the same situation, so the bash side must also treat it as enabled.
    const readsFile = join(memDir, 'runtime', 'reads-org--proj.txt');
    if (process.getuid?.() === 0) return; // root ignores mode 000; nothing to assert
    expect(existsSync(readsFile)).toBe(true);
  });

  it('keeps the owner-only perms on the append path (P3-2 stays fixed)', () => {
    const { readsFile } = readEvent(settingsWith(true));
    // umask 077 added by the sibling P3-2 fix — this asserts the disable guard did
    // not get inserted in a way that skips it.
    expect(statSync(readsFile).mode & 0o777).toBe(0o600);
  });
});

describe('bash/Node disable-detection parity', () => {
  const bash = readFileSync(SCRIPT, 'utf8');
  const nodeSrc = readFileSync(HOOK_MJS, 'utf8');

  it('both sides hard-code the same plugin key', () => {
    const nodeKey = (nodeSrc.match(/const PLUGIN_KEY = '([^']+)'/) || [])[1];
    expect(nodeKey).toBe(PLUGIN_KEY);
    expect(bash, 'post-tool-use.sh must carry the same key literal as hook.mjs PLUGIN_KEY').toContain(PLUGIN_KEY);
  });

  it('both sides read $HOME/.claude/settings.json (not CLAUDE_CONFIG_DIR)', () => {
    // hook.mjs uses join(homedir(), '.claude', 'settings.json'); honoring
    // CLAUDE_CONFIG_DIR on only one side would make the two disagree.
    expect(nodeSrc).toMatch(/join\(homedir\(\), '\.claude', 'settings\.json'\)/);
    expect(bash).toMatch(/\$\{?HOME\}?\/\.claude\/settings\.json/);
    // Comments may name the variable to explain why it is not honored; no CODE line may.
    const bashCode = bash.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(bashCode).not.toContain('CLAUDE_CONFIG_DIR');
  });
});
