// A session's follow-up prompts are not a resume of ANOTHER session (E2E round 2026-09-29).
//
// detectContinuationIntent counted the session's OWN exit handoff (written by its own previous
// Stop) as resume evidence — the HEAD anchor's `(type = 'exit' OR session_id = ?)`, the <40-char
// shortcut, the keyword stage's `OR type = 'exit'` — while pickHandoffToInject excludes own exit
// rows and returns the newest unconsumed exit of any OTHER session. Detect and pick disagreed on
// the population, so inside the 3-prompt window:
//   - `继续` resumed session X, and the next `ok do it` injected (and consumed) session Y's
//     handoff — one unrelated session per short follow-up;
//   - a session that started a NEW task got yesterday's handoff on `also add a usage example`;
//   - `claude --resume` of R injected Q's handoff on `now add the tests`.
// Now: one resume per session, and once the session has ended a turn of its own only an
// explicit reference to a past session resumes one — a bare 继续 / continue then means "go on".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { detectContinuationIntent } from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';

const SHA = 'a'.repeat(40);
let db;

beforeEach(() => {
  vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
    changed: [],
    stashes: [],
    branch: 'main',
    headSha: SHA,
  });
  db = createTestDb();
  insertSession(db, { id: 'mem-z', project: 'p' });
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const handoff = (sessionId, { ageMs, consumedAt = null, keywords = 'echo feature csv export' }) =>
  db
    .prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, match_keywords, git_sha_at_handoff,
         created_at_epoch, consumed_at) VALUES ('p', 'exit', ?, 'task', ?, ?, ?, ?)`,
    )
    .run(sessionId, keywords, SHA, Date.now() - ageMs, consumedAt);
const prompt = (text, epoch) =>
  db
    .prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
       VALUES ('mem-z', ?, 1, 'Z', ?, ?)`,
    )
    .run(text, new Date(epoch).toISOString(), epoch);
const detect = (text) => detectContinuationIntent(db, text, 'p', 'Z');

describe('a session does not resume another one on its follow-ups', () => {
  it('premise: the first prompt of a session still resumes (short prompt at an unmoved HEAD, or 继续)', () => {
    handoff('Y', { ageMs: 3600000 });
    prompt('ok', Date.now());
    expect(detect('ok')).toBe(true);
    expect(detect('继续')).toBe(true);
  });

  it('after one resume in this session, nothing resumes again (the d2-chain walk)', () => {
    const t0 = Date.now() - 60000;
    prompt('继续', t0);
    handoff('Y', { ageMs: 86400000 });
    handoff('X', { ageMs: 7200000, consumedAt: t0 + 1000 }); // injected on the first prompt
    handoff('Z', { ageMs: 1000 }); // Z's own Stop
    expect(detect('ok do it')).toBe(false);
    expect(detect('继续')).toBe(false);
  });

  it('one resume per session even before its first Stop (a queued second prompt)', () => {
    const t0 = Date.now() - 60000;
    prompt('继续', t0);
    handoff('Y', { ageMs: 86400000 });
    handoff('X', { ageMs: 7200000, consumedAt: t0 + 1000 }); // injected on prompt 1, no Stop yet
    expect(detect('继续')).toBe(false);
  });

  it('a session that started a new task gets no handoff on a short follow-up', () => {
    prompt('Write a README section FOXTROT_DOCS that documents the listTodos function', Date.now() - 60000);
    handoff('Y', { ageMs: 86400000 });
    handoff('Z', { ageMs: 1000 });
    expect(detect('also add a usage example')).toBe(false);
    expect(detect('now add the tests')).toBe(false);
    expect(detect('继续')).toBe(false); // mid-session 继续 = go on
    expect(detect('continue')).toBe(false);
  });

  it('an explicit reference to a past session still resumes after a turn', () => {
    prompt('hi', Date.now() - 60000);
    handoff('Y', { ageMs: 86400000 });
    handoff('Z', { ageMs: 1000 });
    expect(detect('pick up where we left off last session')).toBe(true);
    expect(detect('继续上次的工作')).toBe(true);
  });
});
