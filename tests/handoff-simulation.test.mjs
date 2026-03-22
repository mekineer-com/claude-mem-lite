// Handoff simulation tests — validates /clear and /exit from user's perspective
// Each test simulates a realistic user workflow and verifies the handoff output
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff, detectContinuationIntent, renderHandoffInjection, extractUnfinishedSummary } from '../hook-handoff.mjs';
import { buildSummaryLines } from '../hook-context.mjs';
import { truncate } from '../utils.mjs';

function seedSession(db, id, project) {
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, datetime('now'), ?, 'active')`).run(id, id, project, Date.now());
}

function seedPrompt(db, sessionId, text, num) {
  db.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, datetime('now'), ?)`).run(sessionId, text, num, Date.now());
}

let _epoch = 0;
function seedObs(db, sessionId, project, { title, type = 'change', importance = 1, narrative = null, files = null }) {
  const epoch = Date.now() + (_epoch++);
  db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative,
    created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`)
    .run(sessionId, project, type, title, importance, files, narrative, epoch);
}

function seedSummary(db, sessionId, project, { request, completed, next_steps = '', remaining = '', lessons = null, decisions = null }) {
  db.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed,
    next_steps, remaining_items, files_read, files_edited, notes, lessons, key_decisions, created_at, created_at_epoch)
    VALUES (?, ?, ?, '', '', ?, ?, ?, '[]', '[]', 'fast', ?, ?, datetime('now'), ?)`)
    .run(sessionId, project, request, completed, next_steps, remaining, lessons, decisions, Date.now());
}

/**
 * Simulate what handleSessionStart outputs for CLAUDE.md context.
 * Mirrors hook.mjs lines 699-777 logic.
 */
function simulateSessionStartOutput(db, project, prevClearHandoff) {
  const latestSummary = db.prepare(`
    SELECT request, completed, next_steps, remaining_items, lessons, key_decisions, created_at
    FROM session_summaries WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 1
  `).get(project);

  const summaryLines = buildSummaryLines(latestSummary);

  const keyObs = db.prepare(`
    SELECT id, type, title FROM observations
    WHERE project = ? AND COALESCE(compressed_into, 0) = 0 AND COALESCE(importance, 1) >= 2
    ORDER BY created_at_epoch DESC LIMIT 5
  `).all(project);

  if (keyObs.length > 0) {
    summaryLines.push('### Key Context');
    for (const o of keyObs) {
      summaryLines.push(`- [${o.type}] ${truncate(o.title, 80)} (#${o.id})`);
    }
    summaryLines.push('');
  }

  const handoffLines = [];
  if (prevClearHandoff) {
    handoffLines.push('### Working State (from /clear)');
    if (prevClearHandoff.working_on) handoffLines.push(`- Working on: ${truncate(prevClearHandoff.working_on, 200)}`);
    if (prevClearHandoff.unfinished) {
      const pendingSummary = extractUnfinishedSummary(prevClearHandoff.unfinished);
      if (pendingSummary) handoffLines.push(`- Unfinished: ${truncate(pendingSummary, 200)}`);
    }
    handoffLines.push('');
  }

  return {
    claudeMd: [...summaryLines, ...handoffLines].join('\n'),
    stdout: [...summaryLines, ...handoffLines].join('\n'),
  };
}

// ─── Scenario 1: /exit → new session (normal workflow) ──────────────────────

