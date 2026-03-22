import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { resolveProject, _resetProjectCache } from '../project-utils.mjs';

describe('resolveProject', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _resetProjectCache(); });
  afterEach(() => { db.close(); _resetProjectCache(); });

  it('returns null/undefined unchanged', () => {
    expect(resolveProject(db, null)).toBe(null);
    expect(resolveProject(db, undefined)).toBe(undefined);
  });

  it('returns canonical names (with --) unchanged', () => {
    expect(resolveProject(db, 'parent--child')).toBe('parent--child');
  });

  it('resolves short name to canonical via DB suffix match', () => {
    insertSession(db, { id: 's1', project: 'projects--myapp' });
    insertObs(db, { sessionId: 's1', project: 'projects--myapp', title: 'test obs' });
    expect(resolveProject(db, 'myapp')).toBe('projects--myapp');
  });

  it('picks the most common canonical name when multiple match', () => {
    insertSession(db, { id: 's1', project: 'dev--myapp' });
    insertSession(db, { id: 's2', project: 'projects--myapp' });
    insertObs(db, { sessionId: 's1', project: 'dev--myapp', title: 'obs1' });
    insertObs(db, { sessionId: 's2', project: 'projects--myapp', title: 'obs2' });
    insertObs(db, { sessionId: 's2', project: 'projects--myapp', title: 'obs3' });
    // projects--myapp has 2 observations, dev--myapp has 1 => picks projects--myapp
    expect(resolveProject(db, 'myapp')).toBe('projects--myapp');
  });

  it('falls back to short name when no DB match', () => {
    expect(resolveProject(db, 'unknown')).toBe('unknown');
  });

  it('caches resolved names across calls', () => {
    insertSession(db, { id: 's1', project: 'projects--cached' });
    insertObs(db, { sessionId: 's1', project: 'projects--cached', title: 'test' });
    const first = resolveProject(db, 'cached');
    const second = resolveProject(db, 'cached');
    expect(first).toBe('projects--cached');
    expect(second).toBe('projects--cached');
  });

  it('cache is cleared by _resetProjectCache', () => {
    // Populate cache with a short name that has no DB match
    expect(resolveProject(db, 'nomatch')).toBe('nomatch');
    // Now add data
    insertSession(db, { id: 's1', project: 'data--nomatch' });
    insertObs(db, { sessionId: 's1', project: 'data--nomatch', title: 'obs' });
    // Still cached as 'nomatch'
    expect(resolveProject(db, 'nomatch')).toBe('nomatch');
    // After reset, picks up DB data
    _resetProjectCache();
    expect(resolveProject(db, 'nomatch')).toBe('data--nomatch');
  });

  it('caches canonical names without DB lookup', () => {
    // Canonical names should be cached directly (no SQL needed)
    expect(resolveProject(db, 'a--b')).toBe('a--b');
    // Close DB — if it tried to query, it would throw
    db.close();
    expect(resolveProject(db, 'a--b')).toBe('a--b');
    // Re-open for afterEach cleanup
    db = createTestDb();
  });
});
