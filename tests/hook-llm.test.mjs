// Tests for hook-llm.mjs — saveObservation, dedup tiers, related linking, LLM episode/summary
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { computeMinHash } from '../utils.mjs';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../hook-shared.mjs', async () => {
  const actual = await vi.importActual('../hook-shared.mjs');
  return {
    ...actual,
    openDb: vi.fn(),
    callLLM: vi.fn(),
    sleep: vi.fn(async () => {}),
  };
});

import { saveObservation, handleLLMEpisode, handleLLMSummary } from '../hook-llm.mjs';
import { openDb, callLLM } from '../hook-shared.mjs';
import { acquireLLMSlot } from '../hook-semaphore.mjs';

// ─── saveObservation ─────────────────────────────────────────────────────────

describe('saveObservation', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });

  afterEach(() => {
    db.close();
  });

  it('inserts observation and returns row ID', () => {
    const obs = {
      type: 'feature',
      title: 'Add user authentication',
      subtitle: 'auth.mjs',
      narrative: 'Implemented JWT auth flow',
      concepts: ['auth', 'jwt'],
      facts: ['Uses RS256 signing'],
      files: ['auth.mjs'],
      filesRead: ['config.mjs'],
      importance: 2,
    };

    const id = saveObservation(obs, 'test', 'sess-1', db);
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.title).toBe('Add user authentication');
    expect(row.type).toBe('feature');
    expect(row.narrative).toBe('Implemented JWT auth flow');
    expect(row.importance).toBe(2);
    expect(row.minhash_sig).not.toBeNull();
    expect(JSON.parse(row.files_modified)).toEqual(['auth.mjs']);
    expect(JSON.parse(row.files_read)).toEqual(['config.mjs']);
    expect(row.text).toBe('auth jwt Uses RS256 signing');
  });

  it('returns null for Tier 1 Jaccard dedup within 5 minutes', () => {
    const obs = { type: 'discovery', title: 'Fix login bug in auth module' };
    const id1 = saveObservation(obs, 'test', 'sess-1', db);
    expect(id1).toBeGreaterThan(0);

    const id2 = saveObservation(obs, 'test', 'sess-1', db);
    expect(id2).toBeNull();
  });

  it('returns null for Tier 2 MinHash dedup within 7 days', () => {
    const title = 'Implementing redis caching for database queries';
    const narrative = 'Added caching layer with TTL support and invalidation logic for the service';
    const sig = computeMinHash(title + ' ' + narrative);

    // Insert existing obs 6 min ago (outside Tier 1 5-min window, inside Tier 2 7-day window)
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
      VALUES (?, ?, '', 'discovery', ?, '', ?, '', '', '[]', '[]', 1, ?, ?, ?)
    `).run('sess-1', 'test', title, narrative, sig, new Date(sixMinAgo).toISOString(), sixMinAgo);

    // Same content should be deduped by Tier 2
    const id = saveObservation({ type: 'discovery', title, narrative }, 'test', 'sess-1', db);
    expect(id).toBeNull();
  });

  it('auto-creates session if absent', () => {
    const id = saveObservation(
      { type: 'discovery', title: 'Test observation' },
      'test', 'new-session', db
    );
    expect(id).toBeGreaterThan(0);

    const session = db.prepare(
      'SELECT * FROM sdk_sessions WHERE content_session_id = ?'
    ).get('new-session');
    expect(session).toBeDefined();
    expect(session.project).toBe('test');
    expect(session.status).toBe('active');
  });

  it('handles null concepts and facts arrays', () => {
    const id = saveObservation(
      { type: 'change', title: 'Null arrays test', concepts: null, facts: null },
      'test', 'sess-1', db
    );
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.concepts).toBe('');
    expect(row.facts).toBe('');
    expect(row.text).toBe('');
  });

  it('handles empty concepts and facts arrays', () => {
    const id = saveObservation(
      { type: 'change', title: 'Empty arrays test', concepts: [], facts: [] },
      'test', 'sess-1', db
    );
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.concepts).toBe('');
    expect(row.facts).toBe('');
  });

  it('handles missing optional fields gracefully', () => {
    const id = saveObservation(
      { type: 'discovery', title: 'Minimal observation' },
      'test', 'sess-1', db
    );
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.subtitle).toBe('');
    expect(row.narrative).toBe('');
    expect(JSON.parse(row.files_read)).toEqual([]);
    expect(JSON.parse(row.files_modified)).toEqual([]);
    expect(row.importance).toBe(1);
  });

  it('does not dedup across different projects', () => {
    const obs = { type: 'discovery', title: 'Fix login bug in auth module' };

    const id1 = saveObservation(obs, 'project-a', 'sess-1', db);
    expect(id1).toBeGreaterThan(0);

    const id2 = saveObservation(obs, 'project-b', 'sess-1', db);
    expect(id2).toBeGreaterThan(0);
  });

  it('returns null when DB is unavailable (no externalDb)', () => {
    openDb.mockReturnValue(null);
    const id = saveObservation({ type: 'discovery', title: 'Test' }, 'test', 'sess-1');
    expect(id).toBeNull();
  });
});

// ─── handleLLMEpisode ────────────────────────────────────────────────────────

describe('handleLLMEpisode', () => {
  let db;
  let tmpFile;
  const originalArgv3 = process.argv[3];

  beforeEach(() => {
    tmpFile = join(tmpdir(), `hook-llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.argv[3] = tmpFile;
    process.env.CLAUDE_MEM_NO_DELAY = '1';

    db = createTestDb();
    // Prevent handleLLMEpisode from closing our test DB
    db._realClose = db.close;
    db.close = () => {};

    openDb.mockReturnValue(db);
    callLLM.mockReturnValue(JSON.stringify({
      type: 'feature',
      title: 'Add user authentication',
      narrative: 'Implemented JWT-based auth flow',
      concepts: ['auth', 'jwt'],
      facts: ['Uses RS256 signing'],
      importance: 2,
    }));
  });

  afterEach(() => {
    if (db?._realClose) db._realClose();
    process.argv[3] = originalArgv3;
    delete process.env.CLAUDE_MEM_NO_DELAY;
    try { writeFileSync(tmpFile, ''); } catch {}
    vi.clearAllMocks();
  });

  it('extracts and saves observation from single-entry episode', async () => {
    const episode = {
      sessionId: 'ep-sess', project: 'test-proj',
      files: ['auth.mjs'], filesRead: ['config.mjs'],
      entries: [{ tool: 'Edit', desc: 'Add JWT middleware', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(obs.length).toBe(1);
    expect(obs[0].title).toBe('Add user authentication');
    expect(obs[0].type).toBe('feature');
    expect(obs[0].importance).toBe(2);
  });

  it('extracts observation from multi-entry episode', async () => {
    const episode = {
      sessionId: 'ep-sess', project: 'test-proj',
      files: ['auth.mjs', 'config.mjs'], filesRead: [],
      entries: [
        { tool: 'Edit', desc: 'Add JWT middleware', isError: false },
        { tool: 'Bash', desc: 'npm test', isError: true },
        { tool: 'Edit', desc: 'Fix test assertion', isError: false },
      ],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(obs.length).toBe(1);
  });

  it('uses degraded fallback when LLM slot unavailable', async () => {
    acquireLLMSlot.mockResolvedValueOnce(false);

    const episode = {
      sessionId: 'ep-sess', project: 'test-proj',
      files: ['app.mjs'], filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Update configuration', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(obs.length).toBe(1);
    // buildDegradedTitle uses file-centric summary: "Modified app.mjs"
    expect(obs[0].title).toBe('Modified app.mjs');
    expect(obs[0].type).toBe('change');
  });

  it('infers bugfix type in fallback when entry has error', async () => {
    acquireLLMSlot.mockResolvedValueOnce(false);

    const episode = {
      sessionId: 'ep-sess', project: 'test-proj',
      files: ['app.mjs'], filesRead: [],
      entries: [{ tool: 'Bash', desc: 'npm test failed', isError: true }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(obs[0].type).toBe('bugfix');
    // buildDegradedTitle: file + error → "Error while working on app.mjs"
    expect(obs[0].title).toBe('Error while working on app.mjs');
  });

  it('returns early when no tmpFile specified', async () => {
    process.argv[3] = undefined;
    await handleLLMEpisode();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('returns early when episode has no entries', async () => {
    writeFileSync(tmpFile, JSON.stringify({
      sessionId: 'ep-sess', project: 'test-proj',
      files: [], filesRead: [], entries: [],
    }));

    await handleLLMEpisode();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('returns early for invalid JSON in tmpFile', async () => {
    writeFileSync(tmpFile, 'not valid json {{{');

    await handleLLMEpisode();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('links related observations by FTS5 title match', async () => {
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'feature', ?, '', 'Previous auth work', '', '', '[]', '[]', 1, ?, ?)
    `).run('ep-sess', 'test-proj', 'Authentication middleware setup', new Date().toISOString(), Date.now());

    callLLM.mockReturnValue(JSON.stringify({
      type: 'feature',
      title: 'Add authentication validation layer',
      narrative: 'Extended authentication with validation',
      concepts: ['auth'], facts: [], importance: 1,
    }));

    writeFileSync(tmpFile, JSON.stringify({
      sessionId: 'ep-sess', project: 'test-proj',
      files: ['auth.mjs'], filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Add auth check', isError: false }],
    }));

    await handleLLMEpisode();

    const allObs = db.prepare('SELECT id, related_ids FROM observations ORDER BY id').all();
    expect(allObs.length).toBe(2);

    const firstRelated = JSON.parse(allObs[0].related_ids || '[]');
    const secondRelated = JSON.parse(allObs[1].related_ids || '[]');
    const hasBidirectional = firstRelated.includes(allObs[1].id) && secondRelated.includes(allObs[0].id);
    expect(hasBidirectional).toBe(true);
  });

  it('links related observations by file overlap', async () => {
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', ?, '', '', '', '', '[]', ?, 1, ?, ?)
    `).run('ep-sess', 'test-proj', 'Previous edit to shared file', '["shared.mjs"]', new Date().toISOString(), Date.now());

    callLLM.mockReturnValue(JSON.stringify({
      type: 'change',
      title: 'Completely different title here',
      narrative: 'Unrelated narrative text',
      concepts: [], facts: [], importance: 1,
    }));

    writeFileSync(tmpFile, JSON.stringify({
      sessionId: 'ep-sess', project: 'test-proj',
      files: ['shared.mjs'], filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Update shared module', isError: false }],
    }));

    await handleLLMEpisode();

    const allObs = db.prepare('SELECT id, related_ids FROM observations ORDER BY id').all();
    expect(allObs.length).toBe(2);

    const firstRelated = JSON.parse(allObs[0].related_ids || '[]');
    const secondRelated = JSON.parse(allObs[1].related_ids || '[]');
    const hasLink = firstRelated.includes(allObs[1].id) || secondRelated.includes(allObs[0].id);
    expect(hasLink).toBe(true);
  });

  it('caps related_ids at 5', async () => {
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });

    for (let i = 0; i < 7; i++) {
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, ?, '', 'change', ?, '', '', '', '', '[]', ?, 1, ?, ?)
      `).run('ep-sess', 'test-proj', `Performance optimization step ${i}`, '["perf.mjs"]', new Date().toISOString(), Date.now() + i);
    }

    callLLM.mockReturnValue(JSON.stringify({
      type: 'refactor',
      title: 'Final performance optimization pass',
      narrative: 'Completed performance optimization work',
      concepts: ['optimization'], facts: [], importance: 1,
    }));

    writeFileSync(tmpFile, JSON.stringify({
      sessionId: 'ep-sess', project: 'test-proj',
      files: ['perf.mjs'], filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Optimize perf.mjs', isError: false }],
    }));

    await handleLLMEpisode();

    const newObs = db.prepare('SELECT related_ids FROM observations ORDER BY id DESC LIMIT 1').get();
    const relatedIds = JSON.parse(newObs.related_ids || '[]');
    expect(relatedIds.length).toBeLessThanOrEqual(5);
  });
});

// ─── handleLLMSummary ────────────────────────────────────────────────────────

describe('handleLLMSummary', () => {
  let db;
  const originalArgv3 = process.argv[3];
  const originalArgv4 = process.argv[4];

  beforeEach(() => {
    process.argv[3] = 'test-session';
    process.argv[4] = 'test-proj';
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = '0';

    db = createTestDb();
    db._realClose = db.close;
    db.close = () => {};

    openDb.mockReturnValue(db);
    callLLM.mockReturnValue(JSON.stringify({
      request: 'Implementing auth system',
      investigated: 'JWT vs session tokens',
      learned: 'JWT is stateless and scalable',
      completed: 'Basic auth flow with login/logout',
      next_steps: 'Add refresh token rotation',
    }));
  });

  afterEach(() => {
    if (db?._realClose) db._realClose();
    process.argv[3] = originalArgv3;
    process.argv[4] = originalArgv4;
    delete process.env.CLAUDE_MEM_FLUSH_TIMEOUT;
    vi.clearAllMocks();
  });

  it('creates session summary from observations', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, ?, '', 'feature', ?, '', 'Narrative text', '', '', '[]', '[]', 1, ?, ?)
      `).run('test-session', 'test-proj', `Observation ${i}`, new Date().toISOString(), Date.now() + i);
    }

    await handleLLMSummary();

    const summaries = db.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').all('test-session');
    expect(summaries.length).toBe(1);
    expect(summaries[0].request).toBe('Implementing auth system');
    expect(summaries[0].completed).toBe('Basic auth flow with login/logout');
    expect(summaries[0].next_steps).toBe('Add refresh token rotation');
  });

  it('skips summary when no observations exist', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });

    await handleLLMSummary();

    const count = db.prepare('SELECT COUNT(*) as cnt FROM session_summaries').get();
    expect(count.cnt).toBe(0);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('skips summary when LLM slot unavailable', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', 'Test obs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run('test-session', 'test-proj', new Date().toISOString(), Date.now());

    acquireLLMSlot.mockResolvedValueOnce(false);

    await handleLLMSummary();

    const count = db.prepare('SELECT COUNT(*) as cnt FROM session_summaries').get();
    expect(count.cnt).toBe(0);
  });
});
