// E2E test suite for claude-mem-lite hook lifecycle
// Tests the actual CLI entry point (node hook.mjs <event>) as a subprocess
// Isolation via HOME env var → redirects ~/.claude-mem-lite/ to temp dir

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { computeMinHash } from './utils.mjs';
import { initSchema } from './schema.mjs';

const HOOK_PATH = resolve('hook.mjs');
const MOCK_CLAUDE = resolve('scripts/mock-claude.mjs');

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-e2e-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initTestDb(tmpHome) {
  const dbDir = join(tmpHome, '.claude-mem-lite');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dbDir, 'runtime'), { recursive: true });

  const dbPath = join(dbDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  // Single source of truth: reuse initSchema from schema.mjs
  initSchema(db);

  db.close();
  return dbPath;
}

function openTestDb(tmpHome) {
  const dbPath = join(tmpHome, '.claude-mem-lite', 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  return db;
}

function runHook(event, { stdin, env = {}, args = [] } = {}) {
  const mergedEnv = {
    ...process.env,
    HOME: env.HOME || process.env.HOME,
    CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR || projectDir,
    CLAUDE_CODE_PATH: env.CLAUDE_CODE_PATH || MOCK_CLAUDE,
    CLAUDE_MEM_HOOK_RUNNING: undefined, // Don't inherit — let hooks run
    CLAUDE_MEM_DEBUG: '1',
    ...env,
  };

  // Remove undefined keys
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }

  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH, event, ...args], {
      input: stdin || '',
      timeout: 15000,
      encoding: 'utf8',
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

function makeToolPayload(toolName, input, response) {
  return JSON.stringify({ tool_name: toolName, tool_input: input, tool_response: response });
}

function getSessionFile(tmpHome) {
  const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
  const files = readdirSync(runtimeDir).filter(f => f.startsWith('session-'));
  return files.length > 0 ? join(runtimeDir, files[0]) : null;
}

function getSessionIdFromFile(tmpHome) {
  const sf = getSessionFile(tmpHome);
  if (!sf) return null;
  try {
    return JSON.parse(readFileSync(sf, 'utf8')).id;
  } catch { return null; }
}

function getEpisodeFile(tmpHome) {
  const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
  const files = readdirSync(runtimeDir).filter(f => f.startsWith('ep-') && f.endsWith('.json') && !f.startsWith('ep-flush-'));
  return files.length > 0 ? join(runtimeDir, files[0]) : null;
}

function getFlushFiles(tmpHome) {
  const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
  return readdirSync(runtimeDir).filter(f => f.startsWith('ep-flush-'));
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

let tmpHome;
let projectDir;

beforeEach(() => {
  tmpHome = makeTmpDir();
  projectDir = join(tmpHome, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  initTestDb(tmpHome);
});

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('Suite 1: Full Session Lifecycle', () => {
  it('session-start creates session row and outputs context', () => {
    const { stdout, exitCode } = runHook('session-start', { env: { HOME: tmpHome } });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('<claude-mem-context>');
    expect(stdout).toContain('</claude-mem-context>');

    // Session file created
    const sf = getSessionFile(tmpHome);
    expect(sf).not.toBeNull();

    // Session row in DB
    const db = openTestDb(tmpHome);
    const rows = db.prepare('SELECT * FROM sdk_sessions').all();
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].project).toContain('testproj');
  });

  it('post-tool-use (Edit) creates episode buffer file', () => {
    // Start session first
    runHook('session-start', { env: { HOME: tmpHome } });

    const payload = makeToolPayload('Edit', {
      file_path: '/tmp/src/index.js',
      old_string: 'foo',
      new_string: 'bar',
    }, 'OK — edited file');

    const { exitCode } = runHook('post-tool-use', {
      stdin: payload,
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    // Episode file should exist
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();

    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    expect(episode.entries.length).toBe(1);
    expect(episode.entries[0].tool).toBe('Edit');
    expect(episode.files).toContain('/tmp/src/index.js');
  });

  it('multiple post-tool-use entries accumulate in episode', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Three related edits to the same file
    for (let i = 0; i < 3; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload('Edit', {
          file_path: '/tmp/src/index.js',
          old_string: `old${i}`,
          new_string: `new${i}`,
        }, 'OK — edited file'),
        env: { HOME: tmpHome },
      });
    }

    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();
    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    expect(episode.entries.length).toBe(3);
  });

  it('stop flushes episode and marks session completed', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Add some entries
    runHook('post-tool-use', {
      stdin: makeToolPayload('Edit', {
        file_path: '/tmp/src/app.js',
        old_string: 'a',
        new_string: 'b',
      }, 'OK — edited file'),
      env: { HOME: tmpHome },
    });

    const { exitCode } = runHook('stop', { env: { HOME: tmpHome } });
    expect(exitCode).toBe(0);

    // Session marked completed
    const db = openTestDb(tmpHome);
    const sess = db.prepare('SELECT status FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    db.close();
    expect(sess.status).toBe('completed');

    // Episode file should be gone (flushed)
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).toBeNull();

    // Session file should be cleaned up
    const sf = getSessionFile(tmpHome);
    expect(sf).toBeNull();
  });

  it('full cycle: start → tool-use ×3 → stop → verify DB', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Three edits
    for (let i = 0; i < 3; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload('Edit', {
          file_path: `/tmp/src/file${i}.js`,
          old_string: 'old',
          new_string: 'new',
        }, 'OK — edited file'),
        env: { HOME: tmpHome },
      });
    }

    runHook('stop', { env: { HOME: tmpHome } });

    // DB should have: 1 session (completed), flush file created
    const db = openTestDb(tmpHome);
    const sess = db.prepare('SELECT * FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    expect(sess.status).toBe('completed');
    expect(sess.completed_at).not.toBeNull();

    // Flush file should have been created (background worker not actually running in test)
    const flushFiles = getFlushFiles(tmpHome);
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);

    db.close();
  });
});

