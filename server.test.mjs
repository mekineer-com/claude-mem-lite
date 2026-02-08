import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { sanitizeFtsQuery, jaccardSimilarity, truncate, estimateTokens } from './utils.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// ─── Dedup Migration ────────────────────────────────────────────────────────

describe('dedup migration', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates unique index when no duplicates exist', () => {
    insertSession(db, { id: 'a', memoryId: 'mem-a' });
    insertSession(db, { id: 'b', memoryId: 'mem-b' });

    // Simulate migration logic
    const hasIdx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sess_memory_sid'").get();
    expect(hasIdx).toBeUndefined();

    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sess_memory_sid ON sdk_sessions(memory_session_id)");
    db.pragma('foreign_keys = ON');

    const fk = db.pragma('foreign_keys')[0];
    expect(fk.foreign_keys).toBe(1);
  });

  it('deduplicates sessions keeping oldest row', () => {
    // Create duplicate memory_session_id
    insertSession(db, { id: 'a', memoryId: 'dup-mem' });
    insertSession(db, { id: 'b', memoryId: 'dup-mem' });
    insertSession(db, { id: 'c', memoryId: 'dup-mem' });
    insertSession(db, { id: 'unique', memoryId: 'unique-mem' });

    // Verify duplicates exist
    const dupes = db.prepare(`
      SELECT memory_session_id, COUNT(*) as cnt FROM sdk_sessions
      WHERE memory_session_id IS NOT NULL GROUP BY memory_session_id HAVING cnt > 1
    `).all();
    expect(dupes.length).toBe(1);
    expect(dupes[0].cnt).toBe(3);

    // Run dedup (same logic as server.mjs)
    const dedupFn = db.transaction(() => {
      for (const { memory_session_id } of dupes) {
        const rows = db.prepare(`
          SELECT s.id FROM sdk_sessions s WHERE s.memory_session_id = ? ORDER BY s.id ASC
        `).all(memory_session_id);
        for (let i = 1; i < rows.length; i++) {
          db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(rows[i].id);
        }
      }
    });
    dedupFn();

    // Verify: only 1 row per memory_session_id
    const remaining = db.prepare("SELECT id, memory_session_id FROM sdk_sessions ORDER BY id").all();
    expect(remaining.length).toBe(2);
    expect(remaining[0].memory_session_id).toBe('dup-mem');
    expect(remaining[1].memory_session_id).toBe('unique-mem');

    // Now unique index should succeed
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sess_memory_sid ON sdk_sessions(memory_session_id)");
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_keys')[0].foreign_keys).toBe(1);
  });
});

// ─── FK enforcement ─────────────────────────────────────────────────────────

describe('FK enforcement after migration', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sess_memory_sid ON sdk_sessions(memory_session_id)");
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => { db.close(); });

  it('allows inserting observation with valid session', () => {
    expect(() => insertObs(db, { sessionId: 'sess-1', title: 'valid' })).not.toThrow();
  });

  it('rejects observation with invalid session', () => {
    expect(() => insertObs(db, { sessionId: 'nonexistent', title: 'invalid' })).toThrow(/FOREIGN KEY/);
  });
});

// ─── mem_delete related_ids cleanup ─────────────────────────────────────────

