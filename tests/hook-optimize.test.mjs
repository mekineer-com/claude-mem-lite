// Tests for hook-optimize.mjs — LLM-powered database optimization
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../haiku-client.mjs', () => ({
  callModelJSON: vi.fn(),
  callLLMWithModel: vi.fn(),
}));

import { callModelJSON } from '../haiku-client.mjs';

describe('schema: optimized_at column', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('observations table has optimized_at column', () => {
    const cols = db.prepare(`PRAGMA table_info(observations)`).all();
    const col = cols.find(c => c.name === 'optimized_at');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe('NULL');
  });

  it('optimized_at defaults to NULL for new observations', () => {
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { title: 'test obs' });
    const obs = db.prepare('SELECT optimized_at FROM observations LIMIT 1').get();
    expect(obs.optimized_at).toBeNull();
  });
});

describe('re-enrich', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSON.mockReset();
  });
  afterEach(() => { db.close(); });

  it('finds degraded observations missing concepts/facts/lesson/aliases', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed the schema' });
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(1);
    expect(candidates[0].title).toBe('Modified schema.mjs');
  });

  it('skips already-optimized observations', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare('UPDATE observations SET optimized_at = ? WHERE id = ?').run(Date.now(), id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('skips observations that have concepts', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Rich obs', narrative: 'Has data', text: 'auth jwt' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare("UPDATE observations SET concepts = 'auth jwt' WHERE id = ?").run(id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('executes re-enrich and updates observation fields', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Error in utils.mjs', narrative: 'Fixed a bug in sanitizeFtsQuery' });
    callModelJSON.mockResolvedValue({
      type: 'bugfix',
      title: 'Fix sanitizeFtsQuery edge case',
      narrative: 'Fixed edge case where special chars caused crash',
      concepts: ['FTS5', 'sanitize'],
      facts: ['sanitizeFtsQuery in utils.mjs crashes on parentheses'],
      importance: 2,
      lesson_learned: 'FTS5 special chars need escaping',
      search_aliases: ['fts query bug', 'sanitize crash'],
    });

    const result = await executeReenrich(db, 10);
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT * FROM observations LIMIT 1').get();
    expect(obs.concepts).toContain('FTS5');
    expect(obs.lesson_learned).toBe('FTS5 special chars need escaping');
    expect(obs.optimized_at).toBeGreaterThan(0);
  });
});
