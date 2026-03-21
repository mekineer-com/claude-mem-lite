import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { buildVocabulary, computeVector, _resetVocabCache, VOCAB_DIM } from '../tfidf.mjs';

describe('observation_vectors table', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-1' }); _resetVocabCache(); });
  afterEach(() => { db.close(); });

  it('exists after initSchema', () => {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_vectors'").get();
    expect(table).toBeDefined();
  });

  it('stores and retrieves Float32Array vectors', () => {
    insertObs(db, { title: 'test obs' });
    const obsId = db.prepare("SELECT id FROM observations LIMIT 1").get().id;

    const vec = new Float32Array(VOCAB_DIM);
    vec[0] = 1.5; vec[1] = -0.5; vec[100] = 0.999;

    db.prepare('INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
      .run(obsId, Buffer.from(vec.buffer), 'v1', Date.now());

    const row = db.prepare('SELECT vector FROM observation_vectors WHERE observation_id = ?').get(obsId);
    const restored = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    expect(restored[0]).toBeCloseTo(1.5);
    expect(restored[1]).toBeCloseTo(-0.5);
    expect(restored[100]).toBeCloseTo(0.999);
  });

  it('CASCADE deletes vector when observation is deleted', () => {
    insertObs(db, { title: 'to delete' });
    const obsId = db.prepare("SELECT id FROM observations WHERE title = 'to delete'").get().id;

    const vec = new Float32Array(VOCAB_DIM);
    db.prepare('INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
      .run(obsId, Buffer.from(vec.buffer), 'v1', Date.now());

    expect(db.prepare('SELECT COUNT(*) as c FROM observation_vectors').get().c).toBe(1);
    db.prepare('DELETE FROM observations WHERE id = ?').run(obsId);
    expect(db.prepare('SELECT COUNT(*) as c FROM observation_vectors').get().c).toBe(0);
  });
});

describe('vector write helper', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-1' }); _resetVocabCache(); });
  afterEach(() => { db.close(); });

  it('can write and read back a computed vector', () => {
    insertObs(db, { title: 'auth token', narrative: 'fix authentication issue' });
    insertObs(db, { title: 'database query', narrative: 'optimize SQL performance' });
    const vocab = buildVocabulary(db);

    const obsId = db.prepare("SELECT id FROM observations WHERE title = 'auth token'").get().id;
    const vec = computeVector('auth token fix authentication issue', vocab);
    expect(vec).not.toBeNull();

    db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
      .run(obsId, Buffer.from(vec.buffer), vocab.version, Date.now());

    const row = db.prepare('SELECT vector, vocab_version FROM observation_vectors WHERE observation_id = ?').get(obsId);
    expect(row.vocab_version).toBe(vocab.version);
    const restored = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    expect(restored.length).toBe(VOCAB_DIM);
  });
});
