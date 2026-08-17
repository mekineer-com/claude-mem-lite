// SessionStart stdout must be EXACTLY ONE JSON envelope.
//
// hook.mjs session-start had three independent writers on one stdout: the
// startup-dashboard envelope, a raw <claude-mem-context> block, and the
// update banner. The result is a stdout that is not a single JSON document,
// and the observed consequence in a live Claude Code session (2026-08-17) is
// that the envelope is NOT parsed: the session shows
//
//   SessionStart:startup hook success: {"suppressOutput":true,"hookSpecificOutput":{…}}
//
// i.e. the raw JSON — escaped newlines and all — delivered to the model as
// literal text, with suppressOutput:true ignored. The same product's PreToolUse
// and PostToolUse hooks, which emit an envelope and nothing else, render as
// `hook additional context:` with the content extracted. One writer parses,
// three writers do not.
//
// Merging is also strictly safer under the line-based reading of the contract
// (tests/feature-sweep-hooks.test.mjs::expectHookStdout): one envelope on one
// line satisfies both models, mixed output only satisfies one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const HOOK_PATH = resolve(import.meta.dirname, '../hook.mjs');
let tmpHome, projDir, dbPath, runtimeDir, env;

function runSessionStart(sessionId, extraEnv = {}) {
  try {
    return execFileSync(process.execPath, [HOOK_PATH, 'session-start'], {
      input: JSON.stringify({ session_id: sessionId, source: 'startup', cwd: projDir }),
      timeout: 20000, encoding: 'utf8',
      env: { ...env, HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return e.stdout || '';
  }
}

/** The assertion the old shape fails: stdout parses as ONE JSON document. */
function expectSingleEnvelope(stdout) {
  const trimmed = stdout.trim();
  expect(trimmed, 'expected SessionStart to emit something').not.toBe('');
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `SessionStart stdout is not one JSON document — the host falls back to plain text `
      + `and the envelope reaches the model as raw JSON:\n${stdout.slice(0, 600)}`,
      { cause: e },
    );
  }
  expect(parsed.suppressOutput).toBe(true);
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string');
  return parsed;
}

function seedObservation(text, title) {
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare(`INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
              VALUES ('seed-cc', 'seed-mem', 'work--fresh', ?, ?, 'active')`)
    .run(new Date(now).toISOString(), now);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts,
                              facts, files_read, files_modified, importance, created_at, created_at_epoch)
    VALUES ('seed-mem', 'work--fresh', ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 3, ?, ?)
  `).run(text, title, new Date(now).toISOString(), now);
  db.close();
}

describe('SessionStart stdout envelope', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-ssenv-'));
    projDir = join(tmpHome, 'work', 'fresh');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(tmpHome, '.claude-mem-lite');
    runtimeDir = join(dbDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    dbPath = join(dbDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.close();

    env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
    }
    Object.assign(env, {
      CLAUDE_CODE_PATH: join(tmpHome, 'no-such-claude-binary'),
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
      MEM_NO_AUTO_ADOPT: '1',
    });
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('emits one JSON document when the memory block and the dashboard both have content', () => {
    seedObservation('Retry budget was shared across shards so one hot shard starved the rest',
      'Retry budget was shared across shards');
    const stdout = runSessionStart('cc-env-1');
    const parsed = expectSingleEnvelope(stdout);
    // Both surfaces must survive the merge — this is a delivery-channel change,
    // not a content change.
    expect(parsed.hookSpecificOutput.additionalContext).toContain('<claude-mem-context>');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('</claude-mem-context>');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Retry budget was shared across shards');
  });

  it('carries the startup dashboard in the same envelope, not a second write', () => {
    seedObservation('Backoff reset on every redirect hop', 'Backoff reset on every redirect hop');
    const stdout = runSessionStart('cc-env-2');
    const parsed = expectSingleEnvelope(stdout);
    // One document ⇒ exactly one line that parses as JSON.
    const jsonLines = stdout.split('\n').filter((l) => {
      if (!l.trim()) return false;
      try { JSON.parse(l); return true; } catch { return false; }
    });
    expect(jsonLines).toHaveLength(1);
    // Pin the DASHBOARD leg by content, not by "additionalContext is non-empty":
    // deleting the dashboard push left this green because the <claude-mem-context>
    // block alone satisfied a length check (pre-tag review, SHOULD-FIX-3).
    // `mem events` is the dashboard's own line, absent from the context block.
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/\[mem\] Startup dashboard|mem events:/);
  });

  it('folds the update banner in too, instead of appending raw text after the envelope', () => {
    seedObservation('Shard rebalance dropped the last write', 'Shard rebalance dropped the last write');
    writeFileSync(join(runtimeDir, 'update-state.json'), JSON.stringify({
      lastCheck: new Date().toISOString(),
      latestVersion: '99.0.0',
      updateAvailable: true,
    }));
    const stdout = runSessionStart('cc-env-3', { CLAUDE_MEM_SKIP_UPDATE: '' });
    const parsed = expectSingleEnvelope(stdout);
    // Pin the BANNER leg by content. Asserting only single-envelope-ness left the
    // banner unguarded anywhere in the repo, and the banner is the one contributor
    // this release physically relocated — from a raw write at the end of
    // handleSessionStart to a queued part ~90 lines earlier (SHOULD-FIX-2).
    expect(parsed.hookSpecificOutput.additionalContext).toContain('99.0.0');
  });

  it('stays silent when there is nothing to say (no empty envelope)', () => {
    const stdout = runSessionStart('cc-env-4');
    if (stdout.trim()) {
      // A dashboard line is legitimate on an empty DB; a bare wrapper is not.
      const parsed = expectSingleEnvelope(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain('<claude-mem-context>');
    }
  });

  it('never emits a JSON envelope that does not start its own line', () => {
    seedObservation('Cache stampede on cold start', 'Cache stampede on cold start');
    const stdout = runSessionStart('cc-env-5');
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      expect(
        /^[^{].*[{,]\s*"(?:suppressOutput|hookSpecificOutput)"/.test(line),
        `envelope is not at the start of its line:\n${line}`,
      ).toBe(false);
    }
  });
});
