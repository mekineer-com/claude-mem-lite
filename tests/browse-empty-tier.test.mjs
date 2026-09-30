// `browse --tier <t>` on a tier that happens to be empty told the user the whole store was
// empty: "No observations found. Start a coding session to build memory." — measured on a
// store with 58 live rows (E2E round 2026-09-29). Under a tier filter grandTotal counts that
// tier alone, so both faces now say which tier is empty. The MCP face is pinned in
// tests/mcp-protocol.test.mjs.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = mkdtempSync(join(tmpdir(), 'cml-browse-tier-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const WORK = join(ROOT, 'work', 'proj');
mkdirSync(WORK, { recursive: true });
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
Object.assign(env, {
  HOME: join(ROOT, 'home'),
  CLAUDE_MEM_DIR: join(ROOT, 'data'),
  CLAUDE_PROJECT_DIR: WORK,
  PWD: WORK,
  MEM_NO_AUTO_ADOPT: '1',
  CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
  CLAUDE_MEM_SKIP_UPDATE: '1',
});
const cli = (args) =>
  spawnSync(process.execPath, [join(REPO, 'cli.mjs'), ...args], { cwd: WORK, env, encoding: 'utf8' });

describe('browse --tier on an empty tier', () => {
  it('names the empty tier instead of calling the store empty', () => {
    expect(cli(['save', 'a fresh observation about the parser', '--type', 'discovery']).status).toBe(0);
    const r = cli(['browse', '--tier', 'archive']);
    expect(r.stdout).not.toMatch(/Start a coding session/);
    expect(r.stdout).toMatch(/No observations in the archive tier/);
    // Premise: the store is not empty.
    expect(cli(['browse']).stdout).toMatch(/Totals: 1 observations/);
  });
});
