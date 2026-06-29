#!/usr/bin/env node
// Denoising A/B tradeoff harness.
//
// WHY THIS EXISTS — denoising levers (synonym gates, OR-fallback floors, signal
// gates, coverage thresholds) shift PRECISION and RECALL in OPPOSITE directions,
// and on DIFFERENT query populations:
//   • precision_hard_negatives (test-queries.json)        — precision-stressed
//   • vocab_mismatch_paraphrase (test-queries-vocab-mismatch.json) — recall-stressed
// The standing benchmark + ci-gate run only the first suite; the paraphrase suite
// lives in a separate recall-band test. So a lever that "improves precision" on
// suite 1 while cratering recall on suite 2 looks like a clean win on one screen
// and a mysterious regression on another. That split is how an OR-BM25 floor got
// shipped-then-reverted (2026-06-29): the precision upside and the recall downside
// were never weighed on the same screen.
//
// This harness runs BOTH suites on the production-hybrid path and reports one
// precision↔recall snapshot, A/B-comparable across a change. Workflow to evaluate
// a SEARCH-PATH denoising change (env-gated OR raw code edit) BEFORE shipping it
// (see SCOPE below — UserPromptSubmit/PreToolUse injection levers are NOT covered):
//
//   node benchmark/denoise-ab.mjs --save /tmp/before.json   # control (change off)
//   …apply the denoising change (flip a default-off flag, or edit code)…
//   node benchmark/denoise-ab.mjs --compare /tmp/before.json # treatment → verdict
//
// The verdict makes the tradeoff falsifiable: REJECT (recall regression, no gain),
// TRADEOFF (precision up / recall down — a human judges worth), NET-POSITIVE, or
// NEUTRAL. Dev tooling only — not shipped in SOURCE_FILES, no release impact.
//
// SCOPE — what runSnapshot actually exercises: searchProductionHybrid →
// searchObservationsHybrid (search-engine.mjs), i.e. the CLI/MCP SEARCH path. That
// covers query-construction + ranking levers: sanitizeFtsQuery synonym expansion,
// the AND→OR relaxation, and FULL_SCORE's decay/type/importance multipliers. It does
// NOT execute the UserPromptSubmit hook (scripts/user-prompt-search.js) or PreToolUse
// recall (scripts/pre-tool-recall.js). The INJECTION-decision levers that live only
// there — TOP_REL_FLOOR, OR_TOP_BM25_FLOOR, REQUIRE_EXPLICIT_SIGNAL, and the
// cite_factor multiplier (scoring-sql.mjs::citeFactorClause, absent from
// search-engine.mjs) — are therefore INVISIBLE to this harness: editing one and
// re-running reports NEUTRAL (all Δ=0) no matter its true effect (verified 2026-06-29
// by flipping the OR_TOP_BM25_FLOOR row-selection — zero metric movement). Evaluate
// those on the UPS/PTR path directly; cite_factor additionally needs a corpus with
// real citation history (cited_count / uncited_streak), which the fixtures lack.

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb } from '../tests/test-helpers.mjs';
import { seedDatabase, seedVectors, runBenchmark } from './benchmark.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

// The two query populations a denoising lever pulls in opposite directions.
export const SUITES = [
  { name: 'precision_hard_negatives', file: 'test-queries.json' },
  { name: 'vocab_mismatch_paraphrase', file: 'test-queries-vocab-mismatch.json' },
];

const METRICS = ['recall_at_10', 'precision_at_10', 'ndcg_at_10', 'mrr_at_10'];

function loadQueries(file) {
  const j = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  return Array.isArray(j) ? j : j.queries;
}

function round(n) { return Math.round(n * 1e4) / 1e4; }

/**
 * Run both suites on the given DB and capture the four ranking metrics (+ per
 * category breakdown) for each. The caller seeds the DB first so the same corpus
 * is reused across control/treatment runs.
 * @returns {Object} { [suiteName]: {recall_at_10, precision_at_10, ndcg_at_10, mrr_at_10, byCategory} }
 */
