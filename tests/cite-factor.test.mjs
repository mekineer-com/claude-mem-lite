// A1: cite_factor — boost obs with proven cite history, dampen uncited-streak
// obs upstream of importance-decay. Composes with noisePenaltyClause (different
// signal: injection_count vs access_count) and TYPE_QUALITY_CASE.
//
// Formula: clamp(0.4, 3.0, 1 + 0.2·cited_count − 0.25·uncited_streak)
//
// Why these constants:
//   - cited=0, streak=0    → 1.0 (neutral for fresh obs — no cite history yet)
//   - cited=1, streak=0    → 1.2 (mild lift)
//   - cited=5, streak=0    → 2.0
//   - cited=10+, streak=0  → 3.0 (capped — one viral obs shouldn't dominate)
//   - cited=0, streak=1    → 0.75
//   - cited=0, streak=2    → 0.5
//   - cited=0, streak=3    → 0.4 (floored; in practice citation-decay demotes
//                                  importance at streak=3 and resets streak)
//
// Disjoint from noisePenaltyClause: noise penalty fires on
// injection_count vs access_count ratio (passive injection vs any access);
// cite_factor uses the cleaner cited_count vs uncited_streak signal that the
// Stop-hook citation-decay loop maintains exclusively.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { citeFactorClause, citeFactorJs } from '../scoring-sql.mjs';
import { searchRelevantMemories } from '../hook-memory.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

function evalSql(citedCount, uncitedStreak) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE t (cited_count INTEGER, uncited_streak INTEGER);
    INSERT INTO t VALUES (${citedCount}, ${uncitedStreak});
  `);
  const row = db.prepare(`SELECT ${citeFactorClause('t')} AS f FROM t`).get();
  db.close();
  return row.f;
}

describe('citeFactorJs', () => {
  it('returns 1.0 for fresh obs (cited=0, streak=0)', () => {
    expect(citeFactorJs({ cited_count: 0, uncited_streak: 0 })).toBeCloseTo(1.0, 5);
  });

  it('boosts mildly at cited=1, streak=0', () => {
    expect(citeFactorJs({ cited_count: 1, uncited_streak: 0 })).toBeCloseTo(1.2, 5);
  });

  it('boosts to 2.0 at cited=5, streak=0', () => {
    expect(citeFactorJs({ cited_count: 5, uncited_streak: 0 })).toBeCloseTo(2.0, 5);
  });

  it('caps at 3.0 for cited ≥ 10', () => {
    expect(citeFactorJs({ cited_count: 10, uncited_streak: 0 })).toBeCloseTo(3.0, 5);
    expect(citeFactorJs({ cited_count: 29, uncited_streak: 0 })).toBeCloseTo(3.0, 5);
    expect(citeFactorJs({ cited_count: 1000, uncited_streak: 0 })).toBeCloseTo(3.0, 5);
  });

  it('penalizes uncited streak monotonically until floor', () => {
    expect(citeFactorJs({ cited_count: 0, uncited_streak: 1 })).toBeCloseTo(0.75, 5);
    expect(citeFactorJs({ cited_count: 0, uncited_streak: 2 })).toBeCloseTo(0.5, 5);
    expect(citeFactorJs({ cited_count: 0, uncited_streak: 3 })).toBeCloseTo(0.4, 5);
    expect(citeFactorJs({ cited_count: 0, uncited_streak: 10 })).toBeCloseTo(0.4, 5);
  });

  it('cite history outweighs short streak', () => {
    // cited=5, streak=2 → 1 + 1.0 − 0.5 = 1.5
    expect(citeFactorJs({ cited_count: 5, uncited_streak: 2 })).toBeCloseTo(1.5, 5);
  });

  it('handles missing/null columns gracefully as zeros', () => {
    expect(citeFactorJs({})).toBeCloseTo(1.0, 5);
    expect(citeFactorJs({ cited_count: null, uncited_streak: null })).toBeCloseTo(1.0, 5);
  });
});

describe('citeFactorClause (SQL) parity with citeFactorJs', () => {
  // Same input grid as JS tests — guarantees the two paths can't drift silently.
  const grid = [
    [0, 0, 1.0],
    [1, 0, 1.2],
    [5, 0, 2.0],
    [10, 0, 3.0],
    [29, 0, 3.0],
    [0, 1, 0.75],
    [0, 2, 0.5],
    [0, 3, 0.4],
    [0, 10, 0.4],
    [5, 2, 1.5],
  ];
  for (const [cited, streak, expected] of grid) {
    it(`SQL: cited=${cited} streak=${streak} → ${expected}`, () => {
      expect(evalSql(cited, streak)).toBeCloseTo(expected, 5);
    });
  }
});

describe('searchRelevantMemories — cite_factor end-to-end', () => {
  // Two identical-content obs share the same FTS tokens; with cite_factor wired
  // into the JS scoring path, the cited one MUST rank above the fresh one even
  // when both have the same raw BM25. This is the integration anchor — pure SQL
  // tests prove the math; this proves the math affects the ranker.
  it('cited obs outranks fresh obs with identical text', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, {
      title: 'fts trigger corruption fix',
      text: 'fts trigger corruption fix',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'wrap UPDATE in per-row try/catch',
      citedCount: 0,
      uncitedStreak: 0,
    });
    insertObs(db, {
      title: 'fts trigger corruption fix',
      text: 'fts trigger corruption fix',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'wrap UPDATE in per-row try/catch',
      citedCount: 5,
      uncitedStreak: 0,
    });
    const rows = searchRelevantMemories(db, 'fts trigger corruption', 'test');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].cited_count).toBe(5);
    expect(rows[1].cited_count).toBe(0);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    db.close();
  });

  it('uncited-streak obs ranks below fresh obs with identical text', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, {
      title: 'fts trigger corruption fix',
      text: 'fts trigger corruption fix',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'wrap UPDATE in per-row try/catch',
      citedCount: 0,
      uncitedStreak: 0,
    });
    insertObs(db, {
      title: 'fts trigger corruption fix',
      text: 'fts trigger corruption fix',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'wrap UPDATE in per-row try/catch',
      citedCount: 0,
      uncitedStreak: 2,
    });
    const rows = searchRelevantMemories(db, 'fts trigger corruption', 'test');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].uncited_streak).toBe(0);
    expect(rows[1].uncited_streak).toBe(2);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    db.close();
  });
});
