// Analysis core for the value A/B experiment.
//
// Pure functions only — given per-run records, produce the paired
// control-vs-treatment summary, deterministic bootstrap confidence intervals,
// and the falsifiable decision rule. No I/O, no claude spawn, no Date/random
// outside the seeded PRNG, so results are reproducible and unit-testable.
//
// A "run record" is one task × one arm × one trial:
//   { taskId, arm: 'control'|'treatment'|'shuffled', trial, recurred: bool,
//     tokens: number, toolCalls: number, wallClockMs?: number }

/** Deterministic PRNG (mulberry32) — seeded so bootstrap CIs are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Aggregate one arm's trials into rates/averages. */
function aggregateArm(records) {
  return {
    trials: records.length,
    recurredRate: mean(records.map((r) => (r.recurred ? 1 : 0))),
    tokens: mean(records.map((r) => r.tokens)),
    toolCalls: mean(records.map((r) => r.toolCalls)),
  };
}

/**
 * Group run records by task, average over trials per arm, and compute paired
 * treatment-minus-control deltas. Tasks missing either control or treatment are
 * dropped (an incomplete pair can't be compared) and reported in `dropped`.
 */
export function pairedSummary(runs) {
  const byTask = new Map();
  for (const r of runs) {
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, { control: [], treatment: [], shuffled: [] });
    const bucket = byTask.get(r.taskId);
    if (bucket[r.arm]) bucket[r.arm].push(r);
  }

  const perTask = [];
  const dropped = [];
  for (const [taskId, arms] of byTask) {
    if (!arms.control.length || !arms.treatment.length) {
      dropped.push(taskId);
      continue;
    }
    const control = aggregateArm(arms.control);
    const treatment = aggregateArm(arms.treatment);
    const row = {
      taskId,
      control,
      treatment,
      recurrenceDelta: treatment.recurredRate - control.recurredRate,
      tokenDelta: treatment.tokens - control.tokens,
      toolCallDelta: treatment.toolCalls - control.toolCalls,
    };
    if (arms.shuffled.length) {
      row.shuffled = aggregateArm(arms.shuffled);
      row.shuffledRecurrenceDelta = row.shuffled.recurredRate - control.recurredRate;
    }
    perTask.push(row);
  }

  return {
    perTask,
    dropped,
    means: {
      recurrenceDelta: mean(perTask.map((t) => t.recurrenceDelta)),
      tokenDelta: mean(perTask.map((t) => t.tokenDelta)),
      toolCallDelta: mean(perTask.map((t) => t.toolCallDelta)),
    },
  };
}

/**
 * Bootstrap confidence interval for the mean of `values`. Deterministic for a
 * fixed seed. Resamples with replacement `iterations` times; the CI is the
 * [alpha/2, 1-alpha/2] percentile band of the resample means.
 */
export function bootstrapCI(values, { seed = 12345, iterations = 10000, alpha = 0.05 } = {}) {
  if (!values.length) return { mean: null, lo: null, hi: null };
  const rand = mulberry32(seed);
  const n = values.length;
  const means = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[(rand() * n) | 0];
    means[i] = sum / n;
  }
  means.sort((x, y) => x - y);
  const loIdx = Math.floor((alpha / 2) * iterations);
  const hiIdx = Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations) - 1);
  return { mean: mean(values), lo: means[loIdx], hi: means[hiIdx] };
}

/**
 * Apply the falsifiable decision rule from the audit's provingExperiment.
 *
 * Claim "improves coding outcomes" ONLY when repeat-bug recurrence is
 * significantly reduced (recurrence-delta CI entirely below 0) AT non-positive
 * net token cost (token-delta CI upper bound ≤ 0). If recurrence is reduced but
 * tokens are higher/inconclusive → mixed. If recurrence is not significantly
 * reduced → unproven (the honest "retrieval-only" state). A shuffled-memory arm
 * that reproduces the treatment effect means any extra context primed the model,
 * not retrieval — that confounds the claim regardless of the headline verdict.
 */
export function decideOutcome({ recurrenceDeltaCI, tokenDeltaCI, shuffled }) {
  const recurrenceSignificantlyReduced =
    recurrenceDeltaCI.hi !== null && recurrenceDeltaCI.hi < 0;
  const tokenNonPositive = tokenDeltaCI.hi !== null && tokenDeltaCI.hi <= 0;

  let verdict;
  if (!recurrenceSignificantlyReduced) verdict = 'unproven';
  else if (tokenNonPositive) verdict = 'improves-outcomes';
  else verdict = 'mixed';

  let confounded = false;
  if (shuffled?.recurrenceDeltaCI && recurrenceDeltaCI.mean !== null) {
    const sh = shuffled.recurrenceDeltaCI;
    confounded =
      sh.hi !== null && sh.hi < 0 &&
      Math.abs(sh.mean) >= 0.5 * Math.abs(recurrenceDeltaCI.mean);
  }

  const claimAllowed = verdict === 'improves-outcomes' && !confounded;

  const rationale =
    verdict === 'improves-outcomes' && !confounded
      ? 'Repeat-bug recurrence significantly reduced at non-positive net token cost, and the shuffled-memory control did not reproduce the effect — retrieval-specific outcome lift.'
      : confounded
        ? 'Recurrence dropped, but the shuffled-memory arm reduced it comparably — the gain is from extra context priming, not relevant retrieval. Claim not supported.'
        : verdict === 'mixed'
          ? 'Repeat-bug recurrence dropped, but net token cost is positive or inconclusive — outcome lift exists but is not free.'
          : 'No statistically significant reduction in repeat-bug recurrence — report "improves retrieval relevance, no measured downstream coding-outcome lift".';

  return {
    verdict,
    claimAllowed,
    confounded,
    recurrenceSignificantlyReduced,
    tokenNonPositive,
    rationale,
  };
}
