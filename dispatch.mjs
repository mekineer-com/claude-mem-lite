// claude-mem-lite: Dispatch orchestration — 3-tier intelligent resource dispatch
// Tier 0: Local fast filter (<1ms)
// Tier 1: Context signal extraction (<1ms)
// Tier 2: Enhanced FTS5 retrieval (<5ms)
// Tier 3: Haiku semantic dispatch (~500ms, only when needed)

import { basename } from 'path';
import { retrieveResources, buildEnhancedQuery, buildQueryFromText } from './registry-retriever.mjs';
import { renderInjection } from './dispatch-inject.mjs';
import { updateResourceStats, recordInvocation } from './registry.mjs';
import { callHaikuJSON } from './haiku-client.mjs';
import { debugCatch, truncate } from './utils.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LSP', 'WebSearch', 'WebFetch',
  'TodoRead', 'TaskList', 'TaskGet',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
]);

const CONFIDENCE_THRESHOLD = 3.0; // BM25 relevance threshold (negative values, lower = better)
export const COOLDOWN_MINUTES = 5;

// ─── Tier 0: Local Fast Filter ───────────────────────────────────────────────

/**
 * Determine if dispatch should be skipped for this tool event.
 * @param {object} event Hook event data
 * @returns {{skip: boolean, reason: string}}
 */
export function shouldSkipDispatch(event) {
  const { tool_name, tool_input } = event;

  // Claude already chose a skill
  if (tool_name === 'Skill') return { skip: true, reason: 'claude_chose_skill' };

  // Claude already chose an agent via Task tool
  if (tool_name === 'Task' && tool_input?.subagent_type) {
    return { skip: true, reason: 'claude_chose_agent' };
  }

  // Read-only tools — no action to suggest
  if (READ_ONLY_TOOLS.has(tool_name)) return { skip: true, reason: 'read_only' };

  // MCP tools — skip (internal/plugin tools)
  if (tool_name?.startsWith('mcp__')) return { skip: true, reason: 'mcp_tool' };

  // Simple bash queries (ls, cat, echo, git status, etc.)
  if (tool_name === 'Bash' && isSimpleBashQuery(tool_input?.command)) {
    return { skip: true, reason: 'simple_bash' };
  }

  return { skip: false, reason: '' };
}

/**
 * Check if a bash command is a simple read-only query.
 * @param {string} cmd Bash command string
 * @returns {boolean} true if the command is a simple read-only query
 */
function isSimpleBashQuery(cmd) {
  if (!cmd) return true;
  const lower = cmd.toLowerCase().trim();
  // Simple commands that don't need skill suggestions
  const simplePatterns = [
    /^(ls|cat|head|tail|echo|pwd|whoami|which|type|file|wc)\b/,
    /^git\s+(status|log|diff|show|branch|remote|stash\s+list)\b/,
    /^(node|python|ruby|go)\s+--?v/,
    /^(npm|yarn|pnpm)\s+(list|ls|outdated|info|view)\b/,
  ];
  return simplePatterns.some(p => p.test(lower));
}

// ─── Tier 1: Context Signal Extraction ───────────────────────────────────────

/**
 * Extract structured context signals from event and session context.
 * @param {object} event Hook event
 * @param {object} [sessionCtx] Additional session context
 * @returns {object} Structured signals
 */
export function extractContextSignals(event, sessionCtx = {}) {
  const signals = {
    intent: '',
    techStack: '',
    action: '',
    errorDomain: '',
  };

  // Extract intent from user prompt
  if (sessionCtx.userPrompt) {
    signals.intent = extractIntent(sessionCtx.userPrompt);
  }

  // Infer tech stack from recent files or current tool_input.file_path
  if (sessionCtx.recentFiles?.length > 0) {
    signals.techStack = inferTechStack(sessionCtx.recentFiles);
  } else if (event.tool_input?.file_path) {
    signals.techStack = inferTechStack([event.tool_input.file_path]);
  }

  // Infer action from tool name and input
  if (event.tool_name) {
    signals.action = inferAction(event.tool_name, event.tool_input);
  }

  // Extract error domain from bash output
  if (event.tool_name === 'Bash' && event.tool_input?.command) {
    const resp = event.tool_response || '';
    if (/error|fail|exception|panic/i.test(resp)) {
      signals.errorDomain = extractErrorDomain(event.tool_input.command, resp);
    }
  }

  return signals;
}

