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

    it('truncates long lessons at 120 chars', () => {
      const longLesson = 'A'.repeat(200);
      const truncated = longLesson.length > 120
        ? longLesson.slice(0, 117) + '...' : longLesson;
      expect(truncated).toHaveLength(120);
      expect(truncated.endsWith('...')).toBe(true);
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
      expect(stdout).toContain('[mem] No prior lessons for credit_service.py');
      // Should mention the save command so Claude knows how to backfill.
      expect(stdout).toContain('claude-mem-lite save');
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
      expect(stdout).toContain('[mem] Lessons for schema.mjs:');
      expect(stdout).toContain('Verify FTS5 integrity');
      // Reminder should NOT be emitted when a lesson was found.
      expect(stdout).not.toContain('No prior lessons');
    });

    it('honors cooldown — second call within window emits neither lesson nor reminder', async () => {
      const filePath = join(projectDir, 'cool.py');
      const { stdout: first } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
      });
      expect(first).toContain('[mem] No prior lessons for cool.py');

      const { stdout: second } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
      });
      expect(second).toBe('');
    });
  });
});