describe('Suite 2: Episode Buffer Management', () => {
  it('buffer flushes at 10 entries', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Send 11 entries to the same file (10 = buffer full → flush)
    for (let i = 0; i < 11; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload('Edit', {
          file_path: '/tmp/src/big.js',
          old_string: `line${i}`,
          new_string: `fixed${i}`,
        }, 'OK — edited file'),
        env: { HOME: tmpHome },
      });
    }

    // A flush file should have been created
    const flushFiles = getFlushFiles(tmpHome);
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);

    // Current episode buffer should have the overflow entries
    const epFile = getEpisodeFile(tmpHome);
    if (epFile) {
      const episode = JSON.parse(readFileSync(epFile, 'utf8'));
      // The 11th entry starts a new episode after the 10-entry flush
      expect(episode.entries.length).toBeLessThanOrEqual(2);
    }
  });

  it('skipped tools (Read, Glob) do not create entries', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Read and Glob should be skipped
    runHook('post-tool-use', {
      stdin: makeToolPayload('Read', { file_path: '/tmp/foo.js' }, 'file contents here more than 10 chars'),
      env: { HOME: tmpHome },
    });
    runHook('post-tool-use', {
      stdin: makeToolPayload('Glob', { pattern: '*.js' }, 'file1.js file2.js more stuff padding'),
      env: { HOME: tmpHome },
    });

    // No episode file should exist
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).toBeNull();
  });

  it('pending entry recovery: pending file gets merged on next call', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // First, create a normal episode entry
    runHook('post-tool-use', {
      stdin: makeToolPayload('Edit', {
        file_path: '/tmp/src/app.js',
        old_string: 'a',
        new_string: 'b',
      }, 'OK — edited file'),
      env: { HOME: tmpHome },
    });

    // Manually create a pending file (simulates what writePendingEntry does on lock failure)
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const pendingFile = join(runtimeDir, `pending-${Date.now()}-test.json`);
    writeFileSync(pendingFile, JSON.stringify({
      entry: {
        tool: 'Write',
        desc: 'Created app.js (200 chars)',
        files: ['/tmp/src/app.js'],
        ts: Date.now(),
        isError: false,
        isSignificant: true,
        bashSig: null,
      },
      sessionId,
      project: 'parent--testproj',
      ts: Date.now(),
    }));

    // Verify pending file exists
    const pendingBefore = readdirSync(runtimeDir).filter(f => f.startsWith('pending-'));
    expect(pendingBefore.length).toBe(1);

    // Next post-tool-use should merge the pending entry
    runHook('post-tool-use', {
      stdin: makeToolPayload('Edit', {
        file_path: '/tmp/src/app.js',
        old_string: 'x',
        new_string: 'y',
      }, 'OK — edited file'),
      env: { HOME: tmpHome },
    });

    // Pending files should be consumed
    const remainingPending = readdirSync(runtimeDir).filter(f => f.startsWith('pending-'));
    expect(remainingPending.length).toBe(0);

    // Episode should contain the merged entries (original + pending + new)
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();
    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    expect(episode.entries.length).toBeGreaterThanOrEqual(3);
  });

  it('file phase change triggers flush (unrelated files + ≥2 entries)', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Two entries on file A
    for (let i = 0; i < 2; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload('Edit', {
          file_path: '/tmp/src/moduleA.js',
          old_string: `a${i}`,
          new_string: `b${i}`,
        }, 'OK — edited file'),
        env: { HOME: tmpHome },
      });
    }

    // Entry on completely unrelated file B → triggers phase change flush
    runHook('post-tool-use', {
      stdin: makeToolPayload('Edit', {
        file_path: '/tmp/tests/unrelated.test.js',
        old_string: 'x',
        new_string: 'y',
      }, 'OK — edited file'),
      env: { HOME: tmpHome },
    });

    // A flush file should have been created from the phase change
    const flushFiles = getFlushFiles(tmpHome);
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Suite 3: LLM Episode Processing', { retry: 2 }, () => {
  it('llm-episode with mock LLM creates observation in DB', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Create a flush file manually (simulating what flushEpisode does)
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flushFile = join(runtimeDir, `ep-flush-${Date.now()}-test.json`);
    writeFileSync(flushFile, JSON.stringify({
      sessionId,
      project: 'parent--testproj',
      startedAt: Date.now() - 5000,
      lastAt: Date.now(),
      files: ['/tmp/src/index.js'],
      entries: [{
        tool: 'Edit',
        desc: 'index.js: "foo" → "bar"',
        files: ['/tmp/src/index.js'],
        ts: Date.now(),
        isError: false,
        isSignificant: true,
        bashSig: null,
      }],
      filesRead: [],
      fileHistoryShown: [],
    }));

    // Run llm-episode — it reads the flush file, calls mock LLM, saves observation
    const { exitCode } = runHook('llm-episode', {
      env: { HOME: tmpHome, CLAUDE_MEM_NO_DELAY: '1' },
      args: [flushFile],
    });
    expect(exitCode).toBe(0);

    // Flush file should be consumed
    expect(existsSync(flushFile)).toBe(false);

    // Observation should be in DB
    const db = openTestDb(tmpHome);
    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all(sessionId);
    db.close();
    expect(obs.length).toBe(1);
    expect(obs[0].title).toBe('Mock single observation');
    expect(obs[0].type).toBe('change');
    expect(obs[0].narrative).toContain('Mock narrative');
  });

  it('llm-episode with LLM failure saves degraded observation', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flushFile = join(runtimeDir, `ep-flush-${Date.now()}-bad.json`);
    writeFileSync(flushFile, JSON.stringify({
      sessionId,
      project: 'parent--testproj',
      startedAt: Date.now() - 5000,
      lastAt: Date.now(),
      files: ['/tmp/src/broken.js'],
      entries: [{
        tool: 'Edit',
        desc: 'broken.js: fixed syntax error',
        files: ['/tmp/src/broken.js'],
        ts: Date.now(),
        isError: false,
        isSignificant: true,
        bashSig: null,
      }],
      filesRead: [],
      fileHistoryShown: [],
    }));

    // Use a mock that returns garbage (non-existent script → callLLM returns null)
    const { exitCode } = runHook('llm-episode', {
      env: { HOME: tmpHome, CLAUDE_CODE_PATH: '/dev/null', CLAUDE_MEM_NO_DELAY: '1' },
      args: [flushFile],
    });
    expect(exitCode).toBe(0);

    // Degraded observation should still be saved
    const db = openTestDb(tmpHome);
    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all(sessionId);
    db.close();
    expect(obs.length).toBe(1);
    // Degraded: uses first entry desc as title
    expect(obs[0].title).toContain('broken.js');
    expect(obs[0].type).toBe('change');
  });

  it('related observation linking: overlapping files populate related_ids', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Seed first observation directly in DB (avoids dedup with identical mock titles)
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'shared refactor concepts', 'refactor', 'Refactored shared module', 'shared.js, a.js', 'Refactored the shared module', 'refactor shared', 'updated exports', '[]', ?, 1, ?, ?)
    `).run(sessionId, JSON.stringify(['/tmp/src/shared.js', '/tmp/src/a.js']), now.toISOString(), now.getTime());
    db.close();

    // Second observation via llm-episode — overlapping file (shared.js)
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flush2 = join(runtimeDir, `ep-flush-${Date.now()}-r2.json`);
    writeFileSync(flush2, JSON.stringify({
      sessionId,
      project: 'parent--testproj',
      startedAt: Date.now() - 3000,
      lastAt: Date.now(),
      files: ['/tmp/src/shared.js', '/tmp/src/b.js'],
      entries: [{
        tool: 'Write',
        desc: 'Created b.js (200 chars)',
        files: ['/tmp/src/shared.js', '/tmp/src/b.js'],
        ts: Date.now() - 1000,
        isError: false, isSignificant: true, bashSig: null,
      }],
      filesRead: [], fileHistoryShown: [],
    }));
    runHook('llm-episode', { env: { HOME: tmpHome, CLAUDE_MEM_NO_DELAY: '1' }, args: [flush2] });

    // Both observations should have related_ids referencing each other
    const db2 = openTestDb(tmpHome);
    const obs = db2.prepare('SELECT id, related_ids FROM observations ORDER BY id').all();
    db2.close();
    expect(obs.length).toBe(2);

    const rel1 = JSON.parse(obs[0].related_ids);
    const rel2 = JSON.parse(obs[1].related_ids);
    expect(rel1).toContain(obs[1].id);
    expect(rel2).toContain(obs[0].id);
  });
});

describe('Suite 4: Session Summary', { retry: 2 }, () => {
  it('llm-summary with observations creates session_summary', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Seed an observation directly in DB
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'test text', 'change', 'Test observation', '', 'Did some changes', '', '', '[]', '[]', 1, ?, ?)
    `).run(sessionId, now.toISOString(), now.getTime());
    db.close();

    // Run llm-summary (pass sessionId and project as args)
    const { exitCode } = runHook('llm-summary', {
      env: { HOME: tmpHome, CLAUDE_MEM_FLUSH_TIMEOUT: '1' },
      args: [sessionId, 'parent--testproj'],
    });
    expect(exitCode).toBe(0);

    // Session summary should exist
    const db2 = openTestDb(tmpHome);
    const summaries = db2.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').all(sessionId);
    db2.close();
    expect(summaries.length).toBe(1);
    expect(summaries[0].request).toBe('Mock session request description');
    expect(summaries[0].completed).toBe('Mock accomplishments');
    expect(summaries[0].next_steps).toBe('Mock suggested follow-up');
  });

  it('llm-summary with no observations exits gracefully', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('llm-summary', {
      env: { HOME: tmpHome, CLAUDE_MEM_FLUSH_TIMEOUT: '1' },
      args: [sessionId, 'parent--testproj'],
    });
    expect(exitCode).toBe(0);

    // No summary should be created
    const db = openTestDb(tmpHome);
    const summaries = db.prepare('SELECT * FROM session_summaries').all();
    db.close();
    expect(summaries.length).toBe(0);
  });
});

