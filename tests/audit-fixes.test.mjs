// Regression tests for the T1 audit fixes (P0-1, P0-2, P1-3, P1-4, P2-5, P2-6, P2-7).
// Each block documents the pre-fix symptom so a future revert is flagged loudly.
//
//   P0-1 CLI  save    --lesson was silently dropped (flag not parsed, column not in INSERT)
//   P0-2 MCP  search  sort='time' / 'importance' were no-ops (created_at_epoch missing on result obj)
//   P1-3 MCP  get     fields=['bogus'] returned header-only empty record (silent, no error)
//   P1-4 MCP  get     partial-missing ids were silently skipped (mem_delete reports but get didn't)
//   P2-5 schema timeline anchor+query precedence wasn't in the description text
//   P2-6 MCP  search  empty query returned "Found N result(s):" with no label vs query flows
//   P2-7 MCP  get     source=session/prompt miss didn't hint "try source='obs'" when ID exists

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { memTimelineSchema, memMaintainSchema, memOptimizeSchema } from '../tool-schemas.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';

const SERVER_PATH = resolve(new URL('..', import.meta.url).pathname, 'server.mjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function startServer(memDir) {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, CLAUDE_MEM_DIR: memDir, MEM_QUIET_HOOKS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', () => {});
  return proc;
}

function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout.off('data', onData);
            return resolve(msg);
          }
        } catch { /* non-JSON frame */ }
      }
      buf = lines[lines.length - 1];
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(payload);
    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`timeout waiting for id=${id} method=${method}`));
    }, 5000);
  });
}

async function initialize(proc) {
  await rpc(proc, 0, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'audit-fixes-test', version: '0' },
  });
}

// Seed a DB at `{dir}/claude-mem-lite.db` with N observations that all match the same
// FTS query ("AUDITKW") but at spaced-out epochs and different importances so sort
// variants can be distinguished.
function seedDb(dir, projectName = 'audit--probe') {
  const dbPath = join(dir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'audit-sess', project: projectName, memoryId: 'audit-mem' });
  // Insert 5 obs, newest = idx 0, importance alternating so sort orders are distinct.
  for (let i = 0; i < 5; i++) {
    insertObs(db, {
      sessionId: 'audit-mem',
      project: projectName,
      type: 'bugfix',
      title: `AUDITKW entry ${i}`,
      text: `AUDITKW probe text marker body ${i}`,
      importance: (i % 3) + 1, // 1,2,3,1,2
      // spaced 1 day apart: newest = i=0, oldest = i=4
      epochOffset: -i * 86_400_000,
    });
  }
  db.close();
  return dbPath;
}

// ─── P0-1: CLI save --lesson (via run) ──────────────────────────────────────
// The pre-fix CLI ignored --lesson entirely: flags.lesson existed but cmdSave never
// read it, and the INSERT statement didn't include the lesson_learned column. Users
// following the tool description's `Equivalent CLI: ... --lesson "..."` lost the
// lesson silently, breaking the project's bugfix-after-save contract.

let testDb;

vi.mock('../schema.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    ensureDb: () => new Proxy(testDb, {
      get(t, p) { if (p === 'close') return () => {}; return t[p]; },
    }),
  };
});

vi.mock('../utils.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, inferProject: () => 'test--probe' };
});

const { run } = await import('../mem-cli.mjs');

function captureStdout(fn) {
  let output = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => { output += s; return true; };
  process.stderr.write = (s) => { output += s; return true; };
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.then(() => { process.stdout.write = origOut; process.stderr.write = origErr; return output; });
    }
  } catch (err) {
    process.stdout.write = origOut; process.stderr.write = origErr;
    throw err;
  }
  process.stdout.write = origOut; process.stderr.write = origErr;
  return output;
}

