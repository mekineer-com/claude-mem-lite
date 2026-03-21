// Unit tests for server-internals.mjs (extracted from server.mjs for testability)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { reRankWithContext, markSuperseded, extractPRFTerms, expandQueryByConcepts, PRF_STOP_WORDS } from '../server-internals.mjs';

// ─── reRankWithContext ──────────────────────────────────────────────────────

describe('reRankWithContext', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('boosts results with exact file match', () => {
    // Insert recent obs editing auth.js
    insertObs(db, { title: 'recent edit', filesModified: '["src/auth.js"]', epochOffset: -1000 });

    const results = [
      { source: 'obs', id: 1, score: -5.0, files_modified: '["src/auth.js"]' },
      { source: 'obs', id: 2, score: -5.0, files_modified: '["lib/other.js"]' },
    ];
    reRankWithContext(db, results, 'test');

    // auth.js result should be boosted (more negative)
    expect(results[0].score).toBeLessThan(-5.0);
    // unrelated dir result should not be boosted
    expect(results[1].score).toBe(-5.0);
  });

  it('applies half-weight for directory-level matches', () => {
    insertObs(db, { title: 'recent edit', filesModified: '["src/components/Button.js"]', epochOffset: -1000 });

    const results = [
      { source: 'obs', id: 1, score: -5.0, files_modified: '["src/components/Modal.js"]' },
    ];
    reRankWithContext(db, results, 'test');

    // Should be boosted but less than exact match (half weight)
    expect(results[0].score).toBeLessThan(-5.0);
    const boost = results[0].score / (-5.0);
    // 0.3 * 0.5 * (1/1) = 0.15 → multiplier = 1.15
    expect(boost).toBeCloseTo(1.15, 1);
  });

  it('skips when no active files', () => {
    // No recent observations → no active files
    const results = [
      { source: 'obs', id: 1, score: -5.0, files_modified: '["foo.js"]' },
    ];
    reRankWithContext(db, results, 'test');
    expect(results[0].score).toBe(-5.0);
  });

  it('skips non-obs results', () => {
    insertObs(db, { title: 'recent', filesModified: '["foo.js"]', epochOffset: -1000 });

    const results = [
      { source: 'session', id: 1, score: -5.0, files_modified: '["foo.js"]' },
    ];
    reRankWithContext(db, results, 'test');
    expect(results[0].score).toBe(-5.0);
  });

  it('handles JSON parse errors gracefully', () => {
    insertObs(db, { title: 'recent', filesModified: '["foo.js"]', epochOffset: -1000 });

    const results = [
      { source: 'obs', id: 1, score: -5.0, files_modified: 'invalid json' },
    ];
    expect(() => reRankWithContext(db, results, 'test')).not.toThrow();
    expect(results[0].score).toBe(-5.0);
  });
});

// ─── markSuperseded ─────────────────────────────────────────────────────────

describe('markSuperseded', () => {
  it('marks older lower-importance obs as superseded', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["auth.js"]', importance: 1 },
      { source: 'obs', id: 2, date: '2026-02-01', files_modified: '["auth.js"]', importance: 2 },
    ];
    markSuperseded(null, results);
    expect(results[0].superseded).toBe(true);
    expect(results[1].superseded).toBeUndefined();
  });

  it('preserves high-importance old records', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["auth.js"]', importance: 3 },
      { source: 'obs', id: 2, date: '2026-02-01', files_modified: '["auth.js"]', importance: 1 },
    ];
    markSuperseded(null, results);
    expect(results[0].superseded).toBeUndefined(); // imp 3 > newest imp 1
    expect(results[1].superseded).toBeUndefined(); // newest
  });

  it('handles single-file results', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["only.js"]', importance: 1 },
    ];
    markSuperseded(null, results);
    expect(results[0].superseded).toBeUndefined();
  });

  it('handles multi-file cross-references', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["a.js","b.js"]', importance: 1 },
      { source: 'obs', id: 2, date: '2026-02-01', files_modified: '["b.js","c.js"]', importance: 1 },
      { source: 'obs', id: 3, date: '2026-03-01', files_modified: '["c.js","d.js"]', importance: 1 },
    ];
    markSuperseded(null, results);
    // For b.js: #1 (oldest) superseded by #2 (newest for b.js)
    expect(results[0].superseded).toBe(true);
    // For c.js: #2 superseded by #3 (newest for c.js)
    expect(results[1].superseded).toBe(true);
    expect(results[2].superseded).toBeUndefined();
  });

  it('handles empty results', () => {
    expect(() => markSuperseded(null, [])).not.toThrow();
    expect(() => markSuperseded(null, null)).not.toThrow();
    expect(() => markSuperseded(null, undefined)).not.toThrow();
  });
});

