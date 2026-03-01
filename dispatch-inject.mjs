// claude-mem-lite: Injection template rendering
// Formats resource recommendations for Claude Code's additionalContext

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { truncate } from './utils.mjs';
import { DB_DIR } from './schema.mjs';

const MAX_INJECTION_CHARS = 3000;

// Allowed base directories for resource file reads (defense-in-depth)
const ALLOWED_BASES = [
  join(homedir(), '.claude'),
  join(DB_DIR, 'managed'),
];

function isAllowedPath(filePath) {
  if (!filePath) return false;
  return ALLOWED_BASES.some(base => filePath.startsWith(base));
}

// ─── Template Detection ──────────────────────────────────────────────────────

/**
 * Check if a skill exists in user's native ~/.claude/skills/ directory.
 * If so, Claude can invoke it directly via /skill-name command.
 */
function isNativeSkill(name) {
  const nativePath = join(homedir(), '.claude', 'skills', name);
  return existsSync(nativePath);
}

// ─── Injection Templates ─────────────────────────────────────────────────────

/**
 * Invocable skill template -- tells Claude to invoke via Skill tool.
 * Used when the resource has an invocation_name (registered as a Claude Code skill/plugin).
 * @param {object} resource Resource object from DB
 * @returns {string} Injection text instructing Skill tool invocation
 */
function injectSkillInvocable(resource) {
  return `[Auto-suggestion] A relevant skill is available for this task. ` +
    `Invoke it now: use the Skill tool with skill="${resource.invocation_name}". ` +
    `Capability: ${truncate(resource.capability_summary, 100)}`;
}

/**
 * Native skill template -- tells Claude to use the skill command.
 * Used when skill exists in ~/.claude/skills/ but has no invocation_name.
 * @param {object} resource Resource object from DB
 * @returns {string} Injection text referencing the native skill command
 */
function injectSkillNative(resource) {
  return `[Auto-suggestion] A relevant skill "${resource.name}" is available for this task. ` +
    `Use: /skill ${resource.name}. ` +
    `Capability: ${truncate(resource.capability_summary, 100)}`;
}

/**
 * Managed skill template -- includes content for Claude to use directly.
 * Used when skill is in managed/ directory (not installed natively).
 * @param {object} resource Resource object from DB
 * @returns {string} Injection text with embedded skill content
 */
function injectSkillManaged(resource) {
  if (!isAllowedPath(resource.local_path)) return injectSkillNative(resource);
  let content = '';
  try {
    content = readFileSync(resource.local_path, 'utf8');
  } catch {
    // Try reading from directory
    try {
      const candidates = ['skill.md', 'SKILL.md', 'README.md'];
      for (const name of candidates) {
        const fp = join(resource.local_path, name);
        if (existsSync(fp)) { content = readFileSync(fp, 'utf8'); break; }
      }
    } catch {}
  }

  const truncatedContent = truncate(content, MAX_INJECTION_CHARS - 300);

  return `[Auto-suggestion] Recommended skill for this task: "${resource.name}"
Capability: ${truncate(resource.capability_summary, 100)}
<skill-content>
${truncatedContent}
</skill-content>`;
}

/**
 * Agent template -- guides Claude to use Agent tool with the agent definition.
 * @param {object} resource Resource object from DB
 * @returns {string} Injection text with agent definition for Agent tool delegation
 */
function injectAgent(resource) {
  if (!isAllowedPath(resource.local_path)) {
    return `[Auto-suggestion] A specialized agent "${resource.name}" is recommended for this task. ` +
      `Capability: ${truncate(resource.capability_summary, 100)}. ` +
      `Use the Agent tool to delegate this work.`;
  }
  let agentDef = '';
  try {
    agentDef = readFileSync(resource.local_path, 'utf8');
  } catch {
    try {
      const candidates = ['agent.md', 'AGENT.md', 'README.md'];
      for (const name of candidates) {
        const fp = join(resource.local_path, name);
        if (existsSync(fp)) { agentDef = readFileSync(fp, 'utf8'); break; }
      }
    } catch {}
  }

  if (agentDef) {
    const truncatedDef = truncate(agentDef, MAX_INJECTION_CHARS - 300);
    return `[Auto-suggestion] A specialized agent "${resource.name}" is recommended for this task.
Capability: ${truncate(resource.capability_summary, 100)}
Use the Agent tool with this agent definition:
<agent-definition>
${truncatedDef}
</agent-definition>`;
  }

  return `[Auto-suggestion] A specialized agent "${resource.name}" is recommended for this task. ` +
    `Capability: ${truncate(resource.capability_summary, 100)}. ` +
    `Use the Agent tool to delegate this work.`;
}

// ─── Main Render ─────────────────────────────────────────────────────────────

/**
 * Render injection text for a resource recommendation.
 * Selects the appropriate template based on resource type and location.
 * Enforces MAX_INJECTION_CHARS hard limit.
 *
 * @param {object} resource Resource object from DB
 * @returns {string} Injection text for additionalContext
 */
export function renderInjection(resource) {
  let injection;

  if (resource.type === 'skill') {
    // Priority: if invocation_name is set, the skill is a registered Claude Code skill/plugin
    // → instruct Claude to invoke via Skill tool (enables adoption tracking)
    if (resource.invocation_name) {
      injection = injectSkillInvocable(resource);
    } else if (isNativeSkill(resource.name)) {
      injection = injectSkillNative(resource);
    } else {
      injection = injectSkillManaged(resource);
    }
  } else {
    injection = injectAgent(resource);
  }

  // Hard limit enforcement
  if (injection.length > MAX_INJECTION_CHARS) {
    injection = injection.slice(0, MAX_INJECTION_CHARS - 3) + '...';
  }

  return injection;
}
