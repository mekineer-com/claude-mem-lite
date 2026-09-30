// Two Claude Code sessions open in the SAME project keep separate memory sessions (D14).
//
// The session file (`session-<project>`) and the episode buffer (`ep-<project>.json`) were keyed
// by project alone. The second session's SessionStart overwrote the first one's session file, so
// every later hook of the first session ran under the SECOND session's id (sandbox repro,
// E2E round 2026-09-29):
//   - A's exit handoff "Working On" was B's prompt;
//   - `session_summaries` had one row for two sessions, the later Stop overwriting the earlier;
//   - A's episode was stored under B's memory_session_id;
//   - A running /clear while B was open carried B's prompt into A's "Working State".
// Both files are now keyed by the Claude Code PROCESS (CLAUDE_PID, set by the host on every hook
// subprocess). The process, not the host session_id, because /clear rotates session_id inside the
// same process and the /clear branch must find the session that was just cleared.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'hook.mjs');
const MOCK = join(REPO, 'scripts/mock-claude.mjs');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

// Two LIVE processes stand in for the two hosts: a dead pid would (correctly) be treated as a
// session that is gone, and its buffer adopted.
const HOST_A = String(process.pid);
const HOST_B = String(process.ppid);

let home, projectDir, runtime;

beforeEach(() => {
  const root = fixtures.track(join(tmpdir(), `mem-hostscope-${randomUUID().slice(0, 8)}`));
  home = join(root, 'home');
  projectDir = join(root, 'work', 'todo-app');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, 'test'), { recursive: true });
  writeFileSync(join(projectDir, 'src/server.js'), 'export function addTodo(body) {\n  return body;\n}\n');
  writeFileSync(join(projectDir, 'test/server.test.js'), "test('adds', () => {});\n");
  runtime = join(home, '.claude-mem-lite', 'runtime');
  mkdirSync(runtime, { recursive: true });
  const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
  initSchema(db);
  db.close();
});

function hook(event, payload, host, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PID: host ?? '',
    CLAUDE_MEM_HOOK_RUNNING: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SUMMARY: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    MEM_NO_AUTO_ADOPT: '1',
    ...extraEnv,
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  return execFileSync(process.execPath, [HOOK, event], {
    input: JSON.stringify({ cwd: projectDir, ...payload }),
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

const start = (sid, host, source = 'startup', extraEnv) =>
  hook('session-start', { session_id: sid, source, hook_event_name: 'SessionStart' }, host, extraEnv);
const prompt = (sid, host, text) =>
  hook('user-prompt', { session_id: sid, prompt: text, hook_event_name: 'UserPromptSubmit' }, host);
const edit = (sid, host, file, marker) =>
  hook(
    'post-tool-use',
    {
      session_id: sid,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: join(projectDir, file),
        old_string: 'export function addTodo(body) {',
        new_string: `export function addTodo(body) {\n  if (!body || !body.title) throw new Error('${marker}: title required');`,
      },
      tool_response: { filePath: join(projectDir, file) },
    },
    host,
  );
const stop = (sid, host) => hook('stop', { session_id: sid, hook_event_name: 'Stop' }, host);

function q(sql, ...args) {
  const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}
const buffers = () =>
  readdirSync(runtime)
    .filter((f) => f.startsWith('ep-') && !f.startsWith('ep-flush-') && f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(runtime, f), 'utf8')));
const memIdOf = (cc) =>
  q('SELECT DISTINCT content_session_id id FROM user_prompts WHERE cc_session_id = ?', cc).map((r) => r.id);

