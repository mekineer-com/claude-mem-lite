// `unadopt --all` must strip the CLAUDE.md managed block from every project
// Claude Code knows about (~/.claude.json `projects`), not just legacy memdir
// residue. Isolated HOME + subprocess CLI so detectCwd()/homedir() can never
// escape to the real machine. afterAll asserts the real repo CLAUDE.md is
// byte-identical — a regression net for the cwd-leak class of bug.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_CLAUDE_MD = join(REPO, 'CLAUDE.md');
const USER_MD = '# proj\n\nMy notes.\n\n## Conventions\n- spaces\n';

let HOME, projA, projB, projGone, BASE_ENV, repoSnapshot;

function run(args, { cwd, allowFail = false } = {}) {
  try {
    const out = execFileSync('node', [join(REPO, 'cli.mjs'), ...args], {
      encoding: 'utf8', cwd,
      env: { ...BASE_ENV, PWD: cwd, CLAUDE_PROJECT_DIR: cwd },
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
    });
    return { ok: true, out };
  } catch (e) {
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    if (!allowFail) throw new Error(`cli ${args.join(' ')} exited ${e.status}:\n${out}`, { cause: e });
    return { ok: false, out, code: e.status };
  }
}

function hasBlock(dir) {
  const p = join(dir, 'CLAUDE.md');
  if (!existsSync(p)) return false;
  return /<!-- claude-mem-lite:begin/.test(readFileSync(p, 'utf8'));
}

describe('unadopt --all scans known projects (~/.claude.json)', () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), 'mem-unadopt-all-'));
    projA = join(HOME, 'a'); projB = join(HOME, 'b'); projGone = join(HOME, 'gone-deleted');
    repoSnapshot = existsSync(REPO_CLAUDE_MD) ? readFileSync(REPO_CLAUDE_MD, 'utf8') : null;

    BASE_ENV = { ...process.env, HOME, CLAUDE_MEM_SKIP_REPOS: '1' };
    delete BASE_ENV.CLAUDE_MEM_DIR;
    delete BASE_ENV.CLAUDE_PROJECT_DIR;
    delete BASE_ENV.PWD;

    mkdirSync(join(HOME, '.claude'), { recursive: true });
    for (const d of [projA, projB]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'CLAUDE.md'), USER_MD); }
    // ~/.claude.json lists A, B, and a now-deleted path (must be filtered out).
    writeFileSync(join(HOME, '.claude.json'), JSON.stringify({
      projects: { [projA]: {}, [projB]: {}, [projGone]: {} },
    }, null, 2));

    run(['adopt'], { cwd: projA });
    run(['adopt'], { cwd: projB });
  }, 60000);

  afterAll(() => {
    if (repoSnapshot !== null) expect(readFileSync(REPO_CLAUDE_MD, 'utf8')).toBe(repoSnapshot);
    try { execFileSync('rm', ['-rf', HOME]); } catch { /* best-effort */ }
  });

  it('adopt wrote a managed block into both known projects', () => {
    expect(hasBlock(projA)).toBe(true);
    expect(hasBlock(projB)).toBe(true);
  });

  it('--all --dry-run reports both but removes nothing', () => {
    const r = run(['unadopt', '--all', '--dry-run'], { cwd: HOME });
    expect(r.out).toMatch(/would-remove/);
    expect(r.out).toContain(projA);
    expect(r.out).toContain(projB);
    expect(hasBlock(projA)).toBe(true);
    expect(hasBlock(projB)).toBe(true);
  });

  it('--all removes the block from every known project, preserving user content', () => {
    const r = run(['unadopt', '--all'], { cwd: HOME });
    expect(r.out).toMatch(/removed 2 CLAUDE\.md block/);
    expect(hasBlock(projA)).toBe(false);
    expect(hasBlock(projB)).toBe(false);
    // User content survives the slug-scoped removal.
    for (const d of [projA, projB]) {
      const md = readFileSync(join(d, 'CLAUDE.md'), 'utf8');
      expect(md).toContain('My notes.');
      expect(md).toContain('- spaces');
      expect(existsSync(join(d, '.claude', 'plugin_claude_mem_lite.md'))).toBe(false);
    }
  });

  it('--all is idempotent (second run removes zero)', () => {
    const r = run(['unadopt', '--all'], { cwd: HOME });
    expect(r.out).toMatch(/removed 0 CLAUDE\.md block/);
  });
});
