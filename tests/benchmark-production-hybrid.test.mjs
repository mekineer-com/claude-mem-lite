// P7: the benchmark's production_hybrid scenario drives the REAL
// searchObservationsHybrid (FTS + TF-IDF vector + RRF), not the file-local
// FTS-only search. These tests pin that the vector arm is actually seeded and
// exercised, and that the constant sweep runs over the real path.
import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { _resetVocabCache } from '../tfidf.mjs';
import { seedDatabase, seedVectors, runBenchmark, runVectorSweep } from '../benchmark/benchmark.mjs';

// Small synthetic corpus: two topical clusters with shared vocabulary (df>=2 so a
// vocabulary builds) plus an off-topic distractor.
function makeSeed() {
  const mk = (id, title, narrative) => ({
    id, session_id: 's1', project: 'proj-a', text: `${title} ${narrative}`,
    type: 'bugfix', title, narrative, facts: '', concepts: '', files_modified: '[]',
    importance: 2, epoch_offset_days: -1,
  });
  return {
    observations: [
      mk(1, 'auth token refresh bug', 'fix the authentication token expiry during login session'),
      mk(2, 'auth session logout', 'authentication session broken after logout, token cleared'),
      mk(3, 'auth login redirect', 'authentication login redirect loops on expired token'),
      mk(4, 'database migration script', 'update database schema add user table columns index'),
      mk(5, 'database query slow', 'optimize database query performance on large table scan'),
    ],
    sessions: [],
  };
}

const QUERIES = [
  { id: 'q-auth', query: 'authentication token login', relevant_ids: [1, 2, 3], project: 'proj-a', category: 'std' },
  { id: 'q-db', query: 'database table query', relevant_ids: [4, 5], project: 'proj-a', category: 'std' },
];

describe('benchmark production_hybrid scenario (P7)', () => {
  it('seedVectors populates observation_vectors for the seeded corpus', () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, makeSeed());
    const before = db.prepare('SELECT COUNT(*) AS c FROM observation_vectors').get().c;
    expect(before).toBe(0);

    const seeded = seedVectors(db);
    expect(seeded.vectors).toBeGreaterThan(0);
    expect(seeded.vocabVersion).toBeTruthy();
    const after = db.prepare('SELECT COUNT(*) AS c FROM observation_vectors').get().c;
    expect(after).toBe(seeded.vectors);
    db.close();
  });

  it('runBenchmark("production_hybrid") retrieves relevant obs over the real path', () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, makeSeed());
    seedVectors(db);

    const results = runBenchmark(db, QUERIES, 'production_hybrid');
    // The real hybrid path should recall the topical clusters well above zero.
    expect(results.metrics.recall_at_10).toBeGreaterThan(0.5);
    expect(results.metrics.mrr_at_10).toBeGreaterThan(0);
    // It actually returned ids (not an empty/broken path).
    expect(results.perQuery.every(q => q.result_ids.length > 0)).toBe(true);
    db.close();
  });

  it('runVectorSweep covers the pinned defaults and reports whether they win', () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, makeSeed());
    seedVectors(db);

    const sweep = runVectorSweep(db, QUERIES, { dims: [256, 512], minCosines: [0.05], rrfKs: [60] });
    // Pinned default config (512/0.05/60) must be one of the swept rows.
    expect(sweep.rows.some(r => r.dim === 512 && r.minCosine === 0.05 && r.rrfK === 60)).toBe(true);
    expect(sweep.pinned).toEqual({ dim: 512, minCosine: 0.05, rrfK: 60 });
    expect(typeof sweep.pinnedIsBest).toBe('boolean');
    expect(sweep.best).toBeTruthy();
    db.close();
  });
});
