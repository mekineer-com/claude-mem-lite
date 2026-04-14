// lib/git-state.mjs — thin wrapper around git status/stash/HEAD sha (T10b).
// Used by startup-dashboard (T10c) and continuation-anchor detection (T10d).
// All calls are timeout-bounded; any failure yields empty fields, never throws.

import { execFileSync } from 'child_process';

const GIT_TIMEOUT_MS = 1500;

function run(cmd, args, { cwd } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
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
