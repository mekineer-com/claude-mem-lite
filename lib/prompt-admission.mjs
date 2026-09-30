// lib/prompt-admission.mjs — which prompts the UserPromptSubmit recall faces search on at all.
//
// That event fires two hooks: scripts/user-prompt-search.js (path A, the FYI block) and
// `hook.mjs user-prompt` (path B, the <memory-context> blocks). Path A has rejected
// no-topic shapes since v2.43 through `shouldSkip`; path B ran both of its arms on them,
// so `continue`, `继续` or a bare slash command pulled whatever row shared the word
// (issue #39). The shape rules live here so the two faces cannot drift apart again —
// the same reason lib/ups-query.mjs holds the one query cap.
//
// A LEAF, deliberately, with no imports: scripts/pre-tool-recall.js loads
// prompt-search-utils.mjs on every Read/Edit, and anything imported here rides along.

// ─── No-topic shapes ────────────────────────────────────────────────────────

const CONFIRM_RE = /^(y(es)?|no?|ok|done|go|sure|lgtm|thanks?|ty|继续|确认|好的|是的|对|嗯|行|可以|没问题)$/i;
const SLASH_CMD_RE = /^\//;
const PURE_OP_RE = /^(git\s+(commit|push|merge)|npm\s+(publish|deploy))\b/i;

// v2.43.x: pure continuation directives — "keep going on what you were doing"
// with no new topic. Long enough to evade CONFIRM_RE / length gate but
// semantically empty for memory-recall purposes; injecting [mem] context
// here reads like a turn boundary and can prematurely end the model's
// in-flight tool chain. Conservative match: must be SOLELY the directive,
// not directive + new instruction (those keep getting injection).
const CONTINUATION_RE =
  /^(继续|接着|继续做|接着做|继续干|继续做下一步|接着做下一步|别停|不要停|next|continue|go\s*on|keep\s+going|carry\s+on|proceed|more(?:\s+please)?)\s*[?？!！。.，,]*\s*$/i;

// v2.43.x: meta-pause questions — user is asking the model to reflect on
// its own pause/stop, then continue. No new topic = no useful memory hit;
// injection just adds reminder noise on top of an already-reflective turn.
const META_PAUSE_RE =
  /(怎么停|为什么停|为何停|你怎么停|工作停下来|刚才停|why\s+(?:did\s+you\s+)?(?:stop|pause|halt))/i;

/**
 * True when the prompt carries no topic by construction: a confirmation, a slash command,
 * a pure git/npm operation, a bare continuation, or a question about the model's own pause.
 * Length is NOT judged here — the two faces floor length differently, on purpose (path A
 * weights CJK x3 and needs 8; path B admits 2-char CJK).
 */
export function isNoTopicShape(text) {
  if (!text) return false;
  const trimmed = text.trim();
  return (
    CONFIRM_RE.test(trimmed) ||
    SLASH_CMD_RE.test(trimmed) ||
    PURE_OP_RE.test(trimmed) ||
    CONTINUATION_RE.test(trimmed) ||
    META_PAUSE_RE.test(trimmed)
  );
}

// ─── Path B length floor ────────────────────────────────────────────────────

/**
 * Path B's minimum prompt length, shared by its observation and events arms (the events arm
 * had none, so `1` reached the events search).
 *
 * The floor is English-centric: 5 chars ≈ one short English word. A CJK query is meaningful
 * at 2 chars (状态/架构) and most real Chinese queries are 2-4 chars (状态管理, 召回率,
 * 熔断降级) — a bare `.length < 5` silently rejected ALL of them, so a Chinese-primary user
 * got zero memory injection. So the 5-char floor applies only to non-CJK queries; CJK
 * needs >= 2.
 */
export function meetsRecallLengthFloor(text) {
  if (!text) return false;
  const hasCjk = /[一-鿿㐀-䶿]/.test(text);
  return text.length >= (hasCjk ? 2 : 5);
}
