// `mem` is the pre-v2.78 name of our MCP server — and a generic one: the MCP reference
// memory server is commonly registered under it. install, uninstall and the plugin's
// setup.sh all removed a user-scope `mem` without looking at what it ran, so a user's
// unrelated `mem` server disappeared on install, on uninstall, and on the first SessionStart
// of the plugin (the recommended install path), with no line saying so on the first two.
// A `mem` registration is ours only when it runs our server.
//
// §8.V3: every case runs against a sandbox HOME; `claude` is a fake that records its argv.
import { describe, it, expect, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeFixtureTracker } from './test-helpers.mjs';
import { isOurMcpRegistration, OUR_MCP_SERVER_RE } from '../install.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const FOREIGN = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
const LEGACY_OURS = { command: 'node', args: ['/home/u/.claude-mem-lite/server.mjs'] };

describe('isOurMcpRegistration', () => {
  it('claims a `mem` entry only when it runs our server', () => {
    expect(isOurMcpRegistration('mem', LEGACY_OURS)).toBe(true);
    expect(
      isOurMcpRegistration('mem', { command: 'node', args: ['C:\\Users\\u\\.claude-mem-lite\\server.mjs'] }),
    ).toBe(true);
    expect(
      isOurMcpRegistration('mem', { command: 'node', args: ['/x/claude-mem-lite/scripts/launch.mjs'] }),
    ).toBe(true);
    expect(isOurMcpRegistration('mem', FOREIGN)).toBe(false);
    expect(isOurMcpRegistration('mem', { command: 'node', args: ['/opt/mem/server.mjs'] })).toBe(false);
    expect(isOurMcpRegistration('mem', null)).toBe(false);
  });
  it('always claims our current name', () => {
    expect(isOurMcpRegistration('mem-lite', FOREIGN)).toBe(true);
  });
});

function sandbox(mcpServers) {
  const root = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-mcp-own-')));
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers }, null, 2));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'claude-calls.log');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> "${calls}"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: root,
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_MEM_DIR: join(root, 'data'),
    CLAUDE_MEM_SKIP_UPDATE: '1',
    MEM_NO_AUTO_ADOPT: '1',
  };
  const recorded = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  return { root, home, env, recorded };
}

describe('uninstall removes `mem` only when it is ours', () => {
  it("leaves a user's own `mem` server and says so", () => {
    const s = sandbox({ mem: FOREIGN });
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'uninstall'], {
      env: s.env,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(s.recorded()).toMatch(/mcp remove -s user mem-lite/);
    expect(s.recorded()).not.toMatch(/mcp remove -s user mem\n/);
    expect(r.stdout).toMatch(/"mem".*left in place/);
  });
  it('still removes a legacy registration of ours', () => {
    const s = sandbox({ mem: LEGACY_OURS });
    spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'uninstall'], { env: s.env, encoding: 'utf8' });
    expect(s.recorded()).toMatch(/mcp remove -s user mem\n/);
  });
});

describe("plugin setup.sh's one-shot MCP purge", () => {
  it('uses the same ownership pattern as install.mjs', () => {
    const setup = readFileSync(join(REPO, 'scripts', 'setup.sh'), 'utf8');
    expect(setup).toContain(OUR_MCP_SERVER_RE.source);
  });

  function runSetup(mcpServers) {
    const s = sandbox(mcpServers);
    const dataDir = join(s.home, '.claude-mem-lite');
    const pluginRoot = join(s.home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    symlinkSync(join(REPO, 'node_modules'), join(dataDir, 'node_modules'));
    spawnSync('bash', [join(REPO, 'scripts', 'setup.sh')], {
      env: { ...s.env, CLAUDE_MEM_DIR: '', CLAUDE_PLUGIN_ROOT: pluginRoot },
      encoding: 'utf8',
    });
    return JSON.parse(readFileSync(join(s.home, '.claude.json'), 'utf8')).mcpServers;
  }

  it("keeps a user's own `mem` server", () => {
    expect(runSetup({ mem: FOREIGN, 'mem-lite': LEGACY_OURS })).toEqual({ mem: FOREIGN });
  });
  it('removes a legacy `mem` of ours', () => {
    expect(runSetup({ mem: LEGACY_OURS, github: FOREIGN })).toEqual({ github: FOREIGN });
  });
});
