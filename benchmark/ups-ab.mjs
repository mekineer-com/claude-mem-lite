#!/usr/bin/env node
// UPS-path A/B harness for the identifier-exact-match floor-bypass.
//
// WHY THIS EXISTS — denoise-ab.mjs drives searchObservationsHybrid (the CLI/MCP
// SEARCH path) and CANNOT see UserPromptSubmit-hook levers (TOP_REL_FLOOR /
// OR_TOP_BM25_FLOOR / cite_factor / signal-gate) — a UPS-gate edit reads NEUTRAL there
// because the code never runs (see denoise-ab.mjs SCOPE note, verified 2026-06-29).
// This harness closes that gap: it drives the REAL scripts/user-prompt-search.js as a
// subprocess (exactly as the hook runs it) on a labeled query set, so a UPS-path lever
// is measured on the path it actually lives in.
//
// It runs BOTH arms in one invocation via the env flag — control = bypass OFF,
// treatment = bypass ON — so no save/compare round-trip is needed:
//
//   node benchmark/ups-ab.mjs                       # both arms + verdict
//   node benchmark/ups-ab.mjs --queries <file.json> # custom labeled set
//   node benchmark/ups-ab.mjs --json                # machine-readable
//
// Metrics (per arm):
//   positives      — recall: fraction of each query's expected obs that got injected,
//                    + hits: # of positives whose expected obs ALL surfaced.
//   hard_negatives — noise: # of injected obs that were NOT expected (ideal 0), across
//                    identifier-tangential queries + signal-less prose (bypass must not fire).
//
// Verdict (treatment vs control): NET-POSITIVE (recall up, precision flat) /
// TRADEOFF (both move) / REJECT (precision down, no recall gain) / NEUTRAL.
//
// Runs against the REAL DB (the labeled obs ids are live; see fixture _meta). Dev
// tooling only — not shipped in SOURCE_FILES, no release impact.

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RUNTIME_DIR } from '../hook-shared.mjs';
import { inferProject } from '../utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'user-prompt-search.js');
const args = new Set(process.argv.slice(2));
const jsonOut = args.has('--json');

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const queryFile = argVal('--queries', join(__dirname, 'fixtures', 'ups-identifier-queries.json'));
const SUITE = JSON.parse(readFileSync(queryFile, 'utf8'));
const PROJECT = inferProject();
const DEDUP_FILE = join(RUNTIME_DIR, `.claude-mem-injected-${PROJECT}`);

// Inject ids the script surfaced for one prompt under one arm. Clears the per-project
// dedup cache first so back-to-back queries don't suppress each other (the cache
// regenerates on the next real hook fire — harmless to clear). Parses obs lines
// (^#NNN); ignores P#/S# (prompt/session) and all other output.
function injectedFor(prompt, bypass) {
  if (DEDUP_FILE && existsSync(DEDUP_FILE)) { try { rmSync(DEDUP_FILE); } catch { /* ignore */ } }
  let out = '';
  try {
    out = execFileSync('node', [SCRIPT], {
      input: JSON.stringify({ prompt, session_id: `ups-ab-${bypass}-${prompt.length}`, cwd: ROOT }),
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, CLAUDE_MEM_UPS_IDENTIFIER_BYPASS: bypass ? '1' : '0' },
    });
  } catch (e) { out = e.stdout || ''; }
  const ids = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^#(\d+)\b/);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

function runArm(bypass) {
  const positives = SUITE.positives.map(q => {
    const injected = injectedFor(q.query, bypass);
    const hit = q.expected_ids.every(id => injected.includes(id));
    const recall = q.expected_ids.length ? q.expected_ids.filter(id => injected.includes(id)).length / q.expected_ids.length : 1;
    return { query: q.query, expected: q.expected_ids, injected, hit, recall };
  });
  const negatives = SUITE.hard_negatives.map(q => {
    const injected = injectedFor(q.query, bypass);
    const noise = injected.filter(id => !q.expected_ids.includes(id));
    return { query: q.query, expected: q.expected_ids, injected, noise: noise.length };
  });
  const pos_hits = positives.filter(p => p.hit).length;
  const pos_recall = positives.reduce((s, p) => s + p.recall, 0) / (positives.length || 1);
  const neg_noise = negatives.reduce((s, n) => s + n.noise, 0);
  const neg_dirty = negatives.filter(n => n.noise > 0).length;
  return { positives, negatives, pos_hits, pos_recall, neg_noise, neg_dirty };
}

function pct(n) { return (100 * n).toFixed(0) + '%'; }

const control = runArm(false);
const treatment = runArm(true);

const recallGain = treatment.pos_hits - control.pos_hits;
const precisionCost = treatment.neg_noise - control.neg_noise;
let verdict;
if (recallGain > 0 && precisionCost <= 0) verdict = 'NET-POSITIVE';
else if (recallGain > 0 && precisionCost > 0) verdict = 'TRADEOFF (human judges worth)';
else if (recallGain <= 0 && precisionCost > 0) verdict = 'REJECT (precision down, no recall gain)';
else verdict = 'NEUTRAL (no movement)';

if (jsonOut) {
  console.log(JSON.stringify({ project: PROJECT, control, treatment, recallGain, precisionCost, verdict }, null, 2));
} else {
  const P = SUITE.positives.length, N = SUITE.hard_negatives.length;
  console.error(`\n─── UPS identifier-bypass A/B (project=${PROJECT}, ${P} positives / ${N} hard-negatives) ───`);
  console.error(`                    control (off)      treatment (on)`);
  console.error(`  positives hits    ${String(control.pos_hits).padStart(2)}/${P}  (recall ${pct(control.pos_recall)})      ${String(treatment.pos_hits).padStart(2)}/${P}  (recall ${pct(treatment.pos_recall)})`);
  console.error(`  hard-neg noise    ${control.neg_noise} obs (${control.neg_dirty}/${N} dirty)        ${treatment.neg_noise} obs (${treatment.neg_dirty}/${N} dirty)`);
  console.error(`\n  Δ recall(hits) = ${recallGain >= 0 ? '+' : ''}${recallGain}   Δ precision(noise) = ${precisionCost >= 0 ? '+' : ''}${precisionCost}`);
  console.error(`  VERDICT: ${verdict}`);
  console.error(`\n  Positives detail [✓=target surfaced]:`);
  for (let i = 0; i < control.positives.length; i++) {
    const c = control.positives[i], t = treatment.positives[i];
    const flip = (!c.hit && t.hit) ? '  ← RECOVERED' : (c.hit && !t.hit) ? '  ← LOST' : '';
    console.error(`    [${c.hit ? '✓' : '·'}→${t.hit ? '✓' : '·'}] exp #${c.expected.join(',')}  ctl=[${c.injected.join(',') || '—'}] trt=[${t.injected.join(',') || '—'}]${flip}`);
  }
  console.error(`\n  Hard-negatives detail [noise = injected obs not expected]:`);
  for (let i = 0; i < control.negatives.length; i++) {
    const c = control.negatives[i], t = treatment.negatives[i];
    const flip = (c.noise === 0 && t.noise > 0) ? '  ← NEW NOISE' : '';
    console.error(`    [${c.noise}→${t.noise}] ctl=[${c.injected.join(',') || '—'}] trt=[${t.injected.join(',') || '—'}]  "${c.query.slice(0, 42)}"${flip}`);
  }
}
