// claude-mem-lite: Dispatch feedback collection
// Runs at Stop hook to track adoption and outcomes of recommendations

import { getSessionInvocations, updateInvocation, updateResourceStats, incrementWeightedAdopt } from './registry.mjs';
import { debugCatch, debugLog, EDIT_TOOLS } from './utils.mjs';

// ─── Adoption Detection ──────────────────────────────────────────────────────

// Abbreviation map for common short-form registry names → full invocation names
const SKILL_ABBREVS = {
  'tdd': 'test driven development',
  'debugging': 'systematic debugging',
  'code-review': 'requesting code review',
  'verification': 'verification before completion',
  'git-worktrees': 'using git worktrees',
};

/**
 * Check if a skill invocation matches a registry resource name.
 * Tries multiple matching strategies: exact, plugin-prefix, normalized,
 * invocation_name, and token-overlap with abbreviation expansion.
 * @param {string} resourceName Registry resource name (e.g. "superpowers-tdd")
 * @param {string} invocationName Stored invocation_name from DB (e.g. "superpowers:test-driven-development")
 * @param {string} skillInput Invoked skill name from Skill tool (e.g. "superpowers:test-driven-development")
 * @returns {boolean}
 */
function detectSkillAdoption(resourceName, invocationName, skillInput) {
  const invoked = (skillInput || '').toLowerCase();
  const resLower = resourceName.toLowerCase();
  if (!invoked) return false;

  // Exact match
  if (invoked === resLower) return true;

  // Stored invocation_name match (most reliable)
  if (invocationName) {
    const invNameLower = invocationName.toLowerCase();
    if (invoked === invNameLower) return true;
  }

  // Plugin prefix match: "superpowers:test-driven-development" for "test-driven-development"
  if (invoked.endsWith(':' + resLower) || resLower.endsWith(':' + invoked)) return true;

  // Normalized match (strip hyphens/colons)
  const norm = s => s.replace(/[-:_]/g, '');
  if (norm(invoked) === norm(resLower)) return true;

  // Token overlap with abbreviation expansion
  const rTokens = resLower.split(/[-:_]+/);
  const iTokens = invoked.split(/[-:_]+/);
  // Plugin name match (first token): "superpowers" === "superpowers"
  if (rTokens[0] === iTokens[0] && rTokens.length > 1 && iTokens.length > 1) {
    const rRest = rTokens.slice(1).join(' ');
    const iRest = iTokens.slice(1).join(' ');
    const expanded = SKILL_ABBREVS[rRest] || rRest;
    if (iRest.includes(expanded) || expanded.includes(iRest)) return true;
  }

  return false;
}

/**
 * Check if event timestamp is within the behavioral detection window.
 * @param {number} eventTs Event timestamp (ms)
 * @param {number} recTime Recommendation time (ms)
 * @param {number} windowMs Window size (default 10 minutes)
 * @returns {boolean}
 */
const BEHAVIORAL_WINDOW_MS = 600000; // 10 minutes (widened from 2 min for methodology skills)

function isWithinWindow(eventTs, recTime, windowMs = BEHAVIORAL_WINDOW_MS) {
  if (recTime === null || recTime === undefined || eventTs === null || eventTs === undefined) return true;
  const delta = eventTs - recTime;
  return delta >= 0 && delta <= windowMs;
}

/**
 * Detect TDD pattern: Bash(test fail) → Edit → Bash(test pass)
 */
