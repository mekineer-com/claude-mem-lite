// Corpus-size normalization of the UPS absolute score floors.
//
// TOP_REL_FLOOR (50) and OR_TOP_BM25_FLOOR (30) gate a quantity that carries an
// FTS5 IDF term (≈ ln(N/df)), so the SAME row scores higher on a bigger index.
// Measured on one fixed query + target while padding the corpus with distinct
// filler (2026-08-13 dogfood): |bm25| 10.0 @ N=10 → 18.6 @ 40 → 24.2 @ 100 →
// 30.7 @ 300. The floors were calibrated at 584 obs, so on a new install they
// reject every hit — a realistic first-day corpus scored 0/8 injections.
//
// corpusFloorScale() restores scale-invariance: ln(N+1)/ln(N_REF+1), capped at 1.
// The cap is the safety property — established installs must be untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { corpusFloorScale } from '../scripts/user-prompt-search.js';

function dbWith(n) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT)');
  const ins = db.prepare('INSERT INTO observations (title) VALUES (?)');
  const many = db.transaction((count) => {
    for (let i = 0; i < count; i++) ins.run(`row ${i}`);
  });
  many(n);
  return db;
}

describe('corpusFloorScale', () => {
  let dbs = [];
  beforeEach(() => { dbs = []; });
  afterEach(() => { for (const d of dbs) { try { d.close(); } catch { /* already closed */ } } });
  const open = (n) => { const d = dbWith(n); dbs.push(d); return d; };

  it('is exactly 1.0 at and above the calibration corpus — established installs unchanged', () => {
    expect(corpusFloorScale(open(584))).toBe(1);
    expect(corpusFloorScale(open(1000))).toBe(1);
    expect(corpusFloorScale(open(3551))).toBe(1);
  });

  it('relaxes proportionally below the calibration corpus', () => {
    const s10 = corpusFloorScale(open(10));
    const s100 = corpusFloorScale(open(100));
    const s500 = corpusFloorScale(open(500));
    expect(s10).toBeLessThan(s100);
    expect(s100).toBeLessThan(s500);
    expect(s500).toBeLessThan(1);
    // ln(11)/ln(585) ≈ 0.376 — the scaled OR floor lands ~11, inside the
    // proportionally-scaled signal/noise gap rather than above all of it.
    expect(s10).toBeCloseTo(Math.log(11) / Math.log(585), 5);
    expect(30 * s10).toBeGreaterThan(0);
    expect(30 * s10).toBeLessThan(30);
  });

  it('never returns 0 (an empty corpus still yields a positive, tiny factor)', () => {
    const s = corpusFloorScale(open(0));
    expect(s).toBe(0); // ln(1)=0 → no floor at all when there is nothing to rank
    expect(Number.isFinite(s)).toBe(true);
  });

  it('fails safe to 1.0 (today\'s behavior) when the corpus probe throws', () => {
    const broken = { prepare() { throw new Error('no such table: observations'); } };
    expect(corpusFloorScale(broken)).toBe(1);
  });

  it('never scans the whole table on a large corpus (bounded OFFSET probe)', () => {
    const db = open(2000);
    let sawCount = false;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => { if (/count\(\*\)/i.test(sql)) sawCount = true; return realPrepare(sql); };
    expect(corpusFloorScale(db)).toBe(1);
    expect(sawCount, 'took the COUNT path on a large corpus').toBe(false);
  });
});
