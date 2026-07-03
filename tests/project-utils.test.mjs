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

  it('exact project name beats a substring match on a bigger project', () => {
    // Regression: a project literally named 'p' (no "--") was shadowed by the
    // substring fallback `%p%`, which matched every "projects--*" row and returned
    // the biggest one (projects--mem), making project 'p' unreachable via --project.
    insertSession(db, { id: 's1', project: 'projects--mem' });
    for (let i = 0; i < 5; i++) {
      insertObs(db, { sessionId: 's1', project: 'projects--mem', title: `big ${i}` });
    }
    insertSession(db, { id: 's2', project: 'p' });
    insertObs(db, { sessionId: 's2', project: 'p', title: 'the p project' });
    expect(resolveProject(db, 'p')).toBe('p');
  });

  it('canonical suffix match still wins over a stray exact short name', () => {
    // Design intent preserved: when both "projects--mem" and a stray "mem" exist,
    // typing "mem" resolves to the canonical (higher-data) form, NOT the stray.
    insertSession(db, { id: 's1', project: 'projects--mem' });
    insertObs(db, { sessionId: 's1', project: 'projects--mem', title: 'canonical' });
    insertSession(db, { id: 's2', project: 'mem' });
    insertObs(db, { sessionId: 's2', project: 'mem', title: 'stray' });
    expect(resolveProject(db, 'mem')).toBe('projects--mem');
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

  it('returns null for non-string input instead of crashing (bare --project flag)', () => {
    // A bare `--project` CLI flag parses to boolean true; `true.includes("--")` used to
    // throw a raw TypeError that crashed search/recent/timeline/stats/export/defer-list.
    // Non-string truthy → null (= no project filter, the absent-flag degradation).
    expect(resolveProject(db, true)).toBeNull();
    expect(resolveProject(db, 123)).toBeNull();
    expect(resolveProject(db, {})).toBeNull();
  });
});
