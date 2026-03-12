// claude-mem-lite: Workflow-aware dispatch intelligence
// Suite auto-flow protection, explicit request detection, stage model

// ─── Stage Model ─────────────────────────────────────────────────────────────

export const STAGES = ['ANALYZE', 'PLAN', 'REVIEW_PLAN', 'EXECUTE', 'TEST', 'REVIEW_CODE', 'COMMIT'];

// Skill invocation name → workflow stage
const SKILL_STAGE_MAP = {
  'superpowers:brainstorming': 'ANALYZE',
  'superpowers:writing-plans': 'PLAN',
  'gsd:start': 'PLAN',
  'gsd:prd': 'PLAN',
  'superpowers:executing-plans': 'EXECUTE',
  'superpowers:subagent-driven-development': 'EXECUTE',
  'gsd:resume': 'EXECUTE',
  'superpowers:test-driven-development': 'TEST',
  'superpowers:systematic-debugging': 'EXECUTE',
  'superpowers:verification-before-completion': 'TEST',
  'superpowers:requesting-code-review': 'REVIEW_CODE',
  'superpowers:receiving-code-review': 'REVIEW_CODE',
  'superpowers:finishing-a-development-branch': 'COMMIT',
  'commit-commands:commit': 'COMMIT',
  'commit-commands:commit-push-pr': 'COMMIT',
  'commit-commands:clean_gone': 'COMMIT',
};

// User intent → stage mapping (for stage inference from prompt)
export const INTENT_STAGE_MAP = {
  'plan': 'PLAN',
  'review': 'REVIEW_CODE',
  'test': 'TEST',
  'fix': 'EXECUTE',
  'clean': 'EXECUTE',
  'commit': 'COMMIT',
  'deploy': 'COMMIT',
  'design': 'ANALYZE',
  'doc': 'COMMIT',
  'build': 'EXECUTE',
  'fast': 'EXECUTE',
  'lint': 'EXECUTE',
  'db': 'EXECUTE',
  'api': 'EXECUTE',
  'secure': 'EXECUTE',
  'infra': 'EXECUTE',
};

// ─── Suite Auto-Flow Protection ──────────────────────────────────────────────

export const SUITE_AUTO_FLOWS = {
  superpowers: {
    stages: ['ANALYZE', 'PLAN', 'EXECUTE', 'TEST', 'REVIEW_CODE', 'COMMIT'],
    gaps: ['REVIEW_PLAN'],
  },
  gsd: {
    stages: ['PLAN', 'EXECUTE', 'TEST', 'REVIEW_CODE'],
    gaps: ['ANALYZE', 'REVIEW_PLAN', 'COMMIT'],
  },
  'feature-dev': {
    stages: ['ANALYZE', 'EXECUTE', 'REVIEW_CODE'],
    gaps: ['PLAN', 'REVIEW_PLAN', 'TEST', 'COMMIT'],
  },
  'commit-commands': {
    stages: ['COMMIT'],
    gaps: ['ANALYZE', 'PLAN', 'REVIEW_PLAN', 'EXECUTE', 'TEST', 'REVIEW_CODE'],
  },
};

const SUITE_MOMENTUM_MAX_DISTANCE = 20;
const SUITE_MOMENTUM_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Detect if a suite auto-flow is active based on recent Skill tool events.
 * Scans backwards with momentum decay: suite influence fades after 20 tool calls or 15 minutes.
 * @param {object[]} sessionEvents Array of tool events
 * @returns {{suite: string, flow: object, lastSkill: string, distance: number}|null}
 */
export function detectActiveSuite(sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return null;

  for (let i = sessionEvents.length - 1; i >= 0; i--) {
    const distance = sessionEvents.length - 1 - i;

    // Momentum decay: suite influence fades after 20 tool calls
    if (distance > SUITE_MOMENTUM_MAX_DISTANCE) return null;

    const e = sessionEvents[i];
    if (e.tool_name === 'Skill' && e.tool_input?.skill) {
      const skill = e.tool_input.skill;
      const suite = skill.split(':')[0];
      if (SUITE_AUTO_FLOWS[suite]) {
        // Time decay: suite influence expires after 15 minutes
        if (e.timestamp && (Date.now() - e.timestamp) > SUITE_MOMENTUM_MAX_AGE_MS) return null;
        return { suite, flow: SUITE_AUTO_FLOWS[suite], lastSkill: skill, distance };
      }
    }
  }
  return null;
}

/**
 * Determine if a recommendation should be made for the current stage.
 * @param {{suite: string, flow: object}|null} activeSuite Active suite info
 * @param {string} currentStage Current workflow stage
 * @returns {{shouldRecommend: boolean, reason: string}}
 */
export function shouldRecommendForStage(activeSuite, currentStage) {
  if (!activeSuite) return { shouldRecommend: true, reason: 'no_suite' };

  const { flow } = activeSuite;
  if (flow.stages.includes(currentStage)) {
    return { shouldRecommend: false, reason: 'suite_covers_stage' };
  }
  if (flow.gaps.includes(currentStage)) {
    return { shouldRecommend: true, reason: 'suite_gap' };
  }
  return { shouldRecommend: true, reason: 'unknown_stage' };
}

/**
 * Infer the current workflow stage from intent or from the last skill used.
 * @param {string} primaryIntent Primary intent from signal extraction
 * @param {{lastSkill: string}|null} activeSuite Active suite info
 * @returns {string|null} Stage name or null
 */
export function inferCurrentStage(primaryIntent, activeSuite) {
  if (activeSuite?.lastSkill && SKILL_STAGE_MAP[activeSuite.lastSkill]) {
    return SKILL_STAGE_MAP[activeSuite.lastSkill];
  }
  return INTENT_STAGE_MAP[primaryIntent] || null;
}

// ─── Explicit Request Detection ──────────────────────────────────────────────

const EXPLICIT_REQUEST_PATTERNS = [
  // EN: "use the playwright skill", "try the ppt skill"
  /(?:use|try|invoke|run|activate|load)\s+(?:the\s+)?(\S+?)\s+(?:skill|agent|tool|plugin)\b/i,
  // CN: "用ppt的技能", "帮我用playwright的skill"
  /(?:用|使用|帮我用|试试|启用)\s*(\S+?)\s*(?:的|的技能|的skill|的agent|技能|skill|agent|工具|插件)/,
  // "有没有xxx的skill", "is there a xxx agent"
  /(?:有没有|有无|是否有|do you have|is there)\s*(?:一个|a|an)?\s*(\S+?)\s*(?:的|skill|agent|技能|工具)/i,
  // "推荐一个xxx", "recommend a xxx agent"
  /(?:推荐|suggest|recommend)\s*(?:一个|a|an)?\s*(\S+?)\s*(?:的|skill|agent|技能|工具)/i,
];

/**
 * Detect if the user is explicitly requesting a specific tool/skill.
 * Highest priority — bypasses all dispatch restrictions.
 * @param {string} userPrompt User's prompt text
 * @returns {{isExplicit: boolean, searchTerm?: string}}
 */
export function detectExplicitRequest(userPrompt) {
  if (!userPrompt) return { isExplicit: false };

  for (const pattern of EXPLICIT_REQUEST_PATTERNS) {
    const match = userPrompt.match(pattern);
    if (match && match[1]) {
      const term = match[1].replace(/['"]/g, '').trim();
      if (term.length >= 2 && term.length <= 30) {
        return { isExplicit: true, searchTerm: term };
      }
    }
  }
  return { isExplicit: false };
}
