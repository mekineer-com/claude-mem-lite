// lib/handoff-constants.mjs — cross-session handoff policy, defined once.
//
// Moved out of `hook-shared.mjs` (audit 2026-09-05 P1-2): `lib/startup-dashboard.mjs`
// imported HANDOFF_EXPIRY_EXIT from the hook layer and thereby loaded the whole hook
// import graph for one number. These are policy values, not hook mechanism.
//
// Zero imports on purpose, the same reason `lib/time-constants.mjs` has none: a
// SessionStart-path module must not pay for a dependency to read a constant. (Units
// live there; the durations below are policy expressed in those units, so they are
// spelled out here rather than folded into that module.)

// Handoff system constants
export const HANDOFF_EXPIRY_CLEAR = 6 * 3600000; // 6 hours (covers lunch/meeting breaks)
export const HANDOFF_EXPIRY_EXIT = 7 * 24 * 60 * 60 * 1000; // 7 days
export const HANDOFF_ANCHOR_MAX_AGE = 72 * 3600000; // 72h cap on git_sha anchor — avoids stale-HEAD false positives
export const HANDOFF_MATCH_THRESHOLD = 3; // min weighted score

// Availability predicate for a stored handoff. Injecting one STAMPS `consumed_at`
// (hook-handoff.mjs::consumeHandoff) instead of deleting the row, so every pool that used
// to rely on the row simply being GONE has to say so now. Spelled once, here, because the
// five sites that need it are a decision and not a sweep:
//   - pickHandoffToInject (both arms)        — else the same row re-injects on prompts 2-3
//   - detectContinuationIntent Stage -1/0/2  — a consumed handoff is not resumable
//   - hook-context's "Working State (from /clear)" block
//   - startup-dashboard's "Continuation available" pointer, whose stated contract is to
//     only promise what the injection could actually deliver
// The one deliberate NON-site is hook.mjs's read-back immediately after buildAndSaveHandoff:
// it reads the row it just wrote, by exact PK, before anything could have consumed it.
export const UNCONSUMED_HANDOFF_SQL = 'consumed_at IS NULL';
export const CONTINUE_KEYWORDS =
  /继续|接着|上次|之前的|前面的|刚才|\bcontinue\b|\bresume\b|\bwhere[\s-]+we[\s-]+left\b|\bpick[\s-]+up\b|\bcarry[\s-]+on\b/i;
// Once a session has ended a turn of its own, a bare 继续 / continue / carry on means "go on"
// with THIS session's work. Only a prompt that names a PAST session resumes one then.
export const RESUME_PAST_KEYWORDS =
  /上次|上一次|上回|之前的会话|\bresume\b|\bwhere[\s-]+we[\s-]+left\b|\blast[\s-]+session\b|\bprevious[\s-]+session\b/i;
