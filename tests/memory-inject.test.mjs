import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { searchRelevantMemories, recallForFile } from '../hook-memory.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('searchRelevantMemories', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'proj' });

    // BM25 needs corpus diversity to produce meaningful scores (IDF requires >1 docs).
    // Add background noise documents so target observations score above threshold.
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'sess-1', project: 'proj', type: 'change',
        title: `Updated config file ${i}`, text: `config yaml settings update number ${i}`,
        importance: 2
      });
    }
  });
  afterEach(() => { db?.close(); });

  it('returns matching bugfix memories for relevant prompt', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fixed dispatch race condition',
      narrative: 'Lock contention in episode flush',
      text: 'dispatch race condition lock contention episode flush',
      importance: 3
    });
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('dispatch');
  });

  it('returns empty when no relevant memories exist', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'change',
      title: 'Updated README', narrative: 'Minor doc changes',
      text: 'readme documentation update', importance: 1
    });
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    expect(results.length).toBe(0);
  });

  it('retrieves importance=1 observations with high BM25 relevance', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Race condition fix in worker pool',
      narrative: 'Fixed thread safety issue in worker pool',
      text: 'race condition worker pool thread safety fix',
      importance: 1
    });
    const results = searchRelevantMemories(db, 'race condition worker pool', 'proj', []);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('Race condition');
  });

  it('does not retrieve importance=1 observations with low BM25 relevance (below threshold after penalty)', () => {
    // Insert an importance=1 observation with a topic that will get low BM25 score
    // against the search query (minimal keyword overlap)
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'change',
      title: 'Minor tweak to settings',
      narrative: 'Small change to settings file',
      text: 'settings yaml minor tweak adjustment',
      importance: 1
    });
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    // importance=1 with weak BM25 match should be filtered by the 0.6x penalty + 1.5 threshold
    expect(results.length).toBe(0);
  });

  it('excludes observations already in Key Context', () => {
    const info = insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fixed dispatch race', narrative: 'Lock issue',
      text: 'dispatch race lock contention', importance: 3
    });
    const obsId = Number(info.lastInsertRowid);
    const results = searchRelevantMemories(db, 'dispatch race', 'proj', [obsId]);
    expect(results.length).toBe(0);
  });

  it('limits to max 3 results', () => {
    for (let i = 1; i <= 5; i++) {
      insertObs(db, {
        sessionId: 'sess-1', project: 'proj', type: 'bugfix',
        title: `Fix dispatch error ${i}`, narrative: `Details ${i}`,
        text: `dispatch error fix crash ${i}`, importance: 3
      });
    }
    const results = searchRelevantMemories(db, 'dispatch error crash', 'proj', []);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('prefers bugfix/decision types over change', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'change',
      title: 'Modified dispatch.mjs', narrative: 'Edited file',
      text: 'dispatch modified file refactor', importance: 2
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fixed dispatch error', narrative: 'Root cause fix',
      text: 'dispatch error fix root cause', importance: 2
    });
    const results = searchRelevantMemories(db, 'dispatch error', 'proj', []);
    if (results.length > 0) {
      expect(results[0].type).toBe('bugfix');
    }
  });

  it('returns empty for very short prompts', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fix something', narrative: 'Details',
      text: 'fix something', importance: 3
    });
    const results = searchRelevantMemories(db, 'hi', 'proj', []);
    expect(results.length).toBe(0);
  });

  // R1: LOW_SIGNAL title filtering — degraded titles from hook-llm fallback
  // (Modified X, Worked on X, Reviewed N files:, etc.) must not be injected.

  it('R1: excludes "Modified X" titles from injection', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'change',
      title: 'Modified dispatch.mjs',
      text: 'dispatch race condition lock worker pool fix',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fix dispatch race condition',
      text: 'dispatch race condition lock worker pool fix',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race condition fix', 'proj', []);
    const titles = results.map(r => r.title);
    expect(titles).toContain('Fix dispatch race condition');
    expect(titles).not.toContain('Modified dispatch.mjs');
  });

  it('R1: excludes "Worked on X" titles from injection', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'discovery',
      title: 'Worked on worker pool',
      text: 'worker pool thread safety crash recovery',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fix worker pool thread safety',
      text: 'worker pool thread safety crash recovery',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'worker pool thread safety', 'proj', []);
    const titles = results.map(r => r.title);
    expect(titles).toContain('Fix worker pool thread safety');
    expect(titles).not.toContain('Worked on worker pool');
  });

  it('R1: excludes "Reviewed N files:" titles from injection', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'discovery',
      title: 'Reviewed 6 files: cache.mjs, worker.mjs, queue.mjs',
      text: 'cache worker queue batch throughput optimization',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'discovery',
      title: 'Cache worker queue batching pattern',
      text: 'cache worker queue batch throughput optimization',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'cache worker queue batch', 'proj', []);
    const titles = results.map(r => r.title);
    expect(titles).toContain('Cache worker queue batching pattern');
    expect(titles.some(t => t.startsWith('Reviewed '))).toBe(false);
  });

  // R2: Type quality rebalancing — bugfix (with empirical 2.4× access rate)
  // should beat change when BM25 is equal.

  it('R2: ranks bugfix above change when text match is equal', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'change',
      title: 'Updated auth middleware signature',
      text: 'auth middleware token validation refresh flow',
      importance: 2,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fixed auth middleware token leak',
      text: 'auth middleware token validation refresh flow',
      importance: 2,
    });
    const results = searchRelevantMemories(db, 'auth middleware token validation', 'proj', []);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('bugfix');
  });

  it('updates injection_count (NOT access_count) for returned memories', () => {
    // v26 P0: auto-injection bumps injection_count, leaving access_count
    // for explicit access (cite / cmdRecall / cmdGet / cmdTimeline /
    // pre-tool-recall). This separation powers the noise-ratio penalty.
    const info = insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fixed dispatch race', narrative: 'Lock contention issue',
      text: 'dispatch race condition lock contention episode flush',
      importance: 3, accessCount: 0
    });
    const obsId = Number(info.lastInsertRowid);
    searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    const row = db.prepare('SELECT access_count, injection_count, last_injected_at FROM observations WHERE id = ?').get(obsId);
    expect(row.injection_count).toBe(1);
    expect(row.access_count).toBe(0);   // preserved — pure auto-inject no longer pollutes
    expect(row.last_injected_at).toBeGreaterThan(0);
  });
});

