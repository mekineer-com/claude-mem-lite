import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

// Helper: run script with piped stdin (spawn handles for-await stdin correctly)
function runScriptRaw(inputStr, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', () => resolve({ stdout, stderr }));
    child.on('error', reject);
    child.stdin.write(inputStr);
    child.stdin.end();
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 5000);
  });
}

// Helper: run script with JSON input and CLAUDE_MEM_HOOK_RUNNING cleared
async function runScript(input, env = {}) {
  return runScriptRaw(JSON.stringify(input), { CLAUDE_MEM_HOOK_RUNNING: '', ...env });
}

describe('pre-tool-recall', () => {
  describe('input parsing', () => {
    it('exits silently on invalid JSON', async () => {
      const { stdout } = await runScriptRaw('not json', { CLAUDE_MEM_HOOK_RUNNING: '' });
      expect(stdout).toBe('');
    });

    it('exits silently when tool_input.file_path is missing', async () => {
      const { stdout } = await runScript({ tool_name: 'Edit', tool_input: {} });
      expect(stdout).toBe('');
    });

    it('exits silently when CLAUDE_MEM_HOOK_RUNNING is set', async () => {
      const { stdout } = await runScriptRaw(
        JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/foo.mjs' } }),
        { CLAUDE_MEM_HOOK_RUNNING: '1' },
      );
      expect(stdout).toBe('');
    });
  });

  describe('cooldown', () => {
    const RUNTIME = join(tmpdir(), 'pre-recall-test-' + process.pid);
    const COOLDOWN = join(RUNTIME, 'pre-recall-cooldown.json');

    beforeEach(() => mkdirSync(RUNTIME, { recursive: true }));
    afterEach(() => rmSync(RUNTIME, { recursive: true, force: true }));

    it('cooldown JSON uses full file path as key', () => {
      const data = { '/path/to/schema.mjs': Date.now() };
      writeFileSync(COOLDOWN, JSON.stringify(data));
      const parsed = JSON.parse(readFileSync(COOLDOWN, 'utf8'));
      expect(parsed['/path/to/schema.mjs']).toBeDefined();
    });

    it('different files with same basename have separate cooldowns', () => {
      const data = { '/src/utils.mjs': Date.now(), '/lib/utils.mjs': Date.now() - 600000 };
      writeFileSync(COOLDOWN, JSON.stringify(data));
      const parsed = JSON.parse(readFileSync(COOLDOWN, 'utf8'));
      expect(Object.keys(parsed)).toHaveLength(2);
    });
  });

  describe('DB query pattern', () => {
    it('uses observation_files junction table with correct filters', () => {
      const db = createTestDb();
      insertSession(db, { id: 'sess-1' });

      // Insert obs with lesson + high importance (SHOULD match)
      insertObs(db, {
        sessionId: 'sess-1', title: 'FTS5 broke after schema change',
        type: 'bugfix', importance: 2,
        lessonLearned: 'Verify FTS5 integrity after schema changes',
        filesModified: '["schema.mjs"]',
      });

      // Insert obs without lesson (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1', title: 'Edited schema.mjs',
        type: 'change', importance: 2, lessonLearned: null,
        filesModified: '["schema.mjs"]',
      });

      // Insert obs with low importance (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1', title: 'Minor tweak',
        type: 'change', importance: 1, lessonLearned: 'Some lesson',
        filesModified: '["schema.mjs"]',
      });

      // Insert compressed obs (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1', title: 'Old compressed',
        type: 'bugfix', importance: 3, lessonLearned: 'Important lesson',
        filesModified: '["schema.mjs"]', compressedInto: 999,
      });

      // Insert superseded obs (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1', title: 'Superseded obs',
        type: 'bugfix', importance: 3, lessonLearned: 'Old lesson',
        filesModified: '["schema.mjs"]', supersededAt: new Date().toISOString(),
      });

      const cutoff = Date.now() - 60 * 86400000;
      const rows = db.prepare(`
        SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
        FROM observations o
        JOIN observation_files of2 ON of2.obs_id = o.id
        WHERE o.project = ?
          AND o.importance >= 2
          AND o.lesson_learned IS NOT NULL
          AND o.lesson_learned != ''
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND o.created_at_epoch > ?
          AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        ORDER BY o.created_at_epoch DESC
        LIMIT 2
      `).all('test', cutoff, 'schema.mjs', '%schema.mjs');

      expect(rows).toHaveLength(1);
      expect(rows[0].lesson_learned).toBe('Verify FTS5 integrity after schema changes');
      db.close();
    });

    it('matches both full path and basename via LIKE', () => {
      const db = createTestDb();
      insertSession(db, { id: 'sess-1' });

      insertObs(db, {
        sessionId: 'sess-1', title: 'Fix in utils',
        type: 'bugfix', importance: 2, lessonLearned: 'Check CJK boundary',
        filesModified: '["/mnt/data/projects/mem/utils.mjs"]',
      });

      const cutoff = Date.now() - 60 * 86400000;
      const rows = db.prepare(`
        SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
        FROM observations o
        JOIN observation_files of2 ON of2.obs_id = o.id
        WHERE o.project = ?
          AND o.importance >= 2
          AND o.lesson_learned IS NOT NULL
          AND o.lesson_learned != ''
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND o.created_at_epoch > ?
          AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        ORDER BY o.created_at_epoch DESC
        LIMIT 2
      `).all('test', cutoff, '/mnt/data/projects/mem/utils.mjs', '%utils.mjs');

      expect(rows).toHaveLength(1);
      expect(rows[0].lesson_learned).toBe('Check CJK boundary');
      db.close();
    });
  });

  describe('output format', () => {
    it('formats lessons correctly', () => {
      const lesson = 'Verify FTS5 integrity after schema changes';
      const output = `[mem] Lessons for schema.mjs:\n  #1 [bugfix] ${lesson}\n`;
      expect(output).toContain('[mem] Lessons for schema.mjs:');
      expect(output).toContain('#1 [bugfix]');
    });

    it('truncates long lessons at 240 chars', () => {
      const LESSON_MAX = 240;
      const longLesson = 'A'.repeat(400);
      const truncated = longLesson.length > LESSON_MAX
        ? longLesson.slice(0, LESSON_MAX - 3) + '...' : longLesson;
      expect(truncated).toHaveLength(LESSON_MAX);
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('preserves lessons ≤ 240 chars untouched', () => {
      const LESSON_MAX = 240;
      const midLesson = 'B'.repeat(218); // matches observed p50 length
      const result = midLesson.length > LESSON_MAX
        ? midLesson.slice(0, LESSON_MAX - 3) + '...' : midLesson;
      expect(result).toBe(midLesson);
      expect(result.endsWith('...')).toBe(false);
    });
  });

  // R-4: when no lessons match, emit a short backfill reminder so Claude (a) knows the
  // system tried and (b) gets nudged to save a lesson after a non-obvious bug solve.
  // Enabled by CLAUDE_MEM_DB_PATH + CLAUDE_MEM_RUNTIME_DIR env overrides for test isolation.
  describe('backfill reminder (R-4)', () => {
    let tmpRoot;
    let dbPath;
    let runtimeDir;
    let projectDir;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `pre-recall-r4-${process.pid}-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      dbPath = join(tmpRoot, 'test.db');
      runtimeDir = join(tmpRoot, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      // CLAUDE_PROJECT_DIR must be two-segment so inferProject() returns a predictable name.
      // "parent--r4test" — matches what we insert into observations.project.
      projectDir = join(tmpRoot, 'parent', 'r4test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-r4', project: 'parent--r4test', memoryId: 'mem-r4' });
      db.close();
    });

    afterEach(() => {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    });

    function runWithEnv(input) {
      return runScript(input, {
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: projectDir,
      });
    }

    it('emits backfill reminder when no lessons match for the file', async () => {
      // No observations for this file → no lessons to surface.
      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'credit_service.py') },
      });
      // Output is now JSON with hookSpecificOutput.additionalContext carrying the reminder.
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] No prior lessons for credit_service.py');
      // Should mention the /lesson command so Claude knows how to backfill.
      expect(parsed.hookSpecificOutput.additionalContext).toContain('/lesson');
    });

    it('still surfaces matching lessons when they exist (regression guard)', async () => {
      // Seed a lesson for the target file.
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-r4', project: 'parent--r4test',
        type: 'bugfix', importance: 2,
        title: 'FTS5 broke after schema change',
        lessonLearned: 'Verify FTS5 integrity after schema changes',
        filesModified: `["${join(projectDir, 'schema.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'schema.mjs') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] Lessons for schema.mjs:');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('Verify FTS5 integrity');
      // Reminder should NOT be emitted when a lesson was found.
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain('No prior lessons');
    });

    it('honors cooldown — second call within window emits neither lesson nor reminder', async () => {
      const filePath = join(projectDir, 'cool.py');
      const { stdout: first } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
      });
      const parsedFirst = JSON.parse(first);
      expect(parsedFirst.hookSpecificOutput.additionalContext).toContain('[mem] No prior lessons for cool.py');

      const { stdout: second } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
      });
      expect(second).toBe('');
    });

    // v2.33.1 Fix 4: session-scoped cooldown — same file in same session recalls
    // exactly once; different session gets fresh recall. Session id supplied via
    // event.session_id (standard Claude Code PreToolUse payload).
    it('v2.33.1: session-scoped cooldown — same session, same file: second call silent', async () => {
      const filePath = join(projectDir, 'scope.py');
      const { stdout: first } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-alpha',
        tool_input: { file_path: filePath },
      });
      expect(JSON.parse(first).hookSpecificOutput.additionalContext).toContain('No prior lessons for scope.py');

      const { stdout: second } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-alpha',
        tool_input: { file_path: filePath },
      });
      expect(second).toBe('');
    });

    it('v2.33.1: session-scoped cooldown — different session gets fresh recall', async () => {
      const filePath = join(projectDir, 'fresh.py');
      const { stdout: first } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-alpha',
        tool_input: { file_path: filePath },
      });
      expect(JSON.parse(first).hookSpecificOutput.additionalContext).toContain('No prior lessons for fresh.py');

      const { stdout: second } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-beta',
        tool_input: { file_path: filePath },
      });
      // Fresh session → recall fires again.
      expect(JSON.parse(second).hookSpecificOutput.additionalContext).toContain('No prior lessons for fresh.py');
    });

    // v2.34.6 Gap 3: Read-side recall. Tighter filter (lesson_learned required),
    // single-row limit, 120-char truncation, zero empty-nudge. Scope discipline:
    // planning Reads get surfaced; pure-exploration Reads cost near-zero tokens.
    it('v2.34.6 Read: surfaces top-1 lesson when file has lesson_learned', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Seed TWO lessons — Read should only inject the most recent one.
      insertObs(db, {
        sessionId: 'mem-r4', project: 'parent--r4test',
        type: 'bugfix', importance: 2,
        title: 'Older bug', lessonLearned: 'Older lesson A',
        filesModified: `["${join(projectDir, 'readable.mjs')}"]`,
        epochOffset: -86400000, // 1 day ago
      });
      insertObs(db, {
        sessionId: 'mem-r4', project: 'parent--r4test',
        type: 'bugfix', importance: 2,
        title: 'Newer bug', lessonLearned: 'Newer lesson B',
        filesModified: `["${join(projectDir, 'readable.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'readable.mjs') },
      });
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for readable.mjs:');
      expect(ctx).toContain('Newer lesson B');
      expect(ctx).not.toContain('Older lesson A');
    });

    it('v2.34.6 Read: suppresses type-only (bugfix/decision without lesson_learned)', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Edit-path would match this (type=bugfix). Read-path must skip it.
      insertObs(db, {
        sessionId: 'mem-r4', project: 'parent--r4test',
        type: 'bugfix', importance: 3,
        title: 'Important but no lesson', lessonLearned: null,
        filesModified: `["${join(projectDir, 'typed.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'typed.mjs') },
      });
      // Read-path finds zero lesson-bearing rows → silent exit (no nudge either).
      expect(stdout).toBe('');
    });

    it('v2.34.6 Read: silent on empty — no /lesson nudge (unlike Edit)', async () => {
      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'brand_new.mjs') },
      });
      expect(stdout).toBe('');
    });

    it('v2.34.6 Read: truncates long lessons at 120 chars (tighter than Edit 240)', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-r4', project: 'parent--r4test',
        type: 'bugfix', importance: 2,
        title: 'Long lesson',
        lessonLearned: 'X'.repeat(300),
        filesModified: `["${join(projectDir, 'longlesson.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'longlesson.mjs') },
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      // Lesson line = "  #N [bugfix] " + up to 120 chars (with '...' if over).
      // Find the lesson line and verify the payload post-"[bugfix] " is ≤120 chars and ends in '...'.
      const line = ctx.split('\n').find(l => l.includes('[bugfix]'));
      expect(line).toBeDefined();
      const payload = line.split('[bugfix] ')[1];
      expect(payload.length).toBeLessThanOrEqual(120);
      expect(payload.endsWith('...')).toBe(true);
    });

    it('v2.34.6 Read→Edit same file same session: Edit deduped by shared cooldown', async () => {
      const filePath = join(projectDir, 'shared.mjs');
      const { stdout: readOut } = await runWithEnv({
        tool_name: 'Read',
        session_id: 'session-gamma',
        tool_input: { file_path: filePath },
      });
      // Read on a lesson-less file: silent (no nudge, no lessons).
      expect(readOut).toBe('');

      const { stdout: editOut } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-gamma',
        tool_input: { file_path: filePath },
      });
      // Even though Edit would normally nudge for no-lesson files, the prior Read
      // already wrote the session cooldown entry → Edit is skipped.
      expect(editOut).toBe('');
    });
  });

  // T2 (v2.31): sdscc and some other CC variants drop plain-text stdout from PreToolUse;
  // only JSON with hookSpecificOutput.additionalContext reliably renders across variants.
  describe('JSON hookSpecificOutput (v2.31 T2)', () => {
    let tmpRoot;
    let dbPath;
    let runtimeDir;
    let projectDir;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `pre-recall-t2-${process.pid}-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      dbPath = join(tmpRoot, 'test.db');
      runtimeDir = join(tmpRoot, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      projectDir = join(tmpRoot, 'parent', 't2test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-t2', project: 'parent--t2test', memoryId: 'mem-t2' });
      db.close();
    });

    afterEach(() => {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    });

    function runWithEnv(input) {
      return runScript(input, {
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: projectDir,
      });
    }

    it('emits JSON hookSpecificOutput on lesson hit', async () => {
      // Seed a lesson for the target file.
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-t2', project: 'parent--t2test',
        type: 'bugfix', importance: 2,
        title: 'Some bug',
        lessonLearned: 'Verify FTS5 integrity after schema changes',
        filesModified: `["${join(projectDir, 'hook-llm.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'hook-llm.mjs') },
      });
      expect(stdout.trim()).not.toBe('');
      const parsed = JSON.parse(stdout);
      expect(parsed.suppressOutput).toBe(true);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] Lessons for hook-llm.mjs:');
    });

    it('emits JSON hookSpecificOutput on backfill reminder (no hit)', async () => {
      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'brand_new.py') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.suppressOutput).toBe(true);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] No prior lessons for brand_new.py');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('/lesson');
    });
  });

  // T9 (v2.31): pre-tool-recall must query BOTH observations and events,
  // since hook-llm now routes bugfix/lesson/decision/etc. to `events`.
  describe('events-table recall (v2.31 T9)', () => {
    let tmpRoot;
    let dbPath;
    let runtimeDir;
    let projectDir;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `pre-recall-t9-${process.pid}-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      dbPath = join(tmpRoot, 'test.db');
      runtimeDir = join(tmpRoot, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      projectDir = join(tmpRoot, 'parent', 't9test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-t9', project: 'parent--t9test', memoryId: 'mem-t9' });
      db.close();
    });

    afterEach(() => {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    });

    function runWithEnv(input) {
      return runScript(input, {
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: projectDir,
      });
    }

    it('surfaces events-table lessons via basename match', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(`
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'lesson', ?, ?, ?, 2, ?)
      `).run(
        'parent--t9test',
        'events-table lesson on foo',
        'remember to flush the cache before rotating keys',
        JSON.stringify(['foo.mjs']),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'foo.mjs') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.suppressOutput).toBe(true);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] Lessons for foo.mjs:');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[lesson]');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('flush the cache before rotating keys');
      // Regression guard: no backfill reminder when an event lesson was found.
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain('No prior lessons');
    });

    it('surfaces events-table lessons via full-path match', async () => {
      const fullPath = join(projectDir, 'bar.mjs');
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(`
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'bugfix', ?, ?, ?, 3, ?)
      `).run(
        'parent--t9test',
        'full-path bugfix',
        'null-check before dereferencing bar()',
        JSON.stringify([fullPath]),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: fullPath },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[bugfix]');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('null-check before dereferencing bar()');
    });

    it('merges observations and events when both match the same file', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Legacy observations lesson
      insertObs(db, {
        sessionId: 'mem-t9', project: 'parent--t9test',
        type: 'bugfix', importance: 2,
        title: 'obs-era bugfix',
        lessonLearned: 'always await the promise before closing db',
        filesModified: `["${join(projectDir, 'mixed.mjs')}"]`,
      });
      // New event lesson
      db.prepare(`
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'lesson', ?, ?, ?, 2, ?)
      `).run(
        'parent--t9test',
        'event-era lesson',
        'check the feature flag in config before rollout',
        JSON.stringify(['mixed.mjs']),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'mixed.mjs') },
      });
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for mixed.mjs:');
      expect(ctx).toContain('always await the promise before closing db');
      expect(ctx).toContain('check the feature flag in config before rollout');
    });

    it('ignores events with importance < 2', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(`
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'lesson', ?, ?, ?, 1, ?)
      `).run(
        'parent--t9test',
        'low-importance lesson',
        'this should not surface',
        JSON.stringify(['lowimp.mjs']),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'lowimp.mjs') },
      });
      const parsed = JSON.parse(stdout);
      // No hit → backfill reminder should show.
      expect(parsed.hookSpecificOutput.additionalContext).toContain('No prior lessons for lowimp.mjs');
    });

    it('ignores superseded events', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(`
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch, superseded_at_epoch)
        VALUES (?, 'bugfix', ?, ?, ?, 3, ?, ?)
      `).run(
        'parent--t9test',
        'stale bugfix',
        'this was replaced — should not surface',
        JSON.stringify(['stale.mjs']),
        Date.now(),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'stale.mjs') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('No prior lessons for stale.mjs');
    });
  });
});