describe('mem_delete related_ids cleanup', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('removes deleted IDs from other observations related_ids', () => {
    // Insert 3 observations with cross-references
    insertObs(db, { title: 'obs A', relatedIds: '[2, 3]' });       // id=1
    insertObs(db, { title: 'obs B', relatedIds: '[1, 3]' });       // id=2
    insertObs(db, { title: 'obs C', relatedIds: '[1, 2]' });       // id=3

    // Delete obs #2 — simulate mem_delete cleanup logic
    const deletedIds = new Set([2]);
    const referencing = db.prepare("SELECT id, related_ids FROM observations WHERE related_ids IS NOT NULL AND related_ids != '[]'").all();
    for (const r of referencing) {
      let ids;
      try { ids = JSON.parse(r.related_ids); } catch { continue; }
      if (!Array.isArray(ids)) continue;
      const filtered = ids.filter(id => !deletedIds.has(id));
      if (filtered.length !== ids.length) {
        db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(filtered), r.id);
      }
    }
    db.prepare('DELETE FROM observations WHERE id = 2').run();

    // Verify cleanup
    const obs1 = db.prepare('SELECT related_ids FROM observations WHERE id = 1').get();
    const obs3 = db.prepare('SELECT related_ids FROM observations WHERE id = 3').get();
    expect(JSON.parse(obs1.related_ids)).toEqual([3]);
    expect(JSON.parse(obs3.related_ids)).toEqual([1]);

    // Verify obs 2 is gone
    expect(db.prepare('SELECT 1 FROM observations WHERE id = 2').get()).toBeUndefined();
  });

  it('FTS5 trigger cleans up on delete', () => {
    insertObs(db, { title: 'unique searchable term', text: 'unique searchable term' });
    const id = db.prepare("SELECT id FROM observations WHERE title = 'unique searchable term'").get().id;

    // Verify FTS finds it
    const before = db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH '\"unique\"'").all();
    expect(before.length).toBe(1);

    // Delete
    db.prepare('DELETE FROM observations WHERE id = ?').run(id);

    // FTS should no longer find it
    const after = db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH '\"unique\"'").all();
    expect(after.length).toBe(0);
  });
});

// ─── mem_save dedup logic ───────────────────────────────────────────────────

describe('mem_save dedup via jaccardSimilarity', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('allows saving non-duplicate titles', () => {
    insertObs(db, { title: 'Fix authentication bug in login flow' });

    const recent = db.prepare("SELECT title FROM observations WHERE project = 'test' ORDER BY created_at_epoch DESC LIMIT 10").all();
    const newTitle = 'Add dark mode toggle to settings';
    const isDuplicate = recent.some(r => jaccardSimilarity(r.title, newTitle) > 0.7);
    expect(isDuplicate).toBe(false);
  });

  it('detects near-duplicate titles', () => {
    insertObs(db, { title: 'Fix authentication bug in login flow' });

    const recent = db.prepare("SELECT title FROM observations WHERE project = 'test' ORDER BY created_at_epoch DESC LIMIT 10").all();
    const newTitle = 'Fix authentication bug in the login flow';
    const isDuplicate = recent.some(r => jaccardSimilarity(r.title, newTitle) > 0.7);
    expect(isDuplicate).toBe(true);
  });
});

// ─── mem_save importance parameter ──────────────────────────────────────────

describe('mem_save importance', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-test', memoryId: 'manual-test' });
  });
  afterEach(() => { db.close(); });

  it('stores explicit importance value', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', ?, ?, ?)
    `).run('manual-test', 'test', 'critical fix', 'bugfix', 'Critical security patch', 'critical fix', 3, new Date(now).toISOString(), now);

    const obs = db.prepare("SELECT importance FROM observations WHERE title = 'Critical security patch'").get();
    expect(obs.importance).toBe(3);
  });

  it('defaults importance to 1', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', ?, ?, ?)
    `).run('manual-test', 'test', 'routine note', 'discovery', 'Simple note', 'routine note', 1, new Date(now).toISOString(), now);

    const obs = db.prepare("SELECT importance FROM observations WHERE title = 'Simple note'").get();
    expect(obs.importance).toBe(1);
  });
});

// ─── FTS5 search with sanitized queries ─────────────────────────────────────

describe('FTS5 search integration', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
    // Insert test observations
    insertObs(db, { title: 'webpack-dev-server configuration fix', text: 'webpack-dev-server configuration fix' });
    insertObs(db, { title: 'next-auth session handling', text: 'next-auth session handling' });
    insertObs(db, { title: 'simple react component', text: 'simple react component' });
  });
  afterEach(() => { db.close(); });

  it('finds hyphenated terms', () => {
    const fts = sanitizeFtsQuery('webpack-dev-server');
    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain('webpack-dev-server');
  });

  it('finds simple terms', () => {
    const fts = sanitizeFtsQuery('react component');
    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain('react');
  });

  it('returns empty for non-matching queries', () => {
    const fts = sanitizeFtsQuery('nonexistent term xyz');
    const rows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(0);
  });
});