/**
 * Extract intent keywords from user prompt.
 * @param {string} prompt User's natural language prompt
 * @returns {string} Comma-separated intent tags (e.g. "test,fix")
 */
function extractIntent(prompt) {
  if (!prompt) return '';
  // English patterns use \b word boundaries
  const intentPatterns = [
    [/\b(tests?|testing|tdd|spec|coverage)\b/i, 'test'],
    [/\b(debug|fix(es)?|bugs?|errors?|troubleshoot)\b/i, 'fix'],
    [/\b(commits?|push|pr|pull request|merge)\b/i, 'commit'],
    [/\b(deploy|release|publish|ship)\b/i, 'deploy'],
    [/\b(reviews?|code review)\b/i, 'review'],
    [/\b(refactor|clean|simplify)\b/i, 'clean'],
    [/\b(perf|performance|optimi)\b/i, 'fast'],
    [/\b(security|secure|vulnerability)\b/i, 'secure'],
    [/\b(lint|format|style|prettier|eslint)\b/i, 'lint'],
    [/\b(design|ui|ux|frontend|css)\b/i, 'design'],
    [/\b(build|compile|bundle)\b/i, 'build'],
    [/\b(docs?|documentation|readme)\b/i, 'doc'],
    [/\b(infra|docker|k8s|terraform)\b/i, 'infra'],
    [/\b(db|database|sql)\b/i, 'db'],
    [/\b(api|endpoints?|routes?)\b/i, 'api'],
    [/\b(plan|architect)\b/i, 'plan'],
    // Chinese patterns — \b doesn't work with CJK characters, so match without boundaries
    [/(测试|写测试)/, 'test'],
    [/(修复|修bug)/, 'fix'],
    [/(提交|推送)/, 'commit'],
    [/(部署|上线|发布)/, 'deploy'],
    [/(审查|代码审查|评审)/, 'review'],
    [/(重构|清理|整理)/, 'clean'],
    [/(优化|快|慢)/, 'fast'],
    [/(安全|漏洞)/, 'secure'],
    [/(界面|设计|前端|UI)/, 'design'],
    [/(构建|编译|打包)/, 'build'],
    [/(文档|说明)/, 'doc'],
    [/(数据库|建表)/, 'db'],
    [/(接口|路由)/, 'api'],
    [/(规划|架构)/, 'plan'],
  ];

  const found = [];
  for (const [pattern, tag] of intentPatterns) {
    if (pattern.test(prompt)) found.push(tag);
  }
  return found.join(',');
}

/**
 * Infer tech stack from file extensions.
 * @param {string[]} files Array of file paths
 * @returns {string} Comma-separated tech/language tags
 */
function inferTechStack(files) {
  const extMap = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript,react',
    '.jsx': 'javascript,react',
    '.py': 'python', '.pyw': 'python',
    '.rs': 'rust', '.go': 'go',
    '.rb': 'ruby', '.java': 'java',
    '.vue': 'vue,javascript', '.svelte': 'svelte,javascript',
    '.css': 'css,frontend', '.scss': 'scss,frontend',
    '.html': 'html,frontend',
    '.sql': 'database,sql',
    '.yml': 'yaml,config', '.yaml': 'yaml,config',
    '.docker': 'docker,infrastructure',
    '.tf': 'terraform,infrastructure',
  };

  const tags = new Set();
  for (const f of files) {
    const ext = '.' + basename(f).split('.').pop();
    if (extMap[ext]) {
      for (const t of extMap[ext].split(',')) tags.add(t);
    }
  }
  return [...tags].join(',');
}

