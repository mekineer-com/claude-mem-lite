#!/usr/bin/env node
// efficacy-harness.mjs — STEP 3b-full driver for the efficacy A/C severe test.
// Spec: docs/superpowers/specs/2026-06-05-memory-efficacy-validation-design.md
//
// WHAT IT MEASURES (read this before trusting any number it prints):
//   An UPPER BOUND. The injected lesson is derived from the same commit whose bug
//   we test, and the task necessarily touches that exact region, so lesson↔task are
//   near-isomorphic. A positive result means "on-topic injection changes the code
//   the model writes", NOT "realistic memory improves coding". A NULL result is the
//   strong, interesting outcome (system fails even when spoon-fed). Framed as a
//   SEVERE TEST + effect-size estimator, NOT a powered hypothesis test (step 2:
//   pilot scale cannot reach significance).
//
// DESIGN (locked by the 3b dry-run, incl. bug #8648):
//   - construction: surgical `git revert -n <C>` at HEAD (bug latent, code current),
//     oracle test kept OUT of the worktree, applied only at scoring time.
//   - bug-set: tests that are RED at the reverted baseline = the bug's signature.
//     A commit with an empty bug-set is unusable (skipped, logged).
//   - arm A: CLAUDE_MEM_DIR sandbox seeded with the commit's real lesson, under
//     project=projects--mem; arm C: empty sandbox. BOTH set CLAUDE_PROJECT_DIR=REPO
//     (else inferProject keys off the /tmp cwd and injection is silently empty — #8648).
//   - injection is VERIFIED per arm-A run via a direct hook probe (not CLI recall,
//     which filters differently and gives false green).
//   - score: pass = every bug-set test GREEN after the arm's edit.
//   - unit of analysis = COMMIT; k runs/arm estimate per-commit pass-prob; report
//     commit-level paired Δ (NOT pooled runs — that is pseudo-replication).
//
// Resumable: writes tasks/efficacy-results.json after every run; rerun skips done cells.
//
//   node benchmark/efficacy-harness.mjs --baseline-only   # validate constructions, no sessions
//   node benchmark/efficacy-harness.mjs --k=3             # full run (default arms A,C)
//   node benchmark/efficacy-harness.mjs --commit=bac2e85  # one commit
//   node benchmark/efficacy-harness.mjs --concurrency=3

import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);

const REPO = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const K = parseInt(args.k || '3', 10);
const ARMS = (args.arms || 'A,C').split(',');
const BASELINE_ONLY = !!args['baseline-only'];
const ONLY_COMMIT = args.commit || null;
const CONCURRENCY = parseInt(args.concurrency || '3', 10);
const SESSION_TIMEOUT = parseInt(args.timeout || '420', 10); // s
const CONFIG_PATH = join(REPO, 'benchmark/efficacy-commits.json');
const RESULTS_PATH = join(REPO, 'tasks/efficacy-results.json');
const NODE_MODULES = join(REPO, 'node_modules');

const TASK_SUFFIX = ' Edit the file(s) directly now; do not ask questions.';

function sh(cmd, opts = {}) { return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }); }
function git(cwd, cmd) { return sh(`git -C '${cwd}' ${cmd}`); }

// ── worktree lifecycle ───────────────────────────────────────────────────────
function makeBugPresentWorktree(spec) {
  const wt = mkdtempSync(join(tmpdir(), 'eff-wt-'));
  git(REPO, `worktree add -q '${wt}' HEAD`);
  try { symlinkSync(NODE_MODULES, join(wt, 'node_modules')); } catch { /* exists */ }
  if (spec.patchFile) {
    // Patch construction: when later commits touched the fix's region, surgical
    // revert conflicts forever (#8650 — the clean-revert pool decays as HEAD moves).
    // A hand-resolved bug-reintroduction patch (old buggy bodies restored onto
    // current code, regression tests excised from the worktree oracle) keeps the
    // cell usable. Oracle at scoring comes from oracleRef (HEAD) in this mode.
    try {
      git(wt, `apply '${join(REPO, spec.patchFile)}'`);
    } catch (e) {
      dropWorktree(wt);
      const err = new Error('patch apply failed'); err.code = 'REVERT_CONFLICT'; throw err;
    }
    return wt;
  }
  try {
    git(wt, `revert -n ${spec.hash}`); // bug latent; oracle test also reverted (kept OUT)
  } catch (e) {
    // surgical revert conflicts when later commits touched the same region — older
    // commits are systematically harder to revert cleanly. Mark unusable, don't crash.
    try { git(wt, 'revert --abort'); } catch { /* */ }
    dropWorktree(wt);
    const err = new Error('revert conflict'); err.code = 'REVERT_CONFLICT'; throw err;
  }
  return wt;
}
function dropWorktree(wt) {
  try { git(REPO, `worktree remove --force '${wt}'`); } catch { /* */ }
}