describe('P0-1: CLI save --lesson persists lesson_learned', () => {
  beforeEach(() => {
    testDb = (() => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      return db;
    })();
    insertSession(testDb, { id: 'p01-sess', project: 'test--probe', memoryId: 'p01-mem' });
  });
  afterEach(() => { testDb.close(); });

  it('writes lesson_learned column when --lesson is passed', async () => {
    const output = await captureStdout(() => run([
      'save', 'root cause X; fix is Y', '--type', 'bugfix', '--lesson', 'always grep usage first',
    ]));
    expect(output).toContain('💡lesson captured');
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.type).toBe('bugfix');
    expect(row.lesson_learned).toBe('always grep usage first');
  });

  it('accepts --lesson-learned alias (mirrors cmdUpdate)', async () => {
    await captureStdout(() => run([
      'save', 'content', '--type', 'bugfix', '--lesson-learned', 'alias works',
    ]));
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.lesson_learned).toBe('alias works');
  });

  it('rejects --lesson exceeding 500 chars (mirrors MCP memSaveSchema)', async () => {
    const longLesson = 'A'.repeat(501);
    const output = await captureStdout(() => run([
      'save', 'probe', '--type', 'bugfix', '--lesson', longLesson,
    ]));
    expect(output).toContain('too long');
    const count = testDb.prepare('SELECT COUNT(*) as c FROM observations').get().c;
    expect(count).toBe(0);
  });

  it('omits lesson badge in output when --lesson not passed', async () => {
    const output = await captureStdout(() => run(['save', 'plain save', '--type', 'discovery']));
    expect(output).not.toContain('💡lesson captured');
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.lesson_learned).toBeNull();
  });
});

// ─── P0-2..P2-7: MCP stdio tests (shared fixture) ───────────────────────────
// Using stdio because the handlers are registered as inline arrow functions inside
// server.mjs — not importable. Each test seeds a fresh DB under a mkdtempSync path.

describe('MCP audit fixes (stdio)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-audit-'));
    seedDb(tmp);
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try { proc.stdin.end(); } catch { /* already closed */ }
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    await new Promise((r) => setTimeout(r, 50));
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function callTool(name, args) {
    return rpc(proc, Math.floor(Math.random() * 1e9), 'tools/call', { name, arguments: args });
  }

  // P0-2: sort variants must produce DIFFERENT IDs orderings.
  it('P0-2: mem_search sort=time, relevance, importance produce distinct orderings', async () => {
    await initialize(proc);
    const t = await callTool('mem_search', { query: 'AUDITKW', sort: 'time', limit: 5 });
    const r = await callTool('mem_search', { query: 'AUDITKW', sort: 'relevance', limit: 5 });
    const i = await callTool('mem_search', { query: 'AUDITKW', sort: 'importance', limit: 5 });

    const parseIds = (resp) => [...(resp.result?.content?.[0]?.text || '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    const timeIds = parseIds(t);
    const relIds = parseIds(r);
    const impIds = parseIds(i);

    expect(timeIds.length).toBe(5);
    // sort=time must be strictly newest-first: DB rows were inserted with epochOffset=-i*day,
    // so id=1 (epochOffset=0) is newest, id=5 (epochOffset=-4d) is oldest.
    expect(timeIds).toEqual([1, 2, 3, 4, 5]);

    // sort=importance must group by importance desc (3 first, then 2, then 1).
    const seedImportances = [1, 2, 3, 1, 2]; // i=0..4 → id=1..5
    const observedImp = impIds.map((id) => seedImportances[id - 1]);
    for (let k = 1; k < observedImp.length; k++) {
      expect(observedImp[k]).toBeLessThanOrEqual(observedImp[k - 1]);
    }

    // Relevance should not be identical to time (this was the original bug signature).
    expect(JSON.stringify(relIds)).not.toBe(JSON.stringify(timeIds));
  });

  // P1-3: all-invalid fields → error, partial-invalid → note + rendering.
  it('P1-3: mem_get with all-invalid fields returns an error', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1], fields: ['not_a_field', 'also_bogus'] });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/No valid fields/);
    expect(text).toMatch(/Valid:/);
  });

  it('P1-3: mem_get with partial-invalid fields proceeds and emits a note', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1], fields: ['title', 'bogus_field'] });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).not.toBe(true);
    expect(text).toMatch(/dropped:\s*bogus_field/);
    expect(text).toMatch(/── #1 ──/);
    expect(text).toMatch(/title:/);
  });

  // P1-4: missing IDs surface in a trailing Note.
  it('P1-4: mem_get appends a Note for missing IDs (mirrors mem_delete)', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1, 999999] });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/── #1 ──/);
    expect(text).toMatch(/Note: ID\(s\) 999999 not found/);
  });

  it('P1-4: mem_get with all missing still returns the "No observations" message', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [888888, 999999] });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/No observations found for given IDs/);
  });

  // P2-6: empty query gets a distinct label so the caller knows results aren't BM25-ranked.
  it('P2-6: mem_search with no query labels output as "no query — listing recent"', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/no query — listing recent/);
  });

  it('P2-6: mem_search with a query preserves the `for "<query>"` label', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW', limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/for "AUDITKW"/);
    expect(text).not.toMatch(/no query/);
  });

  // T: mem_search must surface the AND→OR fallback. A silent fallback lets callers
  // (including Claude) trust a strict multi-term query that actually matched only
  // one of the terms. The hint is the signal for "treat these results as loose".
  it('mem_search surfaces a "relaxed AND→OR" hint when AND returns zero and OR recovers', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW zzzzz_nonexistent', limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/AUDITKW entry/);
    expect(text).toMatch(/relaxed AND.{0,3}OR/);
  });

  it('mem_search omits the fallback hint on a clean AND match', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW', limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/AUDITKW entry/);
    expect(text).not.toMatch(/relaxed AND.{0,3}OR/);
  });

  it('mem_search omits the fallback hint when caller explicitly passed or=true', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW zzzzz_nonexistent', or: true, limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/AUDITKW entry/);
    expect(text).not.toMatch(/relaxed AND.{0,3}OR/);
  });

  // P2-7: obs ID passed with source=session should hint switching source.
  it('P2-7: mem_get source=session with an obs ID hints to try source=\'obs\'', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1], source: 'session' });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/No sessions found/);
    // New symmetric hint format via lib/id-routing.mjs: "Try: #1 (obs — use source='obs')".
    expect(text).toMatch(/#1.*\(obs/);
    expect(text).toMatch(/source='obs'/);
  });

  it('P2-7: mem_get source=session with a truly missing ID omits the hint', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [999999], source: 'session' });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/No sessions found/);
    expect(text).not.toMatch(/Try:/);
  });
});

