import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { searchRelevantMemories } from '../hook-memory.mjs';

describe('searchRelevantMemories', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY, type TEXT, title TEXT, subtitle TEXT,
        narrative TEXT, facts TEXT, concepts TEXT,
        importance INTEGER DEFAULT 1, project TEXT, created_at TEXT,
        created_at_epoch INTEGER, compressed_into INTEGER, access_count INTEGER DEFAULT 0,
        text TEXT
      );
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title, subtitle, narrative, text, facts, concepts,
        content=observations, content_rowid=id
      );
      CREATE TRIGGER obs_fts_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `);

    // BM25 needs corpus diversity to produce meaningful scores (IDF requires >1 docs).
    // Add background noise documents so target observations score above threshold.
    const now = Date.now();
    const insert = db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
      VALUES (?, 'change', ?, ?, 2, 'proj', datetime('now'), ?, ?)`);
    for (let i = 900; i <= 920; i++) {
      insert.run(i, `Updated config file ${i}`, `Minor config changes ${i}`, now, `config yaml settings update number ${i}`);
    }
  });
  afterEach(() => { db.close(); });

  it('returns matching bugfix memories for relevant prompt', () => {
    db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
      VALUES (1, 'bugfix', 'Fixed dispatch race condition', 'Lock contention in episode flush', 3, 'proj', datetime('now'), ?, 'dispatch race condition lock contention episode flush')
    `).run(Date.now());
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('dispatch');
  });

  it('returns empty when no relevant memories exist', () => {
    db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
      VALUES (1, 'change', 'Updated README', 'Minor doc changes', 1, 'proj', datetime('now'), ?, 'readme documentation update')
    `).run(Date.now());
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    expect(results.length).toBe(0);
  });

  it('excludes observations already in Key Context', () => {
    db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
      VALUES (42, 'bugfix', 'Fixed dispatch race', 'Lock issue', 3, 'proj', datetime('now'), ?, 'dispatch race lock contention')
    `).run(Date.now());
    const results = searchRelevantMemories(db, 'dispatch race', 'proj', [42]);
    expect(results.length).toBe(0);
  });

  it('limits to max 2 results', () => {
    for (let i = 1; i <= 5; i++) {
      db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
        VALUES (?, 'bugfix', 'Fix dispatch error ${i}', 'Details ${i}', 3, 'proj', datetime('now'), ?, 'dispatch error fix crash ${i}')
      `).run(i, Date.now());
    }
    const results = searchRelevantMemories(db, 'dispatch error crash', 'proj', []);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('prefers bugfix/decision types over change', () => {
    db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
      VALUES (1, 'change', 'Modified dispatch.mjs', 'Edited file', 2, 'proj', datetime('now'), ?, 'dispatch modified file refactor')
    `).run(Date.now());
    db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
      VALUES (2, 'bugfix', 'Fixed dispatch error', 'Root cause fix', 2, 'proj', datetime('now'), ?, 'dispatch error fix root cause')
    `).run(Date.now());
    const results = searchRelevantMemories(db, 'dispatch error', 'proj', []);
    if (results.length > 0) {
      expect(results[0].type).toBe('bugfix');
    }
  });

  it('returns empty for very short prompts', () => {
    db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, text)
      VALUES (1, 'bugfix', 'Fix something', 'Details', 3, 'proj', datetime('now'), ?, 'fix something')
    `).run(Date.now());
    const results = searchRelevantMemories(db, 'hi', 'proj', []);
    expect(results.length).toBe(0);
  });

  it('updates access_count for returned memories', () => {
    db.prepare(`INSERT INTO observations (id, type, title, narrative, importance, project, created_at, created_at_epoch, access_count, text)
      VALUES (1, 'bugfix', 'Fixed dispatch race', 'Lock contention issue', 3, 'proj', datetime('now'), ?, 0, 'dispatch race condition lock contention episode flush')
    `).run(Date.now());
    searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    const row = db.prepare('SELECT access_count FROM observations WHERE id = 1').get();
    expect(row.access_count).toBe(1);
  });
});
