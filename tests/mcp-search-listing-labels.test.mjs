// mem_search labels a recency LISTING as a listing, never as matches (E2E round 2026-09-29).
//
// Two MCP paths return rows that did not match the query and headed them
// `Found N result(s) for "<query>"`, which is how the calling model reads them:
//   - obs_type + zero matches → the type-list fallback lists the newest rows of that type.
//     `{query:"segfault", obs_type:"bugfix"}` answered "Found 2 result(s) for segfault" over
//     a cache-key bug and a parser bug; the same query without obs_type said "No results".
//   - a query that sanitizes to nothing ("C", "AND", "🚀") in the default AUTO mode skipped the
//     early "was filtered" return (deep MAY rewrite it) and, when deep did not run, printed the
//     recency listing as matches — `Found 20 of 57 result(s) for "C"` — while `deep:false`
//     said "was filtered".
import { describe, it, expect } from 'vitest';
import { handleSearchForTest } from '../server.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

function seed() {
  const db = createTestDb();
  insertSession(db, { id: 's', project: 'p', memoryId: 's' });
  insertObs(db, {
    sessionId: 's',
    project: 'p',
    type: 'bugfix',
    title: 'Cache key ignored the locale',
    narrative: 'x',
  });
  insertObs(db, {
    sessionId: 's',
    project: 'p',
    type: 'bugfix',
    title: 'Parser trailing comma',
    narrative: 'y',
  });
  insertObs(db, {
    sessionId: 's',
    project: 'p',
    type: 'decision',
    title: 'SQLite for the local cache',
    narrative: 'z',
  });
  return db;
}

const text = (res) => res.content.map((c) => c.text).join('\n');

describe('mem_search never presents a listing as matches', () => {
  it('obs_type fallback keeps its rows but says nothing matched', async () => {
    const db = seed();
    const res = await handleSearchForTest(
      db,
      { query: 'segfault', obs_type: 'bugfix', project: 'p', deep: false },
      {},
    );
    db.close();
    expect(res.results.map((r) => r.id).sort()).toEqual([1, 2]); // the fallback still lists
    expect(text(res)).not.toMatch(/Found \d+ result\(s\) for "segfault"/);
    expect(text(res)).toMatch(/No match for "segfault" — the 2 most recent bugfix observation\(s\) instead/);
  });

  it('a real match under obs_type keeps the "Found … for" header', async () => {
    const db = seed();
    const res = await handleSearchForTest(
      db,
      { query: 'locale', obs_type: 'bugfix', project: 'p', deep: false },
      {},
    );
    db.close();
    expect(text(res)).toMatch(/Found 1 result\(s\) for "locale"/);
  });

  for (const query of ['C', 'AND', '🚀']) {
    it(`auto mode answers a filtered query ${JSON.stringify(query)} the way deep:false does`, async () => {
      const db = seed();
      const auto = await handleSearchForTest(db, { query, project: 'p' }, {});
      const normal = await handleSearchForTest(db, { query, project: 'p', deep: false }, {});
      db.close();
      expect(auto.results).toEqual([]);
      expect(text(auto)).toMatch(/was filtered \(FTS5 keywords\/special chars only\)/);
      expect(text(auto)).toBe(text(normal));
    });
  }

  it('a filtered query under a filter lists by the filter and says the query was dropped', async () => {
    const db = seed();
    const res = await handleSearchForTest(db, { query: 'AND', obs_type: 'decision', project: 'p' }, {});
    db.close();
    expect(res.results.map((r) => r.id)).toEqual([3]);
    expect(text(res)).not.toMatch(/Found \d+ result\(s\) for "AND"/);
    expect(text(res)).toMatch(/Query "AND" was filtered .* 1 most recent decision observation\(s\) instead/);
  });
});