// ─── P2-5: Schema description documents anchor/query precedence ──────────────
// This is a pure documentation fix, so the test reads the zod descriptor.

describe('P2-5: memTimelineSchema documents anchor/query precedence', () => {
  it('anchor description mentions taking precedence over query', () => {
    const desc = memTimelineSchema.anchor.description;
    expect(desc).toMatch(/precedence/i);
    expect(desc).toMatch(/query/i);
  });

  it('query description mentions being ignored when anchor is present', () => {
    const desc = memTimelineSchema.query.description;
    expect(desc).toMatch(/ignored when anchor/i);
  });
});

// ─── T2 audit fixes ──────────────────────────────────────────────────────────
//
//   T2-P0-A MCP  maintain purge_stale ran without a confirm gate and silently deleted rows
//                — this is exactly how my audit wiped 421 pending-purge observations.
//   T2-P0-B MCP  optimize schema was missing `scope` so MCP callers could not reach
//                the wide re-enrich path that the CLI exposed as `--scope wide`.
//   T2-P1-A MCP  maintain execute with `operations: []` silently ran only FTS optimize.
//   T2-P1-B CLI  maintain operations did not emit the OP_CAP "re-run for more" hint.
//   T2-P1-C CLI  optimize --max 0 was swallowed by `|| 15` and ran 15 LLM calls anyway.
//   T2-P1-D CLI  optimize --task only accepted a single task; MCP took an array.

