// tests/adoption-imperative-rank.test.mjs
// Task 2 (offline benchmark, 2026-07-05): extract the FULL scored candidate list behind
// selectImperativeLesson's single top-1 pick, so the benchmark can inspect near-miss
// candidates just below the winner. Characterizes rankImperativeCandidates() and locks
// selectImperativeLesson() as its thin [0] wrapper (behavior-preserving refactor).
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { selectImperativeLesson, rankImperativeCandidates } from '../hook-memory.mjs';

// NOTE: observations.memory_session_id is NOT NULL with an FK to sdk_sessions
// (schema.mjs) — insertSession() must run first (known gotcha, carried from Task 1).
function seed(db, rows) {
  insertSession(db, { id: 'mem-s1', project: 'p' });
  const ins = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, lesson_learned, importance, created_at, created_at_epoch)
     VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of rows) ins.run('mem-s1', 'p', 'bugfix', r.title, r.lesson, r.importance ?? 2,
    new Date(r.epoch).toISOString(), r.epoch);
}

describe('rankImperativeCandidates', () => {
  it('returns a score-sorted candidate list, argmax === selectImperativeLesson', () => {
    const db = createTestDb();
    seed(db, [
      { title: 'rrfAccumulate', lesson: 'call rrfAccumulate not manual merge', importance: 3, epoch: 1_700_000_000_000 },
      { title: 'recoverChildrenOf', lesson: 'call recoverChildrenOf before delete', importance: 2, epoch: 1_700_000_100_000 },
    ]);
    const prompt = 'I need to fix the rrfAccumulate merge path';
    const ranked = rankImperativeCandidates(db, prompt, 'p');
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0].lesson_learned).toMatch(/rrfAccumulate/);
    expect(ranked.every((c) => c.overlap >= 1)).toBe(true);
    const winner = selectImperativeLesson(db, prompt, 'p');
    expect(winner).toEqual({ id: ranked[0].id, lesson_learned: ranked[0].lesson_learned });
  });

  it('epochTo filters out later rows', () => {
    const db = createTestDb();
    seed(db, [{ title: 'rrfAccumulate', lesson: 'call rrfAccumulate', importance: 3, epoch: 1_900_000_000_000 }]);
    expect(rankImperativeCandidates(db, 'rrfAccumulate merge', 'p', [], { epochTo: 1_800_000_000_000 })).toEqual([]);
  });

  // Beyond the brief: the whole point of this extraction is near-miss visibility — assert
  // BOTH overlapping candidates survive (not just the argmax), sorted score desc.
  it('keeps every overlapping candidate, sorted by score desc (near-miss visibility)', () => {
    const db = createTestDb();
    seed(db, [
      { title: 'a', lesson: 'touch rrfAccumulate carefully', importance: 2, epoch: 1_700_000_000_000 },
      { title: 'b', lesson: 'rrfAccumulate and rrfFuseN must agree', importance: 3, epoch: 1_700_000_100_000 },
    ]);
    const ranked = rankImperativeCandidates(db, 'editing rrfAccumulate today', 'p');
    expect(ranked.length).toBe(2);
    expect(ranked[0].lesson_learned).toBe('rrfAccumulate and rrfFuseN must agree');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].lesson_learned).toBe('touch rrfAccumulate carefully'); // near-miss, still present
  });
});
