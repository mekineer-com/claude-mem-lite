// tests/pre-tool-recall-bind.test.mjs
// Pins the bind-salience directive selection in scripts/pre-tool-recall.js.
// Mirrors the spawn+seed harness from pre-tool-recall-file-intel.test.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import Database from 'better-sqlite3';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');
function runScript(input, env = {}) {
  return new Promise((res, rej) => {
    const child = spawn('node', [SCRIPT_PATH], { env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => res({ stdout })); child.on('error', rej);
    child.stdin.write(JSON.stringify(input)); child.stdin.end();
    setTimeout(() => { child.kill(); rej(new Error('timeout')); }, 5000);
  });
}

describe('pre-tool-recall bind directive (component 1)', () => {
  let tmpRoot, projectDir, fp;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-bind-${process.pid}-`));
    projectDir = join(tmpRoot, 'parent', 'bindtest');
    mkdirSync(projectDir, { recursive: true });
    fp = join(projectDir, 'maintain-core.mjs');
    writeFileSync(fp, 'export function purgeStale() {}\n');
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF'); initSchema(db);
    insertSession(db, { id: 'sess-bind', project: 'parent--bindtest', memoryId: 'mem-bind' });
    insertObs(db, {
      sessionId: 'mem-bind', project: 'parent--bindtest', type: 'bugfix', importance: 2,
      title: 'orphan recovery', lessonLearned: 'recover referencing rows FIRST before hard-delete',
      filesModified: `["${fp}"]`,
    });
    db.close();
  });
  afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });
  const env = (extra = {}) => ({ CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir, ...extra });

  it('Edit under =bind ends with the comprehension-binding directive', async () => {
    const { stdout } = await runScript({ tool_name: 'Edit', session_id: 'b1', tool_input: { file_path: fp } }, env({ CLAUDE_MEM_SALIENCE: 'bind' }));
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[mem] Lessons for maintain-core.mjs:');
    expect(ctx).toMatch(/state the one concrete check it forces/);
    expect(ctx).not.toContain("'#NN applied'");
  });
  it('Edit by default (current) keeps the v2.98 ack directive', async () => {
    const { stdout } = await runScript({ tool_name: 'Edit', session_id: 'b2', tool_input: { file_path: fp } }, env());
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("'#NN applied'");
    expect(ctx).not.toMatch(/state the one concrete check/);
  });
  it('Edit under legacy emits lessons but NO directive', async () => {
    const { stdout } = await runScript({ tool_name: 'Edit', session_id: 'b3', tool_input: { file_path: fp } }, env({ CLAUDE_MEM_SALIENCE: 'legacy' }));
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[mem] Lessons for maintain-core.mjs:');
    expect(ctx).not.toMatch(/concrete check|#NN applied/);
  });
});
