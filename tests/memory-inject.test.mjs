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

  it('updates access_count for returned memories', () => {
    const info = insertObs(db, {
      sessionId: 'sess-1', project: 'proj', type: 'bugfix',
      title: 'Fixed dispatch race', narrative: 'Lock contention issue',
      text: 'dispatch race condition lock contention episode flush',
      importance: 3, accessCount: 0
    });
    const obsId = Number(info.lastInsertRowid);
    searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    const row = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(obsId);
    expect(row.access_count).toBe(1);
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
});
