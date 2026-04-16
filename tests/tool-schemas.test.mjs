// Task 5: Discouragement-style MCP tool descriptions
// Every tool in `tool-schemas.mjs` must carry both "DO NOT use when" and
// "USE when" markers, and stay under 800 chars. This test is the contract
// that blocks encouragement-style descriptions from slipping back in.

import { describe, test, expect } from 'vitest';
import { tools } from '../tool-schemas.mjs';

describe('MCP tool descriptions use discouragement style', () => {
  test('there are exactly 17 tools (6 core + 11 hidden)', () => {
    expect(tools).toHaveLength(17);
    const core = tools.filter((t) => !t.hidden);
    const hidden = tools.filter((t) => t.hidden === true);
    expect(core, 'core count').toHaveLength(6);
    expect(hidden, 'hidden count').toHaveLength(11);
  });

  test('core (unhidden) names are the contract-critical six', () => {
    const coreNames = tools.filter((t) => !t.hidden).map((t) => t.name).sort();
    // These six back the claude-mem-lite invited-memory contract and the
    // hottest retrieval paths. Changing this list is an MCP surface-area
    // change — update adopt-content.mjs and CLAUDE.md in the same PR.
    expect(coreNames).toEqual(
      ['mem_get', 'mem_recall', 'mem_recent', 'mem_save', 'mem_search', 'mem_timeline'],
    );
  });

  test('hidden names are the maintenance/admin/specialized eleven', () => {
    const hiddenNames = tools.filter((t) => t.hidden === true).map((t) => t.name).sort();
    expect(hiddenNames).toEqual([
      'mem_browse', 'mem_compress', 'mem_delete', 'mem_export', 'mem_fts_check',
      'mem_maintain', 'mem_optimize', 'mem_registry', 'mem_stats', 'mem_update',
      'mem_use',
    ]);
  });

  test('hidden flag is boolean-true (not truthy-string) when set', () => {
    for (const tool of tools) {
      if ('hidden' in tool) {
        expect(tool.hidden, `${tool.name} hidden must be true`).toBe(true);
      }
    }
  });

  test('every tool has name, description, inputSchema', () => {
    for (const tool of tools) {
      expect(tool, 'tool object').toBeTruthy();
      expect(typeof tool.name, `${tool && tool.name} name is string`).toBe('string');
      expect(tool.name, 'name non-empty').toMatch(/^mem_/);
      expect(typeof tool.description, `${tool.name} description is string`).toBe('string');
      expect(tool.inputSchema, `${tool.name} has inputSchema`).toBeTruthy();
    }
  });

  test.each(
    // vitest .each wants an array; map to [name, tool] pairs for nicer labels
    [
      'mem_search', 'mem_recent', 'mem_timeline', 'mem_get', 'mem_delete',
      'mem_save', 'mem_stats', 'mem_compress', 'mem_maintain', 'mem_optimize',
      'mem_registry', 'mem_use', 'mem_update', 'mem_export', 'mem_recall',
      'mem_fts_check', 'mem_browse',
    ].map((n) => [n])
  )('%s description has DO NOT / USE when markers and <800 chars', (name) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} not found in tools export`).toBeTruthy();
    expect(tool.description, `${name} missing "DO NOT use when"`).toMatch(/DO NOT use when/);
    expect(tool.description, `${name} missing "USE when"`).toMatch(/USE when/);
    expect(tool.description.length, `${name} description too long`).toBeLessThan(800);
  });

  test('every tool lists an Equivalent CLI line (or explicit "MCP only")', () => {
    for (const tool of tools) {
      expect(
        /Equivalent CLI:|MCP only/.test(tool.description),
        `${tool.name} should document its CLI equivalent (or mark MCP only)`
      ).toBe(true);
    }
  });
});
