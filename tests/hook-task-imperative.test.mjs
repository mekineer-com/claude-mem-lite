// tests/hook-task-imperative.test.mjs
// Phase-2 task-imperative injection (spec 2026-06-29 §4.1/§4.3/§9).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { selectImperativeLesson } from '../hook-memory.mjs';

describe('selectImperativeLesson (Phase-2 gate)', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'imp-sess', project: 'p' });
  });
  afterEach(() => db.close());
  const seed = (o) => insertObs(db, { sessionId: 'imp-sess', project: 'p', ...o });

  it('returns the importance>=2 lesson whose identifiers overlap the prompt', () => {
    seed({ title: 'RRF merge fix', lessonLearned: 'use rrfMerge not naive union for fusion', importance: 2 });
    const pick = selectImperativeLesson(db, 'about to touch rrfMerge in tfidf', 'p');
    expect(pick).not.toBeNull();
    expect(pick.lesson_learned).toBe('use rrfMerge not naive union for fusion');
  });
  it('excludes importance<2 lessons', () => {
    seed({ title: 'low', lessonLearned: 'keep rrfMerge stable', importance: 1 });
    expect(selectImperativeLesson(db, 'editing rrfMerge', 'p')).toBeNull();
  });
  it('excludes empty / "none" lesson_learned', () => {
    seed({ title: 'no lesson', lessonLearned: '', importance: 3 });
    seed({ title: 'none lesson', lessonLearned: 'none', importance: 3 });
    expect(selectImperativeLesson(db, 'touch rrfMerge', 'p')).toBeNull();
  });
  it('returns null when no lesson identifier overlaps the prompt', () => {
    seed({ title: 'unrelated', lessonLearned: 'always call recoverChildrenOf first', importance: 3 });
    expect(selectImperativeLesson(db, 'plain english prompt no symbols', 'p')).toBeNull();
  });
  it('returns null when the prompt has no extractable identifiers', () => {
    seed({ title: 'x', lessonLearned: 'use rrfMerge here', importance: 3 });
    expect(selectImperativeLesson(db, 'fix the thing please', 'p')).toBeNull();
  });
  it('picks highest importance*overlap (top-1)', () => {
    seed({ title: 'a', lessonLearned: 'touch rrfMerge carefully', importance: 2 });
    seed({ title: 'b', lessonLearned: 'rrfMerge and rrfFuseN must agree', importance: 3 });
    expect(selectImperativeLesson(db, 'editing rrfMerge today', 'p').lesson_learned)
      .toBe('rrfMerge and rrfFuseN must agree');
  });
  it('respects excludeIds (no double-injection with the context block)', () => {
    seed({ title: 'a', lessonLearned: 'use rrfMerge not union', importance: 3 });
    const first = selectImperativeLesson(db, 'editing rrfMerge', 'p');
    expect(first).not.toBeNull();
    expect(selectImperativeLesson(db, 'editing rrfMerge', 'p', [first.id])).toBeNull();
  });
});
