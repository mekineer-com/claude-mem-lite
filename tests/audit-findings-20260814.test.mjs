// Regression pins for the 5 product defects the 2026-08-14 feature sweep surfaced
// (tests/feature-sweep-{cli,mcp,hooks}.test.mjs found them; this file is where each
// FIXED behavior is nailed down so it cannot silently reopen).
//
// One describe per finding, named F1..F5 after the audit report:
//   F1  mem_use substituted a DIFFERENT skill's body on a name miss (HIGH)
//   F2  optimize preview printed two spellings of the same line (MCP vs CLI)
//   F3  mem_save `files` was described as "associated" but rendered as "modified"
//   F4  three hook-llm debugLog calls passed 2 args to a 3-arg signature
//   F5  a non-string tool_name threw a swallowed TypeError in the PostToolUse hook
//
// Every case states, in a comment, the input that makes it fail — an assertion whose
// failing input nobody can name is not a test.
//
// ISOLATION: every spawned process gets CLAUDE_MEM_DIR + HOME pointed at a mkdtemp
// sandbox, and a cwd inside it, so nothing can reach the live ~/.claude-mem-lite DB or
// write into this repo. The sandbox is removed in an afterAll `finally`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { saveObservation } from '../hook-llm.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');

// ─── Sandbox shared by the subprocess-driven cases ─────────────────────────────────

let ROOT, HOME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-audit0814-'));
  HOME_DIR = join(ROOT, 'home');
  mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });

  BASE_ENV = { ...process.env };
  // The developer's own plugin flags would otherwise flip default-OFF surfaces on in the
  // child (the #8608 leak class). Everything needed is set explicitly below.
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    HOME: HOME_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),   // no LLM spend, no network
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
  });
  delete BASE_ENV.CLAUDE_PROJECT_DIR;   // cwd is the only project source
  delete BASE_ENV.PWD;
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));   // let any detached worker settle
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** A sandbox dir under ROOT (cwd / data dir), created on demand. */
function sandboxDir(...parts) {
  const d = join(ROOT, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function fire(cmd, args, { cwd, stdin = '', env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...BASE_ENV, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} did not exit within ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});   // a hook that returns before reading stdin: EPIPE is fine
    child.stdin.end(stdin);
  });
}

// ─── F4 — hook-llm's three write-side noise diagnostics ────────────────────────────
// utils.mjs debugLog(level, context, msg) takes THREE args. hook-llm.mjs:159/175/185
// passed two, so the level slot held the context and the message slot was `undefined`:
// the line rendered as "[saveObservation] <title>: undefined" and could not be filtered
// by level. 11 other call sites in the same file already passed three.

describe('F4 — write-side noise-gate diagnostics log at a real level with a real message', () => {
  const DEBUG_LINE = /^\[claude-mem-lite\] \[[^\]]+\] \[(DEBUG|WARN|ERROR)\] ([^:]+): (.+)$/;
  let db, errSpy, prevDebug;

  beforeEach(() => {
    prevDebug = process.env.CLAUDE_MEM_DEBUG;
    process.env.CLAUDE_MEM_DEBUG = '1';          // debugLog is gated on this
    db = createTestDb();
    insertSession(db, { id: 'sess-f4', project: 'test' });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    db.close();
    if (prevDebug === undefined) delete process.env.CLAUDE_MEM_DEBUG;
    else process.env.CLAUDE_MEM_DEBUG = prevDebug;
  });

  /** The one line the given drop produced, split into level / context / message. */
  function soleDiagnostic() {
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines, `expected exactly one debugLog line, got:\n${lines.join('\n')}`).toHaveLength(1);
    const m = lines[0].match(DEBUG_LINE);
    expect(m, `debugLog line does not match the utils.mjs format:\n${lines[0]}`).toBeTruthy();
    return { level: m[1], context: m[2], message: m[3], raw: lines[0] };
  }

  // FAILS IF: the call reverts to debugLog('saveObservation', msg) — then level='saveObservation'
  // (not in the DEBUG|WARN|ERROR alternation) so DEBUG_LINE does not match at all.
  it('drop-as-noise names its level, its context and the dropped title', () => {
    // isNoiseObservation: LOW_SIGNAL title pattern, no lesson, no facts, importance<2.
    const id = saveObservation(
      { type: 'change', title: 'Modified widget-cache.mjs', narrative: 'edited it', importance: 1 },
      'test', 'sess-f4', db,
    );
    expect(id).toBeNull();                         // it really took the drop branch
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('dropped noise: Modified widget-cache.mjs');
  });

  // FAILS IF: the message argument is dropped again — `message` would then be 'undefined'.
  it('drop-as-low-yield-change names its level, its context and the dropped title', () => {
    const id = saveObservation(
      { type: 'change', title: 'Adjusted the retry backoff in the API client', narrative: 'edited the client', importance: 1, lessonLearned: null },
      'test', 'sess-f4', db,
    );
    expect(id).toBeNull();
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('dropped low-yield change: Adjusted the retry backoff in the API client');
  });

  // FAILS IF: the importance-cap diagnostic loses its message — the before→after numbers
  // are the whole payload of this line.
  it('importance-cap names its level, its context and the before→after importance', () => {
    // capNoiseImportance: a LOW_SIGNAL title that escaped BOTH drop gates on importance>=2
    // alone (no lesson, no facts) is written, but demoted to importance 1.
    const id = saveObservation(
      { type: 'discovery', title: 'Modified transport.mjs', narrative: 'edited it', importance: 3 },
      'test', 'sess-f4', db,
    );
    expect(id).toBeGreaterThan(0);
    expect(db.prepare('SELECT importance FROM observations WHERE id = ?').get(id).importance).toBe(1);
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('capped imp 3→1: Modified transport.mjs');
  });
});

