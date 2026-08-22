// Regression pins for the 2026-08-22 audit, P1-3 — the last un-collapsed CLI/MCP twin.
//
// `registry import|remove|reindex` was the only pair of the five twins where both sides
// still wrote their own SQL. The drift the audit found: the CLI granted a freshly imported
// resource `quality_tier = 'installed'` (mem-cli.mjs:2358 — "the user explicitly chose to
// add this"), and the MCP twin did not. Same user intent, two different rows, and
// quality_tier feeds the retriever's ranking bonus + the recommendation gate, so the
// import route silently decided how discoverable the resource would be.
//
// The failing input, stated plainly: import `parity-probe` with no --source on each side,
// then read back quality_tier. Pre-fix CLI = 'installed', MCP = the schema default.
//
// Both cases run through the REAL surfaces (spawned cli.mjs / server.mjs over stdio), not
// through lib/registry-core.mjs directly — a shared core that no surface actually calls is
// exactly the failure mode this pins against.
//
// ISOLATION: every child gets CLAUDE_MEM_DIR + HOME inside a mkdtemp sandbox and a cwd
// inside it, so nothing touches the live ~/.claude-mem-lite DB or this repo.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');
const SERVER_PATH = join(REPO, 'server.mjs');

let ROOT, HOME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-parity0822-'));
  HOME_DIR = join(ROOT, 'home');
  mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });

  BASE_ENV = { ...process.env };
  // The developer's own plugin flags would otherwise flip default-OFF surfaces on in the
  // child (the #8608 leak class).
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    HOME: HOME_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),   // no LLM spend, no network
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
  });
  delete BASE_ENV.CLAUDE_PROJECT_DIR;
  delete BASE_ENV.PWD;
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function sandboxDir(...parts) {
  const d = join(ROOT, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function fire(cmd, args, { cwd, env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...BASE_ENV, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} did not exit within ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end('');
  });
}

