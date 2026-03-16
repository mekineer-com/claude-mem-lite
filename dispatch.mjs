// claude-mem-lite: Dispatch orchestration — 2-tier intelligent resource dispatch
// Tier 0: Local fast filter (<1ms)
// Tier 1: Context signal extraction (<1ms)
// Tier 2: Enhanced FTS5 retrieval (<5ms)

import { basename, join } from 'path';
import { existsSync } from 'fs';
import { retrieveResources, buildEnhancedQuery, buildQueryFromText, DISPATCH_SYNONYMS } from './registry-retriever.mjs';
import { renderInjection, renderHint } from './dispatch-inject.mjs';
import { updateResourceStats, recordInvocation } from './registry.mjs';
import { debugCatch } from './utils.mjs';
import { peekToolEvents } from './hook-shared.mjs';
import { detectActiveSuite, shouldRecommendForStage, detectExplicitRequest, inferCurrentStage } from './dispatch-workflow.mjs';
import { detectFailurePattern } from './dispatch-patterns.mjs';

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
    failurePattern: null, // detected failure pattern from session events (repeated-test-fail, etc.)
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

  // Failure pattern detection: override signals when Claude is struggling
  const failurePattern = sessionCtx?.sessionEvents
    ? detectFailurePattern(sessionCtx.sessionEvents)
    : null;

  if (failurePattern) {
    if (!signals.primaryIntent || failurePattern.confidence > 0.7) {
      signals.primaryIntent = failurePattern.resource_intent;
      if (!signals.intent.includes(failurePattern.resource_intent)) {
        signals.intent = signals.intent
          ? `${failurePattern.resource_intent},${signals.intent}`
          : failurePattern.resource_intent;
      }
    }
    signals.failurePattern = failurePattern;
  }

  return signals;
}

