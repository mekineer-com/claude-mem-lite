// Hook latency regression tests.
// Each Claude Code hook fires on every tool call / prompt / session-start and
// runs synchronously — wall-clock time directly bills against the user. Before
// this file there was no regression bound: a refactor could land that adds 200ms
// of disk stats on the Edit hot path and only show up as "Claude feels sluggish".
//
// We measure end-to-end (Node spawn + import + DB open + query) on a tiny
// fixture DB. Thresholds are deliberately generous (CI machines vary widely)
// but well under the timeout each hook is gated to in production
// (pre-tool-recall: 3s, post-tool-use: 5s, user-prompt-search: 2s).
//
// CLAUDE_MEM_HOOK_LATENCY_BUDGET_MS env override allows local tightening or
// CI-loosening without touching code.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { createTestDb } from './test-helpers.mjs';

// CI runners and slow laptops both inflate cold-start latency. The budget is
// intentionally above typical observed (≤300ms locally) so a CI hiccup doesn't
// cause flakes — a 4× regression vs typical is what we actually want to flag.
const PRE_TOOL_RECALL_BUDGET_MS = Number(process.env.CLAUDE_MEM_HOOK_LATENCY_BUDGET_MS) || 1500;
const POST_TOOL_USE_BUDGET_MS = Number(process.env.CLAUDE_MEM_HOOK_LATENCY_BUDGET_MS) || 1500;

const PRE_TOOL_RECALL_SCRIPT = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');
const POST_TOOL_USE_SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-use.sh');

describe('hook latency regression', () => {
  let testDir;
  let dbPath;
  let runtimeDir;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'hook-latency-'));
    runtimeDir = join(testDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });

    // Tiny seed DB so we measure overhead, not query cost on a giant corpus.
    dbPath = join(testDir, 'mem.db');
    const db = createTestDb(dbPath);
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('test', 'test', 'projects--test', '2026-01-01T00:00:00Z', 1735689600000, 'active')
    `).run();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_modified, files_read, importance, created_at, created_at_epoch)
      VALUES ('test', 'projects--test', 'sample obs body', 'bugfix', 'Fix sample bug in foo.mjs', '', '', '', '["foo.mjs"]', '[]', 2, '2026-01-01T00:00:00Z', 1735689600000)
    `).run();
    db.close();
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('pre-tool-recall.js completes within latency budget on Edit', () => {
    const hookData = {
      session_id: 'test-session-latency',
      tool_name: 'Edit',
      tool_input: { file_path: '/test/foo.mjs' },
    };

    const start = performance.now();
    const r = spawnSync(process.execPath, [PRE_TOOL_RECALL_SCRIPT], {
      input: JSON.stringify(hookData),
      env: {
        ...process.env,
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: '/test',
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    const elapsed = performance.now() - start;

    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(PRE_TOOL_RECALL_BUDGET_MS);
  });

  it('pre-tool-recall.js exits fast when DB does not exist (no spurious work)', () => {
    const hookData = {
      session_id: 'test-session-latency',
      tool_name: 'Edit',
      tool_input: { file_path: '/test/foo.mjs' },
    };

    const start = performance.now();
    const r = spawnSync(process.execPath, [PRE_TOOL_RECALL_SCRIPT], {
      input: JSON.stringify(hookData),
      env: {
        ...process.env,
        CLAUDE_MEM_DB_PATH: join(testDir, 'does-not-exist.db'),
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: '/test',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    const elapsed = performance.now() - start;

    expect(r.status).toBe(0);
    // No-DB short-circuit must finish faster than the populated path. We only
    // assert "under budget" rather than "faster than first test" because the
    // gap is dominated by Node spawn — which fluctuates 30%+ run-to-run.
    expect(elapsed).toBeLessThan(PRE_TOOL_RECALL_BUDGET_MS);
  });

  it('post-tool-use.sh fast-filter completes within latency budget', () => {
    // Mock CLAUDE_MEM_LITE_HOOK_NODE so the bash filter doesn't recurse into
    // a real hook.mjs run during this test — we only want to measure the bash
    // pre-filter path, which is the per-tool-call overhead.
    const hookData = {
      session_id: 'test-session-latency',
      tool_name: 'Read',
      tool_input: { file_path: '/test/foo.mjs' },
      tool_response: { success: true },
    };

    const start = performance.now();
    const r = spawnSync('bash', [POST_TOOL_USE_SCRIPT], {
      input: JSON.stringify(hookData),
      env: {
        ...process.env,
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: '/test',
        // Tell the shell filter not to spawn the heavy Node hook — sets it
        // to a no-op binary. The bash filter logic still runs end-to-end.
        CLAUDE_MEM_LITE_HOOK_NODE: '/bin/true',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    const elapsed = performance.now() - start;

    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(POST_TOOL_USE_BUDGET_MS);
  });
});