describe('Scenario 1: /exit → new session', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('user works on feature → /exit → new session sees summary and handoff', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '帮我实现用户认证系统', 1);
    seedPrompt(db, 'sess-1', '加上JWT token刷新', 2);

    seedObs(db, 'sess-1', project, { title: 'Added JWT auth middleware', type: 'feature', importance: 2, files: '["auth.mjs"]' });
    seedObs(db, 'sess-1', project, { title: 'Implemented token refresh flow', type: 'feature', importance: 2, files: '["auth.mjs","token.mjs"]' });
    seedObs(db, 'sess-1', project, { title: 'Fixed CORS header for auth endpoints', type: 'bugfix', importance: 1 });

    // Simulate /exit: handleStop builds handoff + fast summary
    buildAndSaveHandoff(db, 'sess-1', project, 'exit', null);
    seedSummary(db, 'sess-1', project, {
      request: '帮我实现用户认证系统',
      completed: 'Added JWT auth middleware; Implemented token refresh flow; Fixed CORS header',
      next_steps: 'Add integration tests for auth',
      remaining: 'Rate limiting not yet implemented',
    });

    // New session: what does the user see?
    const output = simulateSessionStartOutput(db, project, null);

    // 1. Last Session summary should be visible
    expect(output.claudeMd).toContain('### Last Session');
    expect(output.claudeMd).toContain('认证');
    expect(output.claudeMd).toContain('JWT');

    // 2. Key Context should show high-importance observations
    expect(output.claudeMd).toContain('### Key Context');
    expect(output.claudeMd).toContain('JWT auth middleware');
    expect(output.claudeMd).toContain('token refresh');

    // 3. Low-importance bugfix should NOT appear in Key Context (but may appear in summary Completed line)
    const keyContextSection = output.claudeMd.split('### Key Context')[1] || '';
    expect(keyContextSection).not.toContain('CORS header');

    // 4. No /clear working state (this was a normal /exit)
    expect(output.claudeMd).not.toContain('Working State');
  });

  it('continuation detection works for exit handoff', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', 'implement handoff feature for dispatch', 1);
    seedObs(db, 'sess-1', project, { title: 'Added buildAndSaveHandoff', files: '["hook-handoff.mjs"]' });

    buildAndSaveHandoff(db, 'sess-1', project, 'exit', null);

    // User comes back and mentions related topic
    expect(detectContinuationIntent(db, '我想看看 handoff dispatch 的测试结果', project)).toBe(true);
    // User asks something completely unrelated
    expect(detectContinuationIntent(db, '今天天气怎么样', project)).toBe(false);
  });

  it('handoff injection includes session summary when available', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', 'fix auth bug', 1);
    seedObs(db, 'sess-1', project, { title: 'Fixed null token crash', type: 'bugfix', importance: 2 });

    buildAndSaveHandoff(db, 'sess-1', project, 'exit', null);
    seedSummary(db, 'sess-1', project, {
      request: 'fix auth bug',
      completed: 'Fixed null token crash in refresh flow',
      next_steps: 'Add error boundary for expired tokens',
      remaining: 'Error boundary not implemented',
    });

    const injection = renderHandoffInjection(db, project);
    expect(injection).toContain('<session-handoff');
    expect(injection).toContain('fix auth bug');
    expect(injection).toContain('<session-summary');
    expect(injection).toContain('Fixed null token crash');
    expect(injection).toContain('Remaining: Error boundary not implemented');
    expect(injection).toContain('Next steps: Add error boundary');
  });
});

// ─── Scenario 2: /clear → continue same work ───────────────────────────────

describe('Scenario 2: /clear → continue same work', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('user works on dispatch → /clear → new session sees working state', () => {
    const project = 'mem';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '优化 dispatch 推荐系统', 1);
    seedPrompt(db, 'sess-1', '添加 cooldown 机制', 2);

    seedObs(db, 'sess-1', project, {
      title: 'Added session recommend cap', type: 'feature', importance: 2,
      files: '["dispatch.mjs"]', narrative: 'dispatch.mjs: added SESSION_RECOMMEND_CAP = 3',
    });

    // Episode snapshot: work in progress when /clear happened
    const episodeSnapshot = {
      entries: [
        { desc: 'Edit dispatch.mjs: add cooldown timer', isSignificant: true, isError: false },
        { desc: 'Bash: npx vitest run → 3 tests failed', isSignificant: false, isError: true },
      ],
      files: ['/proj/dispatch.mjs', '/proj/dispatch.test.mjs'],
    };

    // Simulate /clear: handleSessionStart builds handoff
    buildAndSaveHandoff(db, 'sess-1', project, 'clear', episodeSnapshot);

    // Read the clear handoff for downstream
    const prevClearHandoff = db.prepare(
      'SELECT working_on, unfinished, key_files FROM session_handoffs WHERE project = ? AND type = ?'
    ).get(project, 'clear');

    const output = simulateSessionStartOutput(db, project, prevClearHandoff);

    // 1. Working State block should exist
    expect(output.claudeMd).toContain('### Working State (from /clear)');
    expect(output.claudeMd).toContain('优化 dispatch');

    // 2. Unfinished should show actual pending work
    expect(output.claudeMd).toContain('Unfinished');
    expect(output.claudeMd).toContain('cooldown timer');
    expect(output.claudeMd).toContain('tests failed');
  });

  it('short prompt after /clear auto-detects continuation', () => {
    const project = 'mem';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '修复 dispatch 测试', 1);
    buildAndSaveHandoff(db, 'sess-1', project, 'clear', null);

    // Short prompts → assume continuation
    expect(detectContinuationIntent(db, '继续', project)).toBe(true);
    expect(detectContinuationIntent(db, 'ok', project)).toBe(true);
    expect(detectContinuationIntent(db, '开始吧', project)).toBe(true);
  });

  it('P2-1: long unrelated prompt after /clear does NOT inject old context', () => {
    const project = 'mem';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '修复 dispatch scoring 问题', 1);
    seedObs(db, 'sess-1', project, { title: 'Fixed dispatch scoring', files: '["dispatch.mjs"]' });
    buildAndSaveHandoff(db, 'sess-1', project, 'clear', null);

    // Long prompt about completely different topic → should NOT inject stale dispatch context
    const unrelatedPrompt = 'I want to create a new React dashboard with charts for monitoring user engagement metrics across all platforms';
    expect(detectContinuationIntent(db, unrelatedPrompt, project)).toBe(false);

    // But if the prompt mentions dispatch-related terms → should detect continuation
    const relatedPrompt = 'Let me check the dispatch scoring results and see if the FTS5 search is working correctly now';
    expect(detectContinuationIntent(db, relatedPrompt, project)).toBe(true);
  });
});

