// D10 (2026-09-29): an importance a person set explicitly is not rewritten by the passes that
// PROMOTE on access. `mem_update importance=1` (or `update N --importance 1`) was undone by the
// next mem_get — autoBoostIfNeeded lifts access_count >= 2, importance 1 rows to 2, and reading
// the row is what raises access_count — and later by maintain's boostAccessed. The row now
// records WHEN a person set it (observations.importance_set_at, additive + nullable, no schema
// version bump), and both promotion passes leave such rows alone. Decay is untouched.
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { applyObsUpdate } from '../lib/observation-write.mjs';
import { autoBoostIfNeeded } from '../search-scoring.mjs';
import { boostAccessed } from '../lib/maintain-core.mjs';

function seed() {
  const db = createTestDb();
  insertSession(db, { id: 's', project: 'p' });
  const id = Number(
    insertObs(db, { sessionId: 's', project: 'p', type: 'decision', title: 'Chose X', importance: 2 })
      .lastInsertRowid,
  );
  db.prepare('UPDATE observations SET access_count = 5 WHERE id = ?').run(id);
  return { db, id };
}
const imp = (db, id) => db.prepare('SELECT importance FROM observations WHERE id = ?').get(id).importance;

describe('a human-set importance survives the promotion passes (D10)', () => {
  it('update stamps importance_set_at', () => {
    const { db, id } = seed();
    applyObsUpdate(db, id, { importance: 1 });
    expect(
      db.prepare('SELECT importance_set_at FROM observations WHERE id = ?').get(id).importance_set_at,
    ).toBeGreaterThan(0);
    db.close();
  });

  it('the read-path autoBoost leaves it at 1', () => {
    const { db, id } = seed();
    applyObsUpdate(db, id, { importance: 1 });
    autoBoostIfNeeded(db, [id]);
    expect(imp(db, id)).toBe(1);
    db.close();
  });

  it("maintain's boostAccessed leaves it too", () => {
    const { db, id } = seed();
    applyObsUpdate(db, id, { importance: 1 });
    boostAccessed(db, { projectFilter: '', baseParams: [], opCap: 1000 });
    expect(imp(db, id)).toBe(1);
    db.close();
  });

  it('premise: an importance nobody set is still promoted', () => {
    const { db, id } = seed();
    db.prepare('UPDATE observations SET importance = 1 WHERE id = ?').run(id);
    autoBoostIfNeeded(db, [id]);
    expect(imp(db, id)).toBe(2);
    db.close();
  });

  it('updating another field does not stamp it', () => {
    const { db, id } = seed();
    applyObsUpdate(db, id, { title: 'Chose X over Y' });
    expect(
      db.prepare('SELECT importance_set_at FROM observations WHERE id = ?').get(id).importance_set_at,
    ).toBeNull();
    db.close();
  });

  it('a DB from the previous release gets the column without a version bump', async () => {
    const { initSchema, CURRENT_SCHEMA_VERSION } = await import('../schema.mjs');
    const { db } = seed();
    db.exec('ALTER TABLE observations DROP COLUMN importance_set_at');
    const cols = () =>
      db
        .prepare('PRAGMA table_info(observations)')
        .all()
        .map((c) => c.name);
    expect(cols()).not.toContain('importance_set_at'); // premise: the previous-release shape
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(CURRENT_SCHEMA_VERSION);
    initSchema(db);
    expect(cols()).toContain('importance_set_at');
    db.close();
  });
});