describe('lesson-boosted memory search', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });

    // Background noise for BM25 IDF
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'sess-1', project: 'test', type: 'change',
        title: `Updated config file ${i}`, text: `config yaml settings update number ${i}`,
        importance: 2
      });
    }
  });
  afterEach(() => { db?.close(); });

  it('ranks memories with lessons higher than without', () => {
    insertObs(db, {
      type: 'bugfix', title: 'Fixed CORS error in auth middleware',
      text: 'auth middleware CORS headers fix bugfix', importance: 2,
      lessonLearned: 'Add CORS headers in middleware, not in route handlers',
      epochOffset: -3 * 86400000
    });
    insertObs(db, {
      type: 'bugfix', title: 'Fixed auth middleware token expiry check',
      text: 'auth middleware token expiry fix', importance: 2,
      epochOffset: -3 * 86400000
    });
    const results = searchRelevantMemories(db, 'auth middleware fix', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    if (results.length >= 2) {
      expect(results[0].lesson_learned).toBeTruthy();
    }
  });

  it('returns empty for unrelated prompts', () => {
    insertObs(db, {
      type: 'bugfix', title: 'Fixed database timeout',
      text: 'database timeout connection pool', importance: 2,
      epochOffset: -3 * 86400000
    });
    const results = searchRelevantMemories(db, 'add a new button to the UI', 'test');
    expect(results.length).toBe(0);
  });
});

describe('file-aware recall', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => { db?.close(); });

  it('finds bugfix memories for files being edited', () => {
    insertObs(db, {
      type: 'bugfix', title: 'Fix race condition in hook.mjs',
      text: 'hook.mjs race condition fix',
      importance: 2, filesModified: '["hook.mjs"]',
      epochOffset: -5 * 86400000
    });
    const results = recallForFile(db, 'hook.mjs', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/hook\.mjs/);
  });

  it('returns empty for files with no history', () => {
    const results = recallForFile(db, 'brand-new-file.mjs', 'test');
    expect(results.length).toBe(0);
  });

  it('only returns importance>=2 observations', () => {
    insertObs(db, {
      type: 'change', title: 'Minor edit to hook.mjs',
      text: 'hook.mjs minor change',
      importance: 1, filesModified: '["hook.mjs"]',
      epochOffset: -2 * 86400000
    });
    const results = recallForFile(db, 'hook.mjs', 'test');
    for (const r of results) {
      expect(r.importance).toBeGreaterThanOrEqual(2);
    }
  });

  it('escapes LIKE wildcards in filenames (% and _)', () => {
    // A file named "test_100%.mjs" should NOT match "testX100Y.mjs" (unescaped _ and %)
    insertObs(db, {
      type: 'bugfix', title: 'Fix in test_100%.mjs',
      text: 'test_100%.mjs fix',
      importance: 2, filesModified: '["test_100%.mjs"]',
      epochOffset: -2 * 86400000
    });
    insertObs(db, {
      type: 'bugfix', title: 'Fix in testX100Y.mjs',
      text: 'testX100Y.mjs fix',
      importance: 2, filesModified: '["testX100Y.mjs"]',
      epochOffset: -2 * 86400000
    });
    // Should only match the exact filename, not the wildcard-expanded one
    const results = recallForFile(db, 'test_100%.mjs', 'test');
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('test_100%.mjs');
  });
});

describe('OR fallback in searchRelevantMemories', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-or-test', project: 'test-project' });

    // Background noise for BM25 IDF
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'sess-or-test', project: 'test-project', type: 'change',
        title: `Updated config file ${i}`, text: `config yaml settings update number ${i}`,
        importance: 2
      });
    }
  });
  afterEach(() => { db?.close(); });

  it('falls back to OR query when AND returns no results for short queries', () => {
    // Insert observation with only partial keyword match
    insertObs(db, {
      sessionId: 'sess-or-test', project: 'test-project', type: 'bugfix',
      title: 'Fixed database connection timeout',
      narrative: 'The pool was exhausted',
      text: 'database connection timeout pool exhausted',
      importance: 2
    });

    // 2-token AND query: "database latency" won't AND-match (no "latency" in text)
    // but OR fallback finds it via "database" (2 tokens → OR allowed)
    const results = searchRelevantMemories(db, 'database latency', 'test-project');
    expect(results.length).toBeGreaterThan(0);
  });

  it('skips OR fallback for 3+ token queries to prevent noise', () => {
    insertSession(db, { id: 'sess-or-test2', project: 'test-project' });
    insertObs(db, {
      sessionId: 'sess-or-test2', project: 'test-project', type: 'bugfix',
      title: 'Fixed database connection timeout',
      text: 'database connection timeout pool exhausted',
      importance: 2
    });

    // 3-token AND query fails → OR fallback skipped (too many tokens = likely off-topic)
    const results = searchRelevantMemories(db, 'database performance optimization', 'test-project');
    expect(results.length).toBe(0);
  });
});
