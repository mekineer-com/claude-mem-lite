// tests/post-tool-recall.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-recall.js');
function run(input, env = {}) {
  return new Promise((res, rej) => {
    const c = spawn('node', [SCRIPT], { env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => res(out)); c.on('error', rej);
    c.stdin.write(JSON.stringify(input)); c.stdin.end();
    setTimeout(() => { c.kill(); rej(new Error('timeout')); }, 5000);
  });
}

describe('post-tool-recall (bind component 2)', () => {
  let root, runtime, fp;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'post-recall-'));
    runtime = join(root, 'runtime'); mkdirSync(runtime, { recursive: true });
    fp = join(root, 'target.mjs');
  });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  const seed = (sessionId, idents) => {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
    writeFileSync(join(runtime, `pre-recall-cooldown-${safe}.json`),
      JSON.stringify({ [fp]: { ts: Date.now(), lessonIds: [42], lessonIdents: idents } }));
  };
  const env = (extra = {}) => ({ CLAUDE_MEM_DIR: root, CLAUDE_MEM_SALIENCE: 'bind', ...extra });

  it('warns when the edit dropped a flagged identifier', async () => {
    seed('s1', { 42: ['recoverChildrenOf'] });
    writeFileSync(fp, 'function purgeStale() { db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: 's1', tool_input: { file_path: fp } }, env());
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('dropped `recoverChildrenOf`');
    expect(ctx).toContain('#42');
  });
  it('silent when the identifier is still present', async () => {
    seed('s2', { 42: ['recoverChildrenOf'] });
    writeFileSync(fp, 'function purgeStale() { recoverChildrenOf(); db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: 's2', tool_input: { file_path: fp } }, env());
    expect(out).toBe('');
  });
  it('silent when NOT in bind mode (current)', async () => {
    seed('s3', { 42: ['recoverChildrenOf'] });
    writeFileSync(fp, 'function purgeStale() { db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: 's3', tool_input: { file_path: fp } }, env({ CLAUDE_MEM_SALIENCE: 'current' }));
    expect(out).toBe('');
  });
  it('silent when no cooldown entry exists', async () => {
    writeFileSync(fp, 'function purgeStale() { db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: 'nope', tool_input: { file_path: fp } }, env());
    expect(out).toBe('');
  });
});
