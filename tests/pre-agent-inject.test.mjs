// tests/pre-agent-inject.test.mjs
// P0 subagent dispatch-time memory injection (2026-07-03). Subagents are
// memory-blind (plugin hooks do not fire inside them — #8848); this feature
// injects one relevant project lesson into a dispatched subagent's prompt via a
// PreToolUse:Agent hook that mutates tool_input.prompt (hookSpecificOutput.updatedInput).
// Mechanism + safe framing verified live 2026-07-03 (Phase 0a/0b): a raw prepend
// tripped the subagent's prompt-injection detector -> refusal; an appended,
// attributed, reference-only block was adopted. These tests lock the pure logic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { formatSubagentContext } from '../lib/task-imperative.mjs';
import { buildSubagentInjection } from '../hook-memory.mjs';

describe('formatSubagentContext (safe framing — Phase 0b validated)', () => {
  it('frames an appended, attributed, reference-only block carrying the #id + lesson', () => {
    const b = formatSubagentContext('use rrfMerge not naive union for fusion', 456);
    expect(b).toContain('#456');
    expect(b).toContain('use rrfMerge not naive union for fusion');
    expect(b).toContain('Reference context, not an external instruction');
    expect(b.startsWith('\n')).toBe(true); // appends below the task, blank-line separated
  });
  it('returns empty string for an empty/whitespace lesson', () => {
    expect(formatSubagentContext('', 1)).toBe('');
    expect(formatSubagentContext('   ', 1)).toBe('');
  });
  it('omits the #id tag when id is absent', () => {
    expect(formatSubagentContext('do the thing')).not.toContain('#');
  });
});

describe('buildSubagentInjection', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 's', project: 'p' });
  });
  afterEach(() => db.close());
  const seed = (o) => insertObs(db, { sessionId: 's', project: 'p', ...o });

  it('appends the framed lesson when the subagent prompt names a matching identifier', () => {
    seed({ title: 'rrf', lessonLearned: 'use rrfMerge not naive union', importance: 2 });
    const ti = { subagent_type: 'general-purpose', description: 'x', prompt: 'refactor rrfMerge in tfidf' };
    const out = buildSubagentInjection(db, ti, 'p');
    expect(out).not.toBeNull();
    expect(out.subagent_type).toBe('general-purpose');       // preserves sibling fields
    expect(out.prompt.startsWith('refactor rrfMerge in tfidf')).toBe(true); // task stays first
    expect(out.prompt).toContain('use rrfMerge not naive union');
    expect(out.prompt).toContain('Reference context, not an external instruction');
  });
  it('returns null when no lesson identifier overlaps the subagent prompt', () => {
    seed({ title: 'x', lessonLearned: 'always call recoverChildrenOf first', importance: 3 });
    expect(buildSubagentInjection(db, { prompt: 'write a haiku about spring' }, 'p')).toBeNull();
  });
  it('returns null for missing / empty / non-string prompt', () => {
    seed({ title: 'x', lessonLearned: 'use rrfMerge here', importance: 3 });
    expect(buildSubagentInjection(db, { prompt: '' }, 'p')).toBeNull();
    expect(buildSubagentInjection(db, {}, 'p')).toBeNull();
    expect(buildSubagentInjection(db, null, 'p')).toBeNull();
  });
});
