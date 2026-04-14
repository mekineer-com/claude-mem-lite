// Activity namespace data-layer tests (T7 v2.31).
// Verifies saveEvent/getEvent/searchEvents/recentEvents over the events table
// (added in T6). Activity events are intentionally separate from observations
// so they don't pollute the L1 system-prompt memory section.

import { describe, test, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { saveEvent, searchEvents, recentEvents, getEvent } from '../lib/activity.mjs';

describe('activity store', () => {
  test('saveEvent returns id and persists', () => {
    const db = createTestDb();
    const id = saveEvent(db, {
      project: 'mem',
      event_type: 'bugfix',
      title: 'fix x',
      body: 'root cause y',
      importance: 2,
    });
    expect(id).toBeGreaterThan(0);
    const row = getEvent(db, id);
    expect(row.title).toBe('fix x');
  });

  test('searchEvents uses FTS and filters by type', () => {
    const db = createTestDb();
    saveEvent(db, { project: 'mem', event_type: 'bugfix', title: 'auth null deref', importance: 2 });
    saveEvent(db, { project: 'mem', event_type: 'lesson', title: 'auth caching trap', importance: 2 });
    const hits = searchEvents(db, 'auth', { project: 'mem', type: 'bugfix' });
    expect(hits).toHaveLength(1);
    expect(hits[0].event_type).toBe('bugfix');
  });

  test('recentEvents sorts DESC by created', () => {
    const db = createTestDb();
    const t0 = Date.now();
    saveEvent(db, { project: 'mem', event_type: 'observation', title: 'old', importance: 1, created_at_epoch: t0 - 1000 });
    saveEvent(db, { project: 'mem', event_type: 'observation', title: 'new', importance: 1, created_at_epoch: t0 });
    const hits = recentEvents(db, { project: 'mem', limit: 2 });
    expect(hits[0].title).toBe('new');
  });

  test('saveEvent stores file_paths as JSON array', () => {
    const db = createTestDb();
    const id = saveEvent(db, {
      project: 'mem',
      event_type: 'lesson',
      title: 't',
      file_paths: ['src/foo.mjs', 'src/bar.mjs'],
      importance: 1,
    });
    const row = getEvent(db, id);
    expect(JSON.parse(row.file_paths)).toEqual(['src/foo.mjs', 'src/bar.mjs']);
  });

  test('getEvent increments accessed_count', () => {
    const db = createTestDb();
    const id = saveEvent(db, { project: 'mem', event_type: 'bug', title: 't', importance: 1 });
    getEvent(db, id);
    getEvent(db, id);
    const row = db.prepare(`SELECT accessed_count FROM events WHERE id=?`).get(id);
    expect(row.accessed_count).toBe(2);
  });

  test('searchEvents excludes superseded events', () => {
    const db = createTestDb();
    const id = saveEvent(db, { project: 'mem', event_type: 'lesson', title: 'old approach', importance: 2 });
    db.prepare(`UPDATE events SET superseded_at_epoch = ? WHERE id = ?`).run(Date.now(), id);
    const hits = searchEvents(db, 'old', { project: 'mem' });
    expect(hits).toHaveLength(0);
  });
});