function seedDbWithPurgeable(dir, projectName = 'audit--probe') {
  const dbPath = join(dir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'audit-sess', project: projectName, memoryId: 'audit-mem' });
  // Three rows marked pending-purge and older than 30d (eligible for purge_stale).
  for (let i = 0; i < 3; i++) {
    insertObs(db, {
      sessionId: 'audit-mem',
      project: projectName,
      type: 'change',
      title: `PURGEABLE ${i}`,
      text: `stale marker ${i}`,
      importance: 1,
      epochOffset: -60 * 86_400_000, // 60 days old
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
  }
  // One live control row that must NOT be purged.
  insertObs(db, {
    sessionId: 'audit-mem',
    project: projectName,
    type: 'bugfix',
    title: 'LIVE CONTROL',
    text: 'not-purgeable',
    importance: 3,
    epochOffset: 0,
    compressedInto: null,
  });
  db.close();
  return dbPath;
}

describe('MCP T2 audit fixes (stdio)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-audit-t2-'));
    seedDbWithPurgeable(tmp);
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try { proc.stdin.end(); } catch { /* already closed */ }
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    await new Promise((r) => setTimeout(r, 50));
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function callTool(name, args) {
    return rpc(proc, Math.floor(Math.random() * 1e9), 'tools/call', { name, arguments: args });
  }

  // T2-P0-A: purge_stale without confirm returns a preview and deletes nothing.
  it('T2-P0-A: mem_maintain purge_stale without confirm previews and does not delete', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['purge_stale'],
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/preview \(confirm=false\)/);
    expect(text).toMatch(/Candidates \(pending-purge, older than 30d\): 3/);
    expect(text).toMatch(/re-run with confirm=true/);

    // Verify the DB still has all 4 rows (3 purgeable + 1 live).
    const db = new Database(join(tmp, 'claude-mem-lite.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM observations').get().c;
    db.close();
    expect(count).toBe(4);
  });

  it('T2-P0-A: mem_maintain purge_stale with confirm=true actually deletes', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['purge_stale'],
      confirm: true,
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Purged 3 stale observations/);

    const db = new Database(join(tmp, 'claude-mem-lite.db'));
    const remaining = db.prepare("SELECT title FROM observations").all();
    db.close();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('LIVE CONTROL');
  });

  it('T2-P0-A: confirm=false is explicit dry-run (same as omitted)', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['purge_stale'],
      confirm: false,
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/preview \(confirm=false\)/);
    expect(text).not.toMatch(/Purged \d+ stale observations/);
  });

  // T2-P0-B: optimize schema exposes the `scope` field.
  it('T2-P0-B: memOptimizeSchema exposes scope=narrow|wide', () => {
    const desc = memOptimizeSchema.scope?.description || '';
    expect(desc).toMatch(/wide/);
    expect(desc).toMatch(/narrow/);
    // Default must be narrow so behaviour is unchanged for callers who don't opt in.
    const parsed = memOptimizeSchema.scope.safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe('narrow');
  });

  // T2-P1-A: explicit empty operations array is rejected rather than silently running FTS only.
  it('T2-P1-A: mem_maintain execute with operations=[] returns isError', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: [],
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/operations array is empty/);
  });

  it('T2-P1-A: omitted operations still falls back to the default trio', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', { action: 'execute' });
    const text = resp.result?.content?.[0]?.text || '';
    // Default ops produce at least one Cleaned/Decayed/Boosted line.
    expect(text).toMatch(/Cleaned up \d+/);
    expect(text).toMatch(/Decayed \d+/);
    expect(text).toMatch(/Boosted \d+/);
  });
});

// ─── T2 CLI fixes (via run) ──────────────────────────────────────────────────

