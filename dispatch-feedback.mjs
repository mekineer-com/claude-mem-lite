// claude-mem-lite: Dispatch feedback collection
// Runs at Stop hook to track adoption and outcomes of recommendations

import { getSessionInvocations, updateInvocation, updateResourceStats } from './registry.mjs';
import { debugCatch } from './utils.mjs';

// ─── Adoption Detection ──────────────────────────────────────────────────────

/**
 * Check if a recommended resource was adopted in the session events.
 * @param {object} invocation Invocation record with resource info
 * @param {object[]} sessionEvents Array of tool events from the session
 * @returns {boolean} true if the resource was used
 */
function detectAdoption(invocation, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return false;

  const { resource_name, resource_type } = invocation;

  for (const event of sessionEvents) {
    // Skill adoption: Claude used the Skill tool with matching name
    // Case-insensitive matching with plugin-prefix support (e.g. "superpowers:tdd")
    if (resource_type === 'skill' && event.tool_name === 'Skill') {
      const skillName = (event.tool_input?.skill || '').toLowerCase();
      const resLower = resource_name.toLowerCase();
      if (skillName === resLower ||
          skillName.endsWith(`:${resLower}`) ||
          resLower.endsWith(`:${skillName}`) ||
          skillName.replace(/[-:]/g, '') === resLower.replace(/[-:]/g, '')) {
        return true;
      }
    }

    // Agent adoption: Claude used Task tool with matching agent type/description
    // Normalizes hyphens/colons to spaces for comparison (e.g. "code-review-ai" ↔ "code review ai")
    if (resource_type === 'agent' && event.tool_name === 'Task') {
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
        return true;
      }
    }
  }

  return false;
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

    if (['Edit', 'Write', 'NotebookEdit'].includes(e.tool_name)) {
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

    const outcome = detectOutcome(sessionEvents);

    for (const inv of invocations) {
      const adopted = detectAdoption(inv, sessionEvents);
      const score = adopted ? (outcome === 'success' ? 1.0 : outcome === 'partial' ? 0.5 : 0.2) : 0;

      // Update invocation record
      updateInvocation(db, inv.id, {
        adopted: adopted ? 1 : 0,
        outcome,
        score,
      });

      // Update resource stats
      if (adopted) {
        updateResourceStats(db, inv.resource_id, 'adopt_count');
        if (outcome === 'success') {
          updateResourceStats(db, inv.resource_id, 'success_count');
        }
      }
    }
  } catch (e) {
    debugCatch(e, 'collectFeedback');
  }
}
