// Tests for cross-session handoff: schema, utils, extraction, intent detection, injection
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { extractMatchKeywords, tokenizeHandoff, isSpecificTerm } from '../utils.mjs';
import { buildAndSaveHandoff, detectContinuationIntent, renderHandoffInjection } from '../hook-handoff.mjs';

// ─── DB Helper ──────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db;
}

function seedSession(db, sessionId, project) {
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, ?, datetime('now'), ?, 'active')`).run(sessionId, sessionId, project, Date.now());
}

function seedPrompt(db, sessionId, text, num) {
  db.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES (?, ?, ?, datetime('now'), ?)`).run(sessionId, text, num, Date.now());
}

let _seedObsEpochOffset = 0;
function seedObservation(db, sessionId, project, title, type, importance, filesModified, narrative) {
  const epoch = Date.now() + (_seedObsEpochOffset++);
  db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`).run(sessionId, project, type, title, importance, filesModified, narrative || null, epoch);
}

// ─── Schema Tests ───────────────────────────────────────────────────────────

describe('session_handoffs schema', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _seedObsEpochOffset = 0; });
  afterEach(() => { db.close(); });

  it('creates session_handoffs table with correct columns', () => {
    const cols = db.prepare(`PRAGMA table_info(session_handoffs)`).all();
    const names = cols.map(c => c.name);
    expect(names).toContain('project');
    expect(names).toContain('type');
    expect(names).toContain('session_id');
    expect(names).toContain('working_on');
    expect(names).toContain('completed');
    expect(names).toContain('unfinished');
    expect(names).toContain('key_files');
    expect(names).toContain('key_decisions');
    expect(names).toContain('match_keywords');
    expect(names).toContain('created_at_epoch');
  });

  it('enforces PRIMARY KEY (project, type)', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, created_at_epoch) VALUES ('p1', 'clear', 's1', 1000)`).run();
    expect(() => {
      db.prepare(`INSERT INTO session_handoffs (project, type, session_id, created_at_epoch) VALUES ('p1', 'clear', 's2', 2000)`).run();
    }).toThrow(/UNIQUE/);
  });

  it('allows UPSERT via ON CONFLICT', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch) VALUES ('p1', 'clear', 's1', 'old', 1000)`).run();
    db.prepare(`
      INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p1', 'clear', 's2', 'new', 2000)
      ON CONFLICT(project, type) DO UPDATE SET
        session_id = excluded.session_id,
        working_on = excluded.working_on,
        created_at_epoch = excluded.created_at_epoch
    `).run();
    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'p1' AND type = 'clear'`).get();
    expect(row.session_id).toBe('s2');
    expect(row.working_on).toBe('new');
    expect(row.created_at_epoch).toBe(2000);
  });
});

// ─── Utility Tests ──────────────────────────────────────────────────────────

describe('handoff utility functions', () => {
  describe('tokenizeHandoff', () => {
    it('splits text into lowercase tokens', () => {
      expect(tokenizeHandoff('Hello World Foo')).toEqual(['hello', 'world', 'foo']);
    });

    it('filters tokens shorter than 3 chars', () => {
      expect(tokenizeHandoff('a ab abc abcd')).toEqual(['abc', 'abcd']);
    });

    it('splits on punctuation and whitespace', () => {
      const tokens = tokenizeHandoff('hook.mjs:123 (test)');
      expect(tokens).toContain('hook');
      expect(tokens).toContain('mjs');
      expect(tokens).toContain('123');
      expect(tokens).toContain('test');
    });

    it('returns empty array for empty input', () => {
      expect(tokenizeHandoff('')).toEqual([]);
      expect(tokenizeHandoff(null)).toEqual([]);
    });
  });

  describe('isSpecificTerm', () => {
    it('returns true for identifiers with underscores/hyphens', () => {
      expect(isSpecificTerm('session_handoffs')).toBe(true);
      expect(isSpecificTerm('hook-shared')).toBe(true);
    });

    it('returns true for 4+ char non-stop-words', () => {
      expect(isSpecificTerm('hook')).toBe(true);
      expect(isSpecificTerm('schema')).toBe(true);
      expect(isSpecificTerm('dispatch')).toBe(true);
    });

    it('returns false for stop words', () => {
      expect(isSpecificTerm('with')).toBe(false);
      expect(isSpecificTerm('from')).toBe(false);
      expect(isSpecificTerm('function')).toBe(false);
    });

    it('returns false for short tokens', () => {
      expect(isSpecificTerm('ab')).toBe(false);
      expect(isSpecificTerm('')).toBe(false);
    });

    it('returns false for purely numeric tokens', () => {
      expect(isSpecificTerm('1234')).toBe(false);
    });
  });

  describe('extractMatchKeywords', () => {
    it('extracts file basenames without extensions', () => {
      const kw = extractMatchKeywords('some text', ['/path/to/hook.mjs', '/path/to/schema.mjs']);
      expect(kw).toContain('hook');
      expect(kw).toContain('schema');
    });

    it('extracts technical terms from text, skipping stop words', () => {
      const kw = extractMatchKeywords('implement handoff detection for session', []);
      expect(kw).toContain('handoff');
      expect(kw).toContain('detection');
      expect(kw).toContain('session');
      expect(kw).not.toContain('for');
    });

    it('deduplicates terms', () => {
      const kw = extractMatchKeywords('hook hook hook', ['/a/hook.mjs']);
      const tokens = kw.split(' ').filter(t => t === 'hook');
      expect(tokens.length).toBe(1);
    });

    it('returns empty string for empty input', () => {
      expect(extractMatchKeywords('', [])).toBe('');
    });
  });
});