describe('two sessions open in one project', () => {
  it('each keeps its own memory session, episode buffer and handoff', () => {
    start('cc-A', HOST_A);
    prompt('cc-A', HOST_A, 'Add title validation to addTodo so empty titles throw ALPHA_ERR');
    edit('cc-A', HOST_A, 'src/server.js', 'ALPHA_ERR');
    start('cc-B', HOST_B); // B opens while A is still running
    prompt('cc-B', HOST_B, 'Write a README section BRAVO_DOCS describing listTodos');
    edit('cc-B', HOST_B, 'README.md', 'BRAVO_DOCS');

    const [a] = memIdOf('cc-A');
    const [b] = memIdOf('cc-B');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a, 'A and B were given one memory session').not.toBe(b);

    // One buffer per session, each holding only its own session's work.
    const bufs = buffers();
    expect(bufs.map((e) => e.sessionId).sort()).toEqual([a, b].sort());
    for (const ep of bufs) {
      const cc = ep.sessionId === a ? 'cc-A' : 'cc-B';
      expect(ep.entries.map((e) => e.ccSession)).toEqual([cc]);
    }

    // B ending its turn flushes B's work only; A's edit in progress stays buffered.
    stop('cc-B', HOST_B);
    expect(buffers().map((e) => e.sessionId)).toEqual([a]);

    edit('cc-A', HOST_A, 'test/server.test.js', 'ALPHA_ERR');
    stop('cc-A', HOST_A);
    expect(buffers()).toEqual([]);
    const [handoff] = q(
      "SELECT working_on FROM session_handoffs WHERE session_id = 'cc-A' AND type = 'exit'",
    );
    expect(handoff.working_on).toMatch(/ALPHA_ERR/);
    expect(handoff.working_on).not.toMatch(/BRAVO_DOCS/);
    const status = Object.fromEntries(
      q('SELECT content_session_id id, status FROM sdk_sessions').map((r) => [r.id, r.status]),
    );
    expect(status[a]).toBe('completed');
    expect(status[b]).toBe('completed');
  });

  it('/clear in one session carries that session forward, not the other one', () => {
    start('cc-A', HOST_A);
    prompt('cc-A', HOST_A, 'Refactor the OSCAR_TASK retry loop in src/server.js');
    edit('cc-A', HOST_A, 'src/server.js', 'OSCAR_TASK');
    stop('cc-A', HOST_A);
    start('cc-B', HOST_B);
    prompt('cc-B', HOST_B, 'Write the PAPA_DOCS changelog entry');
    start('cc-A2', HOST_A, 'clear'); // /clear rotates A's session_id; the process stays

    const [clear] = q(
      "SELECT working_on FROM session_handoffs WHERE session_id = 'cc-A2' AND type = 'clear'",
    );
    expect(clear, 'no clear handoff was written for the cleared session').toBeTruthy();
    expect(clear.working_on).toMatch(/OSCAR_TASK/);
    expect(clear.working_on).not.toMatch(/PAPA_DOCS/);
  });
});

describe('the buffer of a session whose process is gone', () => {
  it('is flushed by the next session in the project instead of waiting out the 7-day sweep', async () => {
    // A process that has exited: its pid is dead, exactly like a host closed mid-turn (no Stop).
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout;
    start('cc-D', dead);
    prompt('cc-D', dead, 'Fix the DELTA_BUG crash on empty body');
    edit('cc-D', dead, 'src/server.js', 'DELTA_BUG');
    expect(buffers(), 'premise: the dead session left a buffer behind').toHaveLength(1);

    // The flushed episode goes through the (mock) LLM worker, which saves the observation.
    start('cc-E', HOST_A, 'startup', {
      CLAUDE_MEM_SKIP_EPISODE_LLM: '',
      CLAUDE_MEM_NO_DELAY: '1',
      CLAUDE_CODE_PATH: MOCK,
    });
    expect(buffers()).toEqual([]);
    const [d] = memIdOf('cc-D');
    let obs = [];
    for (let i = 0; i < 150 && obs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      obs = q('SELECT memory_session_id m FROM observations');
    }
    expect(obs.map((o) => o.m)).toEqual([d]); // saved under the session that did the work
  });

  it('a LIVE session’s buffer is left alone', () => {
    start('cc-A', HOST_A);
    prompt('cc-A', HOST_A, 'Add ALPHA_ERR validation');
    edit('cc-A', HOST_A, 'src/server.js', 'ALPHA_ERR');
    start('cc-B', HOST_B);
    expect(buffers()).toHaveLength(1);
    expect(q('SELECT COUNT(*) n FROM observations')[0].n).toBe(0);
  });
});

