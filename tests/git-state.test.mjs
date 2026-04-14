import { test, expect } from 'vitest';
import { readGitState } from '../lib/git-state.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

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
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: tmp });
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
