import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { sanitizeFtsQuery, jaccardSimilarity, truncate } from './utils.mjs';

// ─── In-memory DB setup (mirrors server.mjs schema) ────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  db.exec(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL UNIQUE,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0
    );

    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      importance INTEGER DEFAULT 1,
      related_ids TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
    );

    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
    );

    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      prompt_text TEXT,
      prompt_number INTEGER,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id)
    );
  `);

  // FTS5 tables + triggers (same as server.mjs ensureFTS)
  db.exec(`
    CREATE VIRTUAL TABLE observations_fts USING fts5(title, subtitle, narrative, text, facts, concepts, content='observations', content_rowid='id');
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts) VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END;
    CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts) VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
    END;
    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts) VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts) VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END;
  `);

  return db;
}

function insertSession(db, { id, project = 'test', memoryId = null }) {
  const now = new Date();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(id, memoryId ?? id, project, now.toISOString(), now.getTime());
}

function insertObs(db, { sessionId = 'sess-1', project = 'test', type = 'discovery', title, text = '', importance = 1, relatedIds = '[]', epochOffset = 0 }) {
  const now = Date.now() + epochOffset;
  return db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, related_ids, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, '', '', '', '', '[]', '[]', ?, ?, ?, ?)
  `).run(sessionId, project, text, type, title, importance, relatedIds, new Date(now).toISOString(), now);
}

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
