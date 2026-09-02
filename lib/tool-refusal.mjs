// Did this tool call fail because a PROGRAM failed, or because the agent's own
// tool chain said no?
//
// WHY THIS EXISTS. Claude Code delivers host-flagged tool failures to the
// `PostToolUseFailure` event (D#170), which is where error-recall gets its coverage of
// real failures. But that event fires for EVERY failed call, and a large share of them
// are not failures at all in the sense that matters here — they are guardrails working:
// a §8 SAFETY hook denying an `rm -rf $VAR`, a sandbox refusing a syscall, a policy hook
// steering a `grep` to the AST tool. Measured over 1110 transcripts, 558 of 810
// host-flagged Bash failures (68.9%) were of that kind — one number, re-measured with the
// shipped predicate after review found two irreconcilable figures in this file and the
// CHANGELOG. Reproduce with `node benchmark/error-recall-live-replay.mjs --host-failures`,
// which now buckets by the gate's own reason instead of lumping refusals with empties.
//
// Recalling a past lesson because a permission prompt was declined is noise by
// construction, and on the lowest-cited injection surface in the system it is the kind of
// noise that discredits the rest.
//
// THE ERROR DIRECTIONS ARE NOT SYMMETRIC, and the list below is tuned accordingly:
//
//   false "refusal"  → we stay silent on a real failure. Costs nothing beyond the
//                      status quo, which is silence for every host-flagged failure.
//   missed refusal   → we inject three memories about a denied permission prompt.
//
// So every entry is anchored on a tool-chain marker — a bracketed plugin tag, a spec
// section marker, a sandbox syscall name — rather than a generic word like "denied" or
// "permission", which real programs print constantly (`chmod`, `docker`, `sudo`, HTTP
// 403 handlers).
//
// "NO ORDINARY PROGRAM EMITS THESE" IS TOO STRONG, AND REVIEW MEASURED IT. Over the same
// 1110-transcript corpus, three sentinels appear in the stdout of SUCCESSFUL commands:
// `[claudemd]` (21), `No such tool available` (10), `requested permission(s) to use` (7)
// — mostly this repo's own test runners printing hook output. When such a runner FAILS,
// the gate swallows a real failure. That is the cheap direction (see above), but the
// claim is "anchored on a marker real programs rarely emit", not "never".
//
// Two of those three (`[claudemd]`, `requested permissions? to use`) had ZERO matches
// among the 558 actual refusals in that corpus — they are speculative, covering hook
// stacks other than this one, and today they pay only their false-positive cost. Kept
// deliberately: a user running those hooks gets the protection, and the cost is silence
// on a failure that was already silent before this event existed. Delete them if a
// measurement ever shows them costing more than that.
//
// THIS RATIO IS ONE MACHINE'S PROFILE. 68.9% is what the maintainer's own hook stack
// produces; a user with no policy hooks will see close to 0%. The filter is correctness
// for whoever has those hooks, not a tuning constant — do not treat the percentage as a
// property of the product.

/**
 * Sentinels that identify a refusal emitted by the agent's own tool chain.
 * Ordered roughly by observed frequency; the array is small enough that order is
 * cosmetic.
 */
export const REFUSAL_SENTINELS = [
  // Sandbox / seccomp layers refusing to run the command at all.
  /apply-seccomp: unshare\(/,
  /sandbox\.excludedCommands/,
  // Spec / policy hooks (claudemd and friends) denying a command by rule. Anchored on
  // the SECTION MARKER at the start of the text, not on the one section that was found
  // first: pre-release review scanned the same corpus and found the family is wider than
  // `§8` — `§7 Ship-baseline` (a policy hook blocking `git push`), `§11 MEMORY.md`,
  // `§10-V Specificity`, `§10-V prose scan`. The `§7` shape alone was 13 of 135 firing
  // cases (9.6%), and it does not merely waste a slot: its own boilerplate becomes the
  // query, so `git push` blocked by a red-CI rule injected three memories about
  // statusline adoption. The other three shapes were silent only because
  // planErrorRecall found no term in them — luck, not this gate.
  //
  // `§` followed by a digit at the very start of the failure text is a spec citation. No
  // compiler, runtime or CLI opens its stderr that way.
  /^\s*§\s*\d/,
  /§\d[\w.-]*\s+[A-Z][\w-]*[^\n]{0,60}:\s/,
  /\[claudemd\]/,
  // Plugin hooks that deny-and-redirect rather than let the command run.
  /\[code-graph\][^\n]{0,80}denied/i,
  // Host-level refusals: the tool was not available in this context.
  /No such tool available/i,
  /\bis not available to you as the coordinator\b/i,
  // The human said no. Not a program failure, and re-asking with a recalled memory
  // attached is the wrong response to it.
  /user doesn'?t want to (?:take this action|proceed)/i,
  /requested permissions? to use/i,
];

/**
 * @param {string} text The failure text (`error` on a PostToolUseFailure payload).
 * @returns {boolean} true when the failure came from the tool chain, not the program.
 */
export function isToolChainRefusal(text) {
  if (typeof text !== 'string' || !text) return false;
  return REFUSAL_SENTINELS.some((re) => re.test(text));
}

/**
 * Should error-recall run for this failed tool call?
 *
 * Three reasons to stay silent, each for a different kind of "this is not a program
 * failure I can recall anything useful about":
 *
 *  - `is_interrupt` — the HOST's own flag for "the user stopped it". A cancelled
 *    command has no failure to explain, and this is the one discriminator that comes
 *    from the host rather than from pattern-matching its text.
 *  - a tool-chain refusal (above).
 *  - nothing to read: an empty or near-empty error string cannot produce query terms,
 *    and the 10-character floor matches the one PostToolUse already applies to
 *    `tool_response` so the two entry points do not disagree about what "no output"
 *    means.
 *
 * @param {{error?: string, is_interrupt?: boolean}} payload
 * @returns {{ok: boolean, reason?: string}}
 */
export function shouldRecallOnFailure(payload) {
  if (payload?.is_interrupt === true) return { ok: false, reason: 'interrupt' };
  const text = typeof payload?.error === 'string' ? payload.error : '';
  if (text.length < 10) return { ok: false, reason: 'empty' };
  if (isToolChainRefusal(text)) return { ok: false, reason: 'refusal' };
  return { ok: true };
}