// ─── Scenario 3: P1-2 — completed bugfixes not shown as unfinished ─────────

describe('Scenario 3: completed bugfixes', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('P1-2: session with resolved bugfixes → /exit → no misleading Unfinished', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '修复三个 bug', 1);

    // All bugfixes are completed (in observations = they were resolved)
    seedObs(db, 'sess-1', project, { title: 'Fixed null pointer in auth.mjs', type: 'bugfix', importance: 2 });
    seedObs(db, 'sess-1', project, { title: 'Fixed race condition in session init', type: 'bugfix', importance: 2 });
    seedObs(db, 'sess-1', project, { title: 'Fixed memory leak in cache', type: 'bugfix', importance: 1 });

    // /exit with no pending episode
    buildAndSaveHandoff(db, 'sess-1', project, 'exit', null);

    const injection = renderHandoffInjection(db, project);
    // Completed section should list the bugfixes
    expect(injection).toContain('## Completed');
    expect(injection).toContain('null pointer');
    expect(injection).toContain('race condition');

    // Unfinished section should NOT appear (no pending work)
    expect(injection).not.toContain('## Unfinished');
  });

  it('bugfix errors in episode snapshot DO appear as unfinished', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '修复测试失败', 1);

    seedObs(db, 'sess-1', project, { title: 'Investigating test failures', type: 'discovery', importance: 1 });

    // Episode has unresolved errors
    const episodeSnapshot = {
      entries: [
        { desc: 'Bash: vitest run → TypeError: Cannot read undefined', isSignificant: false, isError: true },
      ],
      files: ['/proj/test.mjs'],
    };

    buildAndSaveHandoff(db, 'sess-1', project, 'clear', episodeSnapshot);

    const injection = renderHandoffInjection(db, project);
    // Actual errors in episode SHOULD appear as unfinished
    expect(injection).toContain('## Unfinished');
    expect(injection).toContain('TypeError');
  });
});

// ─── Scenario 4: narrative-only unfinished (no pending work) ────────────────