describe('T2 CLI fixes', () => {
  beforeEach(() => {
    testDb = (() => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      return db;
    })();
    insertSession(testDb, { id: 't2-sess', project: 'test--probe', memoryId: 't2-mem' });
  });
  afterEach(() => { testDb.close(); });

  // T2-P1-C
  it('T2-P1-C: optimize --max 0 is rejected (not swallowed by || 15)', async () => {
    const output = await captureStdout(() => run(['optimize', '--run', '--max', '0']));
    expect(output).toMatch(/Invalid --max "0"/);
    expect(output).not.toMatch(/Running LLM optimization/);
  });

  it('T2-P1-C: optimize --max above 100 is rejected', async () => {
    const output = await captureStdout(() => run(['optimize', '--run', '--max', '200']));
    expect(output).toMatch(/Invalid --max "200"/);
  });

  // T2-P1-D
  it('T2-P1-D: optimize --task accepts a single task (back-compat)', async () => {
    const output = await captureStdout(() => run(['optimize', '--task', 're-enrich']));
    // preview path still runs (no --run) and shows the preview header.
    expect(output).toMatch(/Optimization Preview/);
  });

  it('T2-P1-D: optimize --task accepts comma-separated multi-task', async () => {
    const output = await captureStdout(() => run(['optimize', '--task', 're-enrich,cluster-merge']));
    expect(output).toMatch(/Optimization Preview/);
  });

  it('T2-P1-D: optimize --task rejects unknown task names', async () => {
    const output = await captureStdout(() => run(['optimize', '--task', 'not-a-task']));
    expect(output).toMatch(/Unknown task\(s\): not-a-task/);
    expect(output).toMatch(/Valid: re-enrich, normalize, cluster-merge, smart-compress/);
  });

  // T2-P1-B: purge_stale preview (shares code path with OP_CAP hint helper).
  it('T2-P0-A CLI parity: maintain purge_stale without --confirm previews only', async () => {
    // Seed a pending-purge row.
    insertObs(testDb, {
      sessionId: 't2-mem', project: 'test--probe', type: 'change',
      title: 'CLI PURGEABLE', text: 'stale', importance: 1,
      epochOffset: -60 * 86_400_000, compressedInto: COMPRESSED_PENDING_PURGE,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'purge_stale']));
    expect(output).toMatch(/purge_stale preview \(no --confirm\)/);
    expect(output).toMatch(/Candidates \(pending-purge, older than 30d\): 1/);

    // Row must still exist.
    const row = testDb.prepare("SELECT id FROM observations WHERE title = 'CLI PURGEABLE'").get();
    expect(row).toBeDefined();
  });

  it('T2-P0-A CLI parity: maintain purge_stale --confirm actually deletes', async () => {
    insertObs(testDb, {
      sessionId: 't2-mem', project: 'test--probe', type: 'change',
      title: 'CLI PURGEABLE 2', text: 'stale', importance: 1,
      epochOffset: -60 * 86_400_000, compressedInto: COMPRESSED_PENDING_PURGE,
    });
    const output = await captureStdout(() => run([
      'maintain', 'execute', '--ops', 'purge_stale', '--confirm',
    ]));
    expect(output).toMatch(/Purged 1 stale observations/);
    const row = testDb.prepare("SELECT id FROM observations WHERE title = 'CLI PURGEABLE 2'").get();
    expect(row).toBeUndefined();
  });
});

// ─── T2 maintain schema surface ──────────────────────────────────────────────

// ─── T4 audit fixes ──────────────────────────────────────────────────────────
//
//   T4-P1-A  hook auto-maintain comment claimed "7-day retention" but the filter
//            `created_at_epoch < now-7d` was redundant with the 30-day marking gate —
//            effective retention was next daily cycle (~24h). Fix: cutoff = now - 37d.
//   T4-P1-B  pre-skill-bridge.js used plain-text stdout; some CC variants drop plain-text
//            PreToolUse output (sdscc). Fix: switch to JSON `hookSpecificOutput`.
//   T4-P2-B  handleStop inserted fast session_summaries without a dedup guard — Stop fired
//            twice produced a duplicate row. Fix: mirror handleSessionStart's `hasSummary` check.
//   T4-P2-D  handleUserPrompt did UPDATE prompt_counter + SELECT as two statements — concurrent
//            prompts could read a stale counter. Fix: UPDATE ... RETURNING prompt_counter.

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const HOOK_PATH = resolve(new URL('..', import.meta.url).pathname, 'hook.mjs');
const PRE_SKILL_BRIDGE = resolve(new URL('..', import.meta.url).pathname, 'scripts/pre-skill-bridge.js');

const DAY_MS = 86_400_000;
const PENDING_PURGE_MARKER = -2; // COMPRESSED_PENDING_PURGE

// Init a DB under `{home}/.claude-mem-lite/claude-mem-lite.db` with initSchema.
function initHomeDb(home) {
  const dbDir = join(home, '.claude-mem-lite');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dbDir, 'runtime'), { recursive: true });
  const dbPath = join(dbDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return { db, dbPath };
}

