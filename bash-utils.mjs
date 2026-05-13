// claude-mem-lite: Bash command analysis and file path extraction
// Extracted from utils.mjs for focused responsibility

import { basename } from 'path';

/**
 * Detect significance signals in a Bash command and its response.
 * Checks for errors, test runs, builds, git operations, and deployments.
 * @param {object} input Tool input with command field
 * @param {string} response Command output text
 * @returns {{isError: boolean, isTest: boolean, isBuild: boolean, isGit: boolean, isDeploy: boolean, isSignificant: boolean}}
 */
export function detectBashSignificance(input, response) {
  const cmd = (input.command || '').toLowerCase();
  // Skip error keyword matching when the command is a read/search operation
  // (grep output naturally contains matched keywords like "error")
  const isSearchCmd = /\b(grep|rg|ag|ack|cat|head|tail|less|more|find|locate|wc|file|which|type)\b/i.test(cmd);
  const looksLikeError = !isSearchCmd
    && /\berror\b|\bERR!|fail(ed|ure)?|exception|panic|traceback|errno|enoent|command not found/i.test(response)
    && response.length > 15;
  // Green test summary exemption — "0 fail/failed/failures" in test-runner
  // output (bun/jest/pytest) gets matched by the broad `fail(ed|ure)?` token
  // above, driving episode.isError=true for passing runs. A live cluster-merge
  // audit found 5 noise observations with "Error: <test>.ts ... 0 fail" titles
  // from this path. Flip back to non-error iff a "0 fail" marker is present
  // AND no hard-error signal (panic / ENOENT / AssertionError / TypeError /
  // explicit FAIL banner / npm ERR!) coexists in the output.
  const hasGreenTestSummary = looksLikeError
    && /\b0\s+(fail|failed|failures)\b/i.test(response);
  // NOTE: do not add `\bFAIL\s` here — with /i flag it would re-match the
  // very `0 fail\n` token green-summary is trying to exempt. A real test
  // failure produces "N fail" (N≥1) which never triggers hasGreenTestSummary,
  // so a uppercase-FAIL fingerprint isn't needed for correctness.
  const hasHardErrorSignal = hasGreenTestSummary
    && /\bERR!|panic|traceback|enoent|command not found|exception|AssertionError|TypeError:|SyntaxError:/i.test(response);
  const isError = looksLikeError && !(hasGreenTestSummary && !hasHardErrorSignal);
  // Match actual test runner invocations, not commands that merely reference "test" as a keyword
  const isTest = /\b(npm\s+test|npm\s+run\s+test|yarn\s+test|pnpm\s+test|pnpm\s+run\s+test|bun\s+test|go\s+test|cargo\s+test)\b/i.test(cmd)
    || /\b(jest|pytest|vitest|mocha|cypress|playwright)\b/i.test(cmd);
  const isBuild = /\b(build|compile|tsc|webpack|vite|rollup|esbuild|make|cargo)\b/i.test(cmd);
  const isGit = /\bgit\s+(commit|merge|rebase|cherry-pick|push)\b/i.test(cmd);
  const isDeploy = /\b(deploy|docker|kubectl|terraform)\b/i.test(cmd);
  return {
    isError, isTest, isBuild, isGit, isDeploy,
    isSignificant: isError || isTest || isBuild || isGit || isDeploy,
  };
}

const ERROR_STOP_WORDS = new Set([
  'error', 'failed', 'cannot', 'could', 'with', 'from', 'that', 'this',
  'have', 'been', 'were', 'does', 'will', 'would', 'should', 'must',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'const',
  'node', 'require', 'stack', 'trace',
]);

/**
 * Extract discriminative keywords from a failed command and its error output.
 * Filters out common stop words to produce useful FTS5 search terms.
 * @param {string} cmd The command that was executed
 * @param {string} response The error output text
 * @returns {string[]|null} Array of 1-6 keywords or null if none found
 */
export function extractErrorKeywords(cmd, response) {
  const words = new Set();
  const cmdParts = cmd.split(/[\s/\\|&;]+/).filter(w => w.length > 2 && !/^-/.test(w));
  for (const w of cmdParts.slice(0, 3)) {
    const lw = w.toLowerCase();
    if (!ERROR_STOP_WORDS.has(lw)) words.add(lw);
  }
  const errLines = response.split('\n').filter(l =>
    /error|fail|exception|cannot|not found|undefined|null/i.test(l)
  ).slice(0, 3);
  for (const line of errLines) {
    const tokens = line.replace(/[^a-zA-Z0-9_.-]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !/^\d+$/.test(w));
    for (const t of tokens.slice(0, 5)) {
      const lt = t.toLowerCase();
      if (!ERROR_STOP_WORDS.has(lt)) words.add(lt);
    }
  }
  const result = [...words].slice(0, 6);
  return result.length >= 1 ? result : null;
}

// ─── File Paths ──────────────────────────────────────────────────────────────

/**
 * Extract file paths from tool input (file_path, path, filePath, or command args).
 * Deduplicates and excludes /dev/, /proc/, and /tmp/ paths.
 * @param {object} input Tool input object
 * @returns {string[]} Unique array of file paths
 */
export function extractFilePaths(input) {
  const paths = [];
  if (input.file_path) paths.push(input.file_path);
  if (input.path) paths.push(input.path);
  if (input.filePath) paths.push(input.filePath);
  if (input.command) {
    // Match absolute paths; extension optional to support Makefile, Dockerfile etc.
    const match = input.command.match(/(?:^|\s)(\/[\w./-]+\w)/g);
    if (match) {
      for (const m of match) {
        const p = m.trim();
        if (!p.startsWith('/dev/') && !p.startsWith('/proc/') && !p.startsWith('/tmp/')
          // Skip single-component paths like /exit, /clear — likely slash commands, not files
          && (p.indexOf('/', 1) !== -1 || /\.\w+$/.test(p))) {
          paths.push(p);
        }
      }
    }
  }
  return [...new Set(paths)];
}

// ─── Episode Logic ───────────────────────────────────────────────────────────

/**
 * Strip test/spec/e2e suffixes from a filename for sibling matching.
 * Example: auth.test.ts → auth.ts, auth.spec.js → auth.js
 * @param {string} filePath File path to strip
 * @returns {string} Basename with test suffix removed
 */
export function stripTestSuffix(filePath) {
  return basename(filePath).replace(/\.(test|spec|e2e)\./i, '.');
}
