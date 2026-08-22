// claude-mem-lite: Bash command analysis and file path extraction
// Extracted from utils.mjs for focused responsibility

import { basename } from 'path';

// Read/search commands whose output legitimately contains "error"-like keywords without
// being a failure. Matched against the PRIMARY command (see isReadOnlyCommand).
const SEARCH_VERBS = new Set([
  'grep', 'rg', 'ag', 'ack', 'cat', 'head', 'tail', 'less', 'more', 'find', 'locate', 'wc', 'file', 'which', 'type',
]);
// Command prefixes that wrap the real command (env-assignments handled separately).
const CMD_WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'command', 'nice', 'nohup', 'stdbuf', 'xargs']);
// git read subcommands whose output contains commit/log/match text, not failures.
const GIT_READ_SUBCMDS = new Set(['grep', 'log', 'show', 'diff', 'blame', 'ls-files', 'cat-file', 'whatchanged', 'shortlog', 'reflog', 'status']);

// Hard failure fingerprints — a real crash / thrown exception / non-zero-exit marker,
// as opposed to output that merely CONTAINS the word "error" (search results, log
// scans, prose). Deliberately strong/narrow: a JS stack frame (`\n   at fn (…)`),
// panic/traceback/segfault, ENOENT/command-not-found, AssertionError, or a *named*
// error class (TypeError:/ReferenceError:/…). Generic `Error:`/`exception` are
// intentionally excluded — they appear too often in benign search/log output. Gates
// the bugfix-shape save-nudge (lib/cite-back-hint.mjs) so `node cli.mjs search "error"`
// + an edit in the same episode no longer looks like an unsaved fix.
const HARD_ERROR_RE = /\bERR!|\bpanic\b|traceback|segfault|core dumped|\benoent\b|command not found|assertion\s?error|\n\s+at\s+\S|(?:type|reference|range|syntax|eval|uri)error:/i;

// True when the command's PRIMARY operation (left of the first pipe, past any
// env-assignments / wrapper like `sudo`/`env`/`time`) is a read/search — including
// `git grep`/`git log`. Anchoring on the primary command (not "search verb appears
// anywhere") is what lets `npm run build 2>&1 | tail` stay an error while `sudo grep`,
// `git grep`, `cat f | head` are correctly exempt.
function isReadOnlyCommand(cmd) {
  const primary = cmd.split('|')[0];
  const toks = primary.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && (/^\w+=/.test(toks[i]) || CMD_WRAPPERS.has(toks[i]))) i++;
  const first = toks[i];
  if (!first) return false;
  if (SEARCH_VERBS.has(first)) return true;
  return first === 'git' && GIT_READ_SUBCMDS.has(toks[i + 1]);
}

// Paths excluded from observation capture (ephemeral / virtual filesystems) — applied
// uniformly to both command-parsed paths and direct file_path/path/filePath fields.
function isExcludedPath(p) {
  return p.startsWith('/dev/') || p.startsWith('/proc/') || p.startsWith('/tmp/');
}

/**
 * Detect significance signals in a Bash command and its response.
 * Checks for errors, test runs, builds, git operations, and deployments.
 * @param {object} input Tool input with command field
 * @param {string} response Command output text
 * @returns {{isError: boolean, isTest: boolean, isBuild: boolean, isGit: boolean, isDeploy: boolean, isSignificant: boolean}}
 */
export function detectBashSignificance(input, response) {
  // Coerce command to a string at the source. A malformed PostToolUse payload can
  // hand us a non-string `command` (object/number); `(input.command||'').toLowerCase()`
  // then threw, and this is called UNGUARDED in the hottest hook path (hook.mjs:309) —
  // the throw propagated to main()'s exit(0), dropping the ENTIRE tool event (no episode
  // entry, not even a pending file). A non-string command has nothing to analyze, so
  // degrading to '' (no significance) is the correct, event-preserving fallback.
  const cmd = (typeof input?.command === 'string' ? input.command : '').toLowerCase();
  // Skip error keyword matching only when the PRIMARY command is a read/search op (its
  // output naturally contains "error"-like keywords that aren't failures). Anchored on the
  // primary command — NOT "search verb appears anywhere" — so `npm run build 2>&1 | tail`
  // stays a real failure while `sudo grep`, `git grep`, `git log --grep`, `cat f | head`
  // remain exempt and `run-cat-tests` doesn't trip a substring match.
  const isSearchCmd = isReadOnlyCommand(cmd);
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
  // Strict subset of isError: a genuine failure fingerprint, not just the word "error"
  // in benign output. Consumers that must avoid false positives (the bugfix-shape
  // save-nudge) gate on this instead of isError.
  const isHardError = isError && HARD_ERROR_RE.test(response);
  // Match actual test runner invocations, not commands that merely reference "test" as a keyword
  const isTest = /\b(npm\s+test|npm\s+run\s+test|yarn\s+test|pnpm\s+test|pnpm\s+run\s+test|bun\s+test|go\s+test|cargo\s+test)\b/i.test(cmd)
    || /\b(jest|pytest|vitest|mocha|cypress|playwright)\b/i.test(cmd);
  const isBuild = /\b(build|compile|tsc|webpack|vite|rollup|esbuild|make|cargo)\b/i.test(cmd);
  // Allow intervening global git options (`-C <path>`, `-c k=v`, `--no-pager`, …) between
  // `git` and the subcommand — `git -C /repo push` is the standard multi-repo/scripted form.
  const isGit = /\bgit\s+(?:(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?)\s+)*(commit|merge|rebase|cherry-pick|push)\b/i.test(cmd);
  // Deploy + publish/release: the actual "ship". Package publish and GitHub
  // release are rare, high-value events; without them a release session records
  // the git push but not the publish that defines it. `npm run publish-*` is
  // excluded (custom script, ambiguous) — only the direct publish verb counts.
  const isDeploy = /\b(deploy|docker|kubectl|terraform)\b/i.test(cmd)
    || /\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b/i.test(cmd)
    || /\bgh\s+release\s+(?:create|edit|upload|delete)\b/i.test(cmd)
    || /\btwine\s+upload\b/i.test(cmd);
  return {
    isError, isHardError, isTest, isBuild, isGit, isDeploy,
    isSignificant: isError || isTest || isBuild || isGit || isDeploy,
  };
}