// ── oracle scoring via vitest json reporter ──────────────────────────────────
// returns Map<testFullName, 'passed'|'failed'>
function runOracle(wt, oracleTestRel, commit) {
  // place the post-fix oracle test into the worktree, then run ONLY it
  // (patch-constructed cells score against the HEAD oracle via oracleRef)
  const oracleContent = git(REPO, `show ${commit}:${oracleTestRel}`);
  writeFileSync(join(wt, oracleTestRel), oracleContent);
  let out;
  try {
    out = sh(`./node_modules/.bin/vitest run ${oracleTestRel} --reporter=json 2>/dev/null`, { cwd: wt });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); } // vitest exits non-zero on fail
  const jsonStart = out.indexOf('{');
  let report; try { report = JSON.parse(out.slice(jsonStart)); } catch { return null; }
  const res = new Map();
  for (const f of report.testResults || []) {
    for (const a of f.assertionResults || []) res.set(a.fullName || a.title, a.status);
  }
  return res;
}

// ── mem sandbox seeding ──────────────────────────────────────────────────────
function seedSandbox(arm, spec) {
  const sb = mkdtempSync(join(tmpdir(), `eff-mem${arm}-`));
  if (arm === 'A') {
    const filesArg = spec.srcFiles.map((f) => `--files ${f}`).join(' ');
    execFileSync('bash', ['-c',
      `CLAUDE_MEM_DIR='${sb}' claude-mem-lite save --type bugfix --importance 2 --project projects--mem ` +
      `${filesArg} --title ${JSON.stringify(spec.lessonTitle)} --lesson ${JSON.stringify(spec.lesson)} ` +
      `${JSON.stringify(spec.lessonBody || spec.lesson)}`], { stdio: 'ignore' });
  }
  return sb;
}

// ── injection probe (arm A only): assert the hook really injects ─────────────
function probeInjection(sandbox, wt, srcFile) {
  const event = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(wt, srcFile) }, session_id: `probe-${Math.floor(performance.now())}` });
  let out;
  try {
    out = execFileSync('bash', ['-c',
      `echo '${event.replace(/'/g, "'\\''")}' | CLAUDE_MEM_DIR='${sandbox}' CLAUDE_PROJECT_DIR='${REPO}' node scripts/pre-tool-recall.js`],
      { cwd: REPO, encoding: 'utf8' });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /\[mem\] Lessons for/.test(out); // true = lesson actually injected
}

// ── one session ──────────────────────────────────────────────────────────────
async function runArmSeed(spec, arm, seed) {
  let wt;
  try { wt = makeBugPresentWorktree(spec); }
  catch (e) { return { commit: spec.hash, arm, seed, pass: null, note: e.code === 'REVERT_CONFLICT' ? 'revert conflict' : 'worktree fail' }; }
  const sb = seedSandbox(arm, spec);
  const cell = { commit: spec.hash, arm, seed };
  try {
    if (arm === 'A') {
      cell.injected = probeInjection(sb, wt, spec.srcFiles[0]);
      if (!cell.injected) { cell.pass = null; cell.note = 'INJECTION FAILED — discard'; return cell; }
    }
    const task = spec.task + TASK_SUFFIX;
    try {
      await execFileP('bash', ['-c',
        `cd '${wt}' && CLAUDE_MEM_DIR='${sb}' CLAUDE_PROJECT_DIR='${REPO}' timeout ${SESSION_TIMEOUT} ` +
        `claude -p ${JSON.stringify(task)} --permission-mode bypassPermissions --allowedTools 'Read,Edit' --output-format text`],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: (SESSION_TIMEOUT + 30) * 1000 });
    } catch (e) { cell.sessionErr = String(e.message).slice(0, 120); }
    const res = runOracle(wt, spec.oracleTest, spec.oracleRef || spec.hash);
    if (!res) { cell.pass = null; cell.note = 'oracle parse failed'; return cell; }
    cell.pass = spec.bugSet.every((t) => res.get(t) === 'passed') ? 1 : 0;
    cell.bugSetResults = spec.bugSet.map((t) => [t, res.get(t)]);
  } finally {
    dropWorktree(wt);
    rmSync(sb, { recursive: true, force: true });
  }
  return cell;
}

// ── baseline: discover bug-set + validate construction (no sessions) ─────────
function validateConstruction(spec) {
  let wt;
  try { wt = makeBugPresentWorktree(spec); }
  catch (e) { return { ok: false, reason: e.code === 'REVERT_CONFLICT' ? 'revert conflict (older commit, region changed since)' : String(e.message).slice(0, 80) }; }
  try {
    const res = runOracle(wt, spec.oracleTest, spec.oracleRef || spec.hash);
    if (!res) return { ok: false, reason: 'oracle parse failed' };
    const failing = [...res.entries()].filter(([, s]) => s === 'failed').map(([t]) => t);
    if (failing.length === 0) return { ok: false, reason: 'empty bug-set (revert did not make oracle RED) — unusable' };
    return { ok: true, bugSet: failing, total: res.size };
  } finally { dropWorktree(wt); }
}

