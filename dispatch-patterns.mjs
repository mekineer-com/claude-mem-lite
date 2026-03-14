// claude-mem-lite: Failure pattern detection for pain-point dispatch
// Detects when Claude is struggling (repeated test failures, same errors, blind editing)
// and signals the dispatch system to recommend resources at the right moment.

import { EDIT_TOOLS } from './utils.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

const WINDOW_SIZE = 20;

const TEST_CMD_RE = /\b(test|jest|vitest|pytest|mocha|cypress|playwright|cargo\s+test|go\s+test)\b/i;
const TEST_FAIL_RE = /\bfail|error|FAIL|Error|panic|exception/i;
const ERROR_CLASS_RE = /\b(type\s*error|syntax\s*error|reference\s*error|module\s*not\s*found|TS\d{4}|E\d{4}|error\s+\w+:)/i;
const VERIFY_CMD_RE = /\b(test|jest|vitest|pytest|lint|eslint|tsc|typecheck|build)\b/i;

// Read-only tools that don't break a blind-editing streak
const PASSIVE_TOOLS = new Set(['Read', 'Glob', 'Grep']);

// ─── Pattern Detection ───────────────────────────────────────────────────────

/**
 * Detect failure patterns in recent session events.
 * Analyzes a sliding window of the last 20 events to identify when Claude
 * is struggling with repeated failures or blind editing.
 *
 * @param {Array<{tool_name: string, tool_input?: object, tool_response?: string}>} events
 *   Array of session events (tool invocations with name, input, and response)
 * @returns {{ pattern: string, resource_intent: string, confidence: number } | null}
 *   Detected pattern with recommended resource intent and confidence, or null
 */
export function detectFailurePattern(events) {
  if (!events || events.length === 0) return null;

  // Only consider the last WINDOW_SIZE events
  const window = events.slice(-WINDOW_SIZE);

  // Check patterns in priority order
  return detectRepeatedTestFail(window)
    || detectRepeatedBashError(window)
    || detectBlindEditing(window);
}

// ─── Pattern: repeated-test-fail ─────────────────────────────────────────────

/**
 * Detect (Edit → Bash[test fail]) cycles appearing 2+ times.
 * An edit tool followed by a Bash command that runs tests and fails.
 */
function detectRepeatedTestFail(window) {
  let cycles = 0;
  let sawEdit = false;

  for (const event of window) {
    const tool = event.tool_name;

    if (EDIT_TOOLS.has(tool)) {
      sawEdit = true;
      continue;
    }

    if (sawEdit && tool === 'Bash') {
      const cmd = event.tool_input?.command || '';
      const resp = event.tool_response || '';
      if (TEST_CMD_RE.test(cmd) && TEST_FAIL_RE.test(resp)) {
        cycles++;
        sawEdit = false;
        continue;
      }
    }

    // Non-edit, non-matching-bash resets the edit flag
    // (but keep counting if we see more edits later)
    if (!EDIT_TOOLS.has(tool)) {
      sawEdit = false;
    }
  }

  if (cycles < 2) return null;

  return {
    pattern: 'repeated-test-fail',
    resource_intent: 'fix',
    confidence: 0.7 + Math.min(cycles - 2, 3) * 0.1,
  };
}

// ─── Pattern: repeated-bash-error ────────────────────────────────────────────

/**
 * Detect 3+ Bash errors (test failures or compilation errors) in the window.
 */
function detectRepeatedBashError(window) {
  let errorCount = 0;

  for (const event of window) {
    if (event.tool_name !== 'Bash') continue;
    const resp = event.tool_response || '';
    if (TEST_FAIL_RE.test(resp) || ERROR_CLASS_RE.test(resp)) {
      errorCount++;
    }
  }

  if (errorCount < 3) return null;

  return {
    pattern: 'repeated-bash-error',
    resource_intent: 'fix',
    confidence: 0.6 + Math.min(errorCount - 3, 4) * 0.1,
  };
}

// ─── Pattern: blind-editing ──────────────────────────────────────────────────

/**
 * Detect 5+ consecutive edits to the same file without any test/lint/build verification.
 * Read/Grep/Glob are passive and don't break the streak; other tools do.
 * Bash with a verify command (test/lint/tsc/build) breaks the streak.
 */
function detectBlindEditing(window) {
  let streak = 0;
  let targetFile = null;

  for (const event of window) {
    const tool = event.tool_name;

    // Edit tools extend the streak
    if (EDIT_TOOLS.has(tool)) {
      const file = event.tool_input?.file_path || '';
      if (!targetFile) {
        targetFile = file;
        streak = 1;
      } else if (file === targetFile) {
        streak++;
      } else {
        // Different file — restart streak
        targetFile = file;
        streak = 1;
      }
      continue;
    }

    // Passive tools don't break the streak
    if (PASSIVE_TOOLS.has(tool)) {
      continue;
    }

    // Bash with verify command breaks the streak
    if (tool === 'Bash') {
      const cmd = event.tool_input?.command || '';
      if (VERIFY_CMD_RE.test(cmd)) {
        streak = 0;
        targetFile = null;
        continue;
      }
      // Non-verify Bash breaks the streak too
      streak = 0;
      targetFile = null;
      continue;
    }

    // Any other tool breaks the streak
    streak = 0;
    targetFile = null;
  }

  if (streak < 5) return null;

  return {
    pattern: 'blind-editing',
    resource_intent: 'test',
    confidence: 0.5 + Math.min(streak - 5, 5) * 0.1,
  };
}