/**
 * Infer action type from tool name and input.
 * @param {string} toolName Claude Code tool name (e.g. "Bash", "Edit")
 * @param {object} [toolInput] Tool input parameters
 * @returns {string} Action category (e.g. "edit", "test", "build")
 */
function inferAction(toolName, toolInput) {
  switch (toolName) {
    case 'Edit': case 'Write': case 'NotebookEdit': return 'edit';
    case 'Bash': {
      const cmd = (toolInput?.command || '').toLowerCase();
      if (/\b(test|jest|pytest|vitest)\b/.test(cmd)) return 'test';
      if (/\b(build|compile|tsc|webpack)\b/.test(cmd)) return 'build';
      if (/\b(lint|eslint|prettier)\b/.test(cmd)) return 'lint';
      if (/\b(deploy|docker|kubectl)\b/.test(cmd)) return 'deploy';
      if (/\bgit\s+(commit|push|merge)\b/.test(cmd)) return 'commit';
      return 'bash';
    }
    case 'Task': return 'delegate';
    default: return '';
  }
}

/**
 * Extract error domain from command and error output.
 * @param {string} cmd Bash command that produced the error
 * @param {string} response Command output containing the error
 * @returns {string} Error domain category (e.g. "type-error", "test-fail")
 */
function extractErrorDomain(cmd, response) {
  const combined = (cmd + ' ' + response).toLowerCase();
  if (/type\s*error|typescript|tsc/.test(combined)) return 'type-error';
  if (/test.*fail|jest|vitest|pytest/.test(combined)) return 'test-fail';
  if (/build.*fail|compile|webpack|esbuild/.test(combined)) return 'build-fail';
  if (/syntax\s*error|parse/.test(combined)) return 'syntax-error';
  if (/module.*not found|cannot find|enoent/.test(combined)) return 'module-not-found';
  if (/permission|eacces/.test(combined)) return 'permission-error';
  return 'error';
}

// ─── Tier 3: Haiku Semantic Dispatch ─────────────────────────────────────────

/**
 * Check if Haiku dispatch is needed based on FTS5 results.
 * @param {object[]} results FTS5 results with relevance scores
 * @returns {boolean} true if Haiku should be called
 */
export function needsHaikuDispatch(results) {
  if (results.length === 0) return true;
  // BM25 returns negative values (more negative = more relevant)
  if (Math.abs(results[0].relevance) < CONFIDENCE_THRESHOLD) return true;
  if (results.length > 1 &&
      Math.abs(Math.abs(results[0].relevance) - Math.abs(results[1].relevance)) < 0.5) return true;
  return false;
}

/**
 * Call Haiku LLM to semantically resolve the best resource query.
 * @param {string} userPrompt User's prompt text
 * @param {string} toolContext Current tool action context
 * @returns {Promise<{query: string, type: string, confidence: number}|null>} Haiku result or null
 */
async function haikuDispatch(userPrompt, toolContext) {
  const prompt = `Given this coding context, which resource (skill or agent) would be most helpful?
Return ONLY valid JSON.

User intent: ${truncate(userPrompt || '', 200)}
Current action: ${truncate(toolContext || '', 200)}

JSON: {"query":"search keywords for finding the right skill or agent","type":"skill|agent|either","confidence":0.0-1.0}`;

  return callHaikuJSON(prompt, { timeout: 3000, maxTokens: 100 });
}

// ─── Cooldown & Dedup (DB-persisted, survives process restarts) ─────────────

export function isRecentlyRecommended(db, resourceId, sessionId) {
  // Check 1: Already recommended in this session (session dedup)
  const sessionHit = db.prepare(
    'SELECT 1 FROM invocations WHERE resource_id = ? AND session_id = ? LIMIT 1'
  ).get(resourceId, sessionId);
  if (sessionHit) return true;

  // Check 2: Recommended within cooldown window (cross-session cooldown)
  const cooldownHit = db.prepare(
    `SELECT 1 FROM invocations WHERE resource_id = ? AND created_at > datetime('now', ?) LIMIT 1`
  ).get(resourceId, `-${COOLDOWN_MINUTES} minutes`);
  return !!cooldownHit;
}