describe('Scenario 4: narrative history separation', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('observations with narratives but no pending work → no Unfinished section', () => {
    const project = 'mem';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', 'code review dispatch.mjs', 1);

    // Observations with rich narratives (all completed work)
    seedObs(db, 'sess-1', project, {
      title: 'Modified dispatch.mjs', type: 'change', importance: 1,
      narrative: 'dispatch.mjs: "score * decay" → "score * -decay"',
    });
    seedObs(db, 'sess-1', project, {
      title: 'Modified hook.mjs', type: 'change', importance: 1,
      narrative: 'hook.mjs: added truncate import',
    });

    // /exit with no episode snapshot (all work is completed)
    buildAndSaveHandoff(db, 'sess-1', project, 'exit', null);

    const injection = renderHandoffInjection(db, project);

    // Narratives should be stored in DB (for keyword matching)
    const handoff = db.prepare(`SELECT unfinished FROM session_handoffs WHERE project = ?`).get(project);
    expect(handoff.unfinished).toContain('score * -decay');
    expect(handoff.unfinished).toContain('truncate import');

    // But NOT shown as Unfinished in injection (narratives = completed work, not pending)
    expect(injection).not.toContain('## Unfinished');
    // Completed section should show the work
    expect(injection).toContain('## Completed');
    expect(injection).toContain('Modified dispatch.mjs');
  });

  it('pending work + narratives → only pending shown as Unfinished', () => {
    const project = 'mem';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', 'refactor and test dispatch', 1);

    seedObs(db, 'sess-1', project, {
      title: 'Refactored dispatch scoring', type: 'refactor', importance: 1,
      narrative: 'dispatch.mjs: extracted scoringFunction()',
    });

    const episodeSnapshot = {
      entries: [
        { desc: 'Edit dispatch.test.mjs: add scoring tests', isSignificant: true, isError: false },
        { desc: 'Bash: vitest → 2 tests failed', isSignificant: false, isError: true },
      ],
      files: ['/proj/dispatch.test.mjs'],
    };

    buildAndSaveHandoff(db, 'sess-1', project, 'clear', episodeSnapshot);

    const injection = renderHandoffInjection(db, project);

    // Pending work (episode) should appear as Unfinished
    expect(injection).toContain('## Unfinished');
    expect(injection).toContain('scoring tests');
    expect(injection).toContain('tests failed');

    // Narrative history should NOT appear in Unfinished
    expect(injection).not.toContain('scoringFunction');
  });
});

// ─── Scenario 5: P3-3 — fast summary → LLM upgrade (no duplicates) ─────────

describe('Scenario 5: fast summary deduplication', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('fast summary is the baseline; LLM summary should upgrade it', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);

    // handleStop creates fast summary
    seedSummary(db, 'sess-1', project, {
      request: '实现用户认证', completed: 'Added JWT middleware',
    });

    // Verify fast summary exists
    const summaries1 = db.prepare(`SELECT * FROM session_summaries WHERE memory_session_id = ?`).all('sess-1');
    expect(summaries1.length).toBe(1);
    expect(summaries1[0].notes).toBe('fast');

    // Simulate LLM summary upgrade (what handleLLMSummary does)
    const existingFast = db.prepare(`
      SELECT id FROM session_summaries WHERE memory_session_id = ? AND notes = 'fast' LIMIT 1
    `).get('sess-1');
    expect(existingFast).toBeTruthy();

    db.prepare(`
      UPDATE session_summaries
      SET request=?, completed=?, next_steps=?, remaining_items=?, notes='llm', created_at_epoch=?
      WHERE id = ?
    `).run('Implementing JWT authentication system', 'JWT auth middleware with refresh tokens', 'Add integration tests', 'Rate limiting', Date.now(), existingFast.id);

    // After upgrade: should be exactly 1 summary, not 2
    const summaries2 = db.prepare(`SELECT * FROM session_summaries WHERE memory_session_id = ?`).all('sess-1');
    expect(summaries2.length).toBe(1);
    expect(summaries2[0].notes).toBe('llm');
    expect(summaries2[0].request).toBe('Implementing JWT authentication system');

    // buildSummaryLines should use the upgraded content
    const lines = buildSummaryLines(summaries2[0]);
    const text = lines.join('\n');
    expect(text).toContain('JWT authentication system');
    expect(text).not.toContain('实现用户认证'); // fast version replaced
  });
});

// ─── Scenario 6: /exit → long gap → new session ────────────────────────────

