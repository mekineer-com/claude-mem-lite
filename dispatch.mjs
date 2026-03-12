// claude-mem-lite: Dispatch orchestration — 3-tier intelligent resource dispatch
// Tier 0: Local fast filter (<1ms)
// Tier 1: Context signal extraction (<1ms)
// Tier 2: Enhanced FTS5 retrieval (<5ms)
// Tier 3: Haiku semantic dispatch (~500ms, only when needed)

import { basename, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { retrieveResources, buildEnhancedQuery, buildQueryFromText, DISPATCH_SYNONYMS } from './registry-retriever.mjs';
import { renderInjection } from './dispatch-inject.mjs';
import { updateResourceStats, recordInvocation } from './registry.mjs';
import { callHaikuJSON } from './haiku-client.mjs';
import { debugCatch, truncate } from './utils.mjs';
import { peekToolEvents, RUNTIME_DIR } from './hook-shared.mjs';
import { detectActiveSuite, shouldRecommendForStage, detectExplicitRequest, inferCurrentStage } from './dispatch-workflow.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LSP', 'WebSearch', 'WebFetch',
  'TodoRead', 'TaskList', 'TaskGet',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
]);

export const COOLDOWN_MINUTES = 60;
export const SESSION_RECOMMEND_CAP = 3;

// Minimum absolute BM25 composite score to recommend. Typical good matches score 5-50;
// this filters only near-zero noise matches from incidental text overlap.
export const BM25_MIN_THRESHOLD = 1.5;

// Minimum confidence from Haiku semantic dispatch to replace FTS5 results.
// Prevents low-confidence Haiku queries (e.g. 0.2) from overriding good FTS5 matches.
export const HAIKU_CONFIDENCE_THRESHOLD = 0.6;

// ─── Haiku Circuit Breaker ──────────────────────────────────────────────────
// Prevents cascading latency when Haiku API is down or slow.
// After BREAKER_THRESHOLD consecutive failures, disable for BREAKER_RESET_MS.
// KNOWN LIMITATION: File-based state has a TOCTOU race under concurrent hook
// processes. Worst case: breaker trips on failure N+1 instead of N. This is
// acceptable — the breaker is a latency guard, not a correctness mechanism.

const BREAKER_THRESHOLD = 3;
const BREAKER_RESET_MS = 5 * 60 * 1000; // 5 minutes
let breakerFile = join(RUNTIME_DIR, 'haiku-breaker.json');

function _readBreakerState() {
  try {
    if (!existsSync(breakerFile)) return { failures: 0, openUntil: 0 };
    return JSON.parse(readFileSync(breakerFile, 'utf8'));
  } catch { return { failures: 0, openUntil: 0 }; }
}

function _writeBreakerState(state) {
  try { writeFileSync(breakerFile, JSON.stringify(state)); } catch {}
}

/** Override breaker file path (for testing isolation). */
export function _setBreakerFile(path) { breakerFile = path; }

function isHaikuCircuitOpen() {
  const state = _readBreakerState();
  if (state.openUntil > 0 && Date.now() < state.openUntil) return true;
  if (state.openUntil > 0 && Date.now() >= state.openUntil) {
    // Half-open: single probe failure re-trips immediately
    _writeBreakerState({ failures: BREAKER_THRESHOLD - 1, openUntil: 0 });
  }
  return false;
}

function recordHaikuSuccess() {
  _writeBreakerState({ failures: 0, openUntil: 0 });
}

// NOTE: read-modify-write without file locking — concurrent hook processes may lose
// one increment. Acceptable: threshold is 3, worst case trips on 4th failure instead.
function recordHaikuFailure() {
  const state = _readBreakerState();
  state.failures++;
  if (state.failures >= BREAKER_THRESHOLD) {
    state.openUntil = Date.now() + BREAKER_RESET_MS;
  }
  _writeBreakerState(state);
}

/** Reset circuit breaker state (for testing). */
export function _resetCircuitBreaker() {
  _writeBreakerState({ failures: 0, openUntil: 0 });
}

/** Simulate Haiku failure (for testing). */
export function _recordHaikuFailure() { recordHaikuFailure(); }

/** Simulate Haiku success (for testing). */
export function _recordHaikuSuccess() { recordHaikuSuccess(); }

/** Check if circuit is open (for testing). */
export function _isHaikuCircuitOpen() { return isHaikuCircuitOpen(); }

// ─── Project Domain Detection ─────────────────────────────────────────────────

// Module-level cache — project dir doesn't change during a session
let _domainCache = null;
let _domainCacheDir = null;

/**
 * Detect project tech domains from marker files in the project directory.
 * Used to post-filter FTS5 results — exclude resources whose domain_tags
 * don't overlap with the project's detected domains.
 * Results are cached per directory (project dir doesn't change within a session).
 * @returns {string[]} Array of domain tags (e.g. ['javascript', 'node', 'typescript'])
 */
