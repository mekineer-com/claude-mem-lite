import { test, expect } from 'vitest';
import { readGitState } from '../lib/git-state.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

// Strip inherited GIT_* env so child `git init`/`commit` calls below don't
// contend on a parent process's index lock (e.g. when this test runs inside
// the project's pre-commit hook). Without this, GIT_DIR/GIT_INDEX_FILE/
// GIT_WORK_TREE/GIT_PREFIX leak from the parent and the child operations
// fail on the parent's locked index instead of the test's tmp fixture.
const GIT_ENV = (() => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_PREFIX;
  return env;
})();

test('readGitState returns shape { changed, stashes, branch, headSha }', () => {
  const r = readGitState({ cwd: process.cwd() });
  expect(r).toHaveProperty('changed');
  expect(r).toHaveProperty('stashes');
  expect(r).toHaveProperty('branch');
  expect(r).toHaveProperty('headSha');
  expect(Array.isArray(r.changed)).toBe(true);
  expect(Array.isArray(r.stashes)).toBe(true);
});

test('readGitState returns empty shape for non-git cwd', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'non-git-'));
  try {
    const r = readGitState({ cwd: tmp });
    expect(r.changed).toEqual([]);
    expect(r.stashes).toEqual([]);
    expect(r.branch).toBeFalsy();
    expect(r.headSha).toBeFalsy();
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

test('readGitState picks up uncommitted changes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'git-fixture-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp, env: GIT_ENV });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: tmp, env: GIT_ENV });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmp, env: GIT_ENV });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: tmp, env: GIT_ENV });
    // Create an uncommitted change
    writeFileSync(join(tmp, 'foo.txt'), 'bar');

    const r = readGitState({ cwd: tmp });
    expect(r.changed.length).toBeGreaterThan(0);
    expect(r.branch).toBeTruthy();
    expect(r.headSha).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    rmSync(tmp, { recursive: true });
  }
});