// ─── buildAndSaveHandoff Tests ──────────────────────────────────────────────

describe('buildAndSaveHandoff', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _seedObsEpochOffset = 0; });
  afterEach(() => { db.close(); });

  it('saves handoff with working_on from prompts', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'implement handoff feature', 1);
    seedPrompt(db, 's1', 'add intent detection', 2);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'clear'`).get();
    expect(row).toBeTruthy();
    expect(row.working_on).toContain('handoff');
    expect(row.working_on).toContain('intent');
    expect(row.session_id).toBe('s1');
  });

  it('skips saving when no prompts exist', () => {
    seedSession(db, 's1', 'test-proj');
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);
    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row).toBeUndefined();
  });

  it('extracts completed from observations', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'fix the bug', 1);
    seedObservation(db, 's1', 'test-proj', 'Fixed null pointer in handler', 'bugfix', 2, null);
    seedObservation(db, 's1', 'test-proj', 'Added error logging', 'change', 1, null);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'exit'`).get();
    expect(row.completed).toContain('Fixed null pointer');
    expect(row.completed).toContain('Added error logging');
  });

  it('extracts unfinished from episode snapshot', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'refactor dispatch system', 1);

    const snapshot = {
      entries: [
        { desc: 'Edit hook.mjs: add handoff logic', isSignificant: true, isError: false },
        { desc: 'Read schema.mjs', isSignificant: false, isError: false },
        { desc: 'Bash error: test failed', isSignificant: false, isError: true },
      ],
      files: ['/proj/hook.mjs', '/proj/schema.mjs'],
    };

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', snapshot);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.unfinished).toContain('handoff logic');
    expect(row.unfinished).toContain('test failed');
    expect(row.unfinished).not.toContain('Read schema');
  });

  it('collects key_files from episode + observations', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'edit files', 1);
    seedObservation(db, 's1', 'test-proj', 'Changed utils', 'change', 1, JSON.stringify(['/proj/utils.mjs']));

    const snapshot = { entries: [], files: ['/proj/hook.mjs'] };
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', snapshot);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    const files = JSON.parse(row.key_files);
    expect(files).toContain('/proj/hook.mjs');
    expect(files).toContain('/proj/utils.mjs');
  });

  it('extracts key_decisions from high-importance observations', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'design decisions', 1);
    seedObservation(db, 's1', 'test-proj', 'Chose UPSERT over INSERT', 'decision', 2, null);
    seedObservation(db, 's1', 'test-proj', 'Minor log fix', 'change', 1, null);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.key_decisions).toContain('UPSERT');
    expect(row.key_decisions).not.toContain('Minor log fix');
  });

  it('overwrites previous handoff of same type (UPSERT)', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'old work', 1);
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    seedSession(db, 's2', 'test-proj');
    seedPrompt(db, 's2', 'new work', 1);
    buildAndSaveHandoff(db, 's2', 'test-proj', 'clear', null);

    const rows = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'clear'`).all();
    expect(rows.length).toBe(1);
    expect(rows[0].working_on).toContain('new work');
  });

  it('populates match_keywords for intent matching', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'implement handoff for dispatch system', 1);
    seedObservation(db, 's1', 'test-proj', 'Added buildAndSaveHandoff', 'change', 1, JSON.stringify(['/proj/hook.mjs']));

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.match_keywords).toContain('handoff');
    expect(row.match_keywords).toContain('dispatch');
    expect(row.match_keywords).toContain('hook');
  });

  it('falls back to most recent bugfix for unfinished when no episode snapshot', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'fix bugs', 1);
    seedObservation(db, 's1', 'test-proj', 'Fixed null pointer earlier', 'bugfix', 1, null);
    seedObservation(db, 's1', 'test-proj', 'TypeError in dispatch', 'bugfix', 2, null);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    // Only the most recent bugfix (first in DESC order) is used
    expect(row.unfinished).toContain('TypeError in dispatch');
    expect(row.unfinished).not.toContain('Fixed null pointer');
  });

  it('enriches unfinished with observation narratives (full edit history)', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'code review and fix issues', 1);
    seedObservation(db, 's1', 'test-proj', 'Modified hook.mjs', 'change', 1, null,
      'hook.mjs: "scrubSecrets" → "scrubSecrets, EDIT_TOOLS"');
    seedObservation(db, 's1', 'test-proj', 'Modified dispatch.mjs', 'change', 1, null,
      'dispatch.mjs: "score * decay" → "score * -decay"');

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    // Unfinished should contain the full narrative details
    expect(row.unfinished).toContain('scrubSecrets');
    expect(row.unfinished).toContain('EDIT_TOOLS');
    expect(row.unfinished).toContain('score * -decay');
  });

  it('unfinished preserves up to 3000 chars of narrative detail', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'fix everything', 1);
    // Create observations with long narratives that together exceed old 300 limit
    seedObservation(db, 's1', 'test-proj', 'Change 1', 'change', 1, null, 'detail-'.repeat(100));
    seedObservation(db, 's1', 'test-proj', 'Change 2', 'change', 1, null, 'info-'.repeat(100));

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    // unfinished should exceed old 300 limit, capped at 3000
    expect(row.unfinished.length).toBeGreaterThan(300);
    expect(row.unfinished.length).toBeLessThanOrEqual(3000);
  });
});

// ─── detectContinuationIntent Tests ─────────────────────────────────────────

describe('detectContinuationIntent', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, match_keywords, created_at_epoch)
      VALUES ('test-proj', 'clear', 's1', 'implement handoff', 'handoff dispatch hook schema intent detection', ?)`).run(Date.now());
  });

  it('detects explicit Chinese keywords', () => {
    expect(detectContinuationIntent(db, '继续前面的工作', 'test-proj')).toBe(true);
    expect(detectContinuationIntent(db, '接着干', 'test-proj')).toBe(true);
    expect(detectContinuationIntent(db, '上次的任务', 'test-proj')).toBe(true);
  });

  it('detects explicit English keywords', () => {
    expect(detectContinuationIntent(db, 'continue where we left off', 'test-proj')).toBe(true);
    expect(detectContinuationIntent(db, 'resume the work', 'test-proj')).toBe(true);
  });

  it('detects implicit continuation via FTS term overlap', () => {
    expect(detectContinuationIntent(db, 'how is the handoff dispatch hook going?', 'test-proj')).toBe(true);
  });

  it('rejects unrelated prompts with no overlap', () => {
    expect(detectContinuationIntent(db, 'hello how are you', 'test-proj')).toBe(false);
    expect(detectContinuationIntent(db, 'build a new REST API', 'test-proj')).toBe(false);
  });

  it('rejects prompts with insufficient overlap (score < 3)', () => {
    // Only "handoff" matches = score 2 (specific term) → below threshold
    expect(detectContinuationIntent(db, 'what is a handoff?', 'test-proj')).toBe(false);
  });

  it('does not match "continue" as substring (e.g. "discontinued")', () => {
    expect(detectContinuationIntent(db, 'the feature was discontinued', 'test-proj')).toBe(false);
    expect(detectContinuationIntent(db, 'presumed to be working', 'test-proj')).toBe(false);
  });

  it('returns true for keyword match even without handoff in DB', () => {
    const emptyDb = createTestDb();
    expect(detectContinuationIntent(emptyDb, '继续', 'no-such-proj')).toBe(true);
  });

  it('returns false for FTS match without handoff in DB', () => {
    const emptyDb = createTestDb();
    expect(detectContinuationIntent(emptyDb, 'handoff dispatch hook', 'no-such-proj')).toBe(false);
  });

  it('respects expiry — expired clear handoff is skipped for FTS', () => {
    const oldDb = createTestDb();
    oldDb.prepare(`INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('p', 'clear', 's', 'handoff dispatch hook schema', ?)`).run(Date.now() - 4000000); // > 1 hour ago
    expect(detectContinuationIntent(oldDb, 'handoff dispatch hook schema', 'p')).toBe(false);
    expect(detectContinuationIntent(oldDb, '继续', 'p')).toBe(true); // keyword always works
  });

  it('exit handoff stays valid for 7 days', () => {
    const recentDb = createTestDb();
    recentDb.prepare(`INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('p', 'exit', 's', 'handoff dispatch hook schema', ?)`).run(Date.now() - 3 * 86400000); // 3 days ago
    expect(detectContinuationIntent(recentDb, 'handoff dispatch hook schema', 'p')).toBe(true);
  });

  it('exit handoff expires after 7 days', () => {
    const oldDb = createTestDb();
    oldDb.prepare(`INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('p', 'exit', 's', 'handoff dispatch hook schema', ?)`).run(Date.now() - 8 * 86400000); // 8 days ago
    expect(detectContinuationIntent(oldDb, 'handoff dispatch hook schema', 'p')).toBe(false);
  });
});