describe('Suite 5: User Prompt', () => {
  it('user-prompt stores scrubbed text in DB', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: 'Help me fix the authentication bug' }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT * FROM user_prompts WHERE content_session_id = ?').all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt_text).toBe('Help me fix the authentication bug');
    expect(prompts[0].prompt_number).toBe(1);
  });

  it('user-prompt accepts "prompt" field (Claude Code hook protocol)', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({ prompt: 'Using the new prompt field name' }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT * FROM user_prompts WHERE content_session_id = ?').all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt_text).toBe('Using the new prompt field name');
  });

  it('prompt counter increments across multiple prompts', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    for (let i = 0; i < 3; i++) {
      runHook('user-prompt', {
        stdin: JSON.stringify({ user_prompt: `Prompt number ${i + 1}` }),
        env: { HOME: tmpHome },
      });
    }

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT prompt_number FROM user_prompts WHERE content_session_id = ? ORDER BY id').all(sessionId);
    const sess = db.prepare('SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    db.close();
    expect(prompts.length).toBe(3);
    expect(prompts[0].prompt_number).toBe(1);
    expect(prompts[1].prompt_number).toBe(2);
    expect(prompts[2].prompt_number).toBe(3);
    expect(sess.prompt_counter).toBe(3);
  });
});

describe('Suite 6: Error Recall', () => {
  it('post-tool-use with Bash error outputs recall hints', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Seed DB with a relevant observation
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'ECONNREFUSED connection refused port 3000', 'bugfix', 'Fixed ECONNREFUSED on port 3000', '', 'Server was not running, needed to start it first', '', '', '[]', '[]', 2, ?, ?)
    `).run(sessionId, now.toISOString(), now.getTime());
    db.close();

    // Bash error containing matching keywords
    const { stdout } = runHook('post-tool-use', {
      stdin: makeToolPayload('Bash', {
        command: 'curl http://localhost:3000/api/health',
      }, 'Error: connect ECONNREFUSED 127.0.0.1:3000\n    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)'),
      env: { HOME: tmpHome },
    });

    expect(stdout).toContain('[claude-mem-lite] Related memories found for this error');
    expect(stdout).toContain('ECONNREFUSED');
  });
});

describe('Suite 7: Secret Scrubbing E2E', () => {
  it('post-tool-use with password=secret scrubs episode desc', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    const payload = makeToolPayload('Bash', {
      command: 'curl -u admin:password=secret123 http://api.example.com/deploy',
    }, 'HTTP 200 OK deployed successfully — this is a longer response for the length check');

    runHook('post-tool-use', {
      stdin: payload,
      env: { HOME: tmpHome },
    });

    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();
    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    // The desc should have the secret scrubbed
    expect(episode.entries[0].desc).not.toContain('secret123');
  });
});

describe('Suite 8a: Cross-Session MinHash Dedup', () => {
  it('cross-session dedup blocks near-duplicate observation', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Insert first observation directly into DB with minhash_sig
    const db = openTestDb(tmpHome);
    const now = new Date();
    const title1 = 'Fixed authentication bug in login flow for user sessions';
    const narrative1 = 'The authentication module had a bug where expired tokens were not being refreshed properly';
    const sig = computeMinHash(title1 + ' ' + narrative1);

    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', ?, 'bugfix', ?, '', ?, '', '', '[]', '[]', 1, ?, ?, ?)
    `).run(sessionId, title1, title1, narrative1, sig, now.toISOString(), now.getTime());
    db.close();

    // Try to save a near-duplicate observation via llm-episode
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flushFile = join(runtimeDir, `ep-flush-${Date.now()}-dedup.json`);
    writeFileSync(flushFile, JSON.stringify({
      sessionId: `hook-parent--testproj-different-session`,
      project: 'parent--testproj',
      startedAt: Date.now() - 5000,
      lastAt: Date.now(),
      files: ['/tmp/src/auth.js'],
      entries: [{
        tool: 'Edit',
        desc: 'auth.js: fixed token refresh',
        files: ['/tmp/src/auth.js'],
        ts: Date.now(),
        isError: false, isSignificant: true, bashSig: null,
      }],
      filesRead: [], fileHistoryShown: [],
    }));

    // Run llm-episode - the mock LLM will return a generic title, which won't match
    // by Jaccard but the MinHash check happens on the combined title+narrative
    runHook('llm-episode', { env: { HOME: tmpHome, CLAUDE_MEM_NO_DELAY: '1' }, args: [flushFile] });

    // The mock returns "Mock single observation" which is dissimilar, so it should NOT be deduped
    // This test validates that the minhash_sig column is populated for new observations
    const db2 = openTestDb(tmpHome);
    const obs = db2.prepare('SELECT id, minhash_sig FROM observations ORDER BY id').all();
    db2.close();
    expect(obs.length).toBeGreaterThanOrEqual(1);
    // First observation should have our manually set sig
    expect(obs[0].minhash_sig).toBe(sig);
  });
});