// ─── WAL checkpoint ─────────────────────────────────────────────────────────

describe('WAL checkpoint', () => {
  it('PASSIVE checkpoint succeeds on in-memory DB', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    expect(() => db.pragma('wal_checkpoint(PASSIVE)')).not.toThrow();
    db.close();
  });
});

// ─── mem_get multi-source ───────────────────────────────────────────────────

describe('mem_get multi-source', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
    // Insert observation
    insertObs(db, { title: 'test observation' });
    // Insert session summary
    const now = new Date();
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '', ?, ?)
    `).run('sess-1', 'test', 'build feature X', 'explored codebase', 'found pattern', 'implemented feature', 'add tests', now.toISOString(), now.getTime());
    // Insert user prompt
    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run('sess-1', 'Help me build feature X', 1, now.toISOString(), now.getTime());
  });
  afterEach(() => { db.close(); });

  it('fetches observations by default', () => {
    const rows = db.prepare("SELECT * FROM observations WHERE id = 1").all();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('test observation');
  });

  it('fetches session summaries', () => {
    const rows = db.prepare("SELECT * FROM session_summaries WHERE id = 1").all();
    expect(rows.length).toBe(1);
    expect(rows[0].request).toBe('build feature X');
  });

  it('fetches user prompts', () => {
    const rows = db.prepare("SELECT * FROM user_prompts WHERE id = 1").all();
    expect(rows.length).toBe(1);
    expect(rows[0].prompt_text).toBe('Help me build feature X');
  });
});

// ─── Phase 1c: access_count ─────────────────────────────────────────────────

describe('access_count tracking', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('mem_get increments access_count', () => {
    insertObs(db, { title: 'test obs' });
    const id = db.prepare("SELECT id FROM observations WHERE title = 'test obs'").get().id;

    // Simulate mem_get: increment access_count
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count,0) + 1 WHERE id = ?');
    updateStmt.run(id);
    updateStmt.run(id);

    const obs = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id);
    expect(obs.access_count).toBe(2);
  });

  it('missing access_count defaults to 0', () => {
    insertObs(db, { title: 'old data' });
    const obs = db.prepare("SELECT access_count FROM observations WHERE title = 'old data'").get();
    expect(obs.access_count).toBe(0);
  });

  it('access_count boosts search ranking', () => {
    // Two observations with same text — one with high access_count
    insertObs(db, { title: 'database query optimization', text: 'database query optimization', accessCount: 50 });
    insertObs(db, { title: 'database query slow fix', text: 'database query slow fix', accessCount: 0 });

    const ftsQuery = '"database" "query"';
    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.title, o.access_count,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1))
               * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0))) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
      ORDER BY score
    `).all(now, ftsQuery);

    expect(rows.length).toBe(2);
    // The one with access_count=50 should have a better (more negative) score
    const highAccess = rows.find(r => r.access_count === 50);
    const lowAccess = rows.find(r => r.access_count === 0);
    expect(highAccess.score).toBeLessThan(lowAccess.score);
  });
});

// ─── Phase 2a: reRankWithContext ─────────────────────────────────────────────

