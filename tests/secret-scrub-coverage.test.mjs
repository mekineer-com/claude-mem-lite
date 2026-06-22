import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { scrubRecord } from '../lib/scrub-record.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { stripPrivate } from '../lib/private-strip.mjs';

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

describe('scrubRecord — contract & edge cases', () => {
  it('returns null unchanged', () => {
    expect(scrubRecord('observations', null)).toBeNull();
  });

  it('returns non-object input unchanged', () => {
    expect(scrubRecord('observations', 'a string')).toBe('a string');
    expect(scrubRecord('observations', 42)).toBe(42);
    expect(scrubRecord('observations', undefined)).toBeUndefined();
  });

  it('does not mutate the input row (returns a copy)', () => {
    const row = { title: `failed: ${SECRET}` };
    const out = scrubRecord('observations', row);
    expect(out).not.toBe(row);                      // different object
    expect(row.title).toContain(SECRET);            // input untouched
    expect(out.title).not.toContain(SECRET);        // output scrubbed
  });

  it('failsafe path skips inherited (prototype-chain) properties', () => {
    const proto = { inherited: `proto leak: ${SECRET}` };
    const row = Object.create(proto);
    row.own = `own leak: ${SECRET}`;
    const out = scrubRecord('some_unknown_table', row);
    // Own property scrubbed:
    expect(out.own).not.toContain(SECRET);
    // Prototype property NOT in own enumerable keys, so the failsafe loop
    // skipped it — but it's still readable via prototype lookup. The
    // contract is "scrubs own string fields"; prototype keys are out of
    // scope (and copying them into the output would actually leak more).
    expect(Object.prototype.hasOwnProperty.call(out, 'inherited')).toBe(false);
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

// D#32 safe subset: prefix-anchored provider credentials. Two-sided battery —
// positives MUST scrub, and this repo's own hash-shaped data MUST survive
// (the whole reason the bare-high-entropy pattern was deliberately NOT added).
describe('scrubSecrets — provider-prefixed credentials (D#32 safe subset)', () => {
  // 32-hex / 22-/43-char bodies are fixed-length sentinels, not real keys.
  const HEX32 = '0123456789abcdef0123456789abcdef';     // 32 hex
  const SENDGRID = `SG.${'aBcDeFgHiJkLmNoPqRsTuV'}.${'0123456789012345678901234567890123456789012'}`; // SG.<22>.<43>

  it('scrubs SendGrid SG.<22>.<43> keys', () => {
    expect(SENDGRID.length).toBe(3 + 22 + 1 + 43); // structural guard on the fixture
    expect(scrubSecrets(`key: ${SENDGRID} end`)).not.toContain(SENDGRID);
    expect(scrubSecrets(SENDGRID)).toBe('***');
  });

  it('scrubs Twilio Account SID (AC…) and API Key SID (SK…)', () => {
    expect(scrubSecrets(`AC${HEX32}`)).toBe('***');
    expect(scrubSecrets(`SK${HEX32}`)).toBe('***');
    expect(scrubSecrets(`twilio sid AC${HEX32} configured`)).not.toContain(HEX32);
  });

  it('scrubs Mailgun private key (key-<32hex>)', () => {
    expect(scrubSecrets(`key-${HEX32}`)).toBe('***');
  });

  // The asymmetric-loss negatives: a bare-hex pattern would have eaten all of
  // these. Each is a real shape this repo stores/emits and must pass through.
  it('does NOT scrub this repo\'s own hash-shaped data (no bare-token pattern)', () => {
    const gitSha40   = '0123456789abcdef0123456789abcdef01234567';                       // 40-hex git SHA
    const md5        = '5d41402abc4b2a76b9719d911017c592';                               // 32-hex MD5
    const sha256     = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 64-hex
    const uuid       = '550e8400-e29b-41d4-a716-446655440000';
    const shortSha   = '434c32d';
    const minhashSig = '12,8841,290,77123,4,99021,1532,66,40021,3'; // comma-joined ints
    for (const v of [gitSha40, md5, sha256, uuid, shortSha, minhashSig]) {
      expect(scrubSecrets(`commit ${v} landed`), `over-scrubbed ${v}`).toContain(v);
    }
  });

  // Regression guard for #8664 (already fixed): underscore-cased env vars must
  // still scrub — confirms the deferred note's "underscore env" item is closed.
  it('still scrubs underscore-cased env-var assignments (#8664)', () => {
    expect(scrubSecrets('DB_PASSWORD=hunter2supersecret')).not.toContain('hunter2supersecret');
    expect(scrubSecrets('GH_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toContain('***');
  });
});

// ─── Audit 2026-06-22 P0 #2: secret-scrub coverage holes ──────────────────────
describe('scrubSecrets — quoted credential values (audit #2a)', () => {
  it('scrubs bare-key quoted values: key="value" / key:\'value\'', () => {
    expect(scrubSecrets('api_key="secretvalue123456"')).not.toContain('secretvalue123456');
    expect(scrubSecrets("password: 'hunter2hunter2'")).not.toContain('hunter2hunter2');
    expect(scrubSecrets('token="ghs_realtokenABCDEF"')).not.toContain('ghs_realtokenABCDEF');
    expect(scrubSecrets('client_secret = "abcdef123456ZZ"')).not.toContain('abcdef123456ZZ');
  });
  it('replaces only the value, preserving key + quotes', () => {
    expect(scrubSecrets('api_key="secretvalue123456"')).toBe('api_key="***"');
    expect(scrubSecrets("password: 'hunter2hunter2'")).toBe("password: '***'");
  });
  it('still does NOT break JSON.parse of a quoted-key object (line-80 path intact)', () => {
    const out = scrubSecrets('{"api_key": "secretvalue123456", "ok": "fine"}');
    expect(out).not.toContain('secretvalue123456');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  // Review catch: the quoted pattern must carry the SAME prose split as the unquoted
  // patterns — bare credential nouns preceded by "<word> " are prose, not config, and
  // must survive even when the value is quoted (#8283; the unquoted form already keeps
  // them, so the quoted form must too). Structured keys / env vars still scrub in prose.
  it('does NOT over-scrub a bare noun in prose just because the value is quoted', () => {
    expect(scrubSecrets('the bearer: "alicewashere"')).toBe('the bearer: "alicewashere"');
    expect(scrubSecrets('the token: "somemarkervalue"')).toBe('the token: "somemarkervalue"');
    expect(scrubSecrets('Decision: keep the token: "opaque-by-design" here'))
      .toContain('opaque-by-design');
  });
  it('STILL scrubs a structured key / env var even mid-prose (quoted)', () => {
    expect(scrubSecrets('see api_key: "realsecret123"')).not.toContain('realsecret123');
    expect(scrubSecrets('the PGPASSWORD: "hunter2hunter2" here')).not.toContain('hunter2hunter2');
  });
});

describe('scrubSecrets — well-known no-separator credential env vars (audit #2b)', () => {
  it('scrubs PGPASSWORD= / MYSQL_PWD= (standard secret env-var names)', () => {
    expect(scrubSecrets('PGPASSWORD=hunter2hunter2 psql -h db.prod')).not.toContain('hunter2hunter2');
    expect(scrubSecrets('MYSQL_PWD=secretpass123 mysql')).not.toContain('secretpass123');
    expect(scrubSecrets('export PGPASS=hunter2hunter2')).not.toContain('hunter2hunter2');
  });
  // Guard: PWD is the present-working-dir env var, NOT a secret. The fix
  // deliberately omits a bare `pwd` keyword to avoid scrubbing real paths.
  it('does NOT scrub PWD= (working-directory env var, not a credential)', () => {
    expect(scrubSecrets('PWD=/home/user/projectdir')).toContain('/home/user/projectdir');
    expect(scrubSecrets('cd "$PWD" && ls')).toContain('PWD');
  });
  // Consistency guard: arbitrary letter-prefixed identifiers stay non-credentials,
  // matching the deliberate low-FP decision at utils.test.mjs:1089-1100 (#8283).
  // We enumerate known secret env-var NAMES rather than a blanket letter-prefix.
  it('does NOT scrub arbitrary letter-prefixed words (topsecret=, mypassword=)', () => {
    expect(scrubSecrets('topsecret=foobar123')).toBe('topsecret=foobar123');
    expect(scrubSecrets('mypassword=foobar123')).toBe('mypassword=foobar123');
  });
});

describe('scrubSecrets / scrubRecord — <private> stripped on persistence (audit #2c)', () => {
  it('scrubSecrets strips <private>...</private> blocks', () => {
    expect(scrubSecrets('before <private>topsecret stuff</private> after'))
      .not.toContain('topsecret stuff');
  });
  it('scrubRecord (the persistence chokepoint) strips <private> from text fields', () => {
    const out = scrubRecord('observations', {
      text: 'x <private>leaked-secret-here</private> y',
      title: 'normal title',
    });
    expect(out.text).not.toContain('leaked-secret-here');
    expect(out.title).toBe('normal title');
  });
  it('stripPrivate remains idempotent (double-strip is a no-op)', () => {
    const once = stripPrivate('a <private>x</private> b');
    expect(stripPrivate(once)).toBe(once);
  });
});
