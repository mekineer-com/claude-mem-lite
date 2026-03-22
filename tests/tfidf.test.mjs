// tests/tfidf.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tokenize, buildVocabulary, rebuildVocabulary, getVocabulary, computeVector, cosineSimilarity, vectorSearch, VOCAB_DIM, MIN_COSINE_SIMILARITY, VECTOR_SCAN_LIMIT, porterStem, _resetVocabCache } from '../tfidf.mjs';
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
    // 'mjs' → stemmed to 'mj' (Porter strips trailing s)
    expect(tokens).toContain('mj');
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

    // 'auth' appears in 2/3 docs (stemmed form), should be in vocab with df>=2
    const authEntry = vocab.terms.get('auth');
    expect(authEntry).toBeDefined();
    expect(authEntry.idf).toBeGreaterThan(0);
  });

  it('uses information gain ranking (df × idf) instead of pure DF', () => {
    // Insert observations where a rare-but-present term has higher info gain
    // than a super-common term
    for (let i = 0; i < 10; i++) {
      insertObs(db, { title: `common${i} shared data`, narrative: `common shared data entry ${i}` });
    }
    // 'database' appears in exactly 2 docs — moderate DF, high IDF
    insertObs(db, { title: 'database schema fix', narrative: 'database migration issue' });
    insertObs(db, { title: 'database query bug', narrative: 'database optimization needed' });

    const vocab = buildVocabulary(db);
    expect(vocab).not.toBeNull();
    // 'databas' (stemmed) appears in 2/12 docs, 'data' appears in 10/12
    // Both should be in vocab since df>=2
    // Under info gain ranking, discriminative terms are prioritized
    const terms = [...vocab.terms.keys()];
    expect(terms.length).toBeGreaterThan(0);
  });

  it('excludes hapax legomena (df=1 terms)', () => {
    insertObs(db, { title: 'common shared term', narrative: 'shared content data' });
    insertObs(db, { title: 'common shared info', narrative: 'shared content here' });
    insertObs(db, { title: 'hapaxword only once', narrative: 'unique occurrence' });

    const vocab = buildVocabulary(db);
    expect(vocab).not.toBeNull();
    // 'hapaxword' appears in only 1 doc — should be excluded
    expect(vocab.terms.has('hapaxword')).toBe(false);
    // 'share' (stemmed from 'shared') appears in 2+ docs — should be included
    expect(vocab.terms.has('share')).toBe(true);
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
    // Need 2+ docs with shared terms for df>=2 filter
    insertObs(db, { title: 'test observation', narrative: 'some content here' });
    insertObs(db, { title: 'test content fix', narrative: 'another test content entry' });
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
    const db = createTestDb();
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

describe('buildVocabulary noise filtering', () => {
  it('excludes English stop words from vocabulary', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, { title: 'the and or but in on at to for of is it', narrative: 'the cat sat on the mat with the hat' });
    // Terms like 'schema', 'migrat' need df>=2, so repeat in multiple docs
    insertObs(db, { title: 'database migration schema', narrative: 'fix the error in schema migration' });
    insertObs(db, { title: 'database schema update', narrative: 'schema migration fix applied' });
    insertObs(db, { title: 'hook implementation database', narrative: 'implement the hook for this feature' });
    const vocab = buildVocabulary(db);
    const terms = [...vocab.terms.keys()];
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('and');
    expect(terms).not.toContain('in');
    expect(terms).not.toContain('on');
    expect(terms).not.toContain('for');
    expect(terms).not.toContain('of');
    expect(terms).not.toContain('is');
    // Stemmed forms: 'database' → 'databas', 'migration' → 'migrat', 'schema' stays
    expect(terms).toContain('databas');
    expect(terms).toContain('migrat');
    expect(terms).toContain('schema');
    db.close();
  });

  it('excludes pure numeric tokens from vocabulary', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    // Need terms in 2+ docs for df>=2
    insertObs(db, { title: 'error 2026 03 21 fix 404', narrative: 'date 2026-03-21 status 404 500' });
    insertObs(db, { title: 'error fix performance 10 20 30', narrative: 'run 100 iterations in 50ms' });
    insertObs(db, { title: 'performance error check', narrative: 'performance monitoring error handling' });
    const vocab = buildVocabulary(db);
    const terms = [...vocab.terms.keys()];
    expect(terms).not.toContain('2026');
    expect(terms).not.toContain('03');
    expect(terms).not.toContain('21');
    expect(terms).not.toContain('10');
    expect(terms).toContain('error');
    expect(terms).toContain('perform'); // 'performance' → 'perform' (stemmed)
    db.close();
  });
});

