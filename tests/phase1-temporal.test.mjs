import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { getCurrentBranch } from '../utils.mjs';
import { markSuperseded } from '../server-internals.mjs';

describe('Phase 1 schema migrations', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('adds branch column to observations', () => {
    const cols = db.pragma('table_info(observations)').map(c => c.name);
    expect(cols).toContain('branch');
  });

  it('adds superseded_at column to observations', () => {
    const cols = db.pragma('table_info(observations)').map(c => c.name);
    expect(cols).toContain('superseded_at');
  });

  it('adds superseded_by column to observations', () => {
    const cols = db.pragma('table_info(observations)').map(c => c.name);
    expect(cols).toContain('superseded_by');
  });

  it('adds last_accessed_at column to observations', () => {
    const cols = db.pragma('table_info(observations)').map(c => c.name);
    expect(cols).toContain('last_accessed_at');
  });

  it('creates index on superseded_at for efficient filtering', () => {
    const idx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_obs_superseded'").get();
    expect(idx).toBeDefined();
  });

  it('creates index on branch for efficient filtering', () => {
    const idx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_obs_branch'").get();
    expect(idx).toBeDefined();
  });
});

describe('getCurrentBranch', () => {
  it('returns a non-empty string in a git repo', () => {
    const branch = getCurrentBranch();
    expect(typeof branch).toBe('string');
    expect(branch.length).toBeGreaterThan(0);
  });

  it('returns null or string (never throws)', () => {
    const branch = getCurrentBranch();
    expect(branch === null || typeof branch === 'string').toBe(true);
  });
});

describe('branch on observation creation', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-1' }); });
  afterEach(() => { db.close(); });

  it('insertObs accepts and stores branch', () => {
    insertObs(db, { title: 'test branch', branch: 'feat/temporal' });
    const obs = db.prepare('SELECT branch FROM observations WHERE title = ?').get('test branch');
    expect(obs.branch).toBe('feat/temporal');
  });

  it('insertObs defaults branch to null', () => {
    insertObs(db, { title: 'no branch' });
    const obs = db.prepare('SELECT branch FROM observations WHERE title = ?').get('no branch');
    expect(obs.branch).toBeNull();
  });

  it('insertObs accepts supersededAt and supersededBy', () => {
    const now = Date.now();
    insertObs(db, { title: 'superseded', supersededAt: now, supersededBy: 42 });
    const obs = db.prepare('SELECT superseded_at, superseded_by FROM observations WHERE title = ?').get('superseded');
    expect(obs.superseded_at).toBe(now);
    expect(obs.superseded_by).toBe(42);
  });

  it('insertObs accepts lastAccessedAt', () => {
    const now = Date.now();
    insertObs(db, { title: 'accessed', lastAccessedAt: now });
    const obs = db.prepare('SELECT last_accessed_at FROM observations WHERE title = ?').get('accessed');
    expect(obs.last_accessed_at).toBe(now);
  });
});

describe('branch-scoped search', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, { title: 'fix on main', branch: 'main', type: 'bugfix', text: 'fixed the auth bug' });
    insertObs(db, { title: 'fix on feature', branch: 'feat/auth', type: 'bugfix', text: 'fixed the auth refactor' });
    insertObs(db, { title: 'fix no branch', branch: null, type: 'bugfix', text: 'legacy fix' });
  });
  afterEach(() => { db.close(); });

  it('filters observations by branch when specified', () => {
    const rows = db.prepare(`
      SELECT id, title FROM observations
      WHERE branch = ? AND COALESCE(compressed_into, 0) = 0
    `).all('main');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('fix on main');
  });

  it('returns all branches when branch filter is null', () => {
    const rows = db.prepare(`
      SELECT id, title FROM observations
      WHERE (? IS NULL OR branch = ?) AND COALESCE(compressed_into, 0) = 0
    `).all(null, null);
    expect(rows).toHaveLength(3);
  });
});

describe('supersession persistence', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('excludes superseded observations from search by default', () => {
    insertObs(db, { title: 'old fix', type: 'bugfix', filesModified: '["auth.mjs"]', importance: 1, epochOffset: -86400000 });
    insertObs(db, { title: 'new fix', type: 'bugfix', filesModified: '["auth.mjs"]', importance: 2 });

    const oldObs = db.prepare("SELECT id FROM observations WHERE title = 'old fix'").get();
    const newObs = db.prepare("SELECT id FROM observations WHERE title = 'new fix'").get();
    db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?')
      .run(Date.now(), newObs.id, oldObs.id);

    const active = db.prepare(`
      SELECT id, title FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND superseded_at IS NULL
    `).all();
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe('new fix');
  });

  it('can still retrieve superseded observations when explicitly requested', () => {
    insertObs(db, { title: 'superseded obs', supersededAt: Date.now(), supersededBy: 999 });
    const all = db.prepare('SELECT * FROM observations').all();
    expect(all).toHaveLength(1);
    expect(all[0].superseded_at).not.toBeNull();
  });

  it('markSuperseded with db persists to database', () => {
    insertObs(db, { title: 'older', type: 'bugfix', filesModified: '["x.mjs"]', importance: 1, epochOffset: -86400000 });
    insertObs(db, { title: 'newer', type: 'bugfix', filesModified: '["x.mjs"]', importance: 2 });

    const results = db.prepare('SELECT id, type, title, created_at as date, files_modified, importance FROM observations ORDER BY created_at_epoch ASC').all();
    const searchResults = results.map(r => ({ source: 'obs', ...r }));

    markSuperseded(db, searchResults);

    // In-memory flag should be set
    expect(searchResults[0].superseded).toBe(true);
    // DB should be persisted
    const dbRow = db.prepare('SELECT superseded_at, superseded_by FROM observations WHERE id = ?').get(results[0].id);
    expect(dbRow.superseded_at).not.toBeNull();
    expect(dbRow.superseded_by).toBe(results[1].id);
  });
});

describe('last_accessed_at tracking', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('updates last_accessed_at when access_count increments', () => {
    insertObs(db, { title: 'accessed obs' });
    const before = db.prepare("SELECT last_accessed_at FROM observations WHERE title = 'accessed obs'").get();
    expect(before.last_accessed_at).toBeNull();

    db.prepare("UPDATE observations SET access_count = access_count + 1, last_accessed_at = ? WHERE title = 'accessed obs'").run(Date.now());

    const after = db.prepare("SELECT last_accessed_at, access_count FROM observations WHERE title = 'accessed obs'").get();
    expect(after.last_accessed_at).not.toBeNull();
    expect(after.access_count).toBe(1);
  });

  it('MAX scoring uses last_accessed_at when more recent than created_at', () => {
    const recentAccess = Date.now() - 86400000; // 1 day ago
    insertObs(db, { title: 'old but accessed', epochOffset: -30 * 86400000, lastAccessedAt: recentAccess });
    insertObs(db, { title: 'old never accessed', epochOffset: -30 * 86400000 });

    // Verify MAX picks the larger value
    const rows = db.prepare(`
      SELECT title,
        MAX(created_at_epoch, COALESCE(last_accessed_at, created_at_epoch)) as freshness
      FROM observations
      ORDER BY freshness DESC
    `).all();
    expect(rows[0].title).toBe('old but accessed');
    expect(rows[0].freshness).toBe(recentAccess);
  });
});
