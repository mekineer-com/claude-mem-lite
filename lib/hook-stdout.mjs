// lib/hook-stdout.mjs — one hook process, at most ONE JSON document on stdout.
//
// Claude Code parses a command hook's stdout as a SINGLE JSON document. From the
// 2.1.233 bundle, the whole parser is:
//
//   function Hxi(e) {
//     let t = e.trim();
//     if (!t.startsWith("{")) return { plainText: e };   // whole stdout = prose
//     try { let r = XZf(t); ... }                        // JSON.parse(WHOLE stdout) + zod
//     catch (r) { return { plainText: e } }              // ← throw ⇒ whole stdout = prose
//   }
//
// There is no line splitting anywhere in it. That matters because this codebase
// had assumed the opposite ("Claude Code's line-based JSON parser", hook.mjs
// flushEpisode) and shipped surfaces that emit two envelopes, or an envelope
// plus a raw block, on one stdout. Both shapes make JSON.parse throw, so:
//
//   • SessionStart / UserPromptSubmit / UserPromptExpansion — the plainText is
//     injected verbatim, so the model receives `{"suppressOutput":true,…}` as
//     literal escaped text and suppressOutput is never honoured.
//   • every other event — the renderer returns [] for plain text, so BOTH
//     receipts are dropped in silence.
//
// So contributions are queued and written once. Callers keep their own gating
// (RECEIPT_EVENTS, significance, etc.); this only owns the writing.

let parts = [];
let queuedEvent = null;

/**
 * Queue a contribution to this process's single stdout envelope.
 *
 * @param {string} hookEventName Event name for hookSpecificOutput.
 * @param {string} text additionalContext contribution; empty/blank is ignored.
 * @returns {void}
 */
export function queueHookContext(hookEventName, text) {
  if (!hookEventName) return;
  const body = String(text ?? '').trim();
  if (!body) return;
  // Mixed event names cannot be merged — Claude Code throws when
  // hookSpecificOutput.hookEventName does not match the event it dispatched.
  // In practice one process serves one event; keep the first and drop the
  // stragglers rather than emit an envelope the host rejects outright.
  if (queuedEvent && queuedEvent !== hookEventName) return;
  queuedEvent = hookEventName;
  parts.push(body);
}

/**
 * Write the queued contributions as one envelope. Idempotent: a second call
 * with nothing queued writes nothing, so calling it from both the dispatcher
 * and an exit backstop is safe.
 *
 * @param {{write?: (s: string) => void}} [deps]
 * @returns {boolean} true when an envelope was written.
 */
export function flushHookStdout(deps = {}) {
  if (!queuedEvent || parts.length === 0) return false;
  const write = deps.write || ((s) => process.stdout.write(s));
  const payload = JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: queuedEvent,
      additionalContext: parts.join('\n\n'),
    },
  }) + '\n';
  parts = [];
  queuedEvent = null;
  write(payload);
  return true;
}

/** Test seam: forget anything queued but not yet written. */
export function resetHookStdout() {
  parts = [];
  queuedEvent = null;
}

/** Test seam: what is queued right now. */
export function peekHookStdout() {
  return { hookEventName: queuedEvent, parts: [...parts] };
}