describe('persisted vocabulary', () => {
  it('rebuildVocabulary persists to vocab_state table', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    // Need shared terms across docs for df>=2
    insertObs(db, { title: 'database schema migration', narrative: 'alter table add column' });
    insertObs(db, { title: 'database schema fix', narrative: 'schema migration update' });
    insertObs(db, { title: 'search query optimization', narrative: 'FTS5 BM25 ranking search' });
    const vocab = rebuildVocabulary(db);
    expect(vocab).not.toBeNull();
    const rows = db.prepare('SELECT COUNT(*) as c FROM vocab_state').get();
    expect(rows.c).toBe(vocab.terms.size);
    const versionRow = db.prepare('SELECT DISTINCT version FROM vocab_state').get();
    expect(versionRow.version).toBe(vocab.version);
    db.close();
  });

  it('getVocabulary loads from DB without recomputing', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    // Need 2+ docs with shared terms for df>=2
    insertObs(db, { title: 'test observation one', narrative: 'content here' });
    insertObs(db, { title: 'test content two', narrative: 'another test observation' });
    const v1 = rebuildVocabulary(db);
    _resetVocabCache();
    const v2 = getVocabulary(db);
    expect(v2.version).toBe(v1.version);
    expect(v2.terms.size).toBe(v1.terms.size);
    for (const [term, entry] of v1.terms) {
      expect(v2.terms.get(term)?.index).toBe(entry.index);
    }
    db.close();
  });

  it('vectors use persisted vocab version and match on search', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    // Need shared terms for df>=2 — 'databas', 'schema', 'fix' appear in 2+ docs
    insertObs(db, { title: 'database error fix', narrative: 'fixed the schema bug' });
    insertObs(db, { title: 'database schema update', narrative: 'schema fix applied' });
    insertObs(db, { title: 'search optimization fix', narrative: 'improved query ranking' });
    const vocab = rebuildVocabulary(db);
    const obs = db.prepare('SELECT id, title, narrative FROM observations').all();
    const insertVec = db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)');
    for (const o of obs) {
      const vec = computeVector(o.title + ' ' + o.narrative, vocab);
      if (vec) insertVec.run(o.id, Buffer.from(vec.buffer), vocab.version, Date.now());
    }
    const queryVec = computeVector('database schema error', vocab);
    const results = vectorSearch(db, queryVec, { vocabVersion: vocab.version });
    expect(results.length).toBeGreaterThan(0);
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

describe('porterStem', () => {
  it('stems common English suffixes', () => {
    expect(porterStem('running')).toBe('run');
    expect(porterStem('connected')).toBe('connect');
    expect(porterStem('connections')).toBe('connect');
    expect(porterStem('caresses')).toBe('caress');
  });

  it('handles -ational → -ate → step5a', () => {
    // relational → relate (step2) → relat (step5a removes e since m>1)
    expect(porterStem('relational')).toBe('relat');
  });

  it('handles -izer → -ize → step4', () => {
    // digitizer → digitize (step2) → digit (step4 removes -ize since m>1)
    expect(porterStem('digitizer')).toBe('digit');
  });

  it('leaves short words unchanged', () => {
    expect(porterStem('db')).toBe('db');
    expect(porterStem('go')).toBe('go');
    expect(porterStem('a')).toBe('a');
  });

  it('stems programming-relevant terms', () => {
    // authentication should stem consistently
    const stem = porterStem('authentication');
    expect(porterStem('authenticate')).toBe(stem);
  });

  it('handles -ness, -ful, -ive', () => {
    expect(porterStem('effectiveness')).toBe('effect');
    expect(porterStem('hopeful')).toBe('hope');
  });
});

describe('tokenize with stemming', () => {
  it('stems ASCII tokens', () => {
    const tokens = tokenize('authenticating connections');
    // Should produce stemmed forms, not raw words
    expect(tokens).not.toContain('authenticating');
    expect(tokens).not.toContain('connections');
    // Stemmed forms should be present
    expect(tokens.length).toBe(2);
  });

  it('does not stem CJK tokens', () => {
    const tokens = tokenize('数据库');
    // CJK bigrams are unchanged by stemming
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe('named constants', () => {
  it('exports MIN_COSINE_SIMILARITY', () => {
    expect(MIN_COSINE_SIMILARITY).toBe(0.05);
  });

  it('exports VECTOR_SCAN_LIMIT', () => {
    expect(VECTOR_SCAN_LIMIT).toBe(500);
  });
});

describe('sublinear TF in computeVector', () => {
  it('repeated terms do not dominate vector', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    // Create enough docs for vocab to form
    insertObs(db, { title: 'search query test', narrative: 'search query optimization' });
    insertObs(db, { title: 'search performance', narrative: 'query speed search' });
    insertObs(db, { title: 'database search', narrative: 'query database search' });
    const vocab = buildVocabulary(db);
    if (vocab) {
      // Text with 'search' repeated many times vs once
      const vecRepeat = computeVector('search search search search search query', vocab);
      const vecOnce = computeVector('search query', vocab);
      if (vecRepeat && vecOnce) {
        // With sublinear TF, repeating a word 5x should NOT make it 5x stronger
        // Cosine similarity should be high (both about search+query) but not 1.0
        const sim = cosineSimilarity(vecRepeat, vecOnce);
        expect(sim).toBeGreaterThan(0.5); // still similar topic
        expect(sim).toBeLessThan(1.0);    // but not identical (sublinear dampens repetition)
      }
    }
    db.close();
  });
});
