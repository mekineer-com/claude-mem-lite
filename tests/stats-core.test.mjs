// lib/stats-core.mjs — shared primary stats feed (audit 2026-07-17 MED-4).
// The ~15 COUNT/GROUP-BY queries were byte-identical twins in server.mjs (mem_stats)
// and mem-cli.mjs (cmdStats); this locks the extracted single source plus the fact
// that both surfaces consume it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeStatsFeed } from '../lib/stats-core.mjs';
import { createTestDb, insertSession } from './test-helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function seed(db) {
  insertSession(db, { id: 'cs1', project: 'proj-a', memoryId: 'ms1' });
  insertSession(db, { id: 'cs2', project: 'proj-b', memoryId: 'ms2' });
  const ins = db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, title, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
  `);
  const now = Date.now();
  ins.run('ms1', 'proj-a', 'bugfix', 'fixed the flux capacitor race', 2, now - 1000);
  ins.run('ms1', 'proj-a', 'bugfix', 'fixed the warp core leak', 2, now - 2000);
  ins.run('ms1', 'proj-a', 'decision', 'chose sqlite over postgres', 3, now - 3000);
  ins.run('ms2', 'proj-b', 'feature', 'added pagination cursor', 1, now - 4000);
  db.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch)
              VALUES ('cs1', 'how do I fix the flux capacitor', datetime('now'), ?)`).run(now - 500);
  return now;
}

describe('computeStatsFeed', () => {
  it('returns totals, distributions, health and tier data with the twin-block row shapes', () => {
    const db = createTestDb();
    try {
      const now = seed(db);
      const feed = computeStatsFeed(db, { project: null, days: 30, now });

      expect(feed.obsTotal.c).toBe(4);
      expect(feed.promptTotal.c).toBe(1);
      expect(feed.obsRecent.c).toBe(4);

      const typeMap = Object.fromEntries(feed.types.map((t) => [t.type, t.c]));
      expect(typeMap).toEqual({ bugfix: 2, decision: 1, feature: 1 });

      // Global view lists projects; per-project view suppresses the list
      expect(feed.projects.map((p) => p.project).sort()).toEqual(['proj-a', 'proj-b']);

      expect(feed.daily.length).toBeGreaterThan(0);
      expect(feed.avgImp.v).toBeCloseTo(2.0, 5);
      expect(feed.liveTotal.c).toBe(4);
      expect(feed.noiseRatio).toBeGreaterThanOrEqual(0);
      expect(feed.compressedCount.c).toBe(0);
      expect(feed.supersededOnlyCount.c).toBe(0);
      // All 4 rows are fresh → working tier
      expect((feed.tierMap.working ?? 0) + (feed.tierMap.active ?? 0) + (feed.tierMap.archive ?? 0)).toBe(4);
    } finally {
      db.close();
    }
  });

  it('project filter scopes counts and suppresses the project list', () => {
    const db = createTestDb();
    try {
      const now = seed(db);
      const feed = computeStatsFeed(db, { project: 'proj-a', days: 30, now });
      expect(feed.obsTotal.c).toBe(3);
      expect(feed.promptTotal.c).toBe(1); // prompts joined via sdk_sessions.project
      expect(feed.projects).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('both surfaces (server.mjs + mem-cli.mjs) import the shared feed — no inline twin left', () => {
    for (const f of ['server.mjs', 'mem-cli.mjs']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, `${f} must import lib/stats-core.mjs`).toMatch(/from '\.\/lib\/stats-core\.mjs'/);
      // The twin block's distinctive inner subquery must not reappear inline outside
      // the tier command (which legitimately uses TIER_CASE_SQL for its own listing):
      // the stats-feed variant is uniquely identified by GROUP BY type ORDER BY c DESC
      // on observations together with a created_at_epoch cutoff in the same statement.
      const twinSig = /SELECT type, COUNT\(\*\) as c FROM observations\s+WHERE created_at_epoch >= \?/;
      expect(twinSig.test(src), `${f} still carries an inline stats type-distribution query`).toBe(false);
    }
  });
});
