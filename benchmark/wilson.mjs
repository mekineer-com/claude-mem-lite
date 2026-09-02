// Wilson score interval — the one copy.
//
// Three benchmarks needed a binomial CI and two of them had already hand-copied the
// same eight lines (`cite-recall.mjs`, `efficacy-observational.mjs`). The arithmetic
// is standard and neither copy was wrong, so this is not a bugfix; it is the same
// discipline `OBS_ID_DIGITS` records for the `#NN` caliber — two hand-maintained
// copies of a number-producing rule drift silently, and nothing errors when they do.

/**
 * 95% Wilson score confidence interval for a binomial proportion.
 *
 * Preferred over the normal approximation here because these samples are small and
 * often near 0 (`error_recall` sits at ~6%): the Wald interval goes negative there
 * and reports a lower bound no reader believes.
 *
 * @param {number} successes
 * @param {number} trials
 * @returns {[number, number]} [lo, hi] clamped to [0, 1]; [0, 0] when trials === 0.
 */
export function wilson95(successes, trials) {
  if (trials === 0) return [0, 0];
  const p = successes / trials;
  const z = 1.96;
  const denom = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