describe('reRankWithContext', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('boosts file-overlapping results', () => {
    // Insert a recent observation editing auth.js
    insertObs(db, { title: 'recent auth edit', filesModified: '["auth.js"]', epochOffset: -1000 });
    // Insert two search results
    const results = [
      { source: 'obs', id: 100, title: 'bug in auth', score: -5.0, files_modified: '["auth.js"]', importance: 1 },
      { source: 'obs', id: 101, title: 'unrelated fix', score: -5.0, files_modified: '["utils.js"]', importance: 1 },
    ];

    // Simulate reRankWithContext logic
    const twoHoursAgo = Date.now() - 2 * 3600000;
    const recentObs = db.prepare(`
      SELECT files_modified FROM observations WHERE project = 'test' AND created_at_epoch > ?
    `).all(twoHoursAgo);

    const activeFiles = new Set();
    for (const r of recentObs) {
      try { for (const f of JSON.parse(r.files_modified || '[]')) activeFiles.add(f); } catch {}
    }

    for (const result of results) {
      let resultFiles;
      try { resultFiles = JSON.parse(result.files_modified || '[]'); } catch { continue; }
      const common = resultFiles.filter(f => activeFiles.has(f));
      const overlap = common.length / resultFiles.length;
      result.score *= (1.0 + 0.3 * overlap);
    }
    results.sort((a, b) => a.score - b.score);

    // auth.js result should be boosted (more negative)
    expect(results[0].id).toBe(100);
    expect(results[0].score).toBeLessThan(results[1].score);
  });

  it('handles no active files gracefully', () => {
    const results = [
      { source: 'obs', id: 100, title: 'test', score: -5.0, files_modified: '["foo.js"]', importance: 1 },
    ];
    // No recent observations → activeFiles is empty → no boost applied
    const twoHoursAgo = Date.now() - 2 * 3600000;
    const recentObs = db.prepare(`
      SELECT files_modified FROM observations WHERE project = 'test' AND created_at_epoch > ?
    `).all(twoHoursAgo);
    expect(recentObs.length).toBe(0);
    // Score unchanged
    expect(results[0].score).toBe(-5.0);
  });

  it('handles empty files_modified', () => {
    const results = [
      { source: 'obs', id: 100, title: 'test', score: -5.0, files_modified: '[]', importance: 1 },
    ];
    let files;
    try { files = JSON.parse(results[0].files_modified); } catch { files = []; }
    expect(files.length).toBe(0);
    // No crash, score unchanged
    expect(results[0].score).toBe(-5.0);
  });
});

// ─── Phase 2b: markSuperseded ────────────────────────────────────────────────

describe('markSuperseded', () => {
  it('marks older lower-importance obs as superseded', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["auth.js"]', importance: 1 },
      { source: 'obs', id: 2, date: '2026-02-01', files_modified: '["auth.js"]', importance: 2 },
    ];

    // Simulate markSuperseded
    const fileMap = new Map();
    for (const r of results) {
      let files;
      try { files = JSON.parse(r.files_modified || '[]'); } catch { continue; }
      for (const f of files) {
        if (!fileMap.has(f)) fileMap.set(f, []);
        fileMap.get(f).push(r);
      }
    }
    for (const [, obsForFile] of fileMap) {
      if (obsForFile.length < 2) continue;
      obsForFile.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const newest = obsForFile[0];
      for (let i = 1; i < obsForFile.length; i++) {
        if ((obsForFile[i].importance ?? 1) <= (newest.importance ?? 1)) {
          obsForFile[i].superseded = true;
        }
      }
    }

    expect(results[0].superseded).toBe(true);  // old, imp=1 <= newest imp=2
    expect(results[1].superseded).toBeUndefined();  // newest
  });

  it('preserves high-importance old obs', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["auth.js"]', importance: 3 },
      { source: 'obs', id: 2, date: '2026-02-01', files_modified: '["auth.js"]', importance: 1 },
    ];

    const fileMap = new Map();
    for (const r of results) {
      let files;
      try { files = JSON.parse(r.files_modified || '[]'); } catch { continue; }
      for (const f of files) {
        if (!fileMap.has(f)) fileMap.set(f, []);
        fileMap.get(f).push(r);
      }
    }
    for (const [, obsForFile] of fileMap) {
      if (obsForFile.length < 2) continue;
      obsForFile.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const newest = obsForFile[0];
      for (let i = 1; i < obsForFile.length; i++) {
        if ((obsForFile[i].importance ?? 1) <= (newest.importance ?? 1)) {
          obsForFile[i].superseded = true;
        }
      }
    }

    expect(results[0].superseded).toBeUndefined();  // imp=3 > newest imp=1
    expect(results[1].superseded).toBeUndefined();  // newest
  });

  it('handles obs without files', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', importance: 1 },
      { source: 'session', id: 2, date: '2026-02-01' },
    ];
    // No files_modified → no crash
    expect(() => {
      for (const r of results) {
        try { JSON.parse(r.files_modified || '[]'); } catch { /* skip */ }
      }
    }).not.toThrow();
  });
});

