import { describe, it, expect } from 'vitest';
import { tools } from '../tool-schemas.mjs';

describe('MCP tool registration — defer family', () => {
  it('registers mem_defer / mem_defer_list / mem_defer_drop', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('mem_defer');
    expect(names).toContain('mem_defer_list');
    expect(names).toContain('mem_defer_drop');
  });

  it('mem_defer description follows DO-NOT/USE-when template', () => {
    const t = tools.find(t => t.name === 'mem_defer');
    expect(t.description).toMatch(/DO NOT use when/);
    expect(t.description).toMatch(/USE when/);
    expect(t.description).toMatch(/Equivalent CLI/);
  });

  it('mem_defer schema requires title + accepts priority 1..3', () => {
    const t = tools.find(t => t.name === 'mem_defer');
    // title required
    expect(() => t.inputSchema.title.parse(undefined)).toThrow();
    expect(t.inputSchema.title.parse('hello')).toBe('hello');
    // priority bounded
    expect(t.inputSchema.priority.parse(2)).toBe(2);
    expect(() => t.inputSchema.priority.parse(4)).toThrow();
  });

  it('memSaveSchema gains optional closes_deferred mixed array', () => {
    const t = tools.find(t => t.name === 'mem_save');
    // closes_deferred should be optional (parse undefined OK)
    expect(t.inputSchema.closes_deferred.parse(undefined)).toBeUndefined();
    // accepts mixed [number, "D#N"]
    expect(t.inputSchema.closes_deferred.parse([1, 'D#42'])).toEqual([1, 'D#42']);
    // rejects unknown string shape
    expect(() => t.inputSchema.closes_deferred.parse(['#5'])).toThrow();
  });
});
