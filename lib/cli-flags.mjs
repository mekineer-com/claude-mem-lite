// CLI numeric-flag validation helper.
//
// Extends the audit pattern from #8277 (Number.isInteger + range check) with a
// single reusable surface that also enforces upper bounds. The pre-existing
// 5-line parseInt boilerplate was duplicated across cmdSearch / cmdRecall /
// cmdBrowse / cmdTimeline / cmdExport — each maintainer drifted slightly,
// and none capped --limit, so `claude-mem-lite search "x" --limit 99999999`
// silently dumped the entire result set.
//
// Behavior contract:
//   - Returns defaultValue when rawValue is undefined/null/empty.
//   - On invalid input (non-integer, out of [min, max]), writes a single
//     stderr warning and returns defaultValue. Does NOT throw — calling code
//     keeps running with a sane fallback.
//   - Returns rawValue (parsed) only when it's a finite integer in range.
//
// Caller responsibilities: pick min/max that make sense for the flag's
// domain (e.g. --offset min=0; --limit max=1000; --importance min=1, max=3).

const DEFAULT_STDERR_WRITE = msg => process.stderr.write(msg);

/**
 * Validate and parse a CLI numeric flag with optional bounds.
 *
 * @param {string|number|undefined|null} rawValue Flag value as captured by parseArgs (or undefined when absent).
 * @param {object} opts
 * @param {string} opts.name Flag name with leading dashes (e.g. "--limit") for the warning text.
 * @param {number} opts.defaultValue Fallback when input is missing or invalid.
 * @param {number} [opts.min=1] Inclusive lower bound.
 * @param {number} [opts.max=Number.MAX_SAFE_INTEGER] Inclusive upper bound.
 * @param {(msg: string) => void} [opts.warn] Test seam — defaults to process.stderr.write.
 * @returns {number} Validated integer or defaultValue.
 */
export function parseIntFlag(rawValue, opts) {
  const { name, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER, warn = DEFAULT_STDERR_WRITE } = opts;

  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue;
  }

  const parsed = parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `≥ ${min}` : `between ${min} and ${max}`;
    warn(`[mem] Invalid ${name} "${rawValue}" (must be an integer ${range}); using default ${defaultValue}\n`);
    return defaultValue;
  }
  return parsed;
}