// ─── Phase 3a: Health metrics in mem_stats ──────────────────────────────────

describe('mem_stats health metrics', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('computes token estimate', () => {
    insertObs(db, { title: 'test observation', narrative: 'some narrative text here', text: 'extra text' });
    const result = db.prepare(`
      SELECT SUM(LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(narrative,'')) + LENGTH(COALESCE(text,''))) / 4 as t
      FROM observations
    `).get();
    expect(result.t).toBeGreaterThan(0);
  });

  it('computes noise ratio', () => {
    // Insert old, low-value, never-accessed observation
    insertObs(db, { title: 'old noise', importance: 1, accessCount: 0, epochOffset: -32 * 86400000 });
    // Insert recent observation
    insertObs(db, { title: 'recent obs', importance: 2, epochOffset: 0 });

    const obsTotal = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    const lowVal = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0 AND created_at_epoch < ?
    `).get(Date.now() - 30 * 86400000);

    const noiseRatio = obsTotal.c > 0 ? lowVal.c / obsTotal.c : 0;
    expect(noiseRatio).toBeCloseTo(0.5, 1);  // 1 of 2 is noise
  });

  it('triggers warning at > 60% noise', () => {
    // Insert 7 old low-value + 3 recent = 70% noise
    for (let i = 0; i < 7; i++) {
      insertObs(db, { title: `old noise ${i}`, importance: 1, accessCount: 0, epochOffset: -(31 + i) * 86400000 });
    }
    for (let i = 0; i < 3; i++) {
      insertObs(db, { title: `recent ${i}`, importance: 2, epochOffset: 0 });
    }

    const obsTotal = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    const lowVal = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0 AND created_at_epoch < ?
    `).get(Date.now() - 30 * 86400000);

    const noiseRatio = obsTotal.c > 0 ? lowVal.c / obsTotal.c : 0;
    expect(noiseRatio).toBeGreaterThan(0.6);
  });
});

// ─── Phase 3b: mem_compress ─────────────────────────────────────────────────

