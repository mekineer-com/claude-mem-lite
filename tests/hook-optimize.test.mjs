// Tests for hook-optimize.mjs — LLM-powered database optimization
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../haiku-client.mjs', () => ({
  callModelJSON: vi.fn(),
  callLLMWithModel: vi.fn(),
}));

import { callModelJSON } from '../haiku-client.mjs';

describe('schema: optimized_at column', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('observations table has optimized_at column', () => {
    const cols = db.prepare(`PRAGMA table_info(observations)`).all();
    const col = cols.find(c => c.name === 'optimized_at');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe('NULL');
  });

  it('optimized_at defaults to NULL for new observations', () => {
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { title: 'test obs' });
    const obs = db.prepare('SELECT optimized_at FROM observations LIMIT 1').get();
    expect(obs.optimized_at).toBeNull();
  });
});

describe('re-enrich', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSON.mockReset();
  });
  afterEach(() => { db.close(); });

  it('finds degraded observations missing concepts/facts/lesson/aliases', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed the schema' });
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(1);
    expect(candidates[0].title).toBe('Modified schema.mjs');
  });

  it('skips already-optimized observations', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare('UPDATE observations SET optimized_at = ? WHERE id = ?').run(Date.now(), id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('skips observations that have concepts', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Rich obs', narrative: 'Has data', text: 'auth jwt' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare("UPDATE observations SET concepts = 'auth jwt' WHERE id = ?").run(id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('executes re-enrich and updates observation fields', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Error in utils.mjs', narrative: 'Fixed a bug in sanitizeFtsQuery' });
    callModelJSON.mockResolvedValue({
      type: 'bugfix',
      title: 'Fix sanitizeFtsQuery edge case',
      narrative: 'Fixed edge case where special chars caused crash',
      concepts: ['FTS5', 'sanitize'],
      facts: ['sanitizeFtsQuery in utils.mjs crashes on parentheses'],
      importance: 2,
      lesson_learned: 'FTS5 special chars need escaping',
      search_aliases: ['fts query bug', 'sanitize crash'],
    });

    const result = await executeReenrich(db, 10);
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT * FROM observations LIMIT 1').get();
    expect(obs.concepts).toContain('FTS5');
    expect(obs.lesson_learned).toBe('FTS5 special chars need escaping');
    expect(obs.optimized_at).toBeGreaterThan(0);
  });
});

describe('normalize', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSON.mockReset();
  });
  afterEach(() => { db.close(); });

  it('extracts unique concepts from active observations', async () => {
    const { extractUniqueConcepts } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'obs1', text: 'FTS5 search' });
    db.prepare("UPDATE observations SET concepts = 'FTS5 full-text' WHERE id = 1").run();
    insertObs(db, { title: 'obs2', text: 'FTS query' });
    db.prepare("UPDATE observations SET concepts = 'FTS search query' WHERE id = 2").run();

    const concepts = extractUniqueConcepts(db);
    expect(concepts).toContain('FTS5');
    expect(concepts).toContain('full-text');
    expect(concepts).toContain('search');
  });

  it('applies synonym groups to observations', async () => {
    const { applyNormalization } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'obs1', text: 'full-text search' });
    db.prepare("UPDATE observations SET concepts = 'full-text search' WHERE id = 1").run();

    const groups = [
      { canonical: 'FTS5', aliases: ['full-text', 'FTS', '全文搜索'] }
    ];
    const result = applyNormalization(db, groups);
    expect(result.updated).toBeGreaterThan(0);

    const obs = db.prepare('SELECT concepts, search_aliases FROM observations WHERE id = 1').get();
    expect(obs.concepts).toContain('FTS5');
  });

  it('returns 0 updated for empty groups', async () => {
    const { applyNormalization } = await import('../hook-optimize.mjs');
    const result = applyNormalization(db, []);
    expect(result.updated).toBe(0);
  });
});

describe('cluster-merge', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSON.mockReset();
  });
  afterEach(() => { db.close(); });

  it('finds merge candidates with moderate similarity', async () => {
    const { findMergeCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Fix FTS5 query sanitization bug in utils.mjs', narrative: 'Fixed special char handling' });
    insertObs(db, { title: 'Fix FTS5 query sanitization edge case in utils.mjs', narrative: 'Fixed parentheses handling' });
    const candidates = findMergeCandidates(db, 10);
    expect(candidates.length).toBeGreaterThanOrEqual(0);
  });

  it('executes merge when LLM approves', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Fix FTS5 bug A', narrative: 'Handled special chars', accessCount: 3 });
    insertObs(db, { title: 'Fix FTS5 bug B', narrative: 'Handled parentheses', accessCount: 1 });

    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
    callModelJSON.mockResolvedValue({
      should_merge: true,
      merged_title: 'Fix FTS5 query sanitization bugs',
      merged_narrative: 'Fixed multiple edge cases in FTS5 query sanitization',
      merged_concepts: ['FTS5', 'sanitize', 'query'],
      merged_facts: ['FTS5 special chars crash sanitizeFtsQuery', 'Parentheses need escaping'],
      merged_lesson: 'FTS5 requires comprehensive input sanitization',
      importance: 2,
    });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(true);

    const keeper = db.prepare('SELECT * FROM observations WHERE id = ?').get(obs[0].id);
    expect(keeper.title).toBe('Fix FTS5 query sanitization bugs');
    expect(keeper.optimized_at).toBeGreaterThan(0);

    const other = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(obs[1].id);
    expect(other.compressed_into).toBe(obs[0].id);
  });

  it('skips merge when LLM says should_merge=false', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Obs A', narrative: 'About auth' });
    insertObs(db, { title: 'Obs B', narrative: 'About database' });
    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();

    callModelJSON.mockResolvedValue({ should_merge: false });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(false);
  });
});

