import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertPrompt } from './test-helpers.mjs';
import { computeTier } from '../tier.mjs';
import {
  buildSearchFtsQuery, parseDateBounds, computePerSourceWindow,
  effectiveObsFtsQuery, searchSessionsFts, searchPromptsFts,
  normalizeCrossSourceScores, applyUserSort, applyTierFilter,
} from '../lib/search-core.mjs';

// Single-source search core (D#34): cmdSearch (CLI) and mem_search (MCP)
// hand-copied the sessions/prompts FTS queries, CJK precision + LIKE fallback,
// cross-source normalization, user-sort, over-fetch sizing, and date parsing —
// synced only by "paired-path" comments (the #8637/#8638 pagination bugs both
// came from exactly this drift). These tests pin the shared contract; flag
// parsing and rendering stay per-surface.
describe('search-core', () => {
  describe('buildSearchFtsQuery', () => {
    it('builds AND query by default and OR query when forced', () => {
      const andQ = buildSearchFtsQuery('cache flush');
      const orQ = buildSearchFtsQuery('cache flush', { or: true });
      expect(andQ).toBeTruthy();
      expect(orQ).toBeTruthy();
      expect(orQ).toContain(' OR ');
      expect(andQ).not.toBe(orQ);
    });

    it('returns falsy for operator-only queries', () => {
      expect(buildSearchFtsQuery('AND OR NOT')).toBeFalsy();
    });
  });

  describe('parseDateBounds', () => {
    it('extends date-only `to` bound to end-of-day', () => {
      const r = parseDateBounds('2026-06-01', '2026-06-02');
      expect(r.ok).toBe(true);
      expect(r.epochFrom).toBe(new Date('2026-06-01').getTime());
      expect(r.epochTo).toBe(new Date('2026-06-02').getTime() + 86400000 - 1);
    });

    it('keeps full ISO `to` timestamps un-extended', () => {
      const iso = '2026-06-02T10:00:00.000Z';
      const r = parseDateBounds(null, iso);
      expect(r.ok).toBe(true);
      expect(r.epochTo).toBe(new Date(iso).getTime());
    });

    it('flags which bound is invalid', () => {
      expect(parseDateBounds('garbage', null)).toEqual({ ok: false, bad: 'from', value: 'garbage' });
      expect(parseDateBounds(null, 'nope')).toEqual({ ok: false, bad: 'to', value: 'nope' });
    });

    it('returns nulls when no bounds given', () => {
      expect(parseDateBounds(undefined, undefined)).toEqual({ ok: true, epochFrom: null, epochTo: null });
    });
  });

  describe('computePerSourceWindow', () => {
    it('over-fetches 3x limit and always fetches from offset 0', () => {
      expect(computePerSourceWindow(20, 0)).toEqual({ perSourceLimit: 60, perSourceOffset: 0 });
    });

    // D#30 re-audit: the fusion pool MUST be offset-independent. Previously
    // (#8638) it grew as max(limit*3, offset+limit+10) so deep pages stayed
    // reachable — but a larger pool re-ranks the RRF/vector prefix, so adjacent
    // --offset pages sliced different orderings and OVERLAPPED/GAPPED. Stability
    // (correct pages) wins over reachability (deep pages that returned wrong rows).
    it('is offset-independent so --offset pages slice one stable ordering (D#30)', () => {
      const w0 = computePerSourceWindow(10, 0);
      const w50 = computePerSourceWindow(10, 50);
      const w500 = computePerSourceWindow(10, 500);
      expect(w0.perSourceLimit).toBe(w50.perSourceLimit);
      expect(w50.perSourceLimit).toBe(w500.perSourceLimit);
      expect(w0.perSourceOffset).toBe(0);
    });

    // MIN_FUSION_POOL floor: limits ≤ 20 (the common range: mem_search=20,
    // mem_recall/recent=10) all fuse the SAME 60-candidate pool, so top-N is
    // limit-stable (top-5 ⊂ top-10 ⊂ top-20) and the default limit=20 offset=0
    // pool is byte-identical to before (60) — no recall regression on the
    // benchmarked path (longmemeval recall@k is pool-insensitive across 20–100).
    it('floors small limits to the default-20 pool so top-N is limit-stable', () => {
      expect(computePerSourceWindow(5, 0).perSourceLimit).toBe(60);
      expect(computePerSourceWindow(10, 0).perSourceLimit).toBe(60);
      expect(computePerSourceWindow(20, 0).perSourceLimit).toBe(60);
    });

    // Larger limits keep the 3× over-fetch buffer (the AND→OR / vector / concept
    // stages re-add rows), so the pool tracks limit above the floor.
    it('keeps 3x over-fetch above the floor for large limits', () => {
      expect(computePerSourceWindow(50, 0).perSourceLimit).toBe(150);
      expect(computePerSourceWindow(50, 30).perSourceLimit).toBe(150); // still offset-independent
    });
  });

  describe('effectiveObsFtsQuery', () => {
    it('relaxes to OR only when the fallback fired', () => {
      const q = buildSearchFtsQuery('cache flush');
      expect(effectiveObsFtsQuery(q, false)).toBe(q);
      expect(effectiveObsFtsQuery(q, true)).toContain(' OR ');
    });
  });

  describe('source queries', () => {
    let db;
    beforeEach(() => {
      db = createTestDb();
      insertSession(db, { id: 'sess-sc', project: 'test' });
    });
    afterEach(() => db.close());

    const addSummary = ({ request, project = 'test', epochOffset = 0 }) => db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
      VALUES ('sess-sc', ?, ?, '', ?, ?)
    `).run(project, request, new Date(Date.now() + epochOffset).toISOString(), Date.now() + epochOffset);

    it('searchSessionsFts matches FTS and respects project filter', () => {
      addSummary({ request: 'fix the zanzibar cache' });
      addSummary({ request: 'zanzibar elsewhere', project: 'other' });
      const all = searchSessionsFts(db, { ftsQuery: 'zanzibar', perSourceLimit: 10 });
      expect(all).toHaveLength(2);
      const scoped = searchSessionsFts(db, { ftsQuery: 'zanzibar', project: 'test', perSourceLimit: 10 });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].project).toBe('test');
      expect(scoped[0].score).toBeLessThan(0); // BM25 negative scale survived extraction
    });

    it('searchSessionsFts boosts the inferred current project 2x', () => {
      addSummary({ request: 'zanzibar here' });
      addSummary({ request: 'zanzibar there', project: 'other' });
      const boosted = searchSessionsFts(db, { ftsQuery: 'zanzibar', projectBoost: 'test', perSourceLimit: 10 });
      const testRow = boosted.find((r) => r.project === 'test');
      const otherRow = boosted.find((r) => r.project === 'other');
      // ORDER BY score ascending (more negative = better): boosted row wins
      expect(Math.abs(testRow.score)).toBeGreaterThan(Math.abs(otherRow.score));
      expect(boosted[0].project).toBe('test');
    });

    it('searchPromptsFts matches FTS and excludes task-notifications', () => {
      insertPrompt(db, { contentSessionId: 'sess-sc', text: 'please fix zanzibar' });
      insertPrompt(db, { contentSessionId: 'sess-sc', text: '<task-notification>zanzibar done' });
      const rows = searchPromptsFts(db, { query: 'zanzibar', ftsQuery: 'zanzibar', perSourceLimit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].prompt_text).toBe('please fix zanzibar');
    });

    it('searchPromptsFts falls back to CJK LIKE scan with score 0 when FTS misses', () => {
      insertPrompt(db, { contentSessionId: 'sess-sc', text: '我们修复了缓存问题' });
      // ftsQuery that legitimately matches nothing forces the fallback path;
      // the CJK bigrams from `query` drive the LIKE scan + precision gate.
      const rows = searchPromptsFts(db, { query: '修复缓存', ftsQuery: '"zzznomatch"', perSourceLimit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBe(0);
      // Precision gate applies to the fallback too (#leak): unrelated CJK prose stays out
      insertPrompt(db, { contentSessionId: 'sess-sc', text: '完全无关的中文句子' });
      const again = searchPromptsFts(db, { query: '修复缓存', ftsQuery: '"zzznomatch"', perSourceLimit: 10 });
      expect(again).toHaveLength(1);
    });
  });

  describe('normalizeCrossSourceScores', () => {
    it('scales each source to [-1, 0] independently, honoring the sourceKey dialect', () => {
      const results = [
        { _source: 'obs', score: -40 }, { _source: 'obs', score: -20 },
        { _source: 'session', score: -6 }, { _source: 'session', score: -3 },
      ];
      normalizeCrossSourceScores(results, '_source');
      expect(results.map((r) => r.score)).toEqual([-1, -0.5, -1, -0.5]);
    });

    it('skips single-row sources (no inflating a weak match to -1)', () => {
      const results = [{ source: 'prompt', score: -0.2 }, { source: 'obs', score: -10 }, { source: 'obs', score: -5 }];
      normalizeCrossSourceScores(results, 'source');
      expect(results[0].score).toBe(-0.2);
    });
  });

  describe('applyUserSort', () => {
    const rows = () => [
      { id: 1, score: -1, created_at_epoch: 100, importance: 1 },
      { id: 2, score: -0.5, created_at_epoch: 300, importance: 3 },
      { id: 3, score: -0.7, created_at_epoch: 200, importance: 3 },
    ];

    it('time sorts newest first', () => {
      const r = rows();
      applyUserSort(r, 'time');
      expect(r.map((x) => x.id)).toEqual([2, 3, 1]);
    });

    it('importance sorts desc with recency tiebreak', () => {
      const r = rows();
      applyUserSort(r, 'importance');
      expect(r.map((x) => x.id)).toEqual([2, 3, 1]);
    });

    it('relevance leaves existing order untouched', () => {
      const r = rows();
      applyUserSort(r, 'relevance');
      expect(r.map((x) => x.id)).toEqual([1, 2, 3]);
    });
  });

  describe('applyTierFilter', () => {
    let db;
    beforeEach(() => {
      db = createTestDb();
      insertSession(db, { id: 'sess-sc', project: 'test' });
    });
    afterEach(() => db.close());

    it('filters obs rows by computed tier and passes non-obs rows through', () => {
      const freshId = Number(db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES ('sess-sc', 'test', 't', 'bugfix', 'fresh obs', '', '', '', '', '[]', '[]', 2, ?, ?)
      `).run(new Date().toISOString(), Date.now()).lastInsertRowid);
      const results = [
        { source: 'obs', id: freshId },
        { source: 'session', id: 999 }, // non-obs passes through regardless of tier
        { source: 'obs', id: 424242 },  // unknown obs id is dropped
      ];
      const ctx = { now: Date.now(), currentProject: 'test', currentSessionId: '' };
      const full = db.prepare('SELECT id, compressed_into, superseded_at, memory_session_id, project, importance, last_accessed_at, created_at_epoch, type FROM observations WHERE id = ?').get(freshId);
      const freshTier = computeTier(full, ctx);

      const kept = applyTierFilter(db, results, { tier: freshTier, sourceKey: 'source', currentProject: 'test' });
      expect(kept.map((r) => r.id)).toEqual([freshId, 999]);

      const otherTier = freshTier === 'archive' ? 'working' : 'archive';
      const dropped = applyTierFilter(db, results, { tier: otherTier, sourceKey: 'source', currentProject: 'test' });
      expect(dropped.map((r) => r.id)).toEqual([999]);
    });

    it('returns input unchanged when there are no obs rows', () => {
      const results = [{ _source: 'prompt', id: 1 }];
      expect(applyTierFilter(db, results, { tier: 'working', sourceKey: '_source', currentProject: 'test' })).toBe(results);
    });
  });
});
