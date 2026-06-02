// Outcome-signal extraction for one experiment run. Pure functions over the
// shapes produced by `claude -p`: the final JSON result (for token usage) and
// the stream-json event array (for tool-call counts), plus the task's
// regression-check exit code (for repeat-bug recurrence).

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];

/** Total tokens for a claude json result. Missing fields count as 0. */
export function extractTokens(result) {
  const usage = result?.usage;
  if (!usage) return 0;
  return USAGE_FIELDS.reduce((sum, k) => sum + (Number(usage[k]) || 0), 0);
}

/** Count `tool_use` content blocks across assistant events in a stream-json transcript. */
export function countToolUses(events) {
  if (!Array.isArray(events)) return 0;
  let n = 0;
  for (const ev of events) {
    if (ev?.type !== 'assistant') continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block?.type === 'tool_use') n++;
  }
  return n;
}

/**
 * Did the previously-captured bug recur? The task's regression check is written
 * to PASS (exit 0) when the bug is absent, so a non-zero exit means the agent
 * reintroduced or failed to avoid it.
 */
export function recurredFromCheck({ exitCode }) {
  return exitCode !== 0;
}