// ─── renderHandoffInjection Tests ───────────────────────────────────────────

describe('renderHandoffInjection', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _seedObsEpochOffset = 0; });
  afterEach(() => { db.close(); });

  it('renders handoff with all sections', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'implement feature X', '[change] Did thing A', 'Still need B', '["hook.mjs"]', 'Chose approach Y', 'feature hook', ?)`).run(Date.now() - 60000);

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('<session-handoff');
    expect(result).toContain('source="clear"');
    expect(result).toContain('implement feature X');
    expect(result).toContain('Did thing A');
    expect(result).toContain('Still need B');
    expect(result).toContain('hook.mjs');
    expect(result).toContain('Chose approach Y');
    expect(result).toContain('</session-handoff>');
  });

  it('appends session summary when available', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'work', ?)`).run(Date.now());
    seedSession(db, 's1', 'p');
    db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES ('s1', 'p', 'original request', 'finished stuff', 'do next thing', datetime('now'), ?)`).run(Date.now());

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('<session-summary');
    expect(result).toContain('finished stuff');
    expect(result).toContain('do next thing');
    expect(result).toContain('</session-summary>');
  });

  it('renders remaining_items from session summary', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'code review', ?)`).run(Date.now());
    seedSession(db, 's1', 'p');
    db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, remaining_items, created_at, created_at_epoch)
      VALUES ('s1', 'p', 'full code review', 'fixed dispatch scoring', 'run tests', 'hook.mjs: missing EDIT_TOOLS import; schema.mjs: remaining_items column needed', datetime('now'), ?)`).run(Date.now());

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('Remaining: hook.mjs: missing EDIT_TOOLS import');
    expect(result).toContain('schema.mjs: remaining_items column needed');
  });

  it('returns null when no handoff exists', () => {
    expect(renderHandoffInjection(db, 'no-project')).toBeNull();
  });

  it('shows human-readable age', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'work', ?)`).run(Date.now() - 120000); // 2 minutes ago

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('age="2m"');
  });

  it('returns null for expired handoff', () => {
    // clear handoff expired (> 1 hour)
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'old work', ?)`).run(Date.now() - 4000000);
    expect(renderHandoffInjection(db, 'p')).toBeNull();
  });

  it('returns null for expired exit handoff (> 7 days)', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'old work', ?)`).run(Date.now() - 8 * 86400000);
    expect(renderHandoffInjection(db, 'p')).toBeNull();
  });

  it('renders non-expired exit handoff', () => {
    db.prepare(`INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'recent work', ?)`).run(Date.now() - 3 * 86400000);
    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('recent work');
  });
});