// ─── extractPRFTerms ────────────────────────────────────────────────────────

describe('extractPRFTerms', () => {
  it('extracts discriminative terms from top results', () => {
    const results = [
      { title: 'authentication session handling', narrative: 'The authentication module handles session tokens securely' },
      { title: 'session token refresh logic', narrative: 'Session token refresh was broken in the authentication flow' },
      { title: 'token validation fix', narrative: 'Fixed token validation in authentication middleware' },
    ];
    const terms = extractPRFTerms(results, '"search"');
    expect(terms.length).toBeGreaterThan(0);
    // Should find terms that appear in >=2 docs
    for (const t of terms) {
      expect(t.length).toBeGreaterThan(3);
    }
  });

  it('excludes query terms', () => {
    const results = [
      { title: 'authentication fix applied', narrative: 'Fixed the authentication flow for authentication system' },
      { title: 'authentication token update', narrative: 'Updated authentication tokens for authentication' },
    ];
    const terms = extractPRFTerms(results, '"authentication"');
    expect(terms.every(t => t !== 'authentication')).toBe(true);
  });

  it('respects limit parameter', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      title: `common term1 term2 term3 term4 term5 doc${i}`,
      narrative: `narrative with term1 term2 term3 term4 term5 extra${i}`,
    }));
    const terms = extractPRFTerms(results, '"search"', 2);
    expect(terms.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for empty results', () => {
    const terms = extractPRFTerms([], '"query"');
    expect(terms).toEqual([]);
  });

  it('filters PRF stop words', () => {
    const results = [
      { title: 'the code was changed', narrative: 'the file was updated with new changes' },
      { title: 'changed the file code', narrative: 'updated the code file changes' },
    ];
    const terms = extractPRFTerms(results, '"query"');
    for (const t of terms) {
      expect(PRF_STOP_WORDS.has(t)).toBe(false);
    }
  });

  it('requires >=2 document frequency', () => {
    const results = [
      { title: 'unique1234 in first doc', narrative: 'some content here' },
      { title: 'different content', narrative: 'other stuff entirely' },
    ];
    const terms = extractPRFTerms(results, '"query"');
    // unique1234 only appears in 1 doc, should not be extracted
    expect(terms.every(t => t !== 'unique1234')).toBe(true);
  });
});

// ─── expandQueryByConcepts ──────────────────────────────────────────────────

describe('expandQueryByConcepts', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('discovers co-occurring concepts', () => {
    // Insert observations with shared concepts
    for (let i = 0; i < 3; i++) {
      const now = Date.now() + i;
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'test', ?, 'discovery', ?, '', 'auth security tokens', '', '[]', '[]', 1, ?, ?)
      `).run('sess-1', `authentication text ${i}`, `auth obs ${i}`, new Date(now).toISOString(), now);
    }

    const concepts = expandQueryByConcepts(db, '"auth"', 'test');
    // "security" and "tokens" should co-occur with "auth"
    expect(concepts.length).toBeGreaterThan(0);
    expect(concepts.every(c => c !== 'auth')).toBe(true);
  });

  it('excludes query terms from results', () => {
    for (let i = 0; i < 3; i++) {
      const now = Date.now() + i;
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'test', ?, 'discovery', ?, '', 'database query optimization', '', '[]', '[]', 1, ?, ?)
      `).run('sess-1', `database text ${i}`, `db obs ${i}`, new Date(now).toISOString(), now);
    }

    const concepts = expandQueryByConcepts(db, '"database"', 'test');
    expect(concepts.every(c => c !== 'database')).toBe(true);
  });

  it('respects project filter', () => {
    for (let i = 0; i < 3; i++) {
      const now = Date.now() + i;
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'other-project', ?, 'discovery', ?, '', 'react hooks state', '', '[]', '[]', 1, ?, ?)
      `).run('sess-1', `react text ${i}`, `react obs ${i}`, new Date(now).toISOString(), now);
    }

    // Searching in 'test' project should not find 'other-project' observations
    const concepts = expandQueryByConcepts(db, '"react"', 'test');
    expect(concepts.length).toBe(0);
  });

  it('returns empty when no matches', () => {
    const concepts = expandQueryByConcepts(db, '"nonexistent_xyz"', 'test');
    expect(concepts).toEqual([]);
  });

  it('handles FTS5 errors gracefully', () => {
    // Invalid FTS query should not throw
    const concepts = expandQueryByConcepts(db, '""', 'test');
    expect(concepts).toEqual([]);
  });
});