export function runSnapshot(db, { mode = 'production_hybrid' } = {}) {
  const out = {};
  for (const s of SUITES) {
    const r = runBenchmark(db, loadQueries(s.file), mode);
    out[s.name] = {
      recall_at_10: r.metrics.recall_at_10,
      precision_at_10: r.metrics.precision_at_10,
      ndcg_at_10: r.metrics.ndcg_at_10,
      mrr_at_10: r.metrics.mrr_at_10,
      byCategory: r.byCategory,
    };
  }
  return out;
}

/**
 * Compare two snapshots and classify the precision↔recall tradeoff. Pure — no DB.
 * A metric move ≥ +threshold is a gain; ≤ −threshold is a regression. The verdict
 * separates the case that bit us (recall regression with NO compensating gain →
 * REJECT) from a genuine precision/recall TRADEOFF a human must judge.
 * @returns {{suites:Array, gains:string[], regressions:string[], verdict:string}}
 */
export function summarizeTradeoff(before, after, { threshold = 0.02 } = {}) {
  const suites = [];
  const gains = [];
  const regressions = [];
  for (const name of Object.keys(after)) {
    if (!before[name]) continue;
    const deltas = { name };
    for (const m of METRICS) {
      const d = round((after[name][m] ?? 0) - (before[name][m] ?? 0));
      deltas[m] = d;
      if (d >= threshold) gains.push(`${name}.${m} +${d}`);
      else if (d <= -threshold) regressions.push(`${name}.${m} ${d}`);
    }
    suites.push(deltas);
  }
  let verdict;
  if (regressions.length && !gains.length) {
    verdict = `REJECT — regression(s) with no compensating gain: ${regressions.join('; ')}`;
  } else if (regressions.length && gains.length) {
    verdict = `TRADEOFF (judge worth) — gains: ${gains.join('; ')} | regressions: ${regressions.join('; ')}`;
  } else if (gains.length) {
    verdict = `NET-POSITIVE — ${gains.join('; ')}`;
  } else {
    verdict = `NEUTRAL — all |Δ| < ${threshold}`;
  }
  return { suites, gains, regressions, verdict };
}

function fmtSnapshot(snap) {
  const lines = [];
  for (const s of SUITES) {
    const m = snap[s.name];
    if (!m) continue;
    lines.push(`  ${s.name.padEnd(28)} R@10=${m.recall_at_10.toFixed(3)}  P@10=${m.precision_at_10.toFixed(3)}  nDCG=${m.ndcg_at_10.toFixed(3)}  MRR=${m.mrr_at_10.toFixed(3)}`);
  }
  return lines.join('\n');
}

function fmtDelta(d) {
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(3)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };
  const savePath = get('--save');
  const comparePath = get('--compare');
  const mode = get('--mode') || 'production_hybrid';

  const db = createTestDb();
  const seedData = JSON.parse(readFileSync(join(FIXTURES, 'seed-data.json'), 'utf8'));
  seedDatabase(db, seedData);
  seedVectors(db);
  const snap = runSnapshot(db, { mode });
  db.close();

  console.error(`\n─── Denoise A/B snapshot (${mode}, ${SUITES.length} suites) ───`);
  console.error(fmtSnapshot(snap));

  if (comparePath) {
    const before = JSON.parse(readFileSync(comparePath, 'utf8'));
    const { suites, verdict } = summarizeTradeoff(before, snap);
    console.error(`\n─── Δ vs ${comparePath} ───`);
    for (const d of suites) {
      console.error(`  ${d.name.padEnd(28)} ΔR@10=${fmtDelta(d.recall_at_10)}  ΔP@10=${fmtDelta(d.precision_at_10)}  ΔnDCG=${fmtDelta(d.ndcg_at_10)}  ΔMRR=${fmtDelta(d.mrr_at_10)}`);
    }
    console.error(`\n  VERDICT: ${verdict}\n`);
  }

  if (savePath) {
    writeFileSync(savePath, JSON.stringify(snap, null, 2));
    console.error(`\nSaved snapshot → ${savePath}\n`);
  }

  // JSON on stdout for scripting (logs go to stderr above).
  console.log(JSON.stringify(snap));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) main();
