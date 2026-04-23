// MCP protocol subprocess test — validates the server over real stdio JSON-RPC,
// not the handler functions in isolation.
//
// Why this is separate from unit tests: lessons #7837, #7843, #8126, #8127,
// #8139 are all CLI↔MCP parity / protocol-layer bugs (silent no-op,
// no-confirm destructive, prefix-token drift, read-path filter mismatch).
// Handler-level unit tests missed them because they hit function shapes,
// not the registered-tool surface. This file guards that layer.
//
// Shape:
//   1. Spawn server.mjs with an isolated CLAUDE_MEM_DIR (fresh DB).
//   2. Connect via StdioClientTransport (same as Claude Code).
//   3. Assert tools/list surface + a handful of critical tools/call contracts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';

const SERVER_PATH = resolve(import.meta.dirname, '../server.mjs');

// Per-suite isolated DB + runtime dir so the test never touches the user's
// real ~/.claude-mem-lite. Cleanup in afterAll.
const DB_DIR = `/tmp/mem-mcp-test-${process.pid}`;

let client;
let transport;

beforeAll(async () => {
  try { rmSync(DB_DIR, { recursive: true }); } catch {}
  mkdirSync(`${DB_DIR}/runtime`, { recursive: true });

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: DB_DIR,
      CLAUDE_PROJECT_DIR: '/test/project',
      PWD: '/test/project',
    },
  });
  client = new Client({ name: 'mem-test-client', version: '0.0.0' });
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
  try { rmSync(DB_DIR, { recursive: true }); } catch {}
});

// Helper: extract text payload from a tools/call result.
function textOf(result) {
  return (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

describe('MCP protocol surface', () => {
  it('tools/list exposes exactly the 6 promised core tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'mem_get', 'mem_recall', 'mem_recent',
      'mem_save', 'mem_search', 'mem_timeline',
    ]);
  });

  it('every exposed tool carries a non-empty description', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(50);
    }
  });

  it('hidden tool mem_stats is callable by exact name despite not being listed', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('mem_stats');
    // Direct call should still work (hidden, not unregistered).
    const res = await client.callTool({ name: 'mem_stats', arguments: {} });
    const text = textOf(res);
    expect(text).toMatch(/observations|sessions|prompts|Stats|projects/i);
  });

  // Regression guard for #7843: mem_maintain purge_stale silently deleted rows
  // without a confirm gate. The fix added `confirm: boolean` and makes the
  // default a dry-run preview. Real guard asserts row counts are invariant —
  // the earlier prose-only check passed even if the SQL fired, so long as
  // the response contained the word "preview" anywhere.
  it('mem_maintain execute purge_stale without confirm does NOT delete rows', async () => {
    // Seed 3 observations via the protocol so they live in the server's DB.
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'mem_save',
        arguments: {
          content: `Purge guard seed ${i}`,
          title: `guard-seed-${i}`,
          type: 'discovery',
        },
      });
    }
    // Baseline: read totals from the server's authoritative view.
    const before = await client.callTool({ name: 'mem_stats', arguments: {} });
    const beforeText = textOf(before);
    const beforeCount = Number((beforeText.match(/Total:\s*([\d,]+)\s*observations/i) || [])[1]?.replace(/,/g, '') || 0);
    expect(beforeCount).toBeGreaterThanOrEqual(3);

    // Actual call under test: execute purge_stale WITHOUT confirm.
    const res = await client.callTool({
      name: 'mem_maintain',
      arguments: { action: 'execute', operations: ['purge_stale'] },
    });
    const resText = textOf(res);
    // Response should clearly signal a dry-run — but text-only isn't enough.
    expect(resText.toLowerCase()).toMatch(/confirm|preview|dry|would/);

    // Hard assertion: row count is invariant after a no-confirm execute.
    const after = await client.callTool({ name: 'mem_stats', arguments: {} });
    const afterText = textOf(after);
    const afterCount = Number((afterText.match(/Total:\s*([\d,]+)\s*observations/i) || [])[1]?.replace(/,/g, '') || 0);
    expect(afterCount).toBe(beforeCount);
  });

  // Regression guard for #7837: mem_search sort=time was a silent no-op
  // pre-v2.34.0. Calling with sort=time on an empty DB should at minimum
  // return a well-formed response (not throw), and not contradict its input.
  it('mem_search sort=time responds cleanly on empty DB', async () => {
    const res = await client.callTool({
      name: 'mem_search',
      arguments: { query: 'nonexistent-term-xyzq', sort: 'time' },
    });
    const text = textOf(res);
    expect(text).toBeTruthy();
    expect(text.toLowerCase()).toMatch(/no (results|match)|empty|0 /);
  });

  it('mem_recent returns a valid (possibly empty) list on fresh DB', async () => {
    const res = await client.callTool({ name: 'mem_recent', arguments: { limit: 5 } });
    const text = textOf(res);
    expect(text).toBeTruthy();
    expect(text.toLowerCase()).toMatch(/recent|no (recent|observ)/);
  });

  it('unknown tool name surfaces an explicit isError result (not a silent success)', async () => {
    // The MCP SDK returns { isError: true, content: [...] } rather than
    // throwing — callers must check isError. Assert shape, not rejection.
    const res = await client.callTool({ name: 'mem_totally_not_a_tool', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not found|unknown/i);
  });
});
