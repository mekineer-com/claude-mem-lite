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
let systemParts = [];

/**
 * Queue a contribution to this process's single stdout envelope.
 *
 * @param {string} hookEventName Event name for hookSpecificOutput.
 * @param {string} text additionalContext contribution; empty/blank is ignored.
 * @param {{warn?: (msg: string) => void}} [deps]
 * @returns {void}
 */
export function queueHookContext(hookEventName, text, deps = {}) {
  if (!hookEventName) return;
  const body = String(text ?? '').trim();
  if (!body) return;
  // Mixed event names cannot be merged — Claude Code throws when
  // hookSpecificOutput.hookEventName does not match the event it dispatched.
  // In practice one process serves one event; keep the first and drop the
  // stragglers rather than emit an envelope the host rejects outright.
  //
  // The drop is NOISY on purpose. It is unreachable today (all call sites are
  // event-consistent), but flushEpisode's hookEventName DEFAULTS to 'PostToolUse',
  // so a future caller that omits the argument would both mis-tag its receipt and
  // have it swallowed without a trace. Silently vanishing work is this repo's
  // most-repeated defect class; stderr is safe here because the host never parses it
  // as the envelope.
  if (queuedEvent && queuedEvent !== hookEventName) {
    const warn = deps.warn || ((m) => { try { process.stderr.write(m); } catch { /* never block on a warning */ } });
    warn(`[claude-mem-lite] hook-stdout: dropped a ${hookEventName} contribution — this process `
      + `already queued ${queuedEvent}, and one envelope carries exactly one hookEventName. `
      + 'This is a wiring bug: the contribution is lost.\n');
    return;
  }
  queuedEvent = hookEventName;
  parts.push(body);
}

/**
 * Queue a line for the HUMAN, not the model.
 *
 * Claude Code renders a command hook's top-level `systemMessage` as its own
 * `hook_system_message` conversation message, independently of
 * `hookSpecificOutput.additionalContext` — verified in the 2.1.234 bundle
 * (`if (G.systemMessage) { … yield { message: yc({ type: "hook_system_message", … }) } }`)
 * and documented there as "Display a message to the user (all hooks)". One envelope
 * can therefore carry context for the model AND a notice for the user.
 *
 * Needed because v3.70.0's merge folded the update banner into additionalContext with
 * `suppressOutput: true`, which kept its content and lost its audience.
 *
 * @param {string} text Notice for the user; empty/blank is ignored.
 * @returns {void}
 */
export function queueHookSystemMessage(text) {
  const body = String(text ?? '').trim();
  if (!body) return;
  systemParts.push(body);
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
  const hasContext = queuedEvent && parts.length > 0;
  const hasSystem = systemParts.length > 0;
  if (!hasContext && !hasSystem) return false;
  const write = deps.write || ((s) => process.stdout.write(s));
  const envelope = { suppressOutput: true };
  if (hasSystem) envelope.systemMessage = systemParts.join('\n');
  // Omitted entirely when there is no model-facing context: Stop's schema REJECTS a
  // hookSpecificOutput block, and an envelope carrying only a user notice must not
  // invent an event name to hang one on.
  if (hasContext) {
    envelope.hookSpecificOutput = {
      hookEventName: queuedEvent,
      additionalContext: parts.join('\n\n'),
    };
  }
  parts = [];
  queuedEvent = null;
  systemParts = [];
  write(JSON.stringify(envelope) + '\n');
  return true;
}

/** Test seam: forget anything queued but not yet written. */
export function resetHookStdout() {
  parts = [];
  queuedEvent = null;
  systemParts = [];
}

/** Test seam: what is queued right now. */
export function peekHookStdout() {
  return { hookEventName: queuedEvent, parts: [...parts], systemParts: [...systemParts] };
}
