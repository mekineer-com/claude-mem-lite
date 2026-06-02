#!/usr/bin/env node
// Analyze experiment run records and emit a markdown report applying the
// falsifiable decision rule.
//
//   node experiment/analyze-results.mjs [results.jsonl]
//
// Reads JSONL produced by run-experiment.mjs, computes paired control-vs-
// treatment deltas with bootstrap CIs, and prints the verdict. If every record
// is synthetic (a dry-run), the report is loudly marked NOT A RESULT.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedSummary, bootstrapCI, decideOutcome } from './lib/stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const fmt = (x) => (x === null || x === undefined ? 'n/a' : (Math.round(x * 1000) / 1000).toString());
const ci = (c) => `${fmt(c.mean)}  [${fmt(c.lo)}, ${fmt(c.hi)}]`;

/** Pure: records → structured analysis. */
export function analyzeRecords(records, { seed = 12345 } = {}) {
  const summary = pairedSummary(records);
  const pick = (k) => summary.perTask.map((t) => t[k]).filter((v) => v !== null && v !== undefined);

  const recurrenceDeltaCI = bootstrapCI(pick('recurrenceDelta'), { seed });
  const tokenDeltaCI = bootstrapCI(pick('tokenDelta'), { seed });
  const toolCallDeltaCI = bootstrapCI(pick('toolCallDelta'), { seed });
  const shuffledVals = pick('shuffledRecurrenceDelta');
  const shuffled = shuffledVals.length
    ? { recurrenceDeltaCI: bootstrapCI(shuffledVals, { seed }) }
    : undefined;

  const decision = decideOutcome({ recurrenceDeltaCI, tokenDeltaCI, shuffled });
  return {
    nTasks: summary.perTask.length,
    nRecords: records.length,
    dropped: summary.dropped,
    synthetic: records.length > 0 && records.every((r) => r.synthetic),
    recurrenceDeltaCI,
    tokenDeltaCI,
    toolCallDeltaCI,
    shuffled,
    decision,
  };
}

export function formatReport(a) {
  const lines = [];
  lines.push('# Value A/B — Outcome Report\n');
  if (a.synthetic) {
    lines.push('> ⚠️ **DRY-RUN / SYNTHETIC DATA — NOT A RESULT.** This validates the harness plumbing only.');
    lines.push('> Re-run with `--live` against real `claude` runs and a real corpus before reporting any verdict.\n');
  }
  lines.push(`- Tasks analyzed (complete pairs): **${a.nTasks}**  |  run records: ${a.nRecords}`);
  if (a.dropped.length) lines.push(`- Dropped (incomplete pair): ${a.dropped.join(', ')}`);
  lines.push('');
  lines.push('| Metric (treatment − control) | mean [95% CI] | reading |');
  lines.push('|---|---|---|');
  lines.push(`| Repeat-bug recurrence Δ | ${ci(a.recurrenceDeltaCI)} | <0 = fewer repeats |`);
  lines.push(`| Net tokens Δ | ${ci(a.tokenDeltaCI)} | ≤0 = not more expensive |`);
  lines.push(`| Tool-calls Δ | ${ci(a.toolCallDeltaCI)} | <0 = fewer steps |`);
  if (a.shuffled) lines.push(`| Shuffled recurrence Δ (neg. control) | ${ci(a.shuffled.recurrenceDeltaCI)} | ≈ treatment ⇒ confounded |`);
  lines.push('');
  lines.push(`**Verdict:** \`${a.decision.verdict}\`${a.decision.confounded ? ' (confounded)' : ''}  |  claim allowed: **${a.synthetic ? 'N/A (synthetic)' : a.decision.claimAllowed}**`);
  lines.push('');
  lines.push(a.decision.rationale);
  return lines.join('\n');
}

function main() {
  const file = process.argv[2] || join(HERE, 'results.jsonl');
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(formatReport(analyzeRecords(records)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
