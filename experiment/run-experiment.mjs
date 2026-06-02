#!/usr/bin/env node
// Orchestrator for the value A/B experiment.
//
//   node experiment/run-experiment.mjs                 # DRY RUN — synthetic data, validates the whole pipeline
//   node experiment/run-experiment.mjs --live          # real claude runs (needs `claude` on PATH)
//   node experiment/run-experiment.mjs --trials 3 --out experiment/results.jsonl
//
// For each task × arm × trial it runs a trial and appends one JSON line to the
// results file. Dry-run injects deterministic mocks so the corpus → seed → run →
// check → results → analyze chain is exercised end-to-end WITHOUT a live claude;
// every dry-run record is tagged `"synthetic": true` so analyze refuses to treat
// it as a result.

import { readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTrial } from './lib/runner.mjs';
import { ARMS } from './lib/arms.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const a = { live: false, trials: null, out: join(HERE, 'results.jsonl'), corpus: join(HERE, 'corpus'), arms: ['control', 'treatment', 'shuffled'] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--live') a.live = true;
    else if (t === '--trials') a.trials = Number(argv[++i]);
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--corpus') a.corpus = argv[++i];
    else if (t === '--arms') a.arms = argv[++i].split(',').map((s) => s.trim());
  }
  if (a.trials === null || a.trials === undefined) a.trials = a.live ? 3 : 1;
  return a;
}

function loadCorpus(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.task.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// Deterministic mock deps for dry-run. Recurrence is stashed on the shared
// sandbox object so runCheck reflects what the (fake) agent did. The synthetic
// effect (treatment recurs less, hooks cost more tokens) only exists to exercise
// the analysis branches — it is NOT a finding.
function mockDeps() {
  return {
    now: () => 0,
    prepareSandbox: (task) => ({ cwd: `/dry/${task.id}`, dir: `/dry/${task.id}`, cleanup: () => {} }),
    seedDb: (task, arm) => (arm.seed === 'none' ? null : `/dry/${task.id}/mem.db`),
    claudeRunner: ({ task, arm, sandbox }) => {
      const h = fnv(`${task.id}:${arm.name}`);
      const recurProb = arm.name === 'treatment' ? 0.25 : 0.55;
      sandbox.__recurred = (h % 100) / 100 < recurProb;
      const tokens = 1500 + (arm.hooks ? 120 : 0) + (h % 200);
      const toolCalls = (arm.name === 'treatment' ? 9 : 12) + (h % 4);
      return {
        result: { usage: { input_tokens: tokens - 100, output_tokens: 100 } },
        events: Array.from({ length: toolCalls }, () => ({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } })),
      };
    },
    runCheck: (_task, sandbox) => ({ exitCode: sandbox.__recurred ? 1 : 0 }),
  };
}

async function buildDeps(args) {
  if (!args.live) return mockDeps();
  const { realDeps } = await import('./lib/real-deps.mjs');
  return realDeps({ repoRoot: REPO_ROOT, shuffledPool: loadShuffledPool(args.corpus), model: process.env.CLAUDE_MEM_EXPERIMENT_MODEL || 'sonnet' });
}

function loadShuffledPool(corpusDir) {
  const f = join(corpusDir, 'shuffled-pool.json');
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return []; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadCorpus(args.corpus);
  const deps = await buildDeps(args);
  const arms = args.arms.map((n) => ARMS[n]).filter(Boolean);

  writeFileSync(args.out, ''); // truncate
  let n = 0;
  console.log(`[experiment] ${args.live ? 'LIVE' : 'DRY-RUN (synthetic)'} — ${tasks.length} tasks × ${arms.length} arms × ${args.trials} trials`);
  for (const task of tasks) {
    for (const arm of arms) {
      for (let trial = 1; trial <= args.trials; trial++) {
        const rec = await runTrial({ task, arm, trial }, deps);
        rec.synthetic = !args.live;
        appendFileSync(args.out, JSON.stringify(rec) + '\n');
        n++;
        console.log(`  ${task.id} / ${arm.name} / t${trial}: recurred=${rec.recurred} tokens=${rec.tokens} tools=${rec.toolCalls}`);
      }
    }
  }
  console.log(`[experiment] wrote ${n} run records → ${args.out}`);
  if (!args.live) console.log('[experiment] DRY-RUN data is synthetic plumbing validation — run with --live for real measurements.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