// ─── F5 — a non-string tool_name in the PostToolUse payload ────────────────────────
// hook.mjs:302 guarded `if (!tool_name) return;` (falsiness only), then called
// tool_name.startsWith(p) two lines down. A number/object/array tool_name therefore threw
// a TypeError that the top-level catch absorbed: exit 0, clean stdout, and NO attributable
// record — a host field-shape change would have silently killed every observation with
// nothing to find. The guard now matches scripts/pre-skill-bridge.js:43 (typeof check) and
// routes the case to the telemetry log instead of a swallowed throw.

describe('F5 — a non-string tool_name is recorded, not thrown-and-swallowed', () => {
  const HOOK_ERROR_SCOPE = 'post-tool-use:tool_name-type';
  let dataDir, runtimeDir, cwd;

  /** All hook-error records written under this case's runtime dir. */
  function hookErrorRecords() {
    const dir = join(runtimeDir, 'hook-errors');
    if (!existsSync(dir)) return [];
    const shard = join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
    if (!existsSync(shard)) return [];
    return readFileSync(shard, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  const post = (payload) => fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
    cwd, stdin: JSON.stringify(payload), env: { CLAUDE_MEM_DIR: dataDir },
  });

  beforeEach(() => {
    // Own data dir per case so the hook-errors shard holds only this case's records.
    const slug = 'f5-' + Math.random().toString(36).slice(2, 8);
    dataDir = sandboxDir('data-' + slug);
    runtimeDir = join(dataDir, 'runtime');
    cwd = sandboxDir('work', slug);
  });

  // FAILS IF: the typeof guard is removed — tool_name.startsWith then throws, the top-level
  // catch prints "[ERROR] post-tool-use: tool_name.startsWith is not a function" to stderr
  // and writes no record, so BOTH the stderr assertion and the record assertion red.
  it('records the malformed field instead of throwing a TypeError into the void', async () => {
    const r = await post({
      session_id: 'cc-f5-number', tool_name: 42,
      tool_input: { file_path: join(cwd, 'widget-cache.mjs') },
      tool_response: 'The file has been updated successfully with the new content applied.',
    });
    expect(r.code, `hook exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toBe('');                                   // host-visible channel stays clean
    expect(r.stderr).not.toMatch(/is not a function|TypeError/); // the throw is gone

    const records = hookErrorRecords();
    expect(records.map((x) => x.scope), `no ${HOOK_ERROR_SCOPE} record:\n${JSON.stringify(records)}`)
      .toContain(HOOK_ERROR_SCOPE);
    const rec = records.find((x) => x.scope === HOOK_ERROR_SCOPE);
    expect(rec.ctx, 'the record must name the type that arrived, else it is unactionable')
      .toMatch(/number/);
  });

  // Array and object shapes take the same path (an array's .startsWith is also undefined),
  // so the guard cannot be a number-only special case.
  // FAILS IF: the guard is narrowed to `typeof tool_name === 'number'`.
  it('covers the array and object shapes too', async () => {
    for (const shape of [['Edit'], { name: 'Edit' }]) {
      const r = await post({ session_id: 'cc-f5-shape', tool_name: shape, tool_input: {}, tool_response: 'ok' });
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/is not a function|TypeError/);
    }
    expect(hookErrorRecords().filter((x) => x.scope === HOOK_ERROR_SCOPE)).toHaveLength(2);
  });

  // The counter-case: a well-formed payload must NOT produce a telemetry record. Without
  // this, an unconditional recordHookError call would pass the two cases above.
  // FAILS IF: the guard is written without the typeof test (e.g. always record).
  it('a well-formed string tool_name writes no hook-error record', async () => {
    const r = await post({
      session_id: 'cc-f5-ok', tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'widget-cache.mjs'), old_string: 'a', new_string: 'b' },
      tool_response: 'The file has been updated successfully with the new content applied.',
    });
    expect(r.code, `hook exited ${r.code}\n${r.stderr}`).toBe(0);
    // Proof the payload really reached the capture path (so the "no record" claim is about a
    // handled payload, not about a payload the hook ignored for some other reason).
    const episode = JSON.parse(readFileSync(join(runtimeDir, `ep-${'work--' + cwd.split('/').pop()}.json`), 'utf8'));
    expect(episode.entries.map((e) => e.tool)).toEqual(['Edit']);
    expect(hookErrorRecords()).toEqual([]);
  });
});

// ─── F3 — `files` was described as "associated", rendered as "modified" ────────────
// tool-schemas.mjs:209 described mem_save's `files` as "File paths associated with this
// observation", but lib/save-observation.mjs:117 stores it in `files_modified` and both
// `get` paths rendered the raw column name — so a file the caller only READ came back
// labelled as modified. Per the F3 decision this is a prose/label fix: no column rename,
// no new field, no migration. The label the reader sees is now `files`, matching the
// input parameter's own name; `--fields files_modified` still selects it by column.

describe('F3 — an attached file is not rendered as a modification', () => {
  let dataDir, cwd;
  const CLI_PATH = join(REPO, 'cli.mjs');
  const readOnlyFile = () => join(cwd, 'widget-cache.mjs');

  const run = (args) => fire(process.execPath, [CLI_PATH, ...args], {
    cwd, env: { CLAUDE_MEM_DIR: dataDir },
  });

  beforeEach(() => {
    const slug = 'f3-' + Math.random().toString(36).slice(2, 8);
    dataDir = sandboxDir('data-' + slug);
    cwd = sandboxDir('work', slug);
  });

  // FAILS IF: the render label goes back to the raw column name — `files_modified: [...]`
  // matches the negative assertion, and the `files: [...]` line the positive one looks for
  // is not emitted.
  it('CLI get labels an attached path `files`, never `files_modified`', async () => {
    const saved = await run(['save', 'Reviewed the retry backoff implementation before touching it',
      '--type', 'discovery', '--files', readOnlyFile()]);
    expect(saved.code, saved.stderr).toBe(0);
    const id = Number(saved.stdout.match(/Saved #(\d+)/)[1]);

    const got = await run(['get', String(id)]);
    expect(got.code, got.stderr).toBe(0);
    expect(got.stdout).toContain(`files: ["${readOnlyFile()}"]`);
    expect(got.stdout, 'a file that was only read must not be labelled modified')
      .not.toMatch(/^files_modified:/m);
  });

  // The column name stays the selector (no rename, per the F3 decision), so a caller who
  // asks for it by column still gets the row — under the honest label.
  // FAILS IF: the fix renamed the column or dropped it from OBS_FIELDS — `--fields
  // files_modified` would then be rejected as an unknown field and print nothing.
  it('--fields files_modified still selects the column and renders the new label', async () => {
    const saved = await run(['save', 'Read through the transport module to map its retries',
      '--type', 'discovery', '--files', readOnlyFile()]);
    const id = Number(saved.stdout.match(/Saved #(\d+)/)[1]);

    const got = await run(['get', String(id), '--fields', 'files_modified']);
    expect(got.code, got.stderr).toBe(0);
    expect(got.stderr).not.toMatch(/Unknown field/);
    expect(got.stdout).toContain(`files: ["${readOnlyFile()}"]`);
  });

  // FAILS IF: the schema description reverts to "File paths associated with this
  // observation" — it then names neither the column the value lands in nor the fact that
  // passing a path is not a claim the file was edited.
  it('the mem_save schema says where the value lands and what it does not claim', async () => {
    const { memSaveSchema } = await import('../tool-schemas.mjs');
    const description = memSaveSchema.files.description;
    expect(description).toContain('files_modified');
    expect(description).toMatch(/not assert|does not claim|not a claim/i);
  });
});
