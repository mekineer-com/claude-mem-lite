import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { scrubRecord } from '../lib/scrub-record.mjs';

const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POISONED = `error from upstream: token=${SECRET} not found`;

describe('scrubRecord — observation table fields', () => {
  it('scrubs every text field listed in OBSERVATION_TEXT_FIELDS', () => {
    const row = {
      title: `failed: ${SECRET}`,
      narrative: POISONED,
      text: POISONED,
      subtitle: SECRET,
      concepts: POISONED,
      facts: POISONED,
      lesson_learned: POISONED,
      search_aliases: SECRET,
    };
    const out = scrubRecord('observations', row);
    for (const field of Object.keys(row)) {
      expect(out[field], `${field} not scrubbed`).not.toContain(SECRET);
    }
  });

  it('leaves non-text fields (numeric/json) untouched', () => {
    const row = { importance: 2, files_modified: '["src/a.mjs"]' };
    const out = scrubRecord('observations', row);
    expect(out.importance).toBe(2);
    expect(out.files_modified).toBe('["src/a.mjs"]');
  });

  it('scrubs all string fields when table is unknown (failsafe)', () => {
    const row = {
      foo: `leaked: ${SECRET}`,
      bar: POISONED,
      baz: 42,
      qux: null,
    };
    const out = scrubRecord('some_future_table', row);
    expect(out.foo).not.toContain(SECRET);
    expect(out.bar).not.toContain(SECRET);
    expect(out.baz).toBe(42);
    expect(out.qux).toBeNull();
  });
});

describe('scrubRecord — session_summaries fields', () => {
  it('scrubs request/investigated/learned/completed/next_steps/remaining_items/notes', () => {
    const row = {
      request: POISONED,
      investigated: POISONED,
      learned: POISONED,
      completed: POISONED,
      next_steps: POISONED,
      remaining_items: POISONED,
      notes: POISONED,
    };
    const out = scrubRecord('session_summaries', row);
    for (const field of Object.keys(row)) {
      expect(out[field]).not.toContain(SECRET);
    }
  });
});

describe('scrubRecord — session_handoffs fields', () => {
  it('scrubs working_on/completed/unfinished/key_decisions', () => {
    const row = {
      working_on: POISONED,
      completed: POISONED,
      unfinished: POISONED,
      key_decisions: POISONED,
    };
    const out = scrubRecord('session_handoffs', row);
    for (const field of Object.keys(row)) {
      expect(out[field]).not.toContain(SECRET);
    }
  });

  it('does NOT scrub JSON-stringified array fields (key_files, match_keywords)', () => {
    // String-level scrub of a JSON.stringify(array) can rewrite quoted values
    // and break downstream JSON.parse. Element-level scrub belongs upstream
    // of the JSON.stringify call. This test guards the contract.
    const keyFilesJson = JSON.stringify([
      `src/foo-${SECRET}.mjs`,
      'src/normal.mjs',
    ]);
    const matchKeywordsJson = JSON.stringify([SECRET, 'normal']);
    const out = scrubRecord('session_handoffs', {
      key_files: keyFilesJson,
      match_keywords: matchKeywordsJson,
    });
    // scrubRecord must leave these untouched so JSON.parse still works.
    expect(out.key_files).toBe(keyFilesJson);
    expect(out.match_keywords).toBe(matchKeywordsJson);
    expect(() => JSON.parse(out.key_files)).not.toThrow();
    expect(() => JSON.parse(out.match_keywords)).not.toThrow();
  });
});

describe('end-to-end UPDATE leak check via in-memory DB', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('UPDATE on observations does not persist secrets via direct prepare', () => {
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                VALUES (?, ?, ?, ?, ?, 'active')`)
      .run('s1', 's1', 'p1', new Date().toISOString(), Date.now());
    const ins = db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('s1', 'p1', 'clean', 'change', 'Clean title', '', 1, new Date().toISOString(), Date.now());
    const id = ins.lastInsertRowid;

    const safe = scrubRecord('observations', {
      title: `failed: ${SECRET}`, narrative: POISONED,
      concepts: POISONED, facts: POISONED,
    });
    db.prepare(`UPDATE observations SET title=?, narrative=?, concepts=?, facts=? WHERE id=?`)
      .run(safe.title, safe.narrative, safe.concepts, safe.facts, id);

    const row = db.prepare('SELECT * FROM observations WHERE id=?').get(id);
    for (const k of ['title', 'narrative', 'concepts', 'facts']) {
      expect(row[k], `${k} leaked via UPDATE`).not.toContain(SECRET);
    }
  });
});

describe('end-to-end leak check via in-memory DB', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('hook-llm INSERT path does not persist secrets', async () => {
    const hookLlm = await import('../hook-llm.mjs');
    // sdk_sessions row is required for FK on observations.memory_session_id
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run('s1', 's1', 'p1', new Date().toISOString(), Date.now());

    hookLlm.__insertObservationForTest(db, {
      session_id: 's1', project: 'p1',
      title: `failed: ${SECRET}`, narrative: POISONED,
      text: POISONED, subtitle: '',
      concepts: POISONED, facts: POISONED, files_read: '[]', files_modified: '[]',
      importance: 1, minhash_sig: '', lesson_learned: POISONED, search_aliases: '',
      branch: '',
    });
    const row = db.prepare('SELECT * FROM observations LIMIT 1').get();
    for (const k of ['title','narrative','text','concepts','facts','lesson_learned']) {
      expect(row[k], `${k} leaked`).not.toContain(SECRET);
    }
  });
});