function runHookCmd(event, { home, stdin = '', cwd = home }) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH, event], {
      input: stdin,
      timeout: 10000,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: cwd,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_COMPRESS: '1',
        CLAUDE_MEM_SKIP_OPTIMIZE: '1',
        MEM_NO_AUTO_ADOPT: '1',
        MEM_QUIET_HOOKS: '1',
        CLAUDE_MEM_HOOK_RUNNING: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', exitCode: e.status ?? 1 };
  }
}

describe('T4-P1-A: auto-maintain 7-day retention (hook.mjs)', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-t4-ret-'));
    // Project dir must match a basename that sanitizes to `audit--t4`.
    projDir = join(tmpHome, 'workspace', 't4');
    mkdirSync(projDir, { recursive: true });
    // Move the project dir up so that `inferProject()` (basename + parent) maps to "audit--t4".
    // inferProject: parent=workspace, base=t4 → "workspace--t4" — not what we want.
    // To get "audit--t4" we need parent=audit, base=t4.
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('preserves pending-purge rows aged 34 days (within 37d cutoff) across SessionStart', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();

    // Seed three rows, each with compressed_into = PENDING_PURGE_MARKER:
    //   A: 40 days old → must be purged under fixed 37d cutoff (older than 37d)
    //   B: 34 days old → must SURVIVE (newer than 37d cutoff, even though marked)
    //   C: 20 days old → not even eligible for marking yet; sanity control
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('t4-ret-sess', 't4-ret-mem', ?, ?, ?, 'active')
    `).run((project_ => project_)('audit--t4'), new Date().toISOString(), now);

    const insertObsRaw = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, compressed_into, access_count,
        created_at, created_at_epoch)
      VALUES ('t4-ret-mem', ?, ?, 'change', ?, '', '', '', '', '[]', '[]', 1, ?, 0, ?, ?)
    `);
    insertObsRaw.run('audit--t4', 'row A body', 'row A (40d)', PENDING_PURGE_MARKER, new Date(now - 40 * DAY_MS).toISOString(), now - 40 * DAY_MS);
    insertObsRaw.run('audit--t4', 'row B body', 'row B (34d)', PENDING_PURGE_MARKER, new Date(now - 34 * DAY_MS).toISOString(), now - 34 * DAY_MS);
    insertObsRaw.run('audit--t4', 'row C body', 'row C (20d, unmarked)', null, new Date(now - 20 * DAY_MS).toISOString(), now - 20 * DAY_MS);
    db.close();

    // SessionStart triggers the auto-maintain cycle (no prior maintain gate file).
    const stdinPayload = JSON.stringify({ session_id: 'cc-t4-uuid' });
    runHookCmd('session-start', { home: tmpHome, cwd: projDir, stdin: stdinPayload });

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const titles = db2.prepare('SELECT title FROM observations ORDER BY created_at_epoch ASC').all().map(r => r.title);
      // After the fix: A is deleted; B (34d, marked) survives; C (20d, unmarked) survives.
      expect(titles).not.toContain('row A (40d)');
      expect(titles).toContain('row B (34d)');
      expect(titles).toContain('row C (20d, unmarked)');
    } finally { db2.close(); }
  });
});

describe('T4-P1-B: pre-skill-bridge emits JSON hookSpecificOutput', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-t4-bridge-'));
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('wraps skill content in JSON hookSpecificOutput instead of plain-text stdout', () => {
    // Build the managed skill fixture the bridge expects:
    //   ~/.claude-mem-lite/managed/skills/t4-probe/SKILL.md
    //   ~/.claude-mem-lite/resource-registry.db with a matching `resources` row.
    const managedDir = join(tmpHome, '.claude-mem-lite', 'managed', 'skills', 't4-probe');
    mkdirSync(managedDir, { recursive: true });
    const skillPath = join(managedDir, 'SKILL.md');
    writeFileSync(skillPath, '# t4-probe\nsample managed skill body for T4-P1-B');

    // Minimal registry DB — we only need a `resources` row the bridge can SELECT.
    const regDbPath = join(tmpHome, '.claude-mem-lite', 'resource-registry.db');
    const rdb = new Database(regDbPath);
    rdb.pragma('journal_mode = WAL');
    rdb.exec(`CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      invocation_name TEXT,
      local_path TEXT,
      source TEXT,
      capability_summary TEXT
    )`);
    rdb.prepare(`INSERT INTO resources (name, type, status, invocation_name, local_path)
                 VALUES (?, 'skill', 'active', ?, ?)`).run('t4-probe', 't4-probe', managedDir);
    rdb.close();

    const input = JSON.stringify({ tool_input: { skill: 't4-probe' } });
    const out = execFileSync(process.execPath, [PRE_SKILL_BRIDGE], {
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: tmpHome, CLAUDE_MEM_HOOK_RUNNING: undefined },
    });

    const trimmed = out.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    // Must parse as JSON — no bare `<skill-bridge>` prefix.
    const parsed = JSON.parse(trimmed);
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput?.additionalContext).toMatch(/t4-probe/);
    expect(parsed.hookSpecificOutput?.additionalContext).toMatch(/sample managed skill body/);
  });
});