function detectTDDPattern(events, recTime) {
  let testFailed = false, edited = false;
  for (const e of events) {
    if (!isWithinWindow(e.timestamp, recTime)) continue;
    const cmd = (e.tool_input?.command || '').toLowerCase();
    const resp = e.tool_response || '';
    if (e.tool_name === 'Bash' && /test|jest|vitest|pytest|mocha/i.test(cmd) && /fail|error|FAIL/i.test(resp)) {
      testFailed = true;
    }
    if (testFailed && EDIT_TOOLS.has(e.tool_name)) edited = true;
    if (edited && e.tool_name === 'Bash' && /test|jest|vitest|pytest|mocha/i.test(cmd) && /pass|passed|✓|\bok\b/i.test(resp) && !/fail|error/i.test(resp)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect verification pattern: successful test/lint/build near session end
 */
function detectVerificationPattern(events, recTime) {
  const lastEvents = events.slice(-5);
  return lastEvents.some(e => {
    if (!isWithinWindow(e.timestamp, recTime)) return false;
    if (e.tool_name !== 'Bash') return false;
    const cmd = (e.tool_input?.command || '').toLowerCase();
    const resp = e.tool_response || '';
    const isVerifyCmd = /\b(test|lint|eslint|build|tsc|typecheck|vitest|jest)\b/.test(cmd);
    const isSuccess = resp.length > 0 && !/error|fail|exception/i.test(resp);
    return isVerifyCmd && isSuccess;
  });
}

/**
 * Multi-tier adoption detection for recommended resources.
 * Returns { adopted: boolean, score: number } where score indicates confidence:
 *   1.0 = explicit (Skill/Agent tool invocation)
 *   0.5 = behavioral (detected methodology pattern: TDD, review)
 *   0.4 = behavioral (debugging: 2+ error→edit cycles, lower confidence)
 *   0.2 = inferred (verification pattern near session end)
 *
 * @param {object} invocation Invocation record with resource info
 * @param {object[]} sessionEvents Array of tool events from the session
 * @returns {{ adopted: boolean, score: number }}
 */
function detectAdoption(invocation, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return { adopted: false, score: 0 };

  const { resource_name, resource_type, invocation_name } = invocation;

  // Tier 1: Explicit adoption — Skill/Agent tool invocation (strongest signal)
  for (const event of sessionEvents) {
    if (resource_type === 'skill' && event.tool_name === 'Skill') {
      if (detectSkillAdoption(resource_name, invocation_name || '', event.tool_input?.skill)) {
        return { adopted: true, score: 1.0 };
      }
    }

    if (resource_type === 'agent' && event.tool_name === 'Agent') {
      const desc = (event.tool_input?.description || '').toLowerCase();
      const prompt = (event.tool_input?.prompt || '').toLowerCase();
      const subType = (event.tool_input?.subagent_type || '').toLowerCase();
      const nameLower = resource_name.toLowerCase();
      const nameNorm = nameLower.replace(/[-:]/g, ' ');
      const nameCompact = nameLower.replace(/[-:]/g, '');
      const subTypeNorm = subType.replace(/[-:]/g, ' ');
      const subTypeCompact = subType.replace(/[-:]/g, '');
      if (desc.includes(nameNorm) || desc.includes(nameLower) ||
          prompt.includes(nameNorm) || prompt.includes(nameLower) ||
          subType === nameLower || subTypeNorm === nameNorm ||
          subTypeCompact === nameCompact ||
          subType.includes(nameNorm) || subType.includes(nameCompact) ||
          subTypeNorm.includes(nameNorm)) {
        return { adopted: true, score: 1.0 };
      }
    }
  }

  // Tier 2: Behavioral adoption — methodology patterns (10 min window)
  const resourceLower = resource_name.toLowerCase();
  const recTime = invocation.created_at ? new Date(invocation.created_at).getTime() : 0;

  // TDD pattern: Bash(test fail) → Edit → Bash(test pass)
  if (resourceLower.includes('tdd') || resourceLower.includes('test-driven')) {
    if (detectTDDPattern(sessionEvents, recTime)) {
      return { adopted: true, score: 0.5 };
    }
  }

  // Debugging pattern: requires 2+ error→edit cycles (not just one)
  // A single error→edit is too common in normal coding and doesn't indicate
  // systematic debugging methodology was actually applied.
  if (resourceLower.includes('debug') || resourceLower.includes('troubleshoot')) {
    const firstRelevant = sessionEvents.find(e =>
      e.tool_name === 'Read' ||
      (e.tool_name === 'Bash' && /error|fail|exception/i.test(e.tool_response || ''))
    );
    if (isWithinWindow(firstRelevant?.timestamp, recTime)) {
      let hasRead = false;
      let cycles = 0;
      let sawError = false;
      for (const e of sessionEvents) {
        if (e.tool_name === 'Read') hasRead = true;
        if (e.tool_name === 'Bash' && /error|fail|exception/i.test(e.tool_response || '')) {
          sawError = true;
        }
        if (sawError && EDIT_TOOLS.has(e.tool_name)) {
          cycles++;
          sawError = false; // Reset for next cycle
        }
      }
      if (hasRead && cycles >= 2) {
        return { adopted: true, score: 0.4 };
      }
    }
  }

  // Code review pattern: Agent with 'review' in prompt/description
  if (resourceLower.includes('review')) {
    for (const e of sessionEvents) {
      if (e.tool_name === 'Agent' && isWithinWindow(e.timestamp, recTime)) {
        const text = ((e.tool_input?.prompt || '') + (e.tool_input?.description || '')).toLowerCase();
        if (text.includes('review')) return { adopted: true, score: 0.5 };
      }
    }
  }

  // Tier 3: Inferred adoption — verification near session end
  if (resourceLower.includes('verif') || resourceLower.includes('quality') || resourceLower.includes('check')) {
    if (detectVerificationPattern(sessionEvents, recTime)) {
      return { adopted: true, score: 0.2 };
    }
  }

  return { adopted: false, score: 0 };
}

// ─── Outcome Detection ───────────────────────────────────────────────────────

/**
 * Determine session outcome using simple rule-based heuristics.
 * @param {object[]} sessionEvents Array of tool events
 * @returns {'success'|'partial'|'failure'|'skipped'}
 */
function detectOutcome(sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return 'skipped';

  let hasError = false;
  let hasEdit = false;
  let errorThenFix = false;
  let lastErrorIndex = -1;

  for (let i = 0; i < sessionEvents.length; i++) {
    const e = sessionEvents[i];
    const resp = typeof e.tool_response === 'string' ? e.tool_response : '';

    if (/error|fail|exception|panic/i.test(resp) && resp.length > 30) {
      hasError = true;
      lastErrorIndex = i;
    }

    if (EDIT_TOOLS.has(e.tool_name)) {
      hasEdit = true;
      if (lastErrorIndex >= 0 && i > lastErrorIndex) {
        errorThenFix = true;
      }
    }
  }

  if (!hasError && hasEdit) return 'success';
  if (errorThenFix) return 'partial';
  if (hasError && !errorThenFix) return 'failure';
  return 'success'; // No errors, no edits = informational session, ok
}

// ─── Rejection Classification ────────────────────────────────────────────────

/**
 * Classify why a recommendation was not adopted.
 * Analyzes post-recommendation events to determine the reason.
 * @param {object} invocation Invocation record with created_at
 * @param {object[]} sessionEvents All session tool events
 * @returns {string} Rejection reason
 */
function classifyRejection(invocation, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return 'no_events';

  const recTime = new Date(invocation.created_at).getTime();
  const afterEvents = sessionEvents.filter(e =>
    (e.timestamp || 0) > recTime || !e.timestamp
  );

  if (afterEvents.length <= 2) return 'session_end';

  // Alternative: Claude used a different skill/agent instead
  const { resource_type, invocation_name, resource_name } = invocation;
  for (const e of afterEvents) {
    if (resource_type === 'skill' && e.tool_name === 'Skill') {
      const used = (e.tool_input?.skill || '').toLowerCase();
      const expected = (invocation_name || resource_name || '').toLowerCase();
      if (used && used !== expected && !used.includes(expected)) return 'alternative';
    }
    if (resource_type === 'agent' && e.tool_name === 'Agent') {
      return 'alternative';
    }
  }

  // Manual: Claude completed work without any skill/agent
  const hasEdits = afterEvents.some(e => EDIT_TOOLS.has(e.tool_name));
  const noSkillAgent = !afterEvents.some(e => e.tool_name === 'Skill' || e.tool_name === 'Agent');
  if (hasEdits && noSkillAgent) return 'manual';

  // Context switch: lots of activity but unrelated
  if (afterEvents.length > 5) return 'context_switch';

  return 'unknown';
}

// ─── Main Feedback Collection ────────────────────────────────────────────────

/**
 * Collect feedback for all recommendations made in a session.
 * Updates invocation records and resource statistics.
 * Designed to run async in background — never throws.
 *
 * @param {Database} db Registry database
 * @param {string} sessionId Session identifier
 * @param {object[]} [sessionEvents] Optional array of session tool events
 */
export async function collectFeedback(db, sessionId, sessionEvents = []) {
  if (!db || !sessionId) return;

  try {
    const invocations = getSessionInvocations(db, sessionId);
    if (invocations.length === 0) return;

    for (const inv of invocations) {
      // Skip if already collected (prevents double-collection from stop + session-start)
      if (inv.outcome) continue;

      const { adopted, score: adoptScore } = detectAdoption(inv, sessionEvents);
      const outcome = adopted ? detectOutcome(sessionEvents) : 'ignored';
      // Combine adoption confidence with outcome quality
      const outcomeMultiplier = outcome === 'success' ? 1.0 : outcome === 'partial' ? 0.7 : 0.3;
      const score = adopted ? adoptScore * outcomeMultiplier : 0;
      const rejection_reason = adopted ? null : (classifyRejection(inv, sessionEvents) || 'unclassified');

      // Update invocation record
      updateInvocation(db, inv.id, {
        adopted: adopted ? 1 : 0,
        outcome,
        score,
        rejection_reason,
      });

      // Update resource stats
      if (adopted) {
        updateResourceStats(db, inv.resource_id, 'adopt_count');
        incrementWeightedAdopt(db, inv.resource_id, score);
        if (outcome === 'success') {
          updateResourceStats(db, inv.resource_id, 'success_count');
        }
      }
    }

    // Auto-demote zombie resources: >8 recs with adopt_rate < 0.1 → on_request mode
    // Unified with COMPOSITE_EXPR zombie penalty threshold in registry-retriever.mjs
    autodemoteZombies(db);
  } catch (e) {
    debugCatch(e, 'collectFeedback');
  }
}

/**
 * Auto-demote resources with high recommendation count and near-zero adoption to on_request mode.
 * Zombie threshold (unified with COMPOSITE_EXPR penalty):
 *   recommend_count > 8 AND Laplace-smoothed adopt_rate < 0.1
 *   adopt_rate = (adopt_count + 1) / (recommend_count + 2)
 * Only demotes resources currently in 'proactive' mode.
 */
function autodemoteZombies(db) {
  try {
    const demoted = db.prepare(`
      UPDATE resources SET recommendation_mode = 'on_request', updated_at = datetime('now')
      WHERE COALESCE(recommend_count, 0) > 8
        AND (COALESCE(adopt_count, 0) + 1.0) / (COALESCE(recommend_count, 0) + 2.0) < 0.1
        AND COALESCE(recommendation_mode, 'proactive') = 'proactive'
        AND status = 'active'
    `).run();
    if (demoted.changes > 0) {
      debugLog('INFO', 'feedback', `auto-demoted ${demoted.changes} zombie resources to on_request`);
    }
  } catch (e) {
    debugCatch(e, 'autodemoteZombies');
  }
}

// Test exports
export { detectAdoption as _detectAdoption };
