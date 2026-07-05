// Task 7 (offline benchmark, 2026-07-05): end-to-end wiring test for
// computeAdoption — replay (T4) -> rankers (T6) -> dual-channel cosine (T3)
// -> cluster-bootstrap/RDD estimator (T5), aggregated per `surface:channel`
// bucket.
//
// NOTE: observations.memory_session_id is NOT NULL with an FK to sdk_sessions
// (schema.mjs) — insertSession() must run first (known gotcha, carried from
// Tasks 1-2/6's own tests: tests/adoption-imperative-rank.test.mjs,
// tests/adoption-searchbyfts-snapshot.test.mjs, tests/adoption-rankers.test.mjs).
// The plan's original seed() snippet omits this and fails the NOT NULL
// constraint.
//
// NOTE 2: adoption-replay.mjs's ID_RE is /#(\d{2,7})\b/g (2-7 digits) — a
// single-digit id like `(#1)` (as in the plan's illustrative fixture) extracts
// ZERO ids, so extractInjectionEvents silently drops the event (surface is
// set internally but injected.length === 0 fails the push guard). Every
// fixture below uses a realistic multi-digit observation id.
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { computeAdoption } from '../benchmark/adoption-overlap.mjs';

// Sandbox-artifact disposal: this file is the creating task for every
// mkdtempSync'd fixture dir below, so it deletes them on exit too (own
// responsibility regardless of what sibling adoption-*.test.mjs fixtures do).
const createdDirs = [];
function tmpFixtureDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length) rmSync(createdDirs.pop(), { recursive: true, force: true });
});

function seed(db, rows) {
  insertSession(db, { id: 'mem-s1', project: 'p' });
  const ins = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, lesson_learned, importance, created_at, created_at_epoch)
     VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of rows) ins.run('mem-s1', 'p', 'bugfix', r.title, r.lesson, r.importance ?? 2, new Date(r.epoch).toISOString(), r.epoch);
}

function writeTranscript(dir, name, sessionId, ts, injectedMarkerLine) {
  writeFileSync(join(dir, name), [
    { type: 'user', sessionId, timestamp: ts, message: { role: 'user', content: 'fix rrfAccumulate merge dedup' } },
    { sessionId, timestamp: ts, attachment: { hookName: 'UserPromptSubmit', content: injectedMarkerLine } },
    { type: 'assistant', sessionId, timestamp: ts, message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: { new_string: 'const r = rrfAccumulate(a, b); // merge dedup' } } ] } },
    { type: 'user', sessionId, timestamp: ts, message: { role: 'user', content: 'ok' } },
  ].map((l) => JSON.stringify(l)).join('\n'));
}

describe('computeAdoption end-to-end', () => {
  it('produces a per-bucket effect (cluster-bootstrap mean) + ci95 + rdd_jump, keyed consistently', () => {
    const db = createTestDb();
    seed(db, [
      { title: 'rrfAccumulate', lesson: 'call rrfAccumulate for merge dedup', importance: 3, epoch: 1_700_000_000_000 },
      { title: 'unrelated', lesson: 'validate VAR before rm in shell scripts', importance: 2, epoch: 1_700_000_100_000 },
    ]);
    const ts = '2026-07-01T00:00:00.000Z';
    const dir = tmpFixtureDir('adopt-e2e-');
    writeTranscript(dir, 's1.jsonl', 's1', ts, 'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate for merge dedup (#42)');

    const res = computeAdoption(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    const actionBucket = res.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'action');
    expect(actionBucket).toBeTruthy();
    expect(actionBucket.nEvents).toBeGreaterThanOrEqual(1);
    expect(actionBucket.nSessions).toBe(1);
    expect(Array.isArray(actionBucket.ci95)).toBe(true);
    expect(actionBucket.ci95).toHaveLength(2);

    // Design refinement (supersedes the plan's `effect: jump`): effect is the
    // cluster-bootstrap MEAN of the per-event control-subtracted deltas
    // (cosShown - mean(cosNearMiss)) -- consistent with ci95, which comes from
    // the SAME clusterBootstrap call. rdd_jump is the secondary,
    // gradient-corrected RDD view, reported separately.
    expect(typeof actionBucket.effect).toBe('number');
    expect(typeof actionBucket.rdd_jump).toBe('number');
    expect(typeof actionBucket.mde).toBe('number');
    // sd is RMS-around-the-bucket's-OWN-mean (not raw RMS-around-zero), so it
    // can never be negative/NaN -- but for a single-event bucket (this
    // fixture) it IS exactly 0 (one point has zero deviation from its own
    // mean), so mde is 0 too. Assert finite + non-negative, not positive.
    expect(Number.isFinite(actionBucket.mde)).toBe(true);
    expect(actionBucket.mde).toBeGreaterThanOrEqual(0);

    // Realistic-signal check, not just a type check: the shown candidate's
    // lesson text ("merge dedup") overlaps the action window's code comment
    // ("// merge dedup"), so the action-channel effect must be strictly
    // positive -- a 0 or NaN "number" would pass a bare typeof check but
    // would mean the dual-channel wiring is broken.
    expect(actionBucket.effect).toBeGreaterThan(0);
  });

  it('emits a separate prose-channel bucket for the same event (dual-channel, not merged)', () => {
    const db = createTestDb();
    seed(db, [
      { title: 'rrfAccumulate', lesson: 'call rrfAccumulate for merge dedup', importance: 3, epoch: 1_700_000_000_000 },
    ]);
    const ts = '2026-07-01T00:00:00.000Z';
    const dir = tmpFixtureDir('adopt-e2e-');
    writeTranscript(dir, 's1.jsonl', 's1', ts, 'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate for merge dedup (#77)');

    const res = computeAdoption(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    const proseBucket = res.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'prose');
    const actionBucket = res.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'action');
    expect(proseBucket).toBeTruthy();
    expect(actionBucket).toBeTruthy();
    // This fixture's output window has no assistant prose (Edit-only turn) --
    // the prose channel's bag is empty, so its cosine (and therefore effect)
    // is 0, distinct from the action channel's positive signal.
    expect(proseBucket.effect).toBe(0);
    expect(actionBucket.effect).toBeGreaterThan(0);
  });

  it('skips coverage-loss events (no shown candidate) instead of crashing on an empty shown[]', () => {
    const db = createTestDb();
    insertSession(db, { id: 'mem-s2', project: 'p' }); // no observations seeded
    const ts = '2026-07-01T00:00:00.000Z';
    const dir = tmpFixtureDir('adopt-e2e-');
    writeTranscript(dir, 's2.jsonl', 's2', ts, 'Memory — a past lesson applies to THIS task. You must: call zzqqNoMatch (#99)');

    const res = computeAdoption(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    expect(res.perBucket).toEqual([]);
  });
});
