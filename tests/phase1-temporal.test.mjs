import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { getCurrentBranch } from '../utils.mjs';

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
