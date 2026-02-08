#!/usr/bin/env node
// Benchmark CI gate — runs benchmark and fails if metrics regress below baseline thresholds.
// Usage: node benchmark/ci-gate.mjs [--tolerance 0.05]
//
// Exit codes: 0 = pass, 1 = regression detected

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse tolerance from CLI args (default: 5% relative regression allowed)
const toleranceIdx = process.argv.indexOf('--tolerance');
const tolerance = toleranceIdx !== -1 ? parseFloat(process.argv[toleranceIdx + 1]) : 0.05;

// Load baseline
const baselinePath = join(__dirname, 'baseline.json');
let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
} catch {
  console.error('No baseline.json found — run benchmark first to create one.');
  process.exit(1);
}

// Run benchmark (JSON on stdout, logs on stderr)
let results;
try {
  const stdout = execSync('node benchmark/benchmark.mjs', {
    cwd: join(__dirname, '..'),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  results = JSON.parse(stdout);
} catch (err) {
  console.error('Benchmark execution failed:', err.message);
  process.exit(1);
}

// Compare key metrics
const checks = [
  { name: 'Recall@10', key: 'recall_at_10' },
  { name: 'Precision@10', key: 'precision_at_10' },
  { name: 'nDCG@10', key: 'ndcg_at_10' },
  { name: 'MRR@10', key: 'mrr_at_10' },
];

const failures = [];
const passes = [];

for (const { name, key } of checks) {
  const base = baseline.metrics[key];
  const curr = results.metrics[key];
  const threshold = Math.max(0, base - tolerance);
  const diff = curr - base;
  const diffStr = diff >= 0 ? `+${diff.toFixed(4)}` : diff.toFixed(4);

  if (curr < threshold) {
    failures.push({ name, base, curr, threshold, diffStr });
  } else {
    passes.push({ name, base, curr, diffStr });
  }
}

// Latency check (allow 2x regression)
const baseLat = baseline.metrics.p95_search_latency_ms;
const currLat = results.metrics.p95_search_latency_ms;
if (currLat > baseLat * 2) {
  failures.push({ name: 'P95 Latency', base: baseLat, curr: currLat, threshold: baseLat * 2, diffStr: `+${(currLat - baseLat).toFixed(4)}ms` });
} else {
  passes.push({ name: 'P95 Latency', base: baseLat, curr: currLat, diffStr: `${(currLat - baseLat).toFixed(4)}ms` });
}

// Report
console.log('\n── Benchmark CI Gate ──');
console.log(`Tolerance: ${(tolerance * 100).toFixed(1)}% | Baseline: ${baseline.timestamp}\n`);

for (const p of passes) {
  console.log(`  PASS  ${p.name}: ${p.curr} (baseline ${p.base}, ${p.diffStr})`);
}
for (const f of failures) {
  console.log(`  FAIL  ${f.name}: ${f.curr} < ${f.threshold} (baseline ${f.base}, ${f.diffStr})`);
}

if (failures.length > 0) {
  console.log(`\n  ${failures.length} metric(s) regressed beyond tolerance.`);
  process.exit(1);
} else {
  console.log('\n  All metrics within tolerance.');
  process.exit(0);
}
