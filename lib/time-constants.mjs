// lib/time-constants.mjs — millisecond time units, defined once.
//
// Four modules each carried their own `const DAY_MS` (deferred-work, metrics,
// err-sampler, hook-telemetry) with ~60 more bare 86400000 literals scattered
// across the runtime. The value cannot drift — that is not the problem. The
// problem is that a reader auditing a window ("is this 30 days or 30 hours?")
// had to re-derive the magic number at every site, and a grep for the policy
// returned a number rather than a name.
//
// Zero imports on purpose: lib/metrics.mjs and lib/err-sampler.mjs are sinks
// that must never crash or slow their callers, so anything they import has to
// stay a leaf.

// Kept internal rather than exported: only DAY_MS has runtime consumers today,
// and an export born with zero importers is how the knip baseline drifted
// 46→47 during v3.50–3.53 (DEFER_STALE_DAYS). Promote one when a caller needs it.
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export const DAY_MS = 24 * HOUR_MS;