async function startMcp(dataDir, cwd) {
  const env = { ...BASE_ENV, CLAUDE_MEM_DIR: dataDir, MEM_QUIET_HOOKS: '1', CLAUDE_MEM_AUTO_DEEP: '0' };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], cwd, env });
  const client = new Client({ name: 'mem-parity0822-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

const textOf = (res) => (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/** Read one resource row straight out of the registry DB the surface just wrote. */
function readResource(dataDir, type, name) {
  const db = new Database(join(dataDir, 'resource-registry.db'), { readonly: true });
  try {
    return db.prepare('SELECT * FROM resources WHERE type = ? AND name = ?').get(type, name);
  } finally {
    db.close();
  }
}

describe('P1-3 — registry import/remove/reindex behave identically on CLI and MCP', () => {
  const NAME = 'parity-probe';
  const TYPE = 'skill';
  const SUMMARY = 'Probe resource for the CLI/MCP registry parity pin.';

  let cliRow, mcpRow;

  beforeAll(async () => {
    // ── CLI side ──
    const cliDir = sandboxDir('cli-data');
    const cliCwd = sandboxDir('cli-proj');
    const r = await fire(process.execPath, [
      CLI_PATH, 'registry', 'import',
      '--name', NAME, '--resource-type', TYPE,
      '--capability-summary', SUMMARY,
    ], { cwd: cliCwd, env: { CLAUDE_MEM_DIR: cliDir } });
    expect(r.code, `CLI import failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    cliRow = readResource(cliDir, TYPE, NAME);

    // ── MCP side ──
    const mcpDir = sandboxDir('mcp-data');
    const mcpCwd = sandboxDir('mcp-proj');
    const { client, transport } = await startMcp(mcpDir, mcpCwd);
    try {
      const res = await client.callTool({
        name: 'mem_registry',
        arguments: { action: 'import', name: NAME, resource_type: TYPE, capability_summary: SUMMARY },
      });
      expect(textOf(res), 'MCP import did not report success').toMatch(/Imported/);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
    mcpRow = readResource(mcpDir, TYPE, NAME);
  }, 60000);

  it('both sides actually created the row', () => {
    expect(cliRow, 'CLI import wrote no row').toBeTruthy();
    expect(mcpRow, 'MCP import wrote no row').toBeTruthy();
  });

  // THE drift the audit named. Pre-fix: cli 'installed', mcp null/default.
  it('grants the same quality_tier for a user-initiated import (no --source)', () => {
    expect(cliRow.quality_tier).toBe('installed');
    expect(mcpRow.quality_tier).toBe(cliRow.quality_tier);
  });

  it('records the same source provenance for a new resource', () => {
    expect(cliRow.source).toBe('user');
    expect(mcpRow.source).toBe(cliRow.source);
  });

  // Everything else the two sides write about the same import must match too — a field
  // that drifts later is the same defect wearing a different column name. Columns that
  // legitimately differ per-row (identity, timestamps) are excluded by name, not by
  // sampling, so a NEW column is compared by default rather than silently skipped.
  it('writes identical values in every non-identity column', () => {
    const PER_ROW = new Set(['id', 'created_at', 'updated_at', 'indexed_at', 'last_used_at']);
    const differing = Object.keys(cliRow)
      .filter((k) => !PER_ROW.has(k))
      .filter((k) => cliRow[k] !== mcpRow[k])
      .map((k) => `${k}: cli=${JSON.stringify(cliRow[k])} mcp=${JSON.stringify(mcpRow[k])}`);
    expect(differing, `columns that drift between the twins:\n${differing.join('\n')}`).toEqual([]);
  });

  it('remove reports the same not-found outcome on both sides', async () => {
    const dir = sandboxDir('rm-data');
    const cwd = sandboxDir('rm-proj');
    // Seed via CLI so the row exists, then remove it via MCP: cross-surface, which is the
    // only way a shared core is actually proven shared.
    await fire(process.execPath, [
      CLI_PATH, 'registry', 'import', '--name', NAME, '--resource-type', TYPE,
    ], { cwd, env: { CLAUDE_MEM_DIR: dir } });

    const { client, transport } = await startMcp(dir, cwd);
    try {
      const hit = await client.callTool({
        name: 'mem_registry',
        arguments: { action: 'remove', name: NAME, resource_type: TYPE },
      });
      expect(textOf(hit)).toMatch(/Removed/);
      expect(readResource(dir, TYPE, NAME)).toBeFalsy();

      const miss = await client.callTool({
        name: 'mem_registry',
        arguments: { action: 'remove', name: NAME, resource_type: TYPE },
      });
      expect(textOf(miss)).toMatch(/[Nn]ot found/);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }

    // And the CLI's own not-found path still reports not-found, not a crash or a lie.
    const cli = await fire(process.execPath, [
      CLI_PATH, 'registry', 'remove', '--name', NAME, '--resource-type', TYPE,
    ], { cwd, env: { CLAUDE_MEM_DIR: dir } });
    expect(cli.stdout).toMatch(/Not found/);
  }, 60000);

  it('reindex reports the same active count on both sides', async () => {
    const dir = sandboxDir('ri-data');
    const cwd = sandboxDir('ri-proj');
    for (const n of ['ri-a', 'ri-b']) {
      await fire(process.execPath, [
        CLI_PATH, 'registry', 'import', '--name', n, '--resource-type', TYPE,
      ], { cwd, env: { CLAUDE_MEM_DIR: dir } });
    }

    const cli = await fire(process.execPath, [CLI_PATH, 'registry', 'reindex'],
      { cwd, env: { CLAUDE_MEM_DIR: dir } });
    const cliCount = cli.stdout.match(/(\d+) active resources/)?.[1];
    expect(cliCount, `CLI reindex output had no count:\n${cli.stdout}`).toBeTruthy();

    const { client, transport } = await startMcp(dir, cwd);
    let mcpCount;
    try {
      const res = await client.callTool({ name: 'mem_registry', arguments: { action: 'reindex' } });
      mcpCount = textOf(res).match(/(\d+) active resources/)?.[1];
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
    expect(mcpCount).toBe(cliCount);
  }, 60000);
});
