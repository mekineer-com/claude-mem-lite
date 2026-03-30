// Tests for hook-optimize.mjs — LLM-powered database optimization
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

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