// ── results store (resumable) ────────────────────────────────────────────────
function loadResults() { try { return JSON.parse(readFileSync(RESULTS_PATH, 'utf8')); } catch { return { cells: [] }; } }
function saveResults(r) { writeFileSync(RESULTS_PATH, JSON.stringify(r, null, 2)); }
const cellKey = (c) => `${c.commit}|${c.arm}|${c.seed}`;

// ── run ───────────────────────────────────────────────────────────────────────
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
let commits = config.commits;
if (ONLY_COMMIT) commits = commits.filter((c) => c.hash.startsWith(ONLY_COMMIT));

console.log(`efficacy-harness: ${commits.length} commits, arms=${ARMS}, k=${K}, baseline-only=${BASELINE_ONLY}`);
console.log('NOTE: measures an UPPER BOUND (lesson↔task isomorphic). Severe test, not a powered test.\n');

// Phase 1: validate constructions + discover bug-sets
for (const spec of commits) {
  const v = validateConstruction(spec);
  if (!v.ok) { console.log(`  ✗ ${spec.hash}  UNUSABLE: ${v.reason}`); spec._skip = true; continue; }
  spec.bugSet = v.bugSet;
  console.log(`  ✓ ${spec.hash}  bug-set = ${v.bugSet.length}/${v.total} RED: ${v.bugSet.map((t) => t.slice(0, 40)).join(' | ')}`);
}
const usable = commits.filter((c) => !c._skip);
console.log(`\n${usable.length}/${commits.length} commits usable.`);
if (BASELINE_ONLY) { console.log('--baseline-only: stopping before any session.'); process.exit(0); }
if (!usable.length) process.exit(1);

// Phase 2: run sessions (resumable, bounded concurrency)
const results = loadResults();
const done = new Set(results.cells.map(cellKey));
const queue = [];
for (const spec of usable) for (const arm of ARMS) for (let s = 1; s <= K; s++) {
  if (!done.has(`${spec.hash}|${arm}|${s}`)) queue.push({ spec, arm, seed: s });
}
console.log(`${queue.length} sessions to run (${done.size} already done), concurrency=${CONCURRENCY}\n`);

let active = 0, idx = 0, completed = 0;
await new Promise((resolve) => {
  const pump = () => {
    if (idx >= queue.length && active === 0) return resolve();
    while (active < CONCURRENCY && idx < queue.length) {
      const job = queue[idx++]; active++;
      Promise.resolve().then(() => runArmSeed(job.spec, job.arm, job.seed)).then((cell) => {
        results.cells.push(cell); saveResults(results); active--; completed++;
        console.log(`  [${completed}/${queue.length}] ${cell.commit} arm ${cell.arm} #${cell.seed}: ` +
          (cell.pass === null ? `SKIP(${cell.note})` : cell.pass ? 'PASS' : 'FAIL') +
          (cell.arm === 'A' && cell.injected === false ? ' ⚠NOINJECT' : ''));
        pump();
      });
    }
  };
  pump();
});

// Phase 3: aggregate (commit-level)
console.log('\n── per-commit pass-rates (k=' + K + ') ──');
const perCommit = [];
for (const spec of usable) {
  const row = { commit: spec.hash };
  for (const arm of ARMS) {
    const cells = results.cells.filter((c) => c.commit === spec.hash && c.arm === arm && c.pass !== null);
    row[arm] = { n: cells.length, pass: cells.filter((c) => c.pass === 1).length };
  }
  perCommit.push(row);
  const a = row.A, c = row.C;
  console.log(`  ${spec.hash}  A=${a?.pass}/${a?.n}  C=${c?.pass}/${c?.n}  Δ=${a && c && a.n && c.n ? (((a.pass / a.n) - (c.pass / c.n)) * 100).toFixed(0) + 'pp' : 'n/a'}`);
}
// commit-level paired mean Δ
const deltas = perCommit.filter((r) => r.A?.n && r.C?.n).map((r) => (r.A.pass / r.A.n) - (r.C.pass / r.C.n));
const meanD = deltas.length ? deltas.reduce((x, y) => x + y, 0) / deltas.length : null;
console.log(`\nCOMMIT-LEVEL mean Δ (A−C) = ${meanD == null ? 'n/a' : (meanD * 100).toFixed(1) + 'pp'} over ${deltas.length} commits.`);
console.log('UPPER BOUND. No significance claimed (step-2 power). NULL/near-0 here = strong negative; large + = on-topic injection works (not realistic efficacy).');
saveResults(results);
