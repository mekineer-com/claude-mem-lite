// claude-mem-lite: Injection template rendering
// Formats resource recommendations for Claude Code's additionalContext

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { truncate } from './utils.mjs';
import { DB_DIR } from './schema.mjs';

const MAX_INJECTION_CHARS = 3000;

/** Truncate multi-line content preserving newlines (unlike utils.truncate which flattens). */
function truncateContent(str, max) {
  if (!str) return '';
  const trimmed = str.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

// Allowed base directories for resource file reads (defense-in-depth)
const ALLOWED_BASES = [
  resolve(join(homedir(), '.claude')),
  resolve(join(DB_DIR, 'managed')),
];

function isAllowedPath(filePath) {
  if (!filePath) return false;
  const resolved = resolve(filePath);
  return ALLOWED_BASES.some(base => resolved === base || resolved.startsWith(base + '/'));
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
 * Build the lead line: reason if available, otherwise capability summary.
 */
function leadLine(resource, reason) {
  return reason || truncate(resource.capability_summary, 120);
}

/**
 * Invocable skill template -- tells Claude to invoke via Skill tool.
 * Used when the resource has an invocation_name (registered as a Claude Code skill/plugin).
 * @param {object} resource Resource object from DB
 * @param {string} [reason] Why this was recommended
 * @returns {string} Injection text instructing Skill tool invocation
 */
function injectSkillInvocable(resource, reason) {
  const lines = [`[Recommended] ${leadLine(resource, reason)}`];
  lines.push(`→ Invoke: Skill tool with skill="${resource.invocation_name}"`);
  if (reason && resource.capability_summary) {
    lines.push(`Capability: ${truncate(resource.capability_summary, 100)}`);
  }
  return lines.join('\n');
}

/**
 * Native skill template -- tells Claude to use the skill command.
 * Used when skill exists in ~/.claude/skills/ but has no invocation_name.
 * @param {object} resource Resource object from DB
 * @param {string} [reason] Why this was recommended
 * @returns {string} Injection text referencing the native skill command
 */
function injectSkillNative(resource, reason) {
  const lines = [`[Recommended] ${leadLine(resource, reason)}`];
  lines.push(`→ Use: /skill ${resource.name}`);
  if (reason && resource.capability_summary) {
    lines.push(`Capability: ${truncate(resource.capability_summary, 100)}`);
  }
  return lines.join('\n');
}

/**
 * Managed skill template -- includes content for Claude to use directly.
 * Used when skill is in managed/ directory (not installed natively).
 * @param {object} resource Resource object from DB
 * @param {string} [reason] Why this was recommended
 * @returns {string} Injection text with embedded skill content
 */
function injectSkillManaged(resource, reason) {
  if (!isAllowedPath(resource.local_path)) return injectSkillNative(resource, reason);
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

  const truncatedContent = truncateContent(content, MAX_INJECTION_CHARS - 300);

  const lines = [`[Recommended] "${resource.name}" — ${truncate(resource.capability_summary, 100)}`];
  if (reason) lines.push(`Why: ${reason}`);
  lines.push('<skill-content>');
  lines.push(truncatedContent);
  lines.push('</skill-content>');
  return lines.join('\n');
}

/**
 * Agent template -- guides Claude to use Agent tool with the agent definition.
 * @param {object} resource Resource object from DB
 * @param {string} [reason] Why this was recommended
 * @returns {string} Injection text with agent definition for Agent tool delegation
 */
function injectAgent(resource, reason) {
  if (!isAllowedPath(resource.local_path)) {
    const lines = [`[Recommended] ${leadLine(resource, reason)}`];
    lines.push(`→ Invoke: Agent tool with subagent_type="${resource.invocation_name || resource.name}"`);
    if (reason && resource.capability_summary) {
      lines.push(`Capability: ${truncate(resource.capability_summary, 100)}`);
    }
    return lines.join('\n');
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
    const truncatedDef = truncateContent(agentDef, MAX_INJECTION_CHARS - 300);
    const lines = [`[Recommended] "${resource.name}" — ${truncate(resource.capability_summary, 100)}`];
    if (reason) lines.push(`Why: ${reason}`);
    lines.push('Use the Agent tool with this agent definition:');
    lines.push('<agent-definition>');
    lines.push(truncatedDef);
    lines.push('</agent-definition>');
    return lines.join('\n');
  }

  const lines = [`[Recommended] ${leadLine(resource, reason)}`];
  lines.push(`→ Invoke: Agent tool with subagent_type="${resource.invocation_name || resource.name}"`);
  if (reason && resource.capability_summary) {
    lines.push(`Capability: ${truncate(resource.capability_summary, 100)}`);
  }
  return lines.join('\n');
}

// ─── Main Render ─────────────────────────────────────────────────────────────

/**
 * Render injection text for a resource recommendation.
 * Selects the appropriate template based on resource type and location.
 * Enforces MAX_INJECTION_CHARS hard limit.
 *
 * @param {object} resource Resource object from DB
 * @param {string} [reason] Brief reason why this resource was recommended
 * @returns {string} Injection text for additionalContext
 */
export function renderInjection(resource, reason) {
  let injection;

  if (resource.type === 'skill') {
    // Priority: if invocation_name is set, the skill is a registered Claude Code skill/plugin
    // → instruct Claude to invoke via Skill tool (enables adoption tracking)
    if (resource.invocation_name) {
      injection = injectSkillInvocable(resource, reason);
    } else if (isNativeSkill(resource.name)) {
      injection = injectSkillNative(resource, reason);
    } else {
      injection = injectSkillManaged(resource, reason);
    }
  } else {
    injection = injectAgent(resource, reason);
  }

  // Hard limit enforcement
  if (injection.length > MAX_INJECTION_CHARS) {
    injection = injection.slice(0, MAX_INJECTION_CHARS - 3) + '...';
  }

  return injection;
}

/**
 * Render a lightweight one-line hint for medium-confidence recommendations.
 * Costs ~30 tokens instead of ~500 for full injection.
 * @param {object} resource Resource object from DB
 * @returns {string} Single-line hint text
 */
export function renderHint(resource) {
  const cap = truncate(resource.capability_summary || '', 80);
  const invoke = resource.invocation_name
    ? ` (Skill: "${resource.invocation_name}")`
    : resource.type === 'agent'
      ? ` (Agent: "${resource.name}")`
      : '';
  return `[Hint] Consider: "${resource.name}" — ${cap}${invoke}`;
}
