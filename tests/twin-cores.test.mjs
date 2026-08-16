// P2-12 (audit 2026-08-14): twin consolidation — the five CLI/MCP pairs that were
// hand-copied line-for-line (the 16-vs-24-column export data-loss incident's
// precursor shape) now share lib/ cores per the cli/fts-check.mjs +
// server/fts-check.mjs thin-adapter template:
//
//   get      → lib/get-core.mjs        OBS_FIELDS + SESSION_DETAIL_FIELDS + fetchObsDetail
//   update   → lib/observation-write.mjs applyObsUpdate
//   delete   → lib/delete-core.mjs      previewDeleteRows
//   browse   → lib/browse-core.mjs      collectBrowseTiers
//   registry → registry.mjs             collectRegistryStats + formatRegistryListLine
//
// Faces keep their own validation front-ends and header/footer conventions —
// only the data collection, field sets, and drift-prone row shapes are shared.

import { describe, it, expect } from 'vitest';
import { ensureRegistryDb, upsertResource } from '../registry.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { OBS_FIELDS, SESSION_DETAIL_FIELDS, fetchObsDetail } from '../lib/get-core.mjs';
import { applyObsUpdate } from '../lib/observation-write.mjs';
import { previewDeleteRows } from '../lib/delete-core.mjs';
import { collectBrowseTiers } from '../lib/browse-core.mjs';
import { collectRegistryStats, formatRegistryListLine } from '../registry.mjs';

function seededDb() {
  const db = createTestDb();
  insertSession(db, { id: 's1', project: 'p' });
  return db;
}

describe('lib/get-core.mjs', () => {
  it('OBS_FIELDS matches the observations table (every field is a real column)', () => {
    const db = createTestDb();
    const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('observations')").all().map((r) => r.name));
    for (const f of OBS_FIELDS) expect(cols.has(f), `OBS_FIELDS names unknown column "${f}"`).toBe(true);
    db.close();
  });

  // FAILS IF: the CLI session detail reverts to its old 6-field subset — a
  // remaining_items/notes/files_* hit found via FTS became a dead end in the CLI
  // detail view (searchable but never rendered).
  it('SESSION_DETAIL_FIELDS carries the full render set incl. remaining_items-adjacent fields', () => {
    for (const f of ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes', 'files_read', 'files_edited', 'project']) {
      expect(SESSION_DETAIL_FIELDS, `session detail lost "${f}"`).toContain(f);
    }
  });

  it('fetchObsDetail bumps access_count and returns rows in created order', () => {
    const db = seededDb();
    const a = Number(insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'older row' }).lastInsertRowid);
    const b = Number(insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'newer row' }).lastInsertRowid);
    const rows = fetchObsDetail(db, [b, a]);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    const bumped = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(a);
    expect(bumped.access_count).toBe(1);
    db.close();
  });
});

describe('lib/observation-write.mjs applyObsUpdate', () => {
  it('updates fields atomically, scrubs strings, rebuilds derived text', () => {
    const db = seededDb();
    const id = Number(insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'before title' }).lastInsertRowid);
    const updated = applyObsUpdate(db, id, { title: 'after title', importance: 3 });
    expect(updated.sort()).toEqual(['importance', 'title']);
    const row = db.prepare('SELECT title, importance, text FROM observations WHERE id = ?').get(id);
    expect(row.title).toBe('after title');
    expect(row.importance).toBe(3);
    expect(row.text, 'derived text not rebuilt').toContain('after title');
    db.close();
  });

  it('returns [] and writes nothing when no fields given', () => {
    const db = seededDb();
    const id = Number(insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'untouched' }).lastInsertRowid);
    expect(applyObsUpdate(db, id, {})).toEqual([]);
    expect(db.prepare('SELECT title FROM observations WHERE id = ?').get(id).title).toBe('untouched');
    db.close();
  });
});

describe('lib/delete-core.mjs previewDeleteRows', () => {
  it('returns rows + shared preview body lines', () => {
    const db = seededDb();
    const id = Number(insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'doomed row' }).lastInsertRowid);
    const { rows, lines } = previewDeleteRows(db, [id, 99999]);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`#${id}`);
    expect(lines[0]).toContain('doomed row');
    expect(lines[0]).toContain('| p');
    db.close();
  });
});

describe('lib/browse-core.mjs collectBrowseTiers', () => {
  it('collects tier counts + rows with the superset column shape', () => {
    const db = seededDb();
    insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'fresh row', importance: 2 });
    const { showTiers, tierData, tierCounts, grandTotal } = collectBrowseTiers(db, {
      project: 'p', tierFilter: null, limit: 5, now: Date.now(), currentSessionId: 's1',
    });
    expect(showTiers).toEqual(['working', 'active', 'archive']);
    expect(grandTotal).toBe(1);
    const withRow = showTiers.find((t) => tierData[t].rows.length > 0);
    expect(withRow, 'seeded row landed in no tier').toBeTruthy();
    const r = tierData[withRow].rows[0];
    // Superset shape: both faces render from these — importance was CLI-only pre-P2-12.
    for (const k of ['id', 'type', 'title', 'importance', 'created_at', 'created_at_epoch']) {
      expect(k in r, `browse row lost "${k}"`).toBe(true);
    }
    expect(tierCounts[withRow]).toBe(1);
    db.close();
  });
});

describe('registry.mjs stats + list twins', () => {
  function regDb() {
    const rdb = ensureRegistryDb(':memory:');
    upsertResource(rdb, { name: 'alpha-skill', type: 'skill', status: 'active', source: 'user', local_path: '/tmp/alpha', capability_summary: 'x'.repeat(120) });
    upsertResource(rdb, { name: 'beta-agent', type: 'agent', status: 'active', source: 'github', local_path: '/tmp/beta' });
    rdb.prepare("UPDATE resources SET adopt_count = 5, recommend_count = 9 WHERE name = 'alpha-skill'").run();
    return rdb;
  }

  it('collectRegistryStats returns the five stat groups both faces render', () => {
    const rdb = regDb();
    const s = collectRegistryStats(rdb);
    expect(s.total).toBe(2);
    expect(Object.fromEntries(s.byType.map((t) => [t.type, t.c]))).toEqual({ skill: 1, agent: 1 });
    expect(s.userAdded).toBe(1);
    expect(s.zeroAdopt).toBe(0);
    expect(s.topAdopted.map((r) => r.name)).toEqual(['alpha-skill']);
    rdb.close();
  });

  // FAILS IF: the faces re-diverge on the list row shape — the audited drift was
  // truncate 50 vs 80 and `adopt:null` on one face only.
  it('formatRegistryListLine coalesces null counts and truncates at 80', () => {
    const line = formatRegistryListLine({
      name: 'alpha-skill', type: 'skill', invocation_name: null,
      recommend_count: null, adopt_count: null, capability_summary: 'y'.repeat(200),
    });
    expect(line).toContain('rec:0');
    expect(line).toContain('adopt:0');
    expect(line).not.toContain('null');
    expect(line.length).toBeLessThan(140);
  });
});