describe('Scenario 6: exit handoff expiry', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('exit handoff stays available for 7 days', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', 'implement caching layer', 1);
    seedObs(db, 'sess-1', project, { title: 'Added Redis cache', type: 'feature', importance: 2 });

    buildAndSaveHandoff(db, 'sess-1', project, 'exit', null);

    // Manually age the handoff to 5 days
    db.prepare(`UPDATE session_handoffs SET created_at_epoch = ? WHERE project = ?`)
      .run(Date.now() - 5 * 86400000, project);

    // Still valid at 5 days
    const injection = renderHandoffInjection(db, project);
    expect(injection).not.toBeNull();
    expect(injection).toContain('Redis cache');

    // Continuation detection still works
    expect(detectContinuationIntent(db, 'how is the caching layer doing?', project)).toBe(true);
  });

  it('exit handoff expires after 7 days', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', 'implement caching layer', 1);
    buildAndSaveHandoff(db, 'sess-1', project, 'exit', null);

    // Age to 8 days
    db.prepare(`UPDATE session_handoffs SET created_at_epoch = ? WHERE project = ?`)
      .run(Date.now() - 8 * 86400000, project);

    expect(renderHandoffInjection(db, project)).toBeNull();
    expect(detectContinuationIntent(db, 'how is the caching layer doing?', project)).toBe(false);
  });

  it('clear handoff expires after 6 hours', () => {
    const project = 'my-app';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', 'fix tests', 1);
    buildAndSaveHandoff(db, 'sess-1', project, 'clear', null);

    // Age to 7 hours
    db.prepare(`UPDATE session_handoffs SET created_at_epoch = ? WHERE project = ? AND type = 'clear'`)
      .run(Date.now() - 7 * 3600000, project);

    expect(renderHandoffInjection(db, project)).toBeNull();
    // Short prompt should NOT auto-continue after expiry
    expect(detectContinuationIntent(db, 'ok', project)).toBe(false);
  });
});

// ─── Scenario 7: CLAUDE.md context size ─────────────────────────────────────

describe('Scenario 7: context size efficiency', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('CLAUDE.md context stays concise (< 2000 chars)', () => {
    const project = 'mem';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '优化 dispatch 系统', 1);

    // Lots of work done
    for (let i = 0; i < 10; i++) {
      seedObs(db, 'sess-1', project, {
        title: `Modified file-${i}.mjs with complex refactoring changes`,
        type: i % 2 === 0 ? 'change' : 'refactor',
        importance: i < 3 ? 2 : 1,
        narrative: `file-${i}.mjs: rewrote scoring logic for better performance`,
      });
    }

    seedSummary(db, 'sess-1', project, {
      request: '优化 dispatch 系统的性能和准确性',
      completed: 'Refactored scoring in 10 files; Added performance tests',
      next_steps: 'Run benchmark suite to validate improvements',
      remaining: 'Benchmark comparison not done yet',
      lessons: JSON.stringify(['FTS5 BM25 weights affect recall more than precision']),
      decisions: JSON.stringify(['Chose greedy knapsack over dynamic programming for token budget']),
    });

    const episodeSnapshot = {
      entries: [{ desc: 'Running benchmarks', isSignificant: true, isError: false }],
      files: ['/proj/dispatch.mjs'],
    };
    buildAndSaveHandoff(db, 'sess-1', project, 'clear', episodeSnapshot);

    const prevClearHandoff = db.prepare(
      'SELECT working_on, unfinished, key_files FROM session_handoffs WHERE project = ? AND type = ?'
    ).get(project, 'clear');

    const output = simulateSessionStartOutput(db, project, prevClearHandoff);

    // Should be concise enough for CLAUDE.md (not bloated with narratives)
    expect(output.claudeMd.length).toBeLessThan(2000);

    // Should contain the essential info
    expect(output.claudeMd).toContain('Last Session');
    expect(output.claudeMd).toContain('dispatch');
    expect(output.claudeMd).toContain('Key Context');
    expect(output.claudeMd).toContain('Working State');
  });
});

// ─── Scenario 8: CJK prompt continuation detection ─────────────────────────

describe('Scenario 8: CJK continuation detection', () => {
  let db;
  beforeEach(() => { db = createTestDb(); _epoch = 0; });
  afterEach(() => db.close());

  it('Chinese continuation keywords always work', () => {
    const project = 'test';
    // No handoff needed — explicit keywords always match
    expect(detectContinuationIntent(db, '继续', project)).toBe(true);
    expect(detectContinuationIntent(db, '接着干', project)).toBe(true);
    expect(detectContinuationIntent(db, '上次的工作', project)).toBe(true);
    expect(detectContinuationIntent(db, '之前的任务怎么样了', project)).toBe(true);
  });

  it('short CJK prompts after /clear assume continuation', () => {
    const project = 'test';
    seedSession(db, 'sess-1', project);
    seedPrompt(db, 'sess-1', '修复数据库连接问题', 1);
    buildAndSaveHandoff(db, 'sess-1', project, 'clear', null);

    // Short CJK prompts (< 40 chars) → assume continuation
    expect(detectContinuationIntent(db, '好的', project)).toBe(true);
    expect(detectContinuationIntent(db, '开始', project)).toBe(true);
    expect(detectContinuationIntent(db, '看看效果', project)).toBe(true);
  });
});