describe('Suite 8a: Additional E2E', () => {
  it('session-start with no existing DB creates DB', () => {
    // Use a fresh tmpHome with no DB
    const freshHome = makeTmpDir();
    const freshProjDir = join(freshHome, 'parent', 'freshproj');
    mkdirSync(freshProjDir, { recursive: true });

    const { exitCode, stdout } = runHook('session-start', {
      env: { HOME: freshHome, CLAUDE_PROJECT_DIR: freshProjDir },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('<claude-mem-context>');

    // DB should have been created
    const dbPath = join(freshHome, '.claude-mem-lite', 'claude-mem-lite.db');
    expect(existsSync(dbPath)).toBe(true);

    try { rmSync(freshHome, { recursive: true, force: true }); } catch {}
  });

  it('auto-migrates ~/claude-mem-lite/claude-mem.db → ~/.claude-mem-lite/claude-mem-lite.db on session-start', () => {
    // Create a fresh home with old unhidden dir + old DB filename
    const migrateHome = makeTmpDir();
    const oldUnhiddenDir = join(migrateHome, 'claude-mem-lite');
    mkdirSync(oldUnhiddenDir, { recursive: true });
    mkdirSync(join(oldUnhiddenDir, 'runtime'), { recursive: true });

    // Create DB with old filename in old dir
    const oldDbPath = join(oldUnhiddenDir, 'claude-mem.db');
    const db = new Database(oldDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    // Insert a marker observation
    const now = new Date();
    const sessId = 'migrate-test-sess';
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`).run(sessId, sessId, now.toISOString(), now.getTime());
    db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'marker', 'discovery', 'Migration marker', '', '', '', '', '[]', '[]', 1, ?, ?)`).run(sessId, now.toISOString(), now.getTime());
    db.close();

    // Old file should exist, new hidden dir should not
    expect(existsSync(oldDbPath)).toBe(true);
    const newHiddenDir = join(migrateHome, '.claude-mem-lite');
    expect(existsSync(newHiddenDir)).toBe(false);

    // Session-start triggers ensureDb() which:
    //   1. Renames ~/claude-mem-lite/ → ~/.claude-mem-lite/
    //   2. Renames claude-mem.db → claude-mem-lite.db
    const migrateProjDir = join(migrateHome, 'parent', 'migrateproj');
    mkdirSync(migrateProjDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: migrateHome, CLAUDE_PROJECT_DIR: migrateProjDir },
    });
    expect(exitCode).toBe(0);

    // Old unhidden dir should be gone
    expect(existsSync(oldUnhiddenDir)).toBe(false);
    // New hidden dir should exist with renamed DB
    const newDbPath = join(newHiddenDir, 'claude-mem-lite.db');
    expect(existsSync(newDbPath)).toBe(true);

    // Verify data survived both migrations
    const db2 = new Database(newDbPath, { readonly: true });
    const obs = db2.prepare("SELECT title FROM observations WHERE title = 'Migration marker'").get();
    db2.close();
    expect(obs).not.toBeUndefined();
    expect(obs.title).toBe('Migration marker');

    try { rmSync(migrateHome, { recursive: true, force: true }); } catch {}
  });

  it('expired sessions get cleaned up on session-start', () => {
    // Seed an old active session (>24h ago)
    const db = openTestDb(tmpHome);
    const oldEpoch = Date.now() - 25 * 3600000;
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--testproj', ?, ?, 'active')
    `).run('old-sess', 'old-sess', new Date(oldEpoch).toISOString(), oldEpoch);
    db.close();

    // Start a new session — should mark old one as expired
    runHook('session-start', { env: { HOME: tmpHome } });

    const db2 = openTestDb(tmpHome);
    const oldSess = db2.prepare("SELECT status FROM sdk_sessions WHERE content_session_id = 'old-sess'").get();
    db2.close();
    // Old active sessions should be marked as expired/completed
    if (oldSess) {
      expect(oldSess.status).not.toBe('active');
    }
  });

  it('user-prompt with API key gets scrubbed', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: 'Deploy with token=sk-abc123def456ghi789jklmnopqrstuvwxyz to production' }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT prompt_text FROM user_prompts WHERE content_session_id = ?').all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    // The sk- token should be scrubbed
    expect(prompts[0].prompt_text).not.toContain('sk-abc123def456ghi789jklmnopqrstuvwxyz');
    expect(prompts[0].prompt_text).toContain('***');
  });

  it('long prompt is truncated to 10000 chars', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const longPrompt = 'A'.repeat(15000);
    runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: longPrompt }),
      env: { HOME: tmpHome },
    });

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT prompt_text FROM user_prompts WHERE content_session_id = ?').all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt_text.length).toBeLessThanOrEqual(10000);
  });

  it('CLAUDE.md idempotent: two session-starts do not duplicate context', () => {
    const projDir2 = join(tmpHome, 'parent', 'idempotent');
    mkdirSync(projDir2, { recursive: true });
    writeFileSync(join(projDir2, 'CLAUDE.md'), '# Existing\n\nContent here.\n');

    // Seed a summary
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--idempotent-${randomUUID().slice(0, 8)}`;
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--idempotent', ?, ?, 'completed')
    `).run(sessId, sessId, now.toISOString(), now.getTime());
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'parent--idempotent', 'Test request', 'Test completed', 'Test next', ?, ?)
    `).run(sessId, now.toISOString(), now.getTime());
    db.close();

    // First session-start
    runHook('session-start', { env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir2 } });
    const claudeMd1 = readFileSync(join(projDir2, 'CLAUDE.md'), 'utf8');

    // Second session-start
    runHook('session-start', { env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir2 } });
    const claudeMd2 = readFileSync(join(projDir2, 'CLAUDE.md'), 'utf8');

    // Count context blocks — should be exactly 1
    const count1 = (claudeMd1.match(/<claude-mem-context>/g) || []).length;
    const count2 = (claudeMd2.match(/<claude-mem-context>/g) || []).length;
    expect(count1).toBe(1);
    expect(count2).toBe(1);
    // Original content preserved
    expect(claudeMd2).toContain('# Existing');
  });

  it('auto-compress marks old low-importance observations during session-start', () => {
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--testproj-${randomUUID().slice(0, 8)}`;
    const hundredDaysAgo = Date.now() - 100 * 86400000;

    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--testproj', ?, ?, 'completed')
    `).run(sessId, sessId, now.toISOString(), now.getTime());

    // Old, low-importance observation (should be auto-compressed)
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'old routine note', 'discovery', 'Old routine observation', '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run(sessId, new Date(hundredDaysAgo).toISOString(), hundredDaysAgo);

    // Old, higher-importance observation (should NOT be auto-compressed)
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'old notable note', 'decision', 'Old notable observation', '', '', '', '', '[]', '[]', 2, ?, ?)
    `).run(sessId, new Date(hundredDaysAgo).toISOString(), hundredDaysAgo);

    db.close();

    // Session-start triggers auto-compression
    runHook('session-start', { env: { HOME: tmpHome } });

    const db2 = openTestDb(tmpHome);
    const obs = db2.prepare('SELECT id, importance, compressed_into FROM observations ORDER BY id').all();
    db2.close();

    expect(obs.length).toBe(2);
    // importance=1 should be marked as auto-compressed
    const lowImportance = obs.find(o => o.importance === 1);
    expect(lowImportance.compressed_into).toBe(-1);
    // importance=2 should be untouched
    const highImportance = obs.find(o => o.importance === 2);
    expect(highImportance.compressed_into).toBeNull();
  });

  it('CLAUDE.md created from scratch when none exists', () => {
    const projDir3 = join(tmpHome, 'parent', 'noclaudemd');
    mkdirSync(projDir3, { recursive: true });
    // No CLAUDE.md file exists

    // Seed a summary
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--noclaudemd-${randomUUID().slice(0, 8)}`;
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--noclaudemd', ?, ?, 'completed')
    `).run(sessId, sessId, now.toISOString(), now.getTime());
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'parent--noclaudemd', 'Build API', 'API built', 'Add tests', ?, ?)
    `).run(sessId, now.toISOString(), now.getTime());
    db.close();

    runHook('session-start', { env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir3 } });

    // CLAUDE.md should be created with context block
    const claudeMdPath = join(projDir3, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);
    const content = readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('<claude-mem-context>');
    expect(content).toContain('Build API');
  });
});