const ERROR_STOP_WORDS = new Set([
  'error', 'failed', 'cannot', 'could', 'with', 'from', 'that', 'this',
  'have', 'been', 'were', 'does', 'will', 'would', 'should', 'must',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'const',
  'node', 'require', 'stack', 'trace',
]);

const ERROR_LINE_RE = /error|fail|exception|cannot|not found|undefined|null/i;
const ERROR_RECALL_MAX_TERMS = 6;

/**
 * Split a failed command + its output into command-derived and error-derived terms.
 * Shared by extractErrorKeywords (merged view, unchanged contract) and
 * planErrorRecall (which needs the two classes kept apart). Dedup is deliberately
 * ACROSS both classes, command-first, so the merged view is byte-identical to the
 * pre-split single-Set implementation.
 * @returns {{cmdWords: string[], errWords: string[]}}
 */
function collectErrorTerms(cmd, response) {
  const seen = new Set();
  const cmdWords = [];
  const cmdParts = String(cmd || '').split(/[\s/\\|&;]+/).filter(w => w.length > 2 && !/^-/.test(w));
  for (const w of cmdParts.slice(0, 3)) {
    const lw = w.toLowerCase();
    if (!ERROR_STOP_WORDS.has(lw) && !seen.has(lw)) { seen.add(lw); cmdWords.push(lw); }
  }
  const errWords = [];
  // The line filter is the TRIGGER's pattern list OR'd with the prose one. Anything
  // that made detectBashSignificance call this a hard error is, by construction, also
  // something we will extract terms from — which closes the "trigger fired, extractor
  // found nothing, so we queried the command's own words" class without enumerating
  // failure shapes. ERROR_LINE_RE alone missed `npm ERR! code ENOENT` (no `error`, no
  // `fail`, no `not found` — npm says "no such file") and `panic: assignment to entry
  // in nil map`, while letting `panic: runtime error: …` through purely because that
  // message happens to contain the substring `error`.
  // Note HARD_ERROR_RE's `\n\s+at\s+\S` alternative cannot match a single line (it
  // needs the preceding newline); that is fine — it is a stack-frame anchor, and the
  // frames it guards are accompanied by a line the other alternatives do catch.
  const errLines = String(response || '')
    .split('\n')
    .filter((l) => ERROR_LINE_RE.test(l) || HARD_ERROR_RE.test(l))
    .slice(0, 3);
  for (const line of errLines) {
    const tokens = line.replace(/[^a-zA-Z0-9_.-]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !/^\d+$/.test(w));
    for (const t of tokens.slice(0, 5)) {
      const lt = t.toLowerCase();
      if (!ERROR_STOP_WORDS.has(lt) && !seen.has(lt)) { seen.add(lt); errWords.push(lt); }
    }
  }
  return { cmdWords, errWords };
}

/**
 * Extract discriminative keywords from a failed command and its error output.
 * Filters out common stop words to produce useful FTS5 search terms.
 * @param {string} cmd The command that was executed
 * @param {string} response The error output text
 * @returns {string[]|null} Array of 1-6 keywords or null if none found
 */
export function extractErrorKeywords(cmd, response) {
  const { cmdWords, errWords } = collectErrorTerms(cmd, response);
  const result = [...cmdWords, ...errWords].slice(0, ERROR_RECALL_MAX_TERMS);
  return result.length >= 1 ? result : null;
}