export function detectProjectDomains() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (_domainCache && _domainCacheDir === dir) return _domainCache;
  const techs = new Set();
  const checks = [
    ['package.json', ['javascript', 'node']],
    ['tsconfig.json', ['typescript', 'javascript']],
    ['Cargo.toml', ['rust']],
    ['go.mod', ['go']],
    ['requirements.txt', ['python']],
    ['pyproject.toml', ['python']],
    ['Gemfile', ['ruby']],
    ['build.gradle', ['java']],
    ['pom.xml', ['java']],
    ['Package.swift', ['swift', 'ios']],
    ['pubspec.yaml', ['dart', 'flutter']],
    ['Podfile', ['ios', 'swift']],
    ['CMakeLists.txt', ['cpp']],
    // Web/browser context — enables domain filtering for browser-specific resources
    ['next.config.js', ['web', 'browser', 'react']],
    ['next.config.mjs', ['web', 'browser', 'react']],
    ['next.config.ts', ['web', 'browser', 'react']],
    ['nuxt.config.ts', ['web', 'browser', 'vue']],
    ['angular.json', ['web', 'browser', 'angular']],
    ['.browserslistrc', ['web', 'browser']],
    ['vite.config.ts', ['web', 'browser', 'frontend']],
    ['vite.config.js', ['web', 'browser', 'frontend']],
    ['webpack.config.js', ['web', 'browser', 'frontend']],
  ];
  for (const [file, tags] of checks) {
    if (existsSync(join(dir, file))) tags.forEach(t => techs.add(t));
  }
  _domainCache = [...techs];
  _domainCacheDir = dir;
  return _domainCache;
}

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

  // Claude already chose an agent via Agent tool
  if (tool_name === 'Agent' && tool_input?.subagent_type) {
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
    /^git\s+(status|log|show|branch|remote|stash\s+list)\b/,
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
    intent: '',          // comma-separated intent tags, primary first
    primaryIntent: '',   // first/strongest intent (for column-targeted queries)
    suppressedIntents: [], // intents detected but actively suppressed (e.g. test-run)
    rawKeywords: [],     // domain-specific keywords not captured by intent patterns (e.g. "seo")
    techStack: '',
    action: '',
    errorDomain: '',
  };

  // Extract weighted intent from user prompt (primary intent is first element)
  if (sessionCtx.userPrompt) {
    const { intent, suppressed } = extractIntent(sessionCtx.userPrompt);
    signals.intent = intent;
    signals.suppressedIntents = suppressed;
    signals.primaryIntent = signals.intent.split(',')[0] || '';
    // Extract raw domain keywords not captured by intent patterns.
    // Intent patterns cover generic actions (test, fix, review) but miss domain
    // topics (seo, kubernetes, oauth). These raw keywords supplement the enhanced
    // query to ensure domain-specific resources are found.
    signals.rawKeywords = extractRawKeywords(sessionCtx.userPrompt, signals.intent);
  }

  // Infer tech stack from recent files, current tool_input, or prompt text
  if (sessionCtx.recentFiles?.length > 0) {
    signals.techStack = inferTechStack(sessionCtx.recentFiles);
  } else if (event.tool_input?.file_path) {
    signals.techStack = inferTechStack([event.tool_input.file_path]);
  }
  // Supplement with prompt-based tech detection (catches "React app", "Django API", etc.)
  if (sessionCtx.userPrompt) {
    const promptTech = inferTechFromPrompt(sessionCtx.userPrompt);
    if (promptTech) {
      signals.techStack = signals.techStack
        ? signals.techStack + ',' + promptTech
        : promptTech;
    }
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

// Negation patterns: "don't test", "not deploy", "别测试", "不要部署"
const NEGATION_EN = /\b(?:don'?t|do\s+not|no\s+need\s+to|skip|without|avoid|not|never|stop|cancel|ignore|hold\s+off)\s+/i;
const NEGATION_CJK = /(?:不要|别|不用|先别|暂时不|不需要|跳过|停止|取消|算了|不做|不搞)/;

// Test-run vs test-write disambiguation (module-scoped for performance)
const _RUN_TEST = /\b(run\w*\s+(?:the\s+)?tests?|npm\s+test|npx\s+(?:vitest|jest|mocha|pytest)|yarn\s+test|pnpm\s+test|make\s+test|cargo\s+test|go\s+test|check\s+(?:if\s+)?tests?\s+pass|execute\s+(?:the\s+)?tests?)\b/i;
const _RUN_TEST_CJK = /(?:运行测试|跑测试|跑一下测试|跑单测|执行测试|测试跑|看测试)/;
const _WRITE_TEST = /\b(write\s+tests?|add\s+tests?|create\s+tests?|need\s+tests?|missing\s+tests?|tdd|test.?driven|red.?green|increase\s+coverage|improve\s+coverage)\b/i;
const _WRITE_TEST_CJK = /(?:写测试|加测试|补测试|补单测|缺测试|测试覆盖)/;

/**
 * Extract weighted intent keywords from user prompt.
 * Returns primary (first match, strongest signal) and secondary intents.
 * Negated intents (e.g. "don't test") are excluded.
 *
 * @param {string} prompt User's natural language prompt
 * @returns {string} Comma-separated intent tags, primary intent listed first (e.g. "test,fix")
 */
function extractIntent(prompt) {
  if (!prompt) return { intent: '', suppressed: [] };
  // English patterns — use trailing-optional boundaries for verb conjugations:
  //   \b prefix ensures word start, but many suffixed forms (debugging, refactoring, deployed)
  //   fail with trailing \b. Use \b...\w* for words that commonly have suffixes.
  // Pattern ordering determines PRIMARY intent (first match).
  // Priority: action verbs → domain-specific → quality/style → generic/overloaded.
  // This ensures "review code before push" → review (not commit),
  // "design database schema" → db (not design), "I have a spec" → plan (not test).
  const intentPatterns = [
    // ── Action verbs (what the user wants to DO) ──
    [/\b(tests?|testing|tested|tdd|coverage|jest|vitest|pytest|mocha|cypress)\b/i, 'test'],
    [/\b(debug\w*|fix\w*|bugs?|errors?|troubleshoot\w*|broken|crash\w*|issue|problem|fail\w*|not working|doesn'?t work)\b/i, 'fix'],
    [/\b(reviews?|reviewing|reviewed|reviewer|code review|audit\w*|inspect\w*|look over|check over)\b/i, 'review'],
    [/\b(commits?|committing|committed|push\w*|pr|pull request|merg\w*|rebas\w*|cherry.?pick|stash|tag)\b/i, 'commit'],
    [/\b(deploy\w*|release\w*|publish\w*|ship\w*|rollout|staging|production)\b/i, 'deploy'],
    [/\b(plan\w*|architect\w*|rfc|proposal|roadmap|blueprint|spec)\b/i, 'plan'],
    [/\b(refactor\w*|clean\w*|simplif\w*|tidy|organiz\w*|restructur\w*|rewrit\w*|messy|ugly|smell|technical.?debt)\b/i, 'clean'],
    [/\b(docs?|documentation|readme|changelog|wiki|guide|tutorial|jsdoc|typedoc)\b/i, 'doc'],
    // ── Domain-specific (what area the work is in) ──
    [/\b(db|database|sql|migrat\w*|schema|orm|prisma|redis|mongo\w*|postgres\w*|mysql|sqlite)\b/i, 'db'],
    [/\b(api|endpoints?|routes?|rest|graphql|grpc|websocket|middleware|swagger|openapi)\b/i, 'api'],
    [/\b(secur\w*|vulnerabilit\w*|xss|csrf|injection|encrypt\w*|ssl|tls|cors|oauth|jwt|cve|insecure|unsafe)\b/i, 'secure'],
    [/\b(infra\w*|docker\w*|k8s|kubernetes|terraform|ansible|helm|aws|gcp|azure|cloud|nginx|ci\b|cd\b|pipeline)\b/i, 'infra'],
    [/\b(build\w*|compil\w*|bundl\w*|transpil\w*|esbuild|vite|rollup|webpack|parcel|babel|swc)\b/i, 'build'],
    // ── Quality / style ──
    [/\b(perf|performance|optimiz\w*|fast\w*|slow\w*|speed\w*|latency|bottleneck|laggy)\b/i, 'fast'],
    [/\b(lint\w*|format\w*|style|prettier|eslint|biome|stylelint)\b/i, 'lint'],
    // ── Generic / overloaded (easily confused with domain terms) ──
    // Note: bare "design" intentionally excluded — too ambiguous ("design database" vs "design UI").
    // Only UI-specific keywords trigger design intent. Prompts like "design the homepage" without
    // UI terms will rely on text-based FTS5 fallback rather than intent matching.
    [/\b(ui|ux|frontend|css|tailwind|responsive|layout|theme|component)\b/i, 'design'],
    // ── Chinese patterns ──
    [/(测试|写测试|单测|单元测试|用例|覆盖率)/, 'test'],
    [/(修复|修bug|改bug|找bug|有bug|调试|排错|报错|出错|有问题|不工作|跑不起来|不能用|挂了|崩溃)/, 'fix'],
    [/(审查|审核|代码审查|评审|代码审核|看看代码|review)/, 'review'],
    [/(提交|推送|上传)/, 'commit'],
    [/(部署|上线|发布|回滚)/, 'deploy'],
    [/(规划|架构|方案|设计方案)/, 'plan'],
    [/(重构|清理|整理|简化|太烂|乱七八糟|看不懂)/, 'clean'],
    [/(写文档|文档化|文档|注释)/, 'doc'],
    [/(数据库|建表|索引|迁移|查询慢)/, 'db'],
    [/(接口|路由)/, 'api'],
    [/(安全|漏洞|鉴权|认证|授权|权限|泄露|暴露|不安全)/, 'secure'],
    [/(容器|服务器|运维|集群|监控|配置|日志)/, 'infra'],
    [/(构建|编译|打包|依赖)/, 'build'],
    [/(优化|性能|卡顿|耗时|太慢|慢死了|好慢|缓存)/, 'fast'],
    [/(格式化|代码风格|代码规范|类型检查)/, 'lint'],
    [/(界面|前端|样式|页面|组件|布局)/, 'design'],
  ];

  // Build per-tag negation/affirmation tracking.
  // A tag is only excluded if ALL its matching instances are negated.
  // This handles mixed-language inputs like "不要测试了，但 write the tests for auth"
  // where the Chinese variant is negated but the English variant is not.
  const CLAUSE_BOUNDARY = /[,，。；;、.!?！？]/;
  const tagHasAffirmative = new Map(); // tag → true if any non-negated match exists
  const tagMatched = new Set();        // tags that matched at least once

  for (const [pattern, tag] of intentPatterns) {
    // Use global flag + matchAll to find ALL matches (not just the first).
    // This handles "don't test auth, but test UI" where the first match is negated
    // but the second is affirmative — the tag should still be included.
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    const matches = prompt.matchAll(globalPattern);
    for (const match of matches) {
      tagMatched.add(tag);
      const matchStart = match.index;
      // EN: 20-char window, CJK: 8-char window — check both
      const enPrefix = prompt.slice(Math.max(0, matchStart - 20), matchStart);
      const cjkPrefix = prompt.slice(Math.max(0, matchStart - 8), matchStart);
      // Clause boundary check: if a comma/period separates negation from keyword, skip
      const hasEnNeg = NEGATION_EN.test(enPrefix) && !CLAUSE_BOUNDARY.test(enPrefix);
      const hasCjkNeg = NEGATION_CJK.test(cjkPrefix) && !CLAUSE_BOUNDARY.test(cjkPrefix);
      if (!hasEnNeg && !hasCjkNeg) {
        tagHasAffirmative.set(tag, true);
      }
    }
  }

  const found = [];
  for (const tag of tagMatched) {
    if (tagHasAffirmative.get(tag) && !found.includes(tag)) {
      found.push(tag);
    }
  }

  // Distinguish test-running from test-writing: "run tests" / "npm test" / "运行测试" should NOT
  // trigger TDD recommendations. Only keep 'test' intent when the prompt implies *writing* tests.
  const suppressed = [];
  if (found.includes('test')) {
    const isRunning = _RUN_TEST.test(prompt) || _RUN_TEST_CJK.test(prompt);
    const isWriting = _WRITE_TEST.test(prompt) || _WRITE_TEST_CJK.test(prompt);
    if (isRunning && !isWriting) {
      found.splice(found.indexOf('test'), 1);
      suppressed.push('test');
    }
  }

  return { intent: found.join(','), suppressed };
}

/** Exported for testing. */
export { NEGATION_EN as _NEGATION_EN, NEGATION_CJK as _NEGATION_CJK, reRankByKeywords as _reRankByKeywords, applyAdoptionDecay as _applyAdoptionDecay, passesConfidenceGate as _passesConfidenceGate };

// Stop words for raw keyword extraction.
// Includes common English stop words + action verbs already covered by intent patterns.
// Domain-specific technical terms (seo, kubernetes, react, etc.) pass through.
const RAW_KW_STOP = new Set([
  // Standard English stop words
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'about', 'and', 'or', 'but', 'not', 'no', 'this',
  'that', 'it', 'its', 'my', 'your', 'me', 'us', 'you', 'he', 'she', 'we', 'they',
  'if', 'so', 'just', 'also', 'then', 'how', 'what', 'when', 'where', 'who',
  'use', 'using', 'need', 'want', 'check', 'look', 'help', 'please', 'let',
  'some', 'all', 'any', 'each', 'every', 'new', 'like', 'before', 'after',
  // Action verbs — captured by intent patterns, not domain keywords
  'design', 'build', 'create', 'make', 'add', 'remove', 'delete', 'update',
  'write', 'read', 'run', 'test', 'tests', 'testing', 'fix', 'debug',
  'review', 'deploy', 'commit', 'push', 'plan', 'clean', 'refactor',
  'find', 'get', 'set', 'show', 'list', 'change', 'move', 'copy', 'send',
  'start', 'stop', 'open', 'close', 'save', 'load', 'install', 'setup',
  'implement', 'configure', 'code', 'file', 'function', 'module', 'app',
]);

/**
 * Extract raw domain keywords from prompt text that aren't captured by intent patterns.
 * Handles embedded English words in CJK text (e.g. "seo" from "用seo技能检查下").
 * Filters out words already covered by extracted intents to avoid duplication.
 * @param {string} prompt User prompt text
 * @param {string} intentStr Comma-separated intents already extracted
 * @returns {string[]} Array of raw keywords (max 5)
 */
function extractRawKeywords(prompt, intentStr) {
  if (!prompt) return [];
  // Extract all English words (2+ chars) from the prompt
  const words = prompt.match(/[a-zA-Z]{2,}/gi) || [];
  const intentSet = new Set((intentStr || '').split(',').filter(Boolean));
  const seen = new Set();
  const result = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (lower.length < 2 || RAW_KW_STOP.has(lower) || intentSet.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    result.push(lower);
  }
  return result.slice(0, 5);
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
    '.rb': 'ruby', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
    '.swift': 'swift', '.dart': 'dart,flutter',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp,dotnet', '.php': 'php',
    '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang',
    '.lua': 'lua', '.zig': 'zig', '.sol': 'solidity',
    '.vue': 'vue,javascript', '.svelte': 'svelte,javascript',
    '.css': 'css,frontend', '.scss': 'scss,frontend', '.less': 'less,frontend',
    '.html': 'html,frontend',
    '.sql': 'database,sql',
    '.prisma': 'prisma,database',
    '.graphql': 'graphql', '.gql': 'graphql',
    '.proto': 'protobuf,grpc',
    '.yml': 'yaml,config', '.yaml': 'yaml,config',
    '.toml': 'toml,config', '.json': 'json',
    '.sh': 'bash,shell', '.bash': 'bash,shell', '.zsh': 'zsh,shell',
    '.docker': 'docker,infrastructure',
    '.tf': 'terraform,infrastructure',
  };

  // Filename-based detection (no extension matching)
  const nameMap = {
    'Dockerfile': 'docker,infrastructure',
    'docker-compose.yml': 'docker,infrastructure',
    'docker-compose.yaml': 'docker,infrastructure',
    'Makefile': 'make,build',
    'Cargo.toml': 'rust', 'go.mod': 'go',
    'Gemfile': 'ruby', 'requirements.txt': 'python',
    'pyproject.toml': 'python', 'Pipfile': 'python',
  };

  const tags = new Set();
  for (const f of files) {
    const name = basename(f);
    if (nameMap[name]) {
      for (const t of nameMap[name].split(',')) tags.add(t);
    }
    const ext = '.' + name.split('.').pop();
    if (extMap[ext]) {
      for (const t of extMap[ext].split(',')) tags.add(t);
    }
  }
  return [...tags].join(',');
}

/**
 * Extract tech stack keywords from prompt text.
 * Supplements file-based detection when no recent files are available.
 * @param {string} prompt User prompt text
 * @returns {string} Comma-separated tech/language tags
 */
function inferTechFromPrompt(prompt) {
  if (!prompt) return '';
  const techPatterns = [
    [/\b(react|nextjs|next\.js|gatsby)\b/i, 'react,frontend'],
    [/\b(vue|nuxt|vuex)\b/i, 'vue,frontend'],
    [/\b(svelte|sveltekit)\b/i, 'svelte,frontend'],
    [/\b(angular)\b/i, 'angular,frontend'],
    [/\b(node\.?js|express|fastify|nestjs|koa)\b/i, 'node,javascript'],
    [/\b(typescript|ts)\b/i, 'typescript'],
    [/\b(python|django|flask|fastapi)\b/i, 'python'],
    [/\b(rust|cargo)\b/i, 'rust'],
    [/\b(golang|go\s+(?:build|test|run|get|mod|install|fmt|vet|generate|clean|work|tool))\b/i, 'go'],
    [/\b(java|spring|maven|gradle)\b/i, 'java'],
    [/\b(ruby|rails)\b/i, 'ruby'],
    [/\b(php|laravel|symfony)\b/i, 'php'],
    [/\b(swift|swiftui)\b/i, 'swift'],
    [/\b(kotlin|android)\b/i, 'kotlin'],
    [/\b(docker|kubernetes|k8s|helm)\b/i, 'docker,infrastructure'],
    [/\b(terraform|ansible|aws|gcp|azure)\b/i, 'infrastructure,cloud'],
    [/\b(postgres\w*|mysql|sqlite|mongodb|redis)\b/i, 'database'],
    [/\b(tailwind|css|sass|scss)\b/i, 'css,frontend'],
    [/\b(graphql)\b/i, 'graphql'],
    [/\b(prisma|drizzle|sequelize)\b/i, 'database,orm'],
  ];
  const tags = new Set();
  for (const [pattern, techTags] of techPatterns) {
    if (pattern.test(prompt)) {
      for (const t of techTags.split(',')) tags.add(t);
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
      if (/\b(test|jest|pytest|vitest|mocha|cypress|playwright|phpunit|rspec|cargo\s+test|go\s+test)\b/.test(cmd)) return 'test';
      if (/\b(build|compile|tsc|webpack|esbuild|vite|rollup|parcel|make|cmake|cargo\s+build|go\s+build|mvn|gradle)\b/.test(cmd)) return 'build';
      if (/\b(lint|eslint|prettier|biome|stylelint|rubocop|flake8|pylint|clippy)\b/.test(cmd)) return 'lint';
      if (/\b(deploy|docker|kubectl|helm|terraform|ansible|pulumi)\b/.test(cmd)) return 'deploy';
      if (/\bgit\s+(commit|push|merge|rebase|tag)\b/.test(cmd)) return 'commit';
      if (/\b(npm\s+install|yarn\s+add|pnpm\s+add|pip\s+install|cargo\s+add|go\s+get|bundle\s+install)\b/.test(cmd)) return 'deps';
      if (/\b(psql|mysql|sqlite3|mongosh|redis-cli)\b/.test(cmd)) return 'db';
      return 'bash';
    }
    case 'Agent': return 'delegate';
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
  if (/test.*fail|jest|vitest|pytest|mocha|cypress/.test(combined)) return 'test-fail';
  if (/build.*fail|compile|webpack|esbuild|vite|rollup/.test(combined)) return 'build-fail';
  if (/syntax\s*error|parse\s*error|unexpected\s+token/.test(combined)) return 'syntax-error';
  if (/module.*not found|cannot find|enoent|no such file/.test(combined)) return 'module-not-found';
  if (/permission|eacces|eperm|forbidden/.test(combined)) return 'permission-error';
  if (/econnrefused|econnreset|etimedout|fetch.*fail|network|socket hang up/.test(combined)) return 'network-error';
  if (/out of memory|heap|oom|enomem|allocation/.test(combined)) return 'memory-error';
  if (/lint|eslint|prettier|stylelint/.test(combined)) return 'lint-error';
  if (/npm\s+err|yarn\s+error|pnpm\s+err|dependency|peer\s+dep|resolution/.test(combined)) return 'dependency-error';
  if (/git\s+(conflict|merge|rebase|cherry)/.test(combined)) return 'git-error';
  return 'error';
}

// ─── Tier 3: Haiku Semantic Dispatch ─────────────────────────────────────────

/**
 * Check if Haiku dispatch is needed based on FTS5 results.
 * Uses relative confidence: top result must be strong enough relative to result set,
 * and gap between top two must be decisive.
 * @param {object[]} results FTS5 results with relevance scores
 * @returns {boolean} true if Haiku should be called
 */
export function needsHaikuDispatch(results) {
  // Circuit breaker: if Haiku is tripped, never escalate (regardless of result quality)
  if (isHaikuCircuitOpen()) return false;

  if (results.length === 0) return true;

  // Prefer composite_score (includes behavioral signals) over raw BM25 relevance.
  // Both are negative (more negative = better). Use absolute values for comparison.
  const scoreOf = r => Math.abs(r.composite_score ?? r.relevance);
  const topScore = scoreOf(results[0]);

  // Relative threshold: if only one result or few results, use absolute minimum
  // For larger result sets, use mean-relative threshold
  if (results.length === 1) {
    // Single result: needs at least moderate relevance
    return topScore < 2.0;
  }

  // Compute mean relevance across results
  const meanScore = results.reduce((sum, r) => sum + scoreOf(r), 0) / results.length;

  // Top result should be significantly above mean (at least 1.5x)
  if (topScore < meanScore * 1.5 && topScore < 3.0) return true;

  // Top two results too close → ambiguous, need Haiku to disambiguate
  if (results.length > 1) {
    const gap = topScore - scoreOf(results[1]);
    // Gap should be at least 10% of top score, or at least 0.5 absolute
    if (gap < Math.max(topScore * 0.1, 0.5)) return true;
  }

  return false;
}

/**
 * Call Haiku LLM to semantically resolve the best resource query.
 * @param {string} userPrompt User's prompt text
 * @param {string} toolContext Current tool action context
 * @returns {Promise<{query: string, type: string, confidence: number}|null>} Haiku result or null
 */
async function haikuDispatch(userPrompt, toolContext) {
  // Circuit breaker: skip if Haiku is tripped
  if (isHaikuCircuitOpen()) return null;

  const prompt = `Given this coding context, which resource (skill or agent) would be most helpful?
Return ONLY valid JSON.

User intent: ${truncate(userPrompt || '', 200)}
Current action: ${truncate(toolContext || '', 200)}

JSON: {"query":"search keywords for finding the right skill or agent","type":"skill|agent|either","confidence":0.0-1.0}`;

  const result = await callHaikuJSON(prompt, { timeout: 3000, maxTokens: 100 });
  if (result) {
    recordHaikuSuccess();
  } else {
    recordHaikuFailure();
  }
  return result;
}

// ─── Cooldown & Dedup (DB-persisted, survives process restarts) ─────────────

/**
 * Check if session has hit the recommendation cap.
 * Separated from per-resource check so callers in filter loops can hoist this.
 * @param {Database} db Registry database
 * @param {string} sessionId Session identifier
 * @returns {boolean} true if session cap is reached
 */
export function isSessionCapped(db, sessionId) {
  if (!sessionId) return false;
  const sessionCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM invocations WHERE session_id = ? AND recommended = 1'
  ).get(sessionId);
  return sessionCount.cnt >= SESSION_RECOMMEND_CAP;
}

export function isRecentlyRecommended(db, resourceId, sessionId) {
  // Check 1: Session cap (loop-invariant — callers should prefer isSessionCapped for filter loops)
  if (sessionId) {
    if (isSessionCapped(db, sessionId)) return true;

    // Check 2: Already recommended in this session (session dedup)
    const sessionHit = db.prepare(
      'SELECT 1 FROM invocations WHERE resource_id = ? AND session_id = ? AND recommended = 1 LIMIT 1'
    ).get(resourceId, sessionId);
    if (sessionHit) return true;
  }

  // Check 3: Recommended within cooldown window (cross-session cooldown)
  const cooldownHit = db.prepare(
    `SELECT 1 FROM invocations WHERE resource_id = ? AND created_at > datetime('now', ?) LIMIT 1`
  ).get(resourceId, `-${COOLDOWN_MINUTES} minutes`);
  return !!cooldownHit;
}

// ─── Keyword Re-ranking ──────────────────────────────────────────────────────

/**
 * Re-rank results to prefer resources matching rawKeywords in their intent_tags.
 * When a user mentions domain-specific terms (e.g. "seo"), resources in that domain
 * should rank above generic resources that only match the action intent (e.g. "review").
 * Within each group (matching vs non-matching), original BM25 order is preserved.
 * No-op when rawKeywords is empty.
 * @param {object[]} results FTS5 results
 * @param {string[]} rawKeywords Domain keywords from prompt
 * @returns {object[]} Re-ranked results
 */
function reRankByKeywords(results, rawKeywords) {
  if (!rawKeywords?.length || results.length <= 1) return results;
  const matching = [];
  const rest = [];
  for (const r of results) {
    const tags = (r.intent_tags || '').toLowerCase();
    if (rawKeywords.some(kw => tags.includes(kw))) {
      matching.push(r);
    } else {
      rest.push(r);
    }
  }
  return [...matching, ...rest];
}

/**
 * Apply adoption-rate-based score decay to penalize zombie resources.
 * Uses Laplace-smoothed adoption rate with tiered multipliers.
 * Cold start protection: no penalty for recommend_count < 10.
 * @param {object[]} results FTS5 results with recommend_count/adopt_count
 * @returns {object[]} Filtered results with decayed scores
 */
function applyAdoptionDecay(results, db) {
  const decayed = results.map(r => {
    const recs = r.recommend_count || 0;
    const adopts = r.adopt_count || 0;
    if (recs < 10) return r; // Cold start protection

    const rate = (adopts + 1) / (recs + 2); // Laplace smoothing
    let multiplier = 1.0;
    if (recs > 100 && rate < 0.01) multiplier = 0.05;   // Near-block but not permanent
    else if (recs > 50 && rate < 0.02) multiplier = 0.15;
    else if (recs > 20 && rate < 0.05) multiplier = 0.4;

    // Recent rejection boost: extra penalty for resources rejected many times recently
    if (db && multiplier < 1) {
      try {
        const recentRejects = db.prepare(
          `SELECT COUNT(*) as cnt FROM invocations WHERE resource_id = ? AND adopted = 0 AND created_at > datetime('now', '-7 days')`
        ).get(r.id)?.cnt || 0;
        if (recentRejects >= 10) multiplier *= 0.3;
        else if (recentRejects >= 5) multiplier *= 0.5;
      } catch (e) { debugCatch(e, 'applyAdoptionDecay-recentRejects'); }
    }

    if (multiplier < 0.01) return null;
    if (multiplier < 1) {
      return { ...r, composite_score: (r.composite_score ?? r.relevance) * multiplier, _decayed: true };
    }
    return r;
  }).filter(Boolean);
  // Re-sort after decay: decayed zombies must drop in ranking.
  // BM25 scores are negative (more negative = better match), sort ascending.
  if (decayed.some(r => r._decayed)) {
    decayed.sort((a, b) => (a.composite_score ?? a.relevance) - (b.composite_score ?? b.relevance));
  }
  return decayed;
}

/**
 * Gate results by confidence: require at least one intent signal
 * to directly match the resource's intent_tags.
 * Prevents recommendations based solely on incidental text overlap.
 * @param {object[]} results FTS5 results
 * @param {object} signals Context signals with intent and rawKeywords arrays
 * @returns {object[]} Filtered results that pass the gate
 */
function passesConfidenceGate(results, signals) {
  // BM25 absolute minimum: filter weak text matches.
  // Stricter threshold for 3+ results (reliable IDF); gentler floor for 1-2 results.
  const minThreshold = results.length >= 3 ? BM25_MIN_THRESHOLD : 1.0;
  results = results.filter(r => {
    const score = Math.abs(r.composite_score ?? r.relevance);
    return score >= minThreshold;
  });

  // signals.intent is a comma-separated string (e.g. "test,fix"), not an array
  const intentTokens = typeof signals?.intent === 'string'
    ? signals.intent.split(',').filter(Boolean)
    : Array.isArray(signals?.intent) ? signals.intent : [];

  // No structured intent → skip gate (rawKeywords match FTS5 text columns, not intent_tags)
  if (intentTokens.length === 0) return results;

  // Expand intent tokens through DISPATCH_SYNONYMS so "fast" also matches "performance", etc.
  const rawKw = signals?.rawKeywords || [];
  const intentSet = new Set([...intentTokens, ...rawKw]);
  for (const token of intentTokens) {
    const syns = DISPATCH_SYNONYMS[token];
    if (syns) for (const s of syns) intentSet.add(s);
  }

  return results.filter(r => {
    const tags = (r.intent_tags || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    return tags.some(t => intentSet.has(t));
  });
}

// ─── Shared Post-Processing Pipeline ────────────────────────────────────────

/**
 * Standard post-processing pipeline for dispatch results.
 * Applies keyword re-ranking, adoption decay, confidence gating, and limit.
 * @param {object[]} results FTS5 results
 * @param {object} signals Context signals
 * @param {object} db Registry database
 * @param {number} [limit=3] Maximum results to return
 * @returns {object[]} Post-processed results
 */
function postProcessResults(results, signals, db, limit = 3) {
  results = reRankByKeywords(results, signals.rawKeywords);
  results = applyAdoptionDecay(results, db);
  results = passesConfidenceGate(results, signals);
  return results.slice(0, limit);
}

// ─── Main Dispatch Functions ─────────────────────────────────────────────────

/**
 * Dispatch on SessionStart: analyze user prompt, return best resource suggestion.
 * Only dispatches when continuing from a previous session (handoff).
 * Cold starts (no previous session) showed 0% adoption — skip dispatch entirely.
 * @param {Database} db Registry database
 * @param {string} userPrompt User's prompt text
 * @param {string} [sessionId] Session identifier for dedup
 * @param {Object} [options]
 * @param {boolean} [options.hasHandoff=false] Whether a previous session handoff exists
 * @returns {Promise<string|null>} Injection text or null
 */
export async function dispatchOnSessionStart(db, userPrompt, sessionId, { hasHandoff = false } = {}) {
  if (!db) return null;
  if (!hasHandoff) return null;  // Only dispatch when continuing from a previous session
  if (!userPrompt) return null;  // Prompt still required for FTS query

  try {
    const projectDomains = detectProjectDomains();

    // Primary: intent-aware enhanced query (column-targeted, better for mixed-domain prompts)
    const signals = extractContextSignals({ tool_name: '_session_start' }, { userPrompt });
    const enhancedQuery = buildEnhancedQuery(signals);

    // Fetch extra results when rawKeywords present — BM25 may rank intent-matching
    // resources above domain-specific ones; extra headroom lets reRankByKeywords promote them.
    const fetchLimit = signals.rawKeywords.length > 0 ? 8 : 3;
    let results = enhancedQuery ? retrieveResources(db, enhancedQuery, { limit: fetchLimit, projectDomains }) : [];

    // Fallback: broad text query (catches prompts without clear intent patterns)
    if (results.length === 0) {
      const textQuery = buildQueryFromText(userPrompt);
      if (!textQuery) return null;
      results = retrieveResources(db, textQuery, { limit: 3, projectDomains });
      // Filter out resources matching suppressed intents (e.g. TDD for test-running prompts)
      if (signals.suppressedIntents.length > 0) {
        results = results.filter(r => {
          const tags = (r.intent_tags || '').toLowerCase().split(/[\s,]+/);
          return !signals.suppressedIntents.some(s => tags.includes(s));
        });
      }
    }

    results = postProcessResults(results, signals, db);

    let tier = 2;

    // Tier 3: Haiku semantic fallback (SessionStart has 10s budget)
    if (needsHaikuDispatch(results)) {
      tier = 3;
      const haikuResult = await haikuDispatch(userPrompt, '');
      if (haikuResult?.query && (haikuResult.confidence ?? 0) >= HAIKU_CONFIDENCE_THRESHOLD) {
        const haikuQuery = buildQueryFromText(haikuResult.query);
        if (haikuQuery) {
          let haikuResults = retrieveResources(db, haikuQuery, {
            type: haikuResult.type === 'either' ? undefined : haikuResult.type,
            limit: 3,
            projectDomains,
          });
          if (haikuResults.length > 0) {
            haikuResults = postProcessResults(haikuResults, signals, db);
            if (haikuResults.length > 0) results = haikuResults;
          }
        }
      }
    }

    if (results.length === 0) return null;

    // Filter by DB-persisted cooldown + session dedup (hoisted cap check avoids N queries)
    if (sessionId && isSessionCapped(db, sessionId)) return null;
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
 * Dispatch on UserPromptSubmit: analyze user's actual prompt, return best resource suggestion.
 * Tier 1+2 only (no Haiku fallback) for fast response within hook timeout.
 * Cooldown + session dedup prevents double-recommending with SessionStart.
 * @param {Database} db Registry database
 * @param {string} userPrompt User's prompt text
 * @param {string} [sessionId] Session identifier for dedup
 * @returns {Promise<string|null>} Injection text or null
 */
export async function dispatchOnUserPrompt(db, userPrompt, sessionId, { sessionEvents } = {}) {
  if (!userPrompt || !db) return null;

  try {
    // 1. Explicit request → highest priority, bypass cooldown but apply adoption decay
    const explicit = detectExplicitRequest(userPrompt);
    if (explicit.isExplicit) {
      const textQuery = buildQueryFromText(explicit.searchTerm);
      if (textQuery) {
        let explicitResults = retrieveResources(db, textQuery, { limit: 3, projectDomains: detectProjectDomains() });
        explicitResults = applyAdoptionDecay(explicitResults, db);
        if (explicitResults.length > 0) {
          const best = explicitResults[0];
          if (!sessionId || !isRecentlyRecommended(db, best.id, sessionId)) {
            recordInvocation(db, { resource_id: best.id, session_id: sessionId, trigger: 'user_prompt', tier: 1, recommended: 1 });
            updateResourceStats(db, best.id, 'recommend_count');
            return renderInjection(best);
          }
        }
      }
    }

    // 2. Suite auto-flow protection
    const events = sessionEvents || peekToolEvents();
    const activeSuite = detectActiveSuite(events);

    const projectDomains = detectProjectDomains();

    // Intent-aware enhanced query (column-targeted)
    const signals = extractContextSignals({ tool_name: '_user_prompt' }, { userPrompt });

    // Check if active suite covers the current stage
    if (activeSuite) {
      const currentStage = inferCurrentStage(signals.primaryIntent, activeSuite);
      if (currentStage) {
        const { shouldRecommend } = shouldRecommendForStage(activeSuite, currentStage);
        if (!shouldRecommend) return null;
      }
    }

    // 3. Normal FTS flow
    const enhancedQuery = buildEnhancedQuery(signals);

    // Fetch extra results when rawKeywords are present — the top-3 by BM25 may be
    // dominated by intent synonyms (e.g. "review" expands to many code-review terms),
    // pushing domain-specific resources (e.g. SEO) below the limit. Extra headroom
    // lets reRankByKeywords() promote domain-matched resources to the top.
    const fetchLimit = signals.rawKeywords.length > 0 ? 8 : 3;
    let results = enhancedQuery ? retrieveResources(db, enhancedQuery, { limit: fetchLimit, projectDomains }) : [];

    // Fallback: broad text query
    if (results.length === 0) {
      const textQuery = buildQueryFromText(userPrompt);
      if (!textQuery) return null;
      results = retrieveResources(db, textQuery, { limit: 3, projectDomains });
      if (signals.suppressedIntents.length > 0) {
        results = results.filter(r => {
          const tags = (r.intent_tags || '').toLowerCase().split(/[\s,]+/);
          return !signals.suppressedIntents.some(s => tags.includes(s));
        });
      }
    }

    results = postProcessResults(results, signals, db);

    if (results.length === 0) return null;

    // Low confidence → skip (no Haiku in user_prompt path — stay fast)
    if (needsHaikuDispatch(results)) return null;

    // Filter by cooldown + session dedup (hoisted cap check avoids N queries)
    if (sessionId && isSessionCapped(db, sessionId)) return null;
    const viable = sessionId
      ? results.filter(r => !isRecentlyRecommended(db, r.id, sessionId))
      : results;
    if (viable.length === 0) return null;

    const best = viable[0];

    recordInvocation(db, {
      resource_id: best.id,
      session_id: sessionId || null,
      trigger: 'user_prompt',
      tier: 2,
      recommended: 1,
    });
    updateResourceStats(db, best.id, 'recommend_count');

    return renderInjection(best);
  } catch (e) {
    debugCatch(e, 'dispatchOnUserPrompt');
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

    // Suite protection: if a suite auto-flow is active, suppress recommendations
    // for stages the suite already covers
    const events = peekToolEvents();
    const activeSuite = detectActiveSuite(events);
    if (activeSuite) {
      const stage = inferCurrentStage(signals.primaryIntent, activeSuite);
      if (stage) {
        const { shouldRecommend } = shouldRecommendForStage(activeSuite, stage);
        if (!shouldRecommend) return null;
      }
    }
    let query = buildEnhancedQuery(signals);
    if (!query && sessionCtx?.userPrompt) {
      query = buildQueryFromText(sessionCtx.userPrompt);
      if (!query) return null;
    }
    if (!query) return null;

    const projectDomains = detectProjectDomains();

    // Tier 2: FTS5 retrieval
    let results = retrieveResources(db, query, { limit: 3, projectDomains });
    results = postProcessResults(results, signals, db);
    if (results.length === 0) return null;

    const tier = 2; // Tier 3 disabled for PreToolUse — 2s hook timeout insufficient

    // Low-confidence results: skip recommendation rather than suggest unreliable match
    if (needsHaikuDispatch(results)) return null;

    // Apply DB-persisted cooldown and session dedup (hoisted cap check avoids N queries)
    const sid = sessionCtx.sessionId || null;
    if (sid && isSessionCapped(db, sid)) return null;
    const viable = sid
      ? results.filter(r => !isRecentlyRecommended(db, r.id, sid))
      : results;
    if (viable.length === 0) return null;
    const best = viable[0];

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