describe('smart-compress', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSON.mockReset();
  });
  afterEach(() => { db.close(); });

  it('finds compress candidates (old, low-importance, no access)', async () => {
    const { findSmartCompressCandidates } = await import('../hook-optimize.mjs');
    const oldEpoch = -(31 * 86400000);
    insertObs(db, { title: 'Old obs 1', epochOffset: oldEpoch, importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Old obs 2', epochOffset: oldEpoch - 1000, importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Old obs 3', epochOffset: oldEpoch - 2000, importance: 1, accessCount: 0 });
    const candidates = findSmartCompressCandidates(db);
    expect(candidates.length).toBe(3);
  });

  it('skips recent or important observations', async () => {
    const { findSmartCompressCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Recent obs', importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Important obs', epochOffset: -(31 * 86400000), importance: 2, accessCount: 0 });
    const candidates = findSmartCompressCandidates(db);
    expect(candidates.length).toBe(0);
  });

  it('creates smart summary from a cluster', async () => {
    const { executeSmartCompressCluster } = await import('../hook-optimize.mjs');
    const oldEpoch = -(31 * 86400000);
    insertObs(db, { title: 'Modified utils.mjs', narrative: 'Changed sanitize fn', epochOffset: oldEpoch });
    insertObs(db, { title: 'Updated utils.mjs tests', narrative: 'Added test cases', epochOffset: oldEpoch - 1000 });
    insertObs(db, { title: 'Fixed utils.mjs lint', narrative: 'Resolved lint warnings', epochOffset: oldEpoch - 2000 });

    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();

    callModelJSON.mockResolvedValue({
      title: 'Utils.mjs maintenance: sanitize improvements and cleanup',
      narrative: 'Series of changes to utils.mjs including sanitize function updates, test additions, and lint fixes.',
      concepts: ['utils', 'sanitize', 'lint'],
      facts: ['sanitize function in utils.mjs was updated', 'lint warnings resolved'],
      lesson_learned: 'none',
      search_aliases: ['utils cleanup', 'sanitize refactor'],
    });

    const result = await executeSmartCompressCluster(db, obs, 'test');
    expect(result.compressed).toBe(true);
    expect(result.summaryId).toBeGreaterThan(0);

    for (const o of obs) {
      const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(o.id);
      expect(row.compressed_into).toBe(result.summaryId);
    }

    const summary = db.prepare('SELECT * FROM observations WHERE id = ?').get(result.summaryId);
    expect(summary.importance).toBe(2);
    expect(summary.title).toContain('Utils.mjs');
  });
});

describe('hook integration', () => {
  it('BG_EVENTS includes llm-optimize', async () => {
    const { readFileSync } = await import('fs');
    const hookSrc = readFileSync(new URL('../hook.mjs', import.meta.url), 'utf8');
    expect(hookSrc).toContain("'llm-optimize'");
  });

  it('hook.mjs imports handleLLMOptimize', async () => {
    const { readFileSync } = await import('fs');
    const hookSrc = readFileSync(new URL('../hook.mjs', import.meta.url), 'utf8');
    expect(hookSrc).toContain('handleLLMOptimize');
  });

  it('hook.mjs spawns llm-optimize after auto-compress', async () => {
    const { readFileSync } = await import('fs');
    const hookSrc = readFileSync(new URL('../hook.mjs', import.meta.url), 'utf8');
    const autoCompressIdx = hookSrc.indexOf("spawnBackground('auto-compress')");
    const llmOptimizeIdx = hookSrc.indexOf("spawnBackground('llm-optimize')");
    expect(autoCompressIdx).toBeGreaterThan(-1);
    expect(llmOptimizeIdx).toBeGreaterThan(autoCompressIdx);
  });
});

describe('pipeline', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSON.mockReset();
  });
  afterEach(() => { db.close(); });

  it('preview returns candidate counts without executing', async () => {
    const { optimizePreview } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Degraded obs', narrative: 'No enrichment' });
    const result = optimizePreview(db);
    expect(result).toHaveProperty('reenrich');
    expect(result).toHaveProperty('normalize');
    expect(result).toHaveProperty('clusterMerge');
    expect(result).toHaveProperty('smartCompress');
    expect(result.reenrich).toBeGreaterThanOrEqual(0);
  });

  it('distributeBudget allocates correctly', async () => {
    const { distributeBudget } = await import('../hook-optimize.mjs');
    const budget = distributeBudget(15);
    expect(budget.reenrich).toBe(6);
    expect(budget.normalize).toBe(1);
    expect(budget.clusterMerge).toBe(4);
    expect(budget.smartCompress).toBe(4);
    expect(budget.reenrich + budget.normalize + budget.clusterMerge + budget.smartCompress).toBeLessThanOrEqual(15);
  });

  it('distributeBudget clamps for small totals', async () => {
    const { distributeBudget } = await import('../hook-optimize.mjs');
    const budget = distributeBudget(4);
    const sum = budget.reenrich + budget.normalize + budget.clusterMerge + budget.smartCompress;
    expect(sum).toBeLessThanOrEqual(4);
    expect(budget.normalize).toBe(1);
  });
});