/**
 * Decide whether the error-recall surface should fire, and with which terms (D#136).
 *
 * Two defects this closes, both measured against the live DB on 2026-08-22 (obs
 * #10730 carries the readings):
 *
 * 1. THE SELECTION FILTER IS A SUPERSET OF THE TRIGGER. This surface fires on
 *    detectBashSignificance's isHardError (HARD_ERROR_RE), but term extraction used to
 *    keep only lines matching ERROR_LINE_RE — a DIFFERENT list. The two diverge:
 *    HARD_ERROR_RE accepts `ERR!`, `enoent`, `panic`, `traceback`; ERROR_LINE_RE takes
 *    `error|fail|exception|cannot|not found|undefined|null` as SUBSTRINGS (no word
 *    boundaries — `AssertionError` matches on `error`). npm's own output sits in the
 *    gap: `npm ERR! code ENOENT / npm ERR! enoent ENOENT: no such file or directory`
 *    has no `error`, no `fail`, no `not found` (npm says "no such file"), so it cleared
 *    the trigger and then yielded ZERO lines to extract from. The keyword set degraded
 *    to pure command words — literally ['npm','run','build'] — and the surface searched
 *    the COMMAND'S TOPIC instead of the failure.
 *    The sharpest symptom was Go: `panic: assignment to entry in nil map` was silenced
 *    while `panic: runtime error: index out of range` was not, purely because the
 *    second message happens to contain the substring `error`. Recall depending on the
 *    wording of a panic is the same divergence, relocated.
 *    OR-ing HARD_ERROR_RE into the line filter closes the class BY CONSTRUCTION rather
 *    than by enumerating shapes: whatever convinced the trigger this was a hard error
 *    is, by definition, also something we will read terms from. (Widening ERROR_LINE_RE
 *    ad hoc WOULD be enumeration; making it a superset of the trigger is not.)
 *
 * 2. COMMAND WORDS STAY IN THE QUERY — a demotion was TRIED AND REJECTED on data.
 *    The obvious follow-up is to drop `npm` / `run` / `grep` from the query, since
 *    they demonstrably let BM25 return release records for a missing-module failure.
 *    Replaying five real failures against the live DB (2026-08-22) says the trade is
 *    not one-way: error-terms-only did fix `npm run build` (it surfaced #8721
 *    ERR_MODULE_NOT_FOUND and #8185 SOURCE_FILES, the rows that actually explain it),
 *    but it REGRESSED two others — dropping `database` lost #8673 (plugin-mode
 *    data-dir skew) for a failed DB open, and dropping `vitest` lost #8725 (test
 *    fails locally) for a test failure. Command words are carrying domain anchoring,
 *    not just noise. A demote-to-fallback variant measured byte-identical to
 *    error-terms-only (12 rows either way): the primary query always filled its
 *    LIMIT 3, so the fallback never ran.
 *
 * 3. THE RESIDUAL GATE. With (1) in place this fires rarely, but it is not dead: a
 *    failure can still yield no usable term — empty output, or a line whose tokens are
 *    all stop words (`Error: it failed`). There is then nothing to recall ON, and
 *    silence beats querying the command's topic.
 *    Read the predicate precisely: `errWords` excludes anything ALREADY taken as a
 *    command word, because collectErrorTerms dedups across both classes with the
 *    command filled first. So this is "no error term that is not also in the command",
 *    not "no error term". `docker compose up -d` and `docker stack deploy` on the SAME
 *    output decide differently for exactly that reason — the first has `compose` in the
 *    command, the second does not. That asymmetry is inherited from the pre-split
 *    single-Set implementation and is preserved deliberately; it is documented here
 *    rather than silently "fixed" because changing it would change extractErrorKeywords
 *    for every caller, which is a separate decision from this one.
 *
 * @param {string} cmd The command that was executed
 * @param {string} response The error output text
 * @returns {{terms: string[]}|null} null ⇒ do not inject
 */
export function planErrorRecall(cmd, response) {
  const { cmdWords, errWords } = collectErrorTerms(cmd, response);
  if (errWords.length === 0) return null;
  return { terms: [...cmdWords, ...errWords].slice(0, ERROR_RECALL_MAX_TERMS) };
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
  // Direct fields (Edit/Write file_path) are kept unconditionally — an explicit edit to a
  // /tmp path is real work the user chose to make, unlike a /tmp path that merely appears as
  // a transient argument inside a Bash command (excluded as noise in the command branch below).
  if (input.file_path) paths.push(input.file_path);
  if (input.path) paths.push(input.path);
  if (input.filePath) paths.push(input.filePath);
  if (input.command) {
    // Match absolute paths; extension optional to support Makefile, Dockerfile etc.
    const match = input.command.match(/(?:^|\s)(\/[\w./-]+\w)/g);
    if (match) {
      for (const m of match) {
        const p = m.trim();
        if (!isExcludedPath(p)
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
