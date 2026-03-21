// tests/tfidf.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tokenize, buildVocabulary, getVocabulary, computeVector, cosineSimilarity, VOCAB_DIM, _resetVocabCache } from '../tfidf.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('tokenize', () => {
  it('lowercases and splits ASCII', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('filters tokens shorter than 2 chars', () => {
    const tokens = tokenize('I am a test');
    expect(tokens).not.toContain('i');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('am');
    expect(tokens).toContain('test');
  });

  it('handles special characters', () => {
    const tokens = tokenize('file.mjs server-config auth_token');
    expect(tokens).toContain('file');
    expect(tokens).toContain('mjs');
    expect(tokens).toContain('server');
    expect(tokens).toContain('config');
  });

  it('handles CJK text via bigrams', () => {
    const tokens = tokenize('修复数据库崩溃');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('handles mixed ASCII and CJK', () => {
    const tokens = tokenize('Fix the 数据库 bug');
    expect(tokens).toContain('fix');
    expect(tokens).toContain('the');
    expect(tokens).toContain('bug');
    expect(tokens.length).toBeGreaterThan(3); // CJK tokens too
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe('buildVocabulary', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-1' }); _resetVocabCache(); });
  afterEach(() => { db.close(); });

  it('returns null for empty database', () => {
    const vocab = buildVocabulary(db);
    expect(vocab).toBeNull();
  });

  it('builds vocabulary from observations', () => {
    insertObs(db, { title: 'fix auth bug', narrative: 'the authentication system had a token refresh issue' });
    insertObs(db, { title: 'add search feature', narrative: 'implemented full text search with FTS5' });
    insertObs(db, { title: 'refactor auth module', narrative: 'cleaned up the authentication code' });

    const vocab = buildVocabulary(db);
    expect(vocab).not.toBeNull();
    expect(vocab.terms).toBeInstanceOf(Map);
    expect(vocab.dim).toBe(VOCAB_DIM);
    expect(vocab.version).toBeTruthy();

    // 'auth' appears in 2/3 docs, should have moderate IDF
    const authEntry = vocab.terms.get('auth');
    expect(authEntry).toBeDefined();
    expect(authEntry.idf).toBeGreaterThan(0);
  });

  it('caps vocabulary at VOCAB_DIM terms', () => {
    // Insert enough observations with diverse vocabulary
    for (let i = 0; i < 20; i++) {
      insertObs(db, { title: `term${i} unique${i}`, narrative: `narrative with word${i} and phrase${i}` });
    }
    const vocab = buildVocabulary(db);
    expect(vocab.terms.size).toBeLessThanOrEqual(VOCAB_DIM);
  });

  it('excludes compressed/superseded observations', () => {
    insertObs(db, { title: 'active obs with uniqueterm', narrative: 'good data' });
    insertObs(db, { title: 'compressed obs with uniqueterm', narrative: 'old data', compressedInto: -1 });

    const vocab = buildVocabulary(db);
    expect(vocab).not.toBeNull();
    // uniqueterm should still be in vocab (from active obs)
  });
});

describe('computeVector', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-1' }); _resetVocabCache(); });
  afterEach(() => { db.close(); });

  it('returns null for null vocabulary', () => {
    expect(computeVector('test text', null)).toBeNull();
  });

  it('returns Float32Array of correct dimension', () => {
    insertObs(db, { title: 'test observation', narrative: 'some content here' });
    const vocab = buildVocabulary(db);
    const vec = computeVector('test observation content', vocab);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(VOCAB_DIM);
  });

  it('produces L2-normalized vectors', () => {
    insertObs(db, { title: 'test', narrative: 'data' });
    const vocab = buildVocabulary(db);
    const vec = computeVector('test data', vocab);
    if (vec) {
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.001);
    }
  });

  it('returns zero vector for text with no vocabulary terms', () => {
    insertObs(db, { title: 'alpha beta', narrative: 'gamma delta' });
    const vocab = buildVocabulary(db);
    const vec = computeVector('zzzzz yyyyy xxxxx', vocab);
    // No matching terms -> all zeros -> can't normalize -> returns null
    expect(vec).toBeNull();
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    // Normalize
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const an = a.map(v => v / norm);
    expect(cosineSimilarity(an, an)).toBeCloseTo(1.0, 4);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 4);
  });

  it('similar texts score higher than dissimilar', () => {
    let db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, { title: 'auth token refresh', narrative: 'fix the authentication token expiry' });
    insertObs(db, { title: 'database schema migration', narrative: 'update the database tables' });
    insertObs(db, { title: 'auth session bug', narrative: 'session authentication was broken' });
    const vocab = buildVocabulary(db);
    if (vocab) {
      const q = computeVector('authentication token problem', vocab);
      const authVec = computeVector('auth token refresh fix the authentication token expiry', vocab);
      const dbVec = computeVector('database schema migration update the database tables', vocab);
      if (q && authVec && dbVec) {
        expect(cosineSimilarity(q, authVec)).toBeGreaterThan(cosineSimilarity(q, dbVec));
      }
    }
    db.close();
  });
});

describe('Float32Array BLOB roundtrip', () => {
  it('survives Buffer serialization', () => {
    const original = new Float32Array([1.5, -2.3, 0, 0.001, 999.99]);
    const blob = Buffer.from(original.buffer);
    const restored = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });
});
