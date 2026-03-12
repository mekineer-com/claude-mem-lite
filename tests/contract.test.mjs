// Contract tests: validate Zod schemas and output formats
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  memSearchSchema,
  memTimelineSchema,
  memGetSchema,
  memDeleteSchema,
  memSaveSchema,
  memStatsSchema,
  memCompressSchema,
  memMaintainSchema,
  memRegistrySchema,
} from '../tool-schemas.mjs';

// Helper: parse object against schema (Zod object from flat dict)
function parseSchema(schemaDef, data) {
  const schema = z.object(schemaDef);
  return schema.safeParse(data);
}

// ─── mem_search schema ──────────────────────────────────────────────────────

describe('mem_search schema', () => {
  it('accepts valid search with all fields', () => {
    const result = parseSchema(memSearchSchema, {
      query: 'authentication',
      type: 'observations',
      obs_type: 'bugfix',
      project: 'myproject',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      importance: 2,
      limit: 50,
      offset: 10,
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all optional)', () => {
    const result = parseSchema(memSearchSchema, {});
    expect(result.success).toBe(true);
  });

  it('rejects invalid type enum', () => {
    const result = parseSchema(memSearchSchema, { type: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects importance out of range', () => {
    const low = parseSchema(memSearchSchema, { importance: 0 });
    expect(low.success).toBe(false);
    const high = parseSchema(memSearchSchema, { importance: 4 });
    expect(high.success).toBe(false);
  });

  it('rejects limit out of range', () => {
    const zero = parseSchema(memSearchSchema, { limit: 0 });
    expect(zero.success).toBe(false);
    const tooHigh = parseSchema(memSearchSchema, { limit: 101 });
    expect(tooHigh.success).toBe(false);
  });

  it('accepts boundary values', () => {
    expect(parseSchema(memSearchSchema, { importance: 1 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { importance: 3 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { limit: 1 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { limit: 100 }).success).toBe(true);
    expect(parseSchema(memSearchSchema, { offset: 0 }).success).toBe(true);
  });
});

// ─── mem_timeline schema ────────────────────────────────────────────────────

describe('mem_timeline schema', () => {
  it('accepts valid timeline with anchor', () => {
    const result = parseSchema(memTimelineSchema, { anchor: 42, before: 5, after: 5 });
    expect(result.success).toBe(true);
  });

  it('accepts query-based timeline', () => {
    const result = parseSchema(memTimelineSchema, { query: 'auth bug', project: 'myproj' });
    expect(result.success).toBe(true);
  });

  it('rejects before/after out of range', () => {
    expect(parseSchema(memTimelineSchema, { before: -1 }).success).toBe(false);
    expect(parseSchema(memTimelineSchema, { after: 51 }).success).toBe(false);
  });
});

// ─── mem_get schema ─────────────────────────────────────────────────────────

describe('mem_get schema', () => {
  it('accepts valid get with ids', () => {
    const result = parseSchema(memGetSchema, { ids: [1, 2, 3] });
    expect(result.success).toBe(true);
  });

  it('accepts source and fields', () => {
    const result = parseSchema(memGetSchema, { ids: [1], source: 'session', fields: ['request', 'completed'] });
    expect(result.success).toBe(true);
  });

  it('rejects empty ids array', () => {
    const result = parseSchema(memGetSchema, { ids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects too many ids (>20)', () => {
    const ids = Array.from({ length: 21 }, (_, i) => i + 1);
    const result = parseSchema(memGetSchema, { ids });
    expect(result.success).toBe(false);
  });

  it('rejects missing ids', () => {
    const result = parseSchema(memGetSchema, {});
    expect(result.success).toBe(false);
  });
});

// ─── mem_delete schema ──────────────────────────────────────────────────────

describe('mem_delete schema', () => {
  it('accepts preview mode', () => {
    const result = parseSchema(memDeleteSchema, { ids: [1, 2], confirm: false });
    expect(result.success).toBe(true);
  });

  it('accepts execute mode', () => {
    const result = parseSchema(memDeleteSchema, { ids: [1], confirm: true });
    expect(result.success).toBe(true);
  });

  it('rejects empty ids', () => {
    const result = parseSchema(memDeleteSchema, { ids: [], confirm: true });
    expect(result.success).toBe(false);
  });

  it('rejects too many ids (>50)', () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const result = parseSchema(memDeleteSchema, { ids, confirm: true });
    expect(result.success).toBe(false);
  });

  it('rejects missing confirm', () => {
    const result = parseSchema(memDeleteSchema, { ids: [1] });
    expect(result.success).toBe(false);
  });
});

// ─── mem_save schema ────────────────────────────────────────────────────────

describe('mem_save schema', () => {
  it('accepts minimal save', () => {
    const result = parseSchema(memSaveSchema, { content: 'some content' });
    expect(result.success).toBe(true);
  });

  it('accepts full save with all fields', () => {
    const result = parseSchema(memSaveSchema, {
      content: 'detailed content',
      title: 'My Title',
      type: 'decision',
      project: 'myproject',
      importance: 3,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty content', () => {
    const result = parseSchema(memSaveSchema, { content: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing content', () => {
    const result = parseSchema(memSaveSchema, { title: 'no content' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type', () => {
    const result = parseSchema(memSaveSchema, { content: 'x', type: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects importance out of range', () => {
    expect(parseSchema(memSaveSchema, { content: 'x', importance: 0 }).success).toBe(false);
    expect(parseSchema(memSaveSchema, { content: 'x', importance: 4 }).success).toBe(false);
  });
});

// ─── mem_stats schema ───────────────────────────────────────────────────────

describe('mem_stats schema', () => {
  it('accepts empty (all optional)', () => {
    expect(parseSchema(memStatsSchema, {}).success).toBe(true);
  });

  it('accepts project and days', () => {
    expect(parseSchema(memStatsSchema, { project: 'test', days: 90 }).success).toBe(true);
  });

  it('rejects days out of range', () => {
    expect(parseSchema(memStatsSchema, { days: 0 }).success).toBe(false);
    expect(parseSchema(memStatsSchema, { days: 366 }).success).toBe(false);
  });
});

// ─── mem_compress schema ────────────────────────────────────────────────────

describe('mem_compress schema', () => {
  it('accepts preview mode', () => {
    expect(parseSchema(memCompressSchema, { preview: true }).success).toBe(true);
  });

  it('accepts execute with age_days', () => {
    expect(parseSchema(memCompressSchema, { preview: false, age_days: 90 }).success).toBe(true);
  });

  it('rejects age_days below minimum', () => {
    expect(parseSchema(memCompressSchema, { age_days: 29 }).success).toBe(false);
  });

  it('rejects age_days above maximum', () => {
    expect(parseSchema(memCompressSchema, { age_days: 366 }).success).toBe(false);
  });
});

// ─── mem_maintain schema ─────────────────────────────────────────────────────

describe('mem_maintain schema', () => {
  it('accepts scan action', () => {
    expect(parseSchema(memMaintainSchema, { action: 'scan' }).success).toBe(true);
  });

  it('accepts scan with project filter', () => {
    expect(parseSchema(memMaintainSchema, { action: 'scan', project: 'my-project' }).success).toBe(true);
  });

  it('accepts execute with operations', () => {
    expect(parseSchema(memMaintainSchema, { action: 'execute', operations: ['cleanup', 'decay', 'boost'] }).success).toBe(true);
  });

  it('accepts execute with dedup and merge_ids', () => {
    expect(parseSchema(memMaintainSchema, { action: 'execute', operations: ['dedup'], merge_ids: [[1, 2, 3], [4, 5]] }).success).toBe(true);
  });

  it('rejects invalid action', () => {
    expect(parseSchema(memMaintainSchema, { action: 'invalid' }).success).toBe(false);
  });

  it('rejects invalid operation', () => {
    expect(parseSchema(memMaintainSchema, { action: 'execute', operations: ['invalid'] }).success).toBe(false);
  });

  it('rejects merge_ids with single element group', () => {
    expect(parseSchema(memMaintainSchema, { action: 'execute', operations: ['dedup'], merge_ids: [[1]] }).success).toBe(false);
  });
});

// ─── mem_registry schema ────────────────────────────────────────────────────

describe('mem_registry schema', () => {
  it('accepts list action', () => {
    expect(parseSchema(memRegistrySchema, { action: 'list' }).success).toBe(true);
  });

  it('accepts list with type filter', () => {
    expect(parseSchema(memRegistrySchema, { action: 'list', type: 'skill' }).success).toBe(true);
  });

  it('accepts stats action', () => {
    expect(parseSchema(memRegistrySchema, { action: 'stats' }).success).toBe(true);
  });

  it('accepts import with full metadata', () => {
    expect(parseSchema(memRegistrySchema, {
      action: 'import',
      name: 'my-tool',
      resource_type: 'skill',
      repo_url: 'https://github.com/user/repo',
      intent_tags: 'test,debug',
      domain_tags: 'javascript',
      capability_summary: 'A testing tool',
      trigger_patterns: 'when user wants to test',
    }).success).toBe(true);
  });

  it('accepts remove action', () => {
    expect(parseSchema(memRegistrySchema, { action: 'remove', name: 'old-tool', resource_type: 'agent' }).success).toBe(true);
  });

  it('accepts reindex action', () => {
    expect(parseSchema(memRegistrySchema, { action: 'reindex' }).success).toBe(true);
  });

  it('rejects invalid action', () => {
    expect(parseSchema(memRegistrySchema, { action: 'invalid' }).success).toBe(false);
  });

  it('rejects invalid resource_type', () => {
    expect(parseSchema(memRegistrySchema, { action: 'import', name: 'x', resource_type: 'invalid' }).success).toBe(false);
  });
});

// ─── LLM string coercion ─────────────────────────────────────────────────────

describe('LLM string coercion (preprocess)', () => {
  it('coerces string integers to numbers', () => {
    const r = parseSchema(memSearchSchema, { importance: '2', limit: '50', offset: '0' });
    expect(r.success).toBe(true);
    expect(r.data.importance).toBe(2);
    expect(r.data.limit).toBe(50);
    expect(r.data.offset).toBe(0);
  });

  it('rejects non-numeric strings', () => {
    expect(parseSchema(memSearchSchema, { importance: 'abc' }).success).toBe(false);
    expect(parseSchema(memSearchSchema, { limit: '3.5' }).success).toBe(false);
  });

  it('coerces string anchor and before/after', () => {
    const r = parseSchema(memTimelineSchema, { anchor: '42', before: '3', after: '7' });
    expect(r.success).toBe(true);
    expect(r.data.anchor).toBe(42);
    expect(r.data.before).toBe(3);
    expect(r.data.after).toBe(7);
  });

  it('coerces comma-separated string ids to int array', () => {
    const r = parseSchema(memGetSchema, { ids: '1,2,3' });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual([1, 2, 3]);
  });

  it('coerces single string id to array', () => {
    const r = parseSchema(memGetSchema, { ids: '42' });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual([42]);
  });

  it('coerces single number id to array', () => {
    const r = parseSchema(memGetSchema, { ids: 7 });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual([7]);
  });

  it('coerces array of string ids', () => {
    const r = parseSchema(memGetSchema, { ids: ['1', '2'] });
    expect(r.success).toBe(true);
    expect(r.data.ids).toEqual([1, 2]);
  });

  it('coerces "true"/"false" strings to boolean', () => {
    const r = parseSchema(memDeleteSchema, { ids: [1], confirm: 'true' });
    expect(r.success).toBe(true);
    expect(r.data.confirm).toBe(true);

    const r2 = parseSchema(memDeleteSchema, { ids: [1], confirm: 'false' });
    expect(r2.success).toBe(true);
    expect(r2.data.confirm).toBe(false);
  });

  it('coerces "True"/"FALSE" (case-insensitive)', () => {
    expect(parseSchema(memDeleteSchema, { ids: [1], confirm: 'True' }).success).toBe(true);
    expect(parseSchema(memDeleteSchema, { ids: [1], confirm: 'FALSE' }).success).toBe(true);
  });

  it('coerces string importance in mem_save', () => {
    const r = parseSchema(memSaveSchema, { content: 'test', importance: '3' });
    expect(r.success).toBe(true);
    expect(r.data.importance).toBe(3);
  });

  it('coerces string days in mem_stats', () => {
    const r = parseSchema(memStatsSchema, { days: '90' });
    expect(r.success).toBe(true);
    expect(r.data.days).toBe(90);
  });

  it('coerces string age_days and preview in mem_compress', () => {
    const r = parseSchema(memCompressSchema, { preview: 'false', age_days: '60' });
    expect(r.success).toBe(true);
    expect(r.data.preview).toBe(false);
    expect(r.data.age_days).toBe(60);
  });

  it('coerces string retain_days in mem_maintain', () => {
    const r = parseSchema(memMaintainSchema, { action: 'execute', operations: ['purge_stale'], retain_days: '30' });
    expect(r.success).toBe(true);
    expect(r.data.retain_days).toBe(30);
  });

  it('coerces string ids inside merge_ids groups', () => {
    const r = parseSchema(memMaintainSchema, { action: 'execute', operations: ['dedup'], merge_ids: [['1', '2', '3']] });
    expect(r.success).toBe(true);
    expect(r.data.merge_ids).toEqual([[1, 2, 3]]);
  });

  it('still rejects invalid coerced values (range check)', () => {
    expect(parseSchema(memSearchSchema, { importance: '5' }).success).toBe(false);
    expect(parseSchema(memSearchSchema, { limit: '0' }).success).toBe(false);
    expect(parseSchema(memCompressSchema, { age_days: '10' }).success).toBe(false);
  });
});

// ─── Output format validation ───────────────────────────────────────────────

describe('output format contracts', () => {
  it('success format: {content: [{type: "text", text: string}]}', () => {
    const output = { content: [{ type: 'text', text: 'Found 5 results.' }] };
    const schema = z.object({
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    });
    expect(schema.safeParse(output).success).toBe(true);
  });

  it('error format: {content: [...], isError: true}', () => {
    const output = { content: [{ type: 'text', text: 'Error: something failed' }], isError: true };
    const schema = z.object({
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
      isError: z.literal(true),
    });
    expect(schema.safeParse(output).success).toBe(true);
  });

  it('error text starts with "Error:"', () => {
    const errorText = 'Error: Invalid date_from: not-a-date';
    expect(errorText.startsWith('Error:')).toBe(true);
  });
});