// ─── Main Dispatch Functions ─────────────────────────────────────────────────

/**
 * Dispatch on SessionStart: analyze user prompt, return best resource suggestion.
 * @param {Database} db Registry database
 * @param {string} userPrompt User's prompt text
 * @param {string} [sessionId] Session identifier for dedup
 * @returns {Promise<string|null>} Injection text or null
 */
export async function dispatchOnSessionStart(db, userPrompt, sessionId) {
  if (!userPrompt || !db) return null;

  try {
    // Build query from user prompt
    const query = buildQueryFromText(userPrompt);
    if (!query) return null;

    let results = retrieveResources(db, query, { limit: 3 });
    let tier = 2;

    // Tier 3: Haiku semantic fallback (SessionStart has 10s budget)
    if (needsHaikuDispatch(results)) {
      tier = 3;
      const haikuResult = await haikuDispatch(userPrompt, '');
      if (haikuResult?.query) {
        const haikuQuery = buildQueryFromText(haikuResult.query);
        if (haikuQuery) {
          const haikuResults = retrieveResources(db, haikuQuery, {
            type: haikuResult.type === 'either' ? undefined : haikuResult.type,
            limit: 3,
          });
          if (haikuResults.length > 0) results = haikuResults;
        }
      }
    }

    if (results.length === 0) return null;

    // Filter by DB-persisted cooldown + session dedup
    const viable = sessionId
      ? results.filter(r => !isRecentlyRecommended(db, r.id, sessionId))
      : results;
    if (viable.length === 0) return null;

    const best = viable[0];

    // Record invocation (also serves as cooldown/dedup marker for future checks)
    recordInvocation(db, {
      resource_id: best.id,
      session_id: sessionId || null,
      trigger: 'session_start',
      tier,
      recommended: 1,
    });
    updateResourceStats(db, best.id, 'recommend_count');

    return renderInjection(best);
  } catch (e) {
    debugCatch(e, 'dispatchOnSessionStart');
    return null;
  }
}

/**
 * Dispatch on PreToolUse: filter, analyze, and optionally recommend.
 * @param {Database} db Registry database
 * @param {object} event Hook event data
 * @param {object} [sessionCtx] Session context (userPrompt, recentFiles, sessionId)
 * @returns {Promise<string|null>} Injection text or null
 */
export async function dispatchOnPreToolUse(db, event, sessionCtx = {}) {
  if (!db || !event) return null;

  try {
    // Tier 0: Fast filter
    const { skip } = shouldSkipDispatch(event);
    if (skip) return null;

    // Tier 1: Extract context signals
    const signals = extractContextSignals(event, sessionCtx);
    const query = buildEnhancedQuery(signals);
    if (!query) return null;

    // Tier 2: FTS5 retrieval
    const results = retrieveResources(db, query, { limit: 3 });

    let best = null;
    const tier = 2; // Tier 3 disabled for PreToolUse — 2s hook timeout insufficient

    if (results.length > 0 && !needsHaikuDispatch(results)) {
      best = results[0];
    }

    // Fallback to best Tier 2 result
    if (!best && results.length > 0) best = results[0];

    if (!best) return null;

    // Apply DB-persisted cooldown and session dedup
    const sid = sessionCtx.sessionId || null;
    if (sid && isRecentlyRecommended(db, best.id, sid)) return null;

    // Record invocation (also serves as cooldown/dedup marker)
    recordInvocation(db, {
      resource_id: best.id,
      session_id: sid,
      trigger: 'pre_tool_use',
      tier,
      recommended: 1,
    });
    updateResourceStats(db, best.id, 'recommend_count');

    return renderInjection(best);
  } catch (e) {
    debugCatch(e, 'dispatchOnPreToolUse');
    return null;
  }
}