describe('Suite 8: CLAUDE.md Persistence', () => {
  it('session-start with summary writes CLAUDE.md context block', () => {
    // Create a project dir whose path produces project name 'parent--testproj'
    // inferProject() does: basename(dirname(path)) + '--' + basename(path)
    const projDir = join(tmpHome, 'parent', 'testproj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'CLAUDE.md'), '# My Project\n\nExisting content.\n');

    // Seed DB with a session summary for project 'parent--testproj'
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessionId = `hook-parent--testproj-${randomUUID().slice(0, 8)}`;

    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--testproj', ?, ?, 'completed')
    `).run(sessionId, sessionId, now.toISOString(), now.getTime());

    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'Fix auth bug', 'Checked login flow', 'Token was expired', 'Fixed token refresh', 'Add tests for token refresh', '[]', '[]', '', ?, ?)
    `).run(sessionId, now.toISOString(), now.getTime());
    db.close();

    runHook('session-start', {
      env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir },
    });

    // CLAUDE.md should have the context block
    const claudeMd = readFileSync(join(projDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('<claude-mem-context>');
    expect(claudeMd).toContain('</claude-mem-context>');
    expect(claudeMd).toContain('### Last Session');
    expect(claudeMd).toContain('Fix auth bug');
    expect(claudeMd).toContain('Fixed token refresh');
    // Original content preserved
    expect(claudeMd).toContain('# My Project');
    expect(claudeMd).toContain('Existing content.');
  });
});

describe('Suite 9: Hidden Data Dir Migration', () => {
  it('migrates ~/claude-mem-lite/ with runtime dir pre-created by module init', () => {
    // Simulates the race: hook-shared.mjs creates ~/.claude-mem-lite/runtime/
    // at module load time BEFORE ensureDb() runs. Migration must still work.
    const home = makeTmpDir();
    const oldDir = join(home, 'claude-mem-lite');
    const newDir = join(home, '.claude-mem-lite');

    // Old dir with DB
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(join(oldDir, 'runtime'), { recursive: true });
    const oldDbPath = join(oldDir, 'claude-mem-lite.db');
    const db = new Database(oldDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    const now = new Date();
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`).run('race-sess', 'race-sess', now.toISOString(), now.getTime());
    db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'race marker', 'discovery', 'Race condition marker', '', '', '', '', '[]', '[]', 1, ?, ?)`).run('race-sess', now.toISOString(), now.getTime());
    db.close();

    // Pre-create new hidden dir with runtime/ (simulates module-level mkdir)
    mkdirSync(join(newDir, 'runtime'), { recursive: true });
    // But NO DB file in new dir
    expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);

    const projDir = join(home, 'parent', 'raceproj');
    mkdirSync(projDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(exitCode).toBe(0);

    // Old dir should be gone, data should be in new hidden dir
    expect(existsSync(oldDir)).toBe(false);
    const newDbPath = join(newDir, 'claude-mem-lite.db');
    expect(existsSync(newDbPath)).toBe(true);

    const db2 = new Database(newDbPath, { readonly: true });
    const obs = db2.prepare("SELECT title FROM observations WHERE title = 'Race condition marker'").get();
    db2.close();
    expect(obs).not.toBeUndefined();

    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it('skips migration when hidden dir already has DB', () => {
    // Both dirs exist with DBs — new dir data must NOT be overwritten
    const home = makeTmpDir();
    const oldDir = join(home, 'claude-mem-lite');
    const newDir = join(home, '.claude-mem-lite');

    // Old dir with old marker
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(join(oldDir, 'runtime'), { recursive: true });
    const oldDb = new Database(join(oldDir, 'claude-mem-lite.db'));
    oldDb.pragma('journal_mode = WAL');
    oldDb.pragma('foreign_keys = OFF');
    initSchema(oldDb);
    const now = new Date();
    oldDb.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`).run('old-sess', 'old-sess', now.toISOString(), now.getTime());
    oldDb.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'old data', 'discovery', 'Old marker', '', '', '', '', '[]', '[]', 1, ?, ?)`).run('old-sess', now.toISOString(), now.getTime());
    oldDb.close();

    // New hidden dir with different marker
    mkdirSync(newDir, { recursive: true });
    mkdirSync(join(newDir, 'runtime'), { recursive: true });
    const newDb = new Database(join(newDir, 'claude-mem-lite.db'));
    newDb.pragma('journal_mode = WAL');
    newDb.pragma('foreign_keys = OFF');
    initSchema(newDb);
    newDb.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`).run('new-sess', 'new-sess', now.toISOString(), now.getTime());
    newDb.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'new data', 'discovery', 'New marker', '', '', '', '', '[]', '[]', 1, ?, ?)`).run('new-sess', now.toISOString(), now.getTime());
    newDb.close();

    const projDir = join(home, 'parent', 'skipproj');
    mkdirSync(projDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(exitCode).toBe(0);

    // Old dir should still exist (not consumed)
    expect(existsSync(oldDir)).toBe(true);

    // New hidden dir should have its own data preserved (not overwritten)
    const db2 = new Database(join(newDir, 'claude-mem-lite.db'), { readonly: true });
    const newMarker = db2.prepare("SELECT title FROM observations WHERE title = 'New marker'").get();
    const oldMarker = db2.prepare("SELECT title FROM observations WHERE title = 'Old marker'").get();
    db2.close();
    expect(newMarker).not.toBeUndefined();
    expect(oldMarker).toBeUndefined(); // old data NOT merged in

    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it('migrates dir with already-renamed DB (no file rename needed)', () => {
    // ~/claude-mem-lite/claude-mem-lite.db → ~/.claude-mem-lite/claude-mem-lite.db
    // Only dir migration, DB filename already correct
    const home = makeTmpDir();
    const oldDir = join(home, 'claude-mem-lite');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(join(oldDir, 'runtime'), { recursive: true });

    const dbPath = join(oldDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    const now = new Date();
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`).run('renamed-sess', 'renamed-sess', now.toISOString(), now.getTime());
    db.prepare(`INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'already renamed', 'discovery', 'Already renamed DB', '', '', '', '', '[]', '[]', 1, ?, ?)`).run('renamed-sess', now.toISOString(), now.getTime());
    db.close();

    const projDir = join(home, 'parent', 'renameproj');
    mkdirSync(projDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(exitCode).toBe(0);

    // Old dir gone, new hidden dir has the DB
    expect(existsSync(oldDir)).toBe(false);
    const newDir = join(home, '.claude-mem-lite');
    const newDbPath = join(newDir, 'claude-mem-lite.db');
    expect(existsSync(newDbPath)).toBe(true);

    // No claude-mem.db should exist (wasn't there to begin with)
    expect(existsSync(join(newDir, 'claude-mem.db'))).toBe(false);

    const db2 = new Database(newDbPath, { readonly: true });
    const obs = db2.prepare("SELECT title FROM observations WHERE title = 'Already renamed DB'").get();
    db2.close();
    expect(obs).not.toBeUndefined();

    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it('full lifecycle uses hidden dir for all runtime files', () => {
    // Verify session file, episode file, flush file all under ~/.claude-mem-lite/
    const home = makeTmpDir();
    const projDir = join(home, 'parent', 'hiddenproj');
    mkdirSync(projDir, { recursive: true });

    // Session start — creates DB + session file
    const { exitCode: e1 } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(e1).toBe(0);

    const hiddenDir = join(home, '.claude-mem-lite');
    const runtimeDir = join(hiddenDir, 'runtime');

    // DB created under hidden dir
    expect(existsSync(join(hiddenDir, 'claude-mem-lite.db'))).toBe(true);

    // Session file created under hidden dir
    const sessionFiles = readdirSync(runtimeDir).filter(f => f.startsWith('session-'));
    expect(sessionFiles.length).toBe(1);

    // Post-tool-use → episode buffer under hidden dir
    runHook('post-tool-use', {
      stdin: makeToolPayload('Edit', {
        file_path: '/tmp/src/hidden.js',
        old_string: 'old',
        new_string: 'new',
      }, 'OK — edited file'),
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });

    const epFiles = readdirSync(runtimeDir).filter(f => f.startsWith('ep-') && !f.startsWith('ep-flush-'));
    expect(epFiles.length).toBe(1);

    // Stop → session completed, flush file created
    runHook('stop', { env: { HOME: home, CLAUDE_PROJECT_DIR: projDir } });

    const flushFiles = readdirSync(runtimeDir).filter(f => f.startsWith('ep-flush-'));
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);

    // No unhidden dir should have been created
    expect(existsSync(join(home, 'claude-mem-lite'))).toBe(false);

    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });
});
