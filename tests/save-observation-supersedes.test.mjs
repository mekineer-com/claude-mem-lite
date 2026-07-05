// P4 governance: explicit supersession. When a new observation overturns a prior
// conclusion, the caller can pass supersedes=[ids] so those rows are tombstoned
// (superseded_at set → drop out of live search) AND linked (superseded_by = the new
// id). Fixes finding #4: contradictory memories (#8754 old rerank verdict vs the
// later reversal) coexist in search results with no supersession link, so stale
// conclusions keep getting injected at full weight. The observations.superseded_by
// column already exists (schema.mjs) — no migration needed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';

describe('saveObservation supersedes', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-test', project: 'test' });
    insertSession(db, { id: 'manual-other', project: 'other' });
  });
  afterEach(() => { db.close(); });

  const seedOld = (over = {}) => insertObs(db, {
    sessionId: 'manual-test', project: 'test', type: 'discovery',
    title: 'Old rerank verdict', narrative: 'rerank is not the lever', text: 'rerank verdict', ...over,
  });

  it('tombstones and links a prior observation the new save overturns', () => {
    const oldId = Number(seedOld().lastInsertRowid);
    const r = saveObservation(db, {
      content: 'Fresh measurement overturns the old rerank verdict: paraphrase gap closed',
      title: 'Rerank verdict reversed', type: 'decision', project: 'test', supersedes: [oldId],
    });
    expect(r.kind).toBe('saved');
    expect(r.supersededIds).toEqual([oldId]);
    const old = db.prepare('SELECT superseded_at, superseded_by FROM observations WHERE id = ?').get(oldId);
    expect(old.superseded_at).toBeGreaterThan(0);
    expect(old.superseded_by).toBe(r.id); // links to the superseding row
  });

  it('never supersedes a row in a different project', () => {
    const otherId = Number(insertObs(db, { sessionId: 'manual-other', project: 'other', title: 'Other proj', narrative: 'x', text: 'x' }).lastInsertRowid);
    const r = saveObservation(db, {
      content: 'A brand new save in test project unrelated to other', title: 'New', project: 'test', supersedes: [otherId],
    });
    expect(r.supersededIds).toEqual([]);
    const other = db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(otherId);
    expect(other.superseded_at).toBeNull();
  });

  it('skips an already-superseded row (idempotent, no re-stamp)', () => {
    const oldId = Number(seedOld({ supersededAt: 111 }).lastInsertRowid);
    const r = saveObservation(db, {
      content: 'Another fresh conclusion about the ranking lever question entirely', title: 'Newer', project: 'test', supersedes: [oldId],
    });
    expect(r.supersededIds).toEqual([]);
    const old = db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(oldId);
    expect(old.superseded_at).toBe(111); // unchanged
  });

  it('ignores self-reference, non-existent, and malformed ids', () => {
    const r = saveObservation(db, {
      content: 'Standalone save that references junk supersede ids for safety', title: 'Standalone', project: 'test',
      supersedes: [999999, -1, 0, 'x', null],
    });
    expect(r.kind).toBe('saved');
    expect(r.supersededIds).toEqual([]);
  });

  it('is a no-op when supersedes is omitted (back-compat)', () => {
    const oldId = Number(seedOld().lastInsertRowid);
    const r = saveObservation(db, { content: 'Plain save with no supersedes field at all here', title: 'Plain', project: 'test' });
    expect(r.supersededIds).toEqual([]);
    expect(db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(oldId).superseded_at).toBeNull();
  });
});