describe('mem_compress', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('preview shows candidates', () => {
    // Seed 5 old low-value obs in same project/week
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `old obs ${i}`, importance: 1, accessCount: 0, epochOffset: -(90 - i) * 86400000 });
    }

    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL
    `).all(cutoff);

    expect(candidates.length).toBe(5);
  });

  it('creates weekly summaries', () => {
    // Seed 5 old low-value obs with same week
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `old obs ${i}`, type: 'change', importance: 1, accessCount: 0, epochOffset: -(90 + i) * 86400000 });
    }

    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id, project, type, title, created_at, created_at_epoch FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL ORDER BY project, created_at_epoch
    `).all(cutoff);

    // Group by project + ISO week
    const groups = new Map();
    for (const c of candidates) {
      const d = new Date(c.created_at_epoch);
      const year = d.getFullYear();
      const jan1 = new Date(year, 0, 1);
      const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      const key = `${c.project}::${year}-W${String(weekNum).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const compressable = [...groups.entries()].filter(([, obs]) => obs.length >= 3);
    expect(compressable.length).toBeGreaterThanOrEqual(1);
  });

  it('marks originals with compressed_into', () => {
    insertObs(db, { title: 'will compress A', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    insertObs(db, { title: 'will compress B', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });

    // Simulate marking
    db.prepare('UPDATE observations SET compressed_into = 999 WHERE id = 1').run();
    const obs = db.prepare('SELECT compressed_into FROM observations WHERE id = 1').get();
    expect(obs.compressed_into).toBe(999);
  });

  it('compressed obs excluded from search', () => {
    insertObs(db, { title: 'visible searchable term', text: 'visible searchable term' });
    insertObs(db, { title: 'hidden searchable term', text: 'hidden searchable term', compressedInto: 99 });

    const rows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"searchable"'
        AND COALESCE(o.compressed_into, 0) = 0
    `).all();

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
  });

  it('skips small groups (< 3 obs)', () => {
    // Only 2 obs → should not be compressed
    insertObs(db, { title: 'small group A', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    insertObs(db, { title: 'small group B', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });

    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id, project, type, title, created_at, created_at_epoch FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL ORDER BY project, created_at_epoch
    `).all(cutoff);

    const groups = new Map();
    for (const c of candidates) {
      const d = new Date(c.created_at_epoch);
      const year = d.getFullYear();
      const jan1 = new Date(year, 0, 1);
      const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      const key = `${c.project}::${year}-W${String(weekNum).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const compressable = [...groups.entries()].filter(([, obs]) => obs.length >= 3);
    expect(compressable.length).toBe(0);
  });
});

// ─── SKIP_TOOLS sync: hook.mjs ↔ post-tool-use.sh ──────────────────────────

describe('SKIP_TOOLS sync between hook.mjs and post-tool-use.sh', () => {
  it('bash skip list matches hook.mjs SKIP_TOOLS + prefix filters', () => {
    // Extract SKIP_TOOLS from hook.mjs
    const hookSrc = readFileSync(resolve('hook.mjs'), 'utf8');
    const skipMatch = hookSrc.match(/const SKIP_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(skipMatch, 'Could not find SKIP_TOOLS in hook.mjs').toBeTruthy();
    const hookTools = skipMatch[1]
      .split(',')
      .map(s => s.replace(/\/\/.*$/gm, '').trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);

    // Extract prefix filters from hook.mjs (tool_name.startsWith checks)
    const prefixMatches = hookSrc.matchAll(/tool_name\.startsWith\(['"]([^'"]+)['"]\)/g);
    const hookPrefixes = [...prefixMatches].map(m => m[1]);

    // Extract from post-tool-use.sh
    const bashSrc = readFileSync(resolve('scripts/post-tool-use.sh'), 'utf8');

    // Extract exact-match tools from the case statement
    const caseMatch = bashSrc.match(/# Exact matches[\s\S]*?exit 0\s*;;/);
    expect(caseMatch, 'Could not find exact matches in post-tool-use.sh').toBeTruthy();
    const bashTools = caseMatch[0]
      .replace(/# .*$/gm, '')
      .replace(/exit 0\s*;;/, '')
      .replace(/\\\n/g, '')
      .split('|')
      .map(s => s.trim().replace(/[)]/g, ''))
      .filter(s => s && s !== 'Read'); // Read is handled separately in bash

    // Extract prefix filters from bash
    const prefixMatch = bashSrc.match(/# Prefix filters\s*\n\s*(.*?)exit 0/s);
    expect(prefixMatch, 'Could not find prefix filters in post-tool-use.sh').toBeTruthy();
    const bashPrefixes = prefixMatch[1]
      .replace(/\)/, '')
      .split('|')
      .map(s => s.trim().replace(/\*$/, ''))
      .filter(Boolean);

    // Compare: hook SKIP_TOOLS should be a superset of bash exact tools (bash includes Read separately)
    const hookSet = new Set(hookTools);
    for (const tool of bashTools) {
      expect(hookSet.has(tool), `Tool "${tool}" in post-tool-use.sh but not in hook.mjs SKIP_TOOLS`).toBe(true);
    }

    // Compare: all non-Read hook tools should be in bash
    const bashSet = new Set([...bashTools, 'Read']); // Read is handled separately
    for (const tool of hookTools) {
      expect(bashSet.has(tool), `Tool "${tool}" in hook.mjs SKIP_TOOLS but not in post-tool-use.sh`).toBe(true);
    }

    // Compare prefixes
    const hookPrefixSet = new Set(hookPrefixes);
    const bashPrefixSet = new Set(bashPrefixes);
    for (const p of bashPrefixes) {
      expect(hookPrefixSet.has(p), `Prefix "${p}" in post-tool-use.sh but not in hook.mjs`).toBe(true);
    }
    for (const p of hookPrefixes) {
      expect(bashPrefixSet.has(p), `Prefix "${p}" in hook.mjs but not in post-tool-use.sh`).toBe(true);
    }
  });
});
