// lib/git-state.mjs — thin wrapper around git status/stash/HEAD sha (T10b).
// Used by startup-dashboard (T10c) and continuation-anchor detection (T10d).
// All calls are timeout-bounded; any failure yields empty fields, never throws.

import { execFileSync } from 'child_process';

const GIT_TIMEOUT_MS = 1500;

// Strip inherited GIT_* env so child `git` operates on the requested `cwd`
// rather than a parent process's repo. Required when readGitState is called
// from contexts where GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_PREFIX leak in:
// pre-commit hooks running tests, hooks invoked under `git commit`, etc.
// Without this, headSha and `changed` reflect the parent's repo, not cwd's.
function buildCleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_PREFIX;
  return env;
}

function run(cmd, args, { cwd } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      env: buildCleanEnv(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // Suppress git's own stderr noise (e.g. "fatal: not a git repository").
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Return a compact snapshot of git state. Safe on non-git directories.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()]
 * @returns {{changed: string[], stashes: string[], branch: string|null, headSha: string|null}}
 */
export function readGitState({ cwd = process.cwd() } = {}) {
  const statusOut = run('git', ['status', '--porcelain'], { cwd });
  const changed = statusOut ? statusOut.split('\n').filter(Boolean) : [];
  const stashOut = run('git', ['stash', 'list'], { cwd });
  const stashes = stashOut ? stashOut.split('\n').filter(Boolean) : [];
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }) || null;
  const headSha = run('git', ['rev-parse', 'HEAD'], { cwd }) || null;
  return { changed, stashes, branch, headSha };
}