describe('T4-P2-B: handleStop fast summary dedup', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-t4-stop-'));
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('running Stop twice for the same session produces at most one fast summary', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();

    // Seed: one active session + one user_prompt + one observation.
    const sessId = 'hook-audit--t4-' + randomUUID().slice(0, 8);
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'audit--t4', ?, ?, 'active')
    `).run(sessId, sessId, new Date(now).toISOString(), now);
    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
      VALUES (?, 'initial probe prompt for dedup test', 1, ?, ?)
    `).run(sessId, new Date(now).toISOString(), now);
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'audit--t4', 'obs body', 'change', 'T4 stop probe obs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run(sessId, new Date(now).toISOString(), now);
    db.close();

    // Write session file so hook.mjs getSessionId() returns the same id on both runs.
    writeFileSync(
      join(tmpHome, '.claude-mem-lite', 'runtime', `session-audit--t4`),
      JSON.stringify({ id: sessId, project: 'audit--t4', startedAt: now }),
    );

    const stdin = JSON.stringify({ session_id: 'cc-t4-stop-uuid' });
    runHookCmd('stop', { home: tmpHome, cwd: projDir, stdin });
    // Re-write the session file (Stop deletes it) so the second call can find the same id.
    writeFileSync(
      join(tmpHome, '.claude-mem-lite', 'runtime', `session-audit--t4`),
      JSON.stringify({ id: sessId, project: 'audit--t4', startedAt: now }),
    );
    runHookCmd('stop', { home: tmpHome, cwd: projDir, stdin });

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const count = db2.prepare('SELECT COUNT(*) AS c FROM session_summaries WHERE memory_session_id = ?').get(sessId).c;
      expect(count).toBeLessThanOrEqual(1);
    } finally { db2.close(); }
  });
});

describe('T4-P2-D: prompt_counter is atomic per prompt', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-t4-counter-'));
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('sequential UserPromptSubmit events produce distinct monotonic prompt_number values', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    db.close();

    // Send three prompts back-to-back; even the simpler sequential case must remain correct
    // after the UPDATE/SELECT → UPDATE ... RETURNING refactor.
    const stdinFor = (text) => JSON.stringify({ prompt: text, session_id: 'cc-t4-counter' });
    for (const t of ['prompt alpha audit', 'prompt beta audit', 'prompt gamma audit']) {
      runHookCmd('user-prompt', { home: tmpHome, cwd: projDir, stdin: stdinFor(t) });
    }

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const numbers = db2.prepare(`SELECT prompt_number FROM user_prompts ORDER BY id ASC`).all().map(r => r.prompt_number);
      expect(numbers).toEqual([1, 2, 3]);
    } finally { db2.close(); }
  });
});

describe('T2 schema: memMaintainSchema.confirm', () => {
  it('exposes the confirm field with a descriptive string', () => {
    expect(memMaintainSchema.confirm).toBeDefined();
    const desc = memMaintainSchema.confirm.description;
    expect(desc).toMatch(/purge_stale/);
    expect(desc).toMatch(/dry-run|preview|destructive/i);
  });
});

// ─── T3 audit fixes ──────────────────────────────────────────────────────────
//
//   T3-P1-A MCP  export silently skipped invalid date filters (CLI errored loudly)
//   T3-P2-A MCP  registry list ordered by name, showing "adopt:null" for NULL counts
//   T3-P2-B MCP  export "Results capped at N" fired even when N was exactly available
//   T3-P2-C MCP  fts_check had a dead "Unknown action" branch gated by the Zod enum
//   T3-P2-D MCP  export SELECT missed branch / access_count / memory_session_id