describe('adoption and clean-up', () => {
  it('flushes the per-project buffer an older version left behind', async () => {
    const legacy = {
      sessionId: 'hook-old-sess',
      project: 'work--todo-app',
      startedAt: Date.now() - 5000,
      lastAt: Date.now() - 4000,
      files: [join(projectDir, 'src/server.js')],
      entries: [
        {
          tool: 'Edit',
          desc: 'server.js: guard body before reading title',
          files: [join(projectDir, 'src/server.js')],
          ts: Date.now() - 4000,
          isError: false,
          isSignificant: true,
          bashSig: null,
        },
      ],
      filesRead: [],
    };
    writeFileSync(join(runtime, 'ep-work--todo-app.json'), JSON.stringify(legacy));
    start('cc-E', HOST_A, 'startup', {
      CLAUDE_MEM_SKIP_EPISODE_LLM: '',
      CLAUDE_MEM_NO_DELAY: '1',
      CLAUDE_CODE_PATH: MOCK,
    });
    expect(buffers()).toEqual([]);
    let obs = [];
    for (let i = 0; i < 150 && obs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      obs = q('SELECT memory_session_id m FROM observations');
    }
    expect(obs.map((o) => o.m)).toEqual(['hook-old-sess']);
  });

  it('puts a claimed buffer back when it cannot be flushed (no openable database)', () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout;
    start('cc-D', dead);
    prompt('cc-D', dead, 'Fix the DELTA_BUG crash on empty body');
    edit('cc-D', dead, 'src/server.js', 'DELTA_BUG');
    const before = buffers();
    expect(before).toHaveLength(1);
    writeFileSync(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), 'not a database');
    start('cc-E', HOST_A);
    expect(readdirSync(runtime).filter((f) => f.includes('.claim-'))).toEqual([]);
    expect(buffers()).toEqual(before); // same file, same content, for the next SessionStart
  });

  it('adopts the per-project buffer an older version left under a non-Latin project’s OLD id', () => {
    // Before D9 ~/projects/博客 buffered into ep-projects----.json; its new id is projects--博客,
    // so nothing looked under the old name again and the 7-day sweep deleted the buffer.
    const blog = join(dirname(dirname(projectDir)), 'projects', '博客');
    mkdirSync(blog, { recursive: true });
    const legacyBuffer = {
      sessionId: 'hook-old-blog',
      project: 'projects----',
      startedAt: Date.now() - 5000,
      lastAt: Date.now() - 4000,
      files: [join(blog, 'post.js')],
      entries: [
        {
          tool: 'Edit',
          desc: 'post.js: layout',
          files: [join(blog, 'post.js')],
          ts: Date.now() - 4000,
          isError: false,
          isSignificant: true,
          bashSig: null,
        },
      ],
      filesRead: [],
    };
    for (const host of [HOST_A, undefined]) {
      writeFileSync(join(runtime, 'ep-projects----.json'), JSON.stringify(legacyBuffer));
      start(`cc-blog-${host}`, host, 'startup', { CLAUDE_PROJECT_DIR: blog });
      expect(readdirSync(runtime), `host ${host}`).not.toContain('ep-projects----.json');
    }
  });

  it("collects a gone process's Read paths along with its buffer", () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout;
    start('cc-D', dead);
    prompt('cc-D', dead, 'Fix the DELTA_BUG crash on empty body');
    const read = spawnSync('bash', [join(REPO, 'scripts/post-tool-use.sh')], {
      input: JSON.stringify({
        session_id: 'cc-D',
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'src/server.js') },
      }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PID: dead,
        CLAUDE_MEM_DIR: '',
      },
      encoding: 'utf8',
    });
    expect(read.status).toBe(0);
    edit('cc-D', dead, 'src/server.js', 'DELTA_BUG');
    expect(readdirSync(runtime), 'premise: the gone process left its reads').toContain(`reads-@h${dead}.txt`);
    start('cc-E', HOST_A);
    expect(readdirSync(runtime).filter((f) => f.startsWith('reads-'))).toEqual([]);
  });

  it("removes a gone process's session file and keeps a live one's", () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout;
    const sessions = () => readdirSync(runtime).filter((f) => f.startsWith('session-'));
    start('cc-D', dead);
    expect(sessions()).toEqual([`session-work--todo-app@h${dead}`]);
    start('cc-B', HOST_B);
    expect(sessions()).toEqual([`session-work--todo-app@h${HOST_B}`]);
    start('cc-A', HOST_A);
    expect(sessions().sort()).toEqual(
      [`session-work--todo-app@h${HOST_A}`, `session-work--todo-app@h${HOST_B}`].sort(),
    );
  });

  it('the bash Read tracker writes the reads file the Node flush collects', () => {
    const read = spawnSync('bash', [join(REPO, 'scripts/post-tool-use.sh')], {
      input: JSON.stringify({
        session_id: 'cc-A',
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'src/server.js') },
      }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PID: HOST_A,
        CLAUDE_MEM_DIR: '',
      },
      encoding: 'utf8',
    });
    expect(read.status).toBe(0);
    const reads = () => readdirSync(runtime).filter((f) => f.startsWith('reads-'));
    expect(reads()).toEqual([`reads-@h${HOST_A}.txt`]);
    start('cc-A', HOST_A);
    prompt('cc-A', HOST_A, 'Add ALPHA_ERR validation');
    edit('cc-A', HOST_A, 'src/server.js', 'ALPHA_ERR');
    stop('cc-A', HOST_A);
    expect(reads(), 'the Stop flush did not collect the reads file bash wrote').toEqual([]);
  });
});

describe('without a host pid', () => {
  it('keeps the per-project file names (tests, other hosts)', () => {
    start('cc-L', undefined);
    prompt('cc-L', undefined, 'Add ALPHA_ERR validation');
    edit('cc-L', undefined, 'src/server.js', 'ALPHA_ERR');
    const names = readdirSync(runtime);
    expect(names).toContain('session-work--todo-app');
    expect(names).toContain('ep-work--todo-app.json');
  });

  it('ignores a CLAUDE_PID that is not a pid', () => {
    start('cc-L', '../../x');
    prompt('cc-L', '../../x', 'Add ALPHA_ERR validation');
    expect(readdirSync(runtime)).toContain('session-work--todo-app');
    expect(existsSync(join(home, 'x'))).toBe(false);
  });
});