// Negation patterns: "don't test", "not deploy", "别测试", "不要部署"
const NEGATION_EN = /\b(?:don'?t|do\s+not|no\s+need\s+to|skip|without|avoid|not|never|stop|cancel|ignore|hold\s+off)\s+/i;
const NEGATION_CJK = /(?:不要|别|不用|先别|暂时不|不需要|跳过|停止|取消|算了|不做|不搞)/;

// Test-run vs test-write disambiguation (module-scoped for performance)
const _RUN_TEST = /\b(run\w*\s+(?:the\s+)?tests?|npm\s+test|npx\s+(?:vitest|jest|mocha|pytest)|yarn\s+test|pnpm\s+test|make\s+test|cargo\s+test|go\s+test|check\s+(?:if\s+)?tests?\s+pass|execute\s+(?:the\s+)?tests?)\b/i;
const _RUN_TEST_CJK = /(?:运行测试|跑测试|跑一下测试|跑单测|跑一下单测|执行测试|执行单测|测试跑|看测试|看单测)/;
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
// Intent patterns — pre-compiled at module scope to avoid re-creating RegExp on every call.
// Each entry: [pattern, globalPattern, tag]. Pattern ordering determines PRIMARY intent (first match).
// Priority: action verbs → domain-specific → quality/style → generic/overloaded.
const _INTENT_PATTERNS = (() => {
  const raw = [
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
    [/(审查|审核|审计|代码审查|评审|代码审核|看看代码|review)/, 'review'],
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
    // search: only unambiguous web/info search indicators — NOT code search (grep/find).
    // "搜索" alone is ambiguous (code search vs web search), so require context modifiers.
    [/(联网搜索|网上搜索|在线搜索|上网查|搜索.{0,2}最新|搜一下.{0,2}最新|查.{0,2}最新|查资料|找资料|搜索资料|搜索文档)/, 'search'],
    [/\b(google|search\s+online|web\s+search|look\s+up\s+(?:the\s+)?(?:latest|newest|recent|docs?|documentation))\b/i, 'search'],
  ];
  // Pre-compile global variants for matchAll — avoids creating new RegExp on every extractIntent call
  return raw.map(([p, tag]) => [p, new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'), tag]);
})();

const _CLAUSE_BOUNDARY = /[,，。；;、.!?！？]/;

function extractIntent(prompt) {
  if (!prompt) return { intent: '', suppressed: [] };

  // Build per-tag negation/affirmation tracking.
  // A tag is only excluded if ALL its matching instances are negated.
  // This handles mixed-language inputs like "不要测试了，但 write the tests for auth"
  // where the Chinese variant is negated but the English variant is not.
  const tagHasAffirmative = new Map(); // tag → true if any non-negated match exists
  const tagMatched = new Set();        // tags that matched at least once

  for (const [, globalPattern, tag] of _INTENT_PATTERNS) {
    // matchAll finds ALL matches (not just the first).
    // This handles "don't test auth, but test UI" where the first match is negated
    // but the second is affirmative — the tag should still be included.
    const matches = prompt.matchAll(globalPattern);
    for (const match of matches) {
      tagMatched.add(tag);
      const matchStart = match.index;
      // EN: 20-char window, CJK: 8-char window — check both
      const enPrefix = prompt.slice(Math.max(0, matchStart - 20), matchStart);
      const cjkPrefix = prompt.slice(Math.max(0, matchStart - 8), matchStart);
      // Clause boundary check: if a comma/period separates negation from keyword, skip
      const hasEnNeg = NEGATION_EN.test(enPrefix) && !_CLAUSE_BOUNDARY.test(enPrefix);
      const hasCjkNeg = NEGATION_CJK.test(cjkPrefix) && !_CLAUSE_BOUNDARY.test(cjkPrefix);
      if (!hasEnNeg && !hasCjkNeg) {
        tagHasAffirmative.set(tag, true);
      }
    }
  }

  const found = [];
  const suppressed = [];
  for (const tag of tagMatched) {
    if (tagHasAffirmative.get(tag) && !found.includes(tag)) {
      found.push(tag);
    } else if (!tagHasAffirmative.get(tag)) {
      // Tag was matched but ALL instances were negated → suppress it.
      // This feeds the text-fallback filter to prevent recommending negated resources.
      suppressed.push(tag);
    }
  }

  // Distinguish test-running from test-writing: "run tests" / "npm test" / "运行测试" should NOT
  // trigger TDD recommendations. Only keep 'test' intent when the prompt implies *writing* tests.
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
export { NEGATION_EN as _NEGATION_EN, NEGATION_CJK as _NEGATION_CJK, reRankByKeywords as _reRankByKeywords, applyAdoptionDecay as _applyAdoptionDecay, passesConfidenceGate as _passesConfidenceGate, filterAutoLoadedSkills as _filterAutoLoadedSkills, filterGarbageMetadata as _filterGarbageMetadata, decideTier as _decideTier };

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
  'implement', 'configure', 'code', 'file', 'function', 'module', 'app', 'system',
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

// ─── Phase Transition Detection ─────────────────────────────────────────────

const PHASE_TOOL_MAP = {
  Read: 'EXPLORE', Glob: 'EXPLORE', Grep: 'EXPLORE', LSP: 'EXPLORE',
  Edit: 'IMPLEMENT', Write: 'IMPLEMENT', NotebookEdit: 'IMPLEMENT',
};

/**
 * Infer current session phase from recent tool events.
 * @param {object[]} events Recent tool events
 * @returns {string} Phase: EXPLORE | IMPLEMENT | DEBUG | TEST | COMMIT
 */
export function inferSessionPhase(events) {
  if (!events || events.length === 0) return 'EXPLORE';

  // Look at last 5 events, filter to significant ones (skip Read-only)
  const recent = events.slice(-5);
  const lastSignificant = recent.filter(e =>
    e.tool_name !== 'Read' && e.tool_name !== 'Glob' && e.tool_name !== 'Grep'
  ).slice(-3);

  if (lastSignificant.length === 0) return 'EXPLORE';

  const last = lastSignificant[lastSignificant.length - 1];

  if (last.tool_name === 'Bash') {
    const cmd = (last.tool_input?.command || '').toLowerCase();
    const resp = (last.tool_response || '');
    if (/\bgit\s+(commit|push|merge|tag)\b/.test(cmd)) return 'COMMIT';
    if (/\b(test|jest|vitest|pytest|mocha)\b/.test(cmd)) return 'TEST';
    if (/error|fail|exception/i.test(resp) && resp.length > 30) return 'DEBUG';
    return 'IMPLEMENT';
  }

  return PHASE_TOOL_MAP[last.tool_name] || 'IMPLEMENT';
}

/**
 * Check if a phase transition occurred.
 * @param {string|null} prev Previous phase
 * @param {string} current Current phase
 * @returns {boolean}
 */
export function isPhaseTransition(prev, current) {
  return prev !== null && prev !== current;
}

// Module-level phase state for dispatchOnPreToolUse
let _lastPhase = null;

/** Reset phase state (for testing). */
export function _resetPhaseState() { _lastPhase = null; }

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

/**
 * Compute adaptive cooldown based on recent adoption rate.
 * High adoption → shorter cooldown (user welcomes recommendations).
 * Low adoption → longer cooldown (reduce noise).
 * @param {Database} db Registry database
 * @returns {number} Cooldown in minutes
 */
function getAdaptiveCooldown(db) {
  try {
    const stats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN adopted = 1 THEN 1 ELSE 0 END) as adopted
      FROM invocations
      WHERE recommended = 1 AND created_at > datetime('now', '-7 days')
    `).get();
    if (!stats || stats.total < 5) return COOLDOWN_MINUTES; // Not enough data, use default
    const rate = stats.adopted / stats.total;
    if (rate > 0.5) return 30;   // High adoption: 30 min
    if (rate > 0.2) return 60;   // Medium: 60 min (default)
    if (rate > 0.1) return 120;  // Low: 2 hours
    return 240;                   // Very low: 4 hours
  } catch { return COOLDOWN_MINUTES; }
}

/**
 * Compute per-resource cooldown based on its individual adoption rate.
 * High-adoption resources (like code-review-expert at 90%) get shorter cooldown,
 * ensuring valuable resources are recommended more frequently.
 * @param {Database} db Registry database
 * @param {number} resourceId Resource ID
 * @param {number} globalCd Global adaptive cooldown (fallback)
 * @returns {number} Cooldown in minutes for this specific resource
 */
function getPerResourceCooldown(db, resourceId, globalCd) {
  try {
    const stats = db.prepare(
      'SELECT recommend_count, adopt_count FROM resources WHERE id = ?'
    ).get(resourceId);
    if (!stats || stats.recommend_count < 5) return globalCd; // Not enough data
    const rate = (stats.adopt_count + 1) / (stats.recommend_count + 2); // Laplace smoothed
    if (rate > 0.5) return Math.min(globalCd, 15);   // Very high adoption: 15 min
    if (rate > 0.3) return Math.min(globalCd, 30);   // High adoption: 30 min
    return globalCd; // Default: use global cooldown
  } catch { return globalCd; }
}

const CONSECUTIVE_REJECT_THRESHOLD = 8;
const CONSECUTIVE_REJECT_WINDOW_DAYS = 7;
const BASE_COOLDOWN_HOURS = 1;
const MAX_COOLDOWN_HOURS = 256; // ~10.7 days cap
const COOLDOWN_RESET_DAYS = 7;  // Reset backoff if no recommendation in 7 days

/**
 * Check if a resource has been consecutively rejected (not adopted) in recent history.
 * Uses exponential backoff instead of binary 30-day silence:
 *   1h → 2h → 4h → 8h → ... → 256h (cap)
 * Backoff resets after COOLDOWN_RESET_DAYS of no recommendations.
 *
 * @param {Database} db Registry database
 * @param {number} resourceId Resource ID
 * @returns {boolean} true if resource should be silenced
 */
function isConsecutivelyRejected(db, resourceId) {
  try {
    // Check active silence first (most efficient)
    const res = db.prepare(
      `SELECT silenced_until, cooldown_hours FROM resources WHERE id = ?`
    ).get(resourceId);
    if (!res) return false;
    if (res.silenced_until && new Date(res.silenced_until) > new Date()) return true;

    // Reset backoff if no recommendation in COOLDOWN_RESET_DAYS
    const lastRec = db.prepare(
      `SELECT created_at FROM invocations WHERE resource_id = ? AND recommended = 1 ORDER BY created_at DESC LIMIT 1`
    ).get(resourceId);
    if (lastRec) {
      const daysSince = (Date.now() - new Date(lastRec.created_at).getTime()) / 86400000;
      if (daysSince > COOLDOWN_RESET_DAYS && (res.cooldown_hours || 0) > 0) {
        db.prepare('UPDATE resources SET cooldown_hours = 0, silenced_until = NULL WHERE id = ?').run(resourceId);
        return false;
      }
    }

    const recent = db.prepare(`
      SELECT adopted FROM invocations
      WHERE resource_id = ? AND recommended = 1
        AND created_at > datetime('now', ?)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(resourceId, `-${CONSECUTIVE_REJECT_WINDOW_DAYS} days`, CONSECUTIVE_REJECT_THRESHOLD);

    if (recent.length < CONSECUTIVE_REJECT_THRESHOLD) return false;
    if (!recent.every(r => r.adopted === 0)) return false;

    // Exponential backoff: double cooldown each cycle (or start at base)
    const currentHours = res.cooldown_hours || 0;
    const nextHours = Math.min(
      currentHours === 0 ? BASE_COOLDOWN_HOURS : currentHours * 2,
      MAX_COOLDOWN_HOURS
    );

    try {
      db.prepare(
        `UPDATE resources SET silenced_until = datetime('now', '+${nextHours} hours'), cooldown_hours = ? WHERE id = ?`
      ).run(nextHours, resourceId);
    } catch { /* best-effort */ }
    return true;
  } catch { return false; }
}

export function isRecentlyRecommended(db, resourceId, sessionId, { skipCapCheck = false, cooldown } = {}) {
  // Check 1: Session cap (loop-invariant — callers should hoist isSessionCapped and pass skipCapCheck: true)
  if (sessionId && !skipCapCheck) {
    if (isSessionCapped(db, sessionId)) return true;

    // Check 2: Already recommended in this session (session dedup)
    const sessionHit = db.prepare(
      'SELECT 1 FROM invocations WHERE resource_id = ? AND session_id = ? AND recommended = 1 LIMIT 1'
    ).get(resourceId, sessionId);
    if (sessionHit) return true;
  }

  // Check 3: Consecutive rejection silencing
  if (isConsecutivelyRejected(db, resourceId)) return true;

  // Check 4: Recommended within adaptive cooldown window (cross-session cooldown)
  // Per-resource cooldown: high-adoption resources get shorter cooldown
  const globalCd = cooldown ?? getAdaptiveCooldown(db);
  const resourceCd = getPerResourceCooldown(db, resourceId, globalCd);
  const cooldownHit = db.prepare(
    `SELECT 1 FROM invocations WHERE resource_id = ? AND created_at > datetime('now', ?) LIMIT 1`
  ).get(resourceId, `-${resourceCd} minutes`);
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
  // Threshold is relative to the top result's score to handle varying corpus sizes:
  // small corpora (< 50 resources) naturally produce lower BM25 IDF values,
  // so an absolute threshold would over-filter genuine matches.
  const baseThreshold = results.length >= 3 ? BM25_MIN_THRESHOLD : 0.5;
  const topScore = results.length > 0 ? Math.abs(results[0].composite_score ?? results[0].relevance ?? 0) : 0;
  // Use the lower of: absolute threshold OR 30% of top score (corpus-size-adaptive floor)
  const minThreshold = topScore > 0 ? Math.min(baseThreshold, topScore * 0.3) : baseThreshold;
  results = results.filter(r => {
    const raw = r.composite_score ?? r.relevance;
    if (raw === null || raw === undefined) return true; // no score → pass (pre-scored or synthetic result)
    return Math.abs(raw) >= minThreshold;
  });

  // Gap check: if top-2 results are too close in score, the query is ambiguous.
  // This prevents recommending when multiple resources match equally well,
  // which usually means the match is incidental rather than precise.
  // Skip the gap check when rawKeywords promoted #1 (keyword re-ranking changes order,
  // so the BM25 gap no longer reflects true relevance — the keyword match is extra signal).
  if (results.length >= 2) {
    const top1 = Math.abs(results[0].composite_score ?? results[0].relevance ?? 0);
    const top2 = Math.abs(results[1].composite_score ?? results[1].relevance ?? 0);
    // After keyword re-ranking, #1 may have lower raw BM25 than #2.
    // Only skip gap check if #1 was actually promoted by a keyword match
    // (not just any rawKeywords present with incidentally inverted scores).
    const top1Tags = (results[0].intent_tags || '').toLowerCase();
    const top1MatchesKw = signals?.rawKeywords?.some(kw => top1Tags.includes(kw));
    const wasReRanked = top1MatchesKw && top1 < top2;
    if (!wasReRanked && top1 > 0) {
      const gapRatio = (top1 - top2) / top1;
      if (gapRatio < 0.2) {
        // Top-1 has no clear lead — ambiguous match, suppress recommendation
        return [];
      }
    }
  }

  // signals.intent is a comma-separated string (e.g. "test,fix"), not an array
  const intentTokens = typeof signals?.intent === 'string'
    ? signals.intent.split(',').filter(Boolean)
    : Array.isArray(signals?.intent) ? signals.intent : [];

  // No structured intent → skip gate (rawKeywords match FTS5 text columns, not intent_tags)
  if (intentTokens.length === 0) return results;

  // Expand ALL intent tokens through DISPATCH_SYNONYMS.
  // rawKeywords are excluded from intentSet — they contribute to FTS5 scoring
  // but must NOT bypass the intent gate. Including them caused false positives
  // (e.g. "debug the dispatch system" → llm-router matched on "dispatch" tag).
  const intentSet = new Set(intentTokens);
  for (const token of intentTokens) {
    const syns = DISPATCH_SYNONYMS[token];
    if (syns) for (const s of syns) intentSet.add(s);
  }

  // Filter: resource must match at least one intent
  const passing = results.filter(r => {
    const tags = (r.intent_tags || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    return tags.some(t => intentSet.has(t));
  });

  // Primary intent preference: when multiple intents extracted (e.g. "fix,commit"),
  // prefer resources matching the primary intent to avoid false positives from
  // incidental context (e.g. recommending git-workflow when user primarily wants to debug).
  if (intentTokens.length > 1 && passing.length > 1) {
    const primaryIntent = signals?.primaryIntent || intentTokens[0] || '';
    const primarySet = new Set([primaryIntent]);
    const primarySyns = DISPATCH_SYNONYMS[primaryIntent];
    if (primarySyns) for (const s of primarySyns) primarySet.add(s);

    const primaryMatches = passing.filter(r => {
      const tags = (r.intent_tags || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
      return tags.some(t => primarySet.has(t));
    });
    if (primaryMatches.length > 0) return primaryMatches;
  }

  return passing;
}

// ─── Auto-loaded Skill Filter ────────────────────────────────────────────────

// Plugin-namespaced skills with high adoption rates deserve proactive recommendations
// even though they're listed in system-reminder. The listing alone doesn't guarantee
// Claude invokes them at the right moment — a contextual nudge at the right time
// is more effective than a static list.
const AUTOLOADED_MIN_ADOPTIONS = 3;    // Must have been adopted at least N times total
const AUTOLOADED_MIN_ADOPT_RATE = 0.08; // Minimum adoption rate to keep recommending

/**
 * Filter auto-loaded skills with adoption-aware logic.
 *
 * Plugin-namespaced skills (e.g. "superpowers:systematic-debugging") are listed
 * in system-reminder, so Claude already knows about them. However, blanket filtering
 * removes high-value skills that users actually adopt when recommended contextually.
 *
 * Strategy: filter auto-loaded skills that have poor adoption history (recommend fatigue),
 * but keep those that users actually adopt — the contextual timing adds real value.
 *
 * User-installed standalone skills (non-namespaced like "build-error-resolver")
 * are always KEPT — contextual recommendations still add value.
 *
 * @param {object[]} results FTS5 results
 * @returns {object[]} Filtered results
 */
function filterAutoLoadedSkills(results) {
  return results.filter(r => {
    if (r.type !== 'skill') return true;
    const inv = (r.invocation_name || '').trim();
    if (inv === '') return true; // Community resource — always recommend
    // Standalone installed skills (e.g. "build-error-resolver") — keep
    if (!inv.includes(':')) return true;
    // Plugin-namespaced: adoption-aware filter
    // Cold start: keep if never recommended (no data to judge yet)
    const recs = r.recommend_count || 0;
    if (recs < 5) return true;
    // Keep if adoption rate is healthy
    const adopts = r.adopt_count || 0;
    if (adopts >= AUTOLOADED_MIN_ADOPTIONS && (adopts + 1) / (recs + 2) >= AUTOLOADED_MIN_ADOPT_RATE) return true;
    // Poor adoption history — suppress proactive recommendation
    return false;
  });
}

// ─── Metadata Quality Gate ──────────────────────────────────────────────────

const GARBAGE_METADATA_OVERLAP_THRESHOLD = 0.8;
const MIN_TOKEN_LENGTH = 2;

/**
 * Filter out resources with auto-generated garbage metadata.
 * Auto-generated metadata restates the resource name as capability_summary
 * (e.g., "agent: error debugging/error detective"), causing overly broad FTS5 matches.
 * @param {object[]} results FTS5 results
 * @returns {object[]} Filtered results (garbage metadata removed)
 */
function filterGarbageMetadata(results) {
  return results.filter(r => {
    const cap = (r.capability_summary || '').toLowerCase().trim();
    if (!cap) return false; // No metadata at all — filter
    const name = (r.name || '').toLowerCase();
    // Garbage pattern: capability_summary is just "type: name" (restated name)
    const nameTokens = name.replace(/[/-]/g, ' ').split(/\s+/).filter(t => t.length >= MIN_TOKEN_LENGTH);
    if (nameTokens.length === 0) return true;
    const capTokens = cap.replace(/[/-:]/g, ' ').split(/\s+/).filter(t => t.length >= MIN_TOKEN_LENGTH);
    if (capTokens.length === 0) return true;
    const overlap = capTokens.filter(t => nameTokens.includes(t)).length;
    return overlap / capTokens.length < GARBAGE_METADATA_OVERLAP_THRESHOLD;
  });
}

// ─── Shared Post-Processing Pipeline ────────────────────────────────────────

/**
 * Standard post-processing pipeline for dispatch results.
 * Applies auto-loaded filter, metadata quality gate, keyword re-ranking,
 * adoption decay, confidence gating, and limit.
 * @param {object[]} results FTS5 results
 * @param {object} signals Context signals
 * @param {object} db Registry database
 * @param {number} [limit=3] Maximum results to return
 * @returns {object[]} Post-processed results
 */
function postProcessResults(results, signals, db, limit = 3, { allowOnRequest = false } = {}) {
  // Filter on_request resources from proactive dispatch (they're only for explicit user requests)
  if (!allowOnRequest) {
    results = results.filter(r => (r.recommendation_mode || 'proactive') === 'proactive');
  }
  results = filterAutoLoadedSkills(results);
  results = filterGarbageMetadata(results);
  results = reRankByKeywords(results, signals.rawKeywords);
  results = applyAdoptionDecay(results, db);
  results = passesConfidenceGate(results, signals);
  return results.slice(0, limit);
}

// ─── Tiered Rendering ────────────────────────────────────────────────────────

/**
 * Decide rendering tier based on composite score.
 * High confidence → full injection (~500 tokens)
 * Medium confidence → one-line hint (~30 tokens)
 * Low confidence → silent (no injection)
 *
 * @param {object} resource Best resource from post-processing
 * @param {object} signals Context signals (may include failurePattern)
 * @returns {'full'|'hint'|'silent'}
 */
function decideTier(resource, signals) {
  const raw = Math.abs(resource.composite_score ?? resource.relevance ?? 0);

  // Pattern-detected pain point: boost confidence
  const patternBoost = signals?.failurePattern?.confidence ?? 0;

  // Normalize: typical good matches score 5-50, great matches 20+
  // Sigmoid-like mapping to 0-1 range
  const normalized = raw / (raw + 5.0); // 5→0.5, 10→0.67, 20→0.8, 50→0.91

  // Signal-based confidence floor: if the result passed structured intent matching
  // + keyword re-ranking, BM25 score alone shouldn't downgrade to 'silent'.
  // Small corpora produce low BM25 scores even for strong matches.
  let signalBoost = 0;
  if (signals?.primaryIntent) {
    const tags = (resource.intent_tags || '').toLowerCase().split(/[\s,]+/);
    // Direct intent match: resource's intent_tags contain the detected primary intent.
    // Strong boost (0.3) ensures small-corpus matches still reach 'hint' tier.
    if (tags.includes(signals.primaryIntent)) signalBoost += 0.3;
    else signalBoost += 0.1;
  }
  if (signals?.rawKeywords?.length > 0) {
    const tagArr = (resource.intent_tags || '').toLowerCase().split(/[\s,]+/);
    if (signals.rawKeywords.some(kw => tagArr.includes(kw))) signalBoost += 0.2;
  }

  const confidence = Math.min(1.0, normalized + patternBoost * 0.3 + signalBoost);

  if (confidence >= 0.55) return 'full';
  if (confidence >= 0.3) return 'hint';
  return 'silent';
}

// ─── Recommendation Reason ──────────────────────────────────────────────────

const INTENT_LABELS = {
  test: 'testing', fix: 'debugging', review: 'code review', commit: 'git workflow',
  deploy: 'deployment', plan: 'planning', clean: 'refactoring', doc: 'documentation',
  db: 'database', api: 'API', secure: 'security', infra: 'infrastructure',
  build: 'build tooling', fast: 'performance', lint: 'code style', design: 'UI/frontend',
};

/**
 * Build a brief human-readable reason for why a resource was recommended.
 * @param {object} signals Context signals from extractContextSignals
 * @param {object} [options]
 * @param {boolean} [options.explicit] Whether this was an explicit user request
 * @returns {string} Brief reason string
 */
function buildRecommendReason(signals, { explicit = false } = {}) {
  if (explicit) return 'Matched your explicit request';

  const parts = [];
  if (signals?.primaryIntent) {
    const label = INTENT_LABELS[signals.primaryIntent] || signals.primaryIntent;
    parts.push(`${label} intent detected`);
  }
  if (signals?.rawKeywords?.length > 0) {
    parts.push(`keywords: ${signals.rawKeywords.slice(0, 3).join(', ')}`);
  }
  return parts.join('; ') || '';
}

// ─── Main Dispatch Functions ─────────────────────────────────────────────────

/**
 * Dispatch on SessionStart — permanently disabled.
 * Data: 0/122 adoption across all session_start recommendations.
 * Session-start context injection (Last Session, Key Context) remains active via hook.mjs.
 * Resource dispatch at session-start adds no value — user_prompt and pre_tool_use cover all needs.
 */
export async function dispatchOnSessionStart() {
  return null;
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
export async function dispatchOnUserPrompt(db, userPrompt, sessionId, { sessionEvents, prevContext } = {}) {
  if (!userPrompt || !db) return null;

  try {
    // 1. Explicit request → highest priority, bypass cooldown but apply adoption decay
    const explicit = detectExplicitRequest(userPrompt);
    if (explicit.isExplicit) {
      const textQuery = buildQueryFromText(explicit.searchTerm);
      if (textQuery) {
        let explicitResults = retrieveResources(db, textQuery, { limit: 3, projectDomains: detectProjectDomains() });
        explicitResults = filterAutoLoadedSkills(explicitResults);
        explicitResults = filterGarbageMetadata(explicitResults);
        explicitResults = applyAdoptionDecay(explicitResults, db);
        if (explicitResults.length > 0) {
          const best = explicitResults[0];
          if (!sessionId || !isRecentlyRecommended(db, best.id, sessionId)) {
            recordInvocation(db, { resource_id: best.id, session_id: sessionId, trigger: 'user_prompt', tier: 1, recommended: 1 });
            updateResourceStats(db, best.id, 'recommend_count');
            return renderInjection(best, buildRecommendReason(null, { explicit: true }));
          }
        }
      }
    }

    // 2. Suite auto-flow protection
    const events = sessionEvents || peekToolEvents();
    const activeSuite = detectActiveSuite(events);

    const projectDomains = detectProjectDomains();

    // Enrich prompt with previous session context (cached at session-start).
    // Combines project history (next_steps) with user intent for richer signal.
    const enrichedPrompt = prevContext
      ? `${userPrompt}\n[Previous session: ${prevContext}]`
      : userPrompt;

    // Intent-aware enhanced query (column-targeted)
    const signals = extractContextSignals({ tool_name: '_user_prompt' }, { userPrompt: enrichedPrompt });

    // Check if active suite covers the current stage
    if (activeSuite) {
      const currentStage = inferCurrentStage(signals.primaryIntent, activeSuite, signals.suppressedIntents);
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

    // Filter by cooldown + session dedup (hoisted cap + cooldown avoids N queries)
    if (sessionId && isSessionCapped(db, sessionId)) return null;
    const cooldown = getAdaptiveCooldown(db);
    const viable = sessionId
      ? results.filter(r => !isRecentlyRecommended(db, r.id, sessionId, { skipCapCheck: true, cooldown }))
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

    const tier = decideTier(best, signals);
    if (tier === 'silent') return null;
    if (tier === 'hint') return renderHint(best);
    return renderInjection(best, buildRecommendReason(signals));
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

    // Phase transition gate: only dispatch on phase transitions to reduce noise.
    // The first few events (≤3) always pass to allow initial recommendations.
    const allEvents = peekToolEvents();
    const currentPhase = inferSessionPhase(allEvents);
    const phaseChanged = isPhaseTransition(_lastPhase, currentPhase);
    _lastPhase = currentPhase;

    if (!phaseChanged && allEvents.length > 3) return null;

    // Tier 1: Extract context signals
    const signals = extractContextSignals(event, sessionCtx);

    // Suite protection: if a suite auto-flow is active, suppress recommendations
    // for stages the suite already covers
    const activeSuite = detectActiveSuite(allEvents);
    if (activeSuite) {
      const stage = inferCurrentStage(signals.primaryIntent, activeSuite, signals.suppressedIntents);
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

    // Apply DB-persisted cooldown and session dedup (hoisted cap + cooldown avoids N queries)
    const sid = sessionCtx.sessionId || null;
    if (sid && isSessionCapped(db, sid)) return null;
    const cooldown = getAdaptiveCooldown(db);
    const viable = sid
      ? results.filter(r => !isRecentlyRecommended(db, r.id, sid, { skipCapCheck: true, cooldown }))
      : results;
    if (viable.length === 0) return null;
    const best = viable[0];

    // Record invocation (also serves as cooldown/dedup marker)
    recordInvocation(db, {
      resource_id: best.id,
      session_id: sid,
      trigger: 'pre_tool_use',
      tier: 2,
      recommended: 1,
    });
    updateResourceStats(db, best.id, 'recommend_count');

    const tier = decideTier(best, signals);
    if (tier === 'silent') return null;
    if (tier === 'hint') return renderHint(best);
    return renderInjection(best, buildRecommendReason(signals));
  } catch (e) {
    debugCatch(e, 'dispatchOnPreToolUse');
    return null;
  }
}