describe('MCP T3 audit fixes (stdio)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-audit-t3-'));
    const dbPath = join(tmp, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 't3-sess', project: 'audit--t3', memoryId: 't3-mem' });
    // Seed 2 observations — one with branch, access_count, and a lesson to verify export completeness.
    insertObs(db, {
      sessionId: 't3-mem', project: 'audit--t3', type: 'bugfix',
      title: 'T3 seed row 1', text: 'seed one', importance: 2,
      epochOffset: -1000, accessCount: 7, branch: 'main',
      lessonLearned: 'export must include branch & access_count',
    });
    insertObs(db, {
      sessionId: 't3-mem', project: 'audit--t3', type: 'change',
      title: 'T3 seed row 2', text: 'seed two', importance: 1,
      epochOffset: 0, branch: 'feature/probe',
    });
    db.close();
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try { proc.stdin.end(); } catch { /* already closed */ }
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    await new Promise((r) => setTimeout(r, 50));
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function callTool(name, args) {
    return rpc(proc, Math.floor(Math.random() * 1e9), 'tools/call', { name, arguments: args });
  }

  // T3-P1-A: invalid date must throw instead of being silently dropped.
  it('T3-P1-A: mem_export with invalid date_from surfaces an error', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', {
      project: 'audit--t3',
      date_from: 'not-a-date',
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/Invalid date_from/i);
  });

  it('T3-P1-A: mem_export with invalid date_to surfaces an error', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', {
      project: 'audit--t3',
      date_to: '2026-13-40', // invalid calendar date
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/Invalid date_to/i);
  });

  it('T3-P1-A: mem_export with valid ISO date_from works', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', {
      project: 'audit--t3',
      date_from: '2020-01-01',
      limit: 10,
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).not.toBe(true);
    expect(text).toMatch(/Exported 2 observations/);
  });

  // T3-P2-A: registry list sorts by adoption and never prints "adopt:null".
  it('T3-P2-A: mem_registry list never emits "adopt:null"', async () => {
    await initialize(proc);
    const resp = await callTool('mem_registry', { action: 'list' });
    const text = resp.result?.content?.[0]?.text || '';
    // Empty registries yield "No resources found." — only assert formatting when populated.
    if (/^Resources /m.test(text)) {
      expect(text).not.toMatch(/adopt:null/);
    }
  });

  // T3-P2-B: cap message must not fire when the result equals the explicit limit but no more rows exist.
  it('T3-P2-B: mem_export with limit == total does NOT claim "capped"', async () => {
    await initialize(proc);
    // The seeded DB has exactly 2 rows for audit--t3 — request limit=2 (equals total).
    const resp = await callTool('mem_export', { project: 'audit--t3', limit: 2 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Exported 2 observations/);
    expect(text).not.toMatch(/capped at/);
  });

  it('T3-P2-B: mem_export with limit < total DOES flag capped', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', { project: 'audit--t3', limit: 1 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Exported 1 observations/);
    expect(text).toMatch(/capped at 1/);
  });

  // T3-P2-D: export must include branch / access_count / memory_session_id in the JSON payload.
  it('T3-P2-D: mem_export JSON includes branch, access_count, memory_session_id', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', { project: 'audit--t3', limit: 10, format: 'jsonl' });
    const text = resp.result?.content?.[0]?.text || '';
    // Extract JSONL lines (skip the "Exported N" header).
    const lines = text.split('\n').filter(l => l.startsWith('{'));
    expect(lines.length).toBeGreaterThan(0);
    const row = JSON.parse(lines[0]);
    expect(row).toHaveProperty('branch');
    expect(row).toHaveProperty('access_count');
    expect(row).toHaveProperty('memory_session_id');
    // At least one row must have a concrete branch value (seeded).
    const hasBranch = lines.map(l => JSON.parse(l)).some(r => r.branch === 'main' || r.branch === 'feature/probe');
    expect(hasBranch).toBe(true);
  });
});
