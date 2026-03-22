// nlp.mjs -- FTS5 query building, synonym expansion, CJK tokenization.
// Extracted from utils.mjs for focused module boundaries.

import { BASE_STOP_WORDS } from './stop-words.mjs';

// ─── FTS5 Constants ──────────────────────────────────────────────────────────

const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

// ─── Synonym Map ─────────────────────────────────────────────────────────────

// Synonym/abbreviation map: query abbreviation -> expanded full forms
// Bidirectional: both directions are registered so "K8s" finds "Kubernetes" and vice versa
export const SYNONYM_MAP = new Map();
const SYNONYM_PAIRS = [
  // Abbreviation ↔ full form
  ['k8s', 'kubernetes'],
  ['db', 'database'],
  ['js', 'javascript'],
  ['ts', 'typescript'],
  ['py', 'python'],
  ['ci', 'continuous integration'],
  ['cd', 'continuous deployment'],
  ['ws', 'websocket'],
  ['auth', 'authentication'],
  ['authn', 'authentication'],
  ['authz', 'authorization'],
  ['config', 'configuration'],
  ['deps', 'dependencies'],
  ['env', 'environment'],
  ['infra', 'infrastructure'],
  ['msg', 'message'],
  ['pkg', 'package'],
  ['repo', 'repository'],
  ['req', 'request'],
  ['res', 'response'],
  ['ml', 'machine learning'],
  ['ai', 'artificial intelligence'],
  ['api', 'application programming interface'],
  ['ui', 'user interface'],
  ['ux', 'user experience'],
  ['fe', 'frontend'],
  ['be', 'backend'],
  ['gql', 'graphql'],
  ['tf', 'terraform'],
  ['cdk', 'cloud development kit'],
  ['iac', 'infrastructure as code'],
  ['e2e', 'end to end'],
  ['perf', 'performance'],
  ['impl', 'implementation'],
  ['fn', 'function'],
  ['util', 'utility'],
  ['utils', 'utilities'],
  ['err', 'error'],
  ['src', 'source'],
  ['lib', 'library'],
  ['dev', 'development'],
  ['prod', 'production'],
  ['async', 'asynchronous'],
  ['sync', 'synchronous'],
  // Semantic equivalents — precise synonyms only (overly broad bridges removed)
  ['login', 'signin'],
  ['bug', 'error'],
  ['bug', 'defect'],
  ['crash', 'panic'],
  ['crash', 'segfault'],
  ['slow', 'latency'],
  ['remove', 'delete'],
  ['setup', 'install'],
  ['deploy', 'release'],
  ['deploy', 'publish'],
  ['refactor', 'restructure'],
  ['test', 'spec'],
  ['cache', 'caching'],
  ['cache', 'memoize'],
  ['optimize', 'optimization'],
  ['fix', 'bugfix'],
  ['fix', 'patch'],
  ['debug', 'debugging'],
  ['debug', 'troubleshoot'],
  ['error', 'failure'],
  ['migrate', 'migration'],
  // ─── CJK ↔ EN cross-language synonyms ───
  // Authentication & Authorization
  ['认证', 'auth'], ['认证', 'authentication'], ['登录', 'login'], ['登录', 'auth'],
  ['授权', 'authorization'], ['权限', 'permission'],
  // Deployment & Operations
  ['部署', 'deploy'], ['部署', 'deployment'], ['发布', 'release'], ['发布', 'publish'],
  // Data & Storage
  ['缓存', 'cache'], ['缓存', 'caching'],
  ['数据库', 'database'], ['数据库', 'db'],
  // Testing & Debugging
  ['测试', 'test'], ['测试', 'testing'],
  ['调试', 'debug'], ['调试', 'debugging'],
  ['修复', 'fix'], ['修复', 'bugfix'],
  // Code Quality
  ['重构', 'refactor'], ['重构', 'refactoring'],
  ['配置', 'config'], ['配置', 'configuration'],
  // API & Networking
  ['接口', 'api'], ['接口', 'endpoint'],
  ['路由', 'route'], ['路由', 'routing'],
  ['中间件', 'middleware'],
  // UI & Components
  ['组件', 'component'], ['模板', 'template'],
  // Database Operations
  ['迁移', 'migration'], ['迁移', 'migrate'],
  ['索引', 'index'], ['查询', 'query'], ['查询', 'search'],
  ['搜索', 'search'], ['搜索', 'query'],
  ['排序', 'sort'], ['分页', 'pagination'],
  ['实现', 'implement'], ['实现', 'implementation'],
  ['功能', 'feature'], ['功能', 'function'],
  // Validation & Security
  ['验证', 'validate'], ['验证', 'validation'],
  ['加密', 'encrypt'], ['加密', 'encryption'],
  ['会话', 'session'], ['令牌', 'token'],
  // Patterns & Architecture
  ['钩子', 'hook'], ['回调', 'callback'],
  ['异步', 'async'], ['同步', 'sync'],
  ['并发', 'concurrent'], ['线程', 'thread'],
  // Performance
  ['性能', 'performance'], ['性能', 'perf'],
  ['内存', 'memory'], ['泄漏', 'leak'],
  ['超时', 'timeout'], ['重试', 'retry'],
  // Observability
  ['日志', 'log'], ['日志', 'logging'],
  ['监控', 'monitor'], ['告警', 'alert'],
  // Build & Dependencies
  ['依赖', 'dependency'], ['构建', 'build'], ['构建', 'compile'],
  ['打包', 'bundle'], ['类型', 'type'], ['类型', 'typescript'],
  // Errors
  ['错误', 'error'], ['异常', 'exception'],
  // Infrastructure
  ['容器', 'container'], ['容器', 'docker'],
  ['集群', 'cluster'], ['集群', 'kubernetes'],
  ['网关', 'gateway'], ['负载', 'load balancing'],
  ['队列', 'queue'], ['序列化', 'serialize'],
];
// Build bidirectional lookup (case-insensitive)
for (const [abbr, full] of SYNONYM_PAIRS) {
  const aLow = abbr.toLowerCase();
  const fLow = full.toLowerCase();
  if (!SYNONYM_MAP.has(aLow)) SYNONYM_MAP.set(aLow, new Set());
  SYNONYM_MAP.get(aLow).add(fLow);
  if (!SYNONYM_MAP.has(fLow)) SYNONYM_MAP.set(fLow, new Set());
  SYNONYM_MAP.get(fLow).add(aLow);
}

// ─── CJK Tokenization ───────────────────────────────────────────────────────

// Common CJK compound words (2-4 chars) — dictionary-first tokenization.
// When a compound word is found, it's emitted as a whole token instead of being
// split into overlapping bigrams. This dramatically reduces noise:
// "数据库" → "数据库" (1 token) instead of "数据 据库" (2 noisy tokens)
export const CJK_COMPOUNDS = new Set([
  // tech/programming
  '数据库', '数据', '接口', '函数', '变量', '组件', '模块', '配置', '框架', '部署',
  '测试', '调试', '编译', '打包', '构建', '缓存', '索引', '迁移', '回滚', '权限',
  '认证', '授权', '加密', '解密', '序列', '并发', '异步', '同步', '线程', '进程',
  '容器', '集群', '服务器', '中间件', '网关', '负载', '监控', '日志', '告警',
  '前端', '后端', '全栈', '响应式', '路由', '状态', '渲染', '样式', '布局',
  // actions
  '修复', '重构', '优化', '升级', '安装', '卸载', '导入', '导出', '上传', '下载',
  '提交', '推送', '合并', '发布', '上线', '回退', '审查', '审核', '评审',
  // errors/issues
  '报错', '崩溃', '泄露', '溢出', '死锁', '超时', '中断', '异常', '故障',
  // architecture
  '架构', '设计', '方案', '规划', '文档', '注释', '版本', '分支', '依赖',
  '性能', '安全', '漏洞', '补丁',
]);

// Sort by length descending for greedy matching
const CJK_SORTED = [...CJK_COMPOUNDS].sort((a, b) => b.length - a.length);

/**
 * Generate search tokens from CJK text using dictionary-first tokenization.
 * Compound words are emitted whole; remaining chars use bigram fallback.
 * "修复了数据库崩溃" → "修复 数据库 崩溃" (3 clean tokens)
 * vs old bigram: "修复 复了 了数 数据 据库 库崩 崩溃" (7 noisy tokens)
 * @param {string} text Input text containing CJK characters
 * @returns {string} Space-separated tokens
 */
export function cjkBigrams(text) {
  if (!text) return '';
  const runs = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || [];
  const tokens = [];
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      let matched = false;
      // Greedy dictionary match (longest first)
      for (const word of CJK_SORTED) {
        if (i + word.length <= run.length && run.slice(i, i + word.length) === word) {
          tokens.push(word);
          i += word.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Fallback: bigram for unknown compound
        if (i + 1 < run.length) {
          tokens.push(run[i] + run[i + 1]);
        }
        i++;
      }
    }
  }
  return [...new Set(tokens)].join(' ');
}

// ─── CJK Synonym Extraction ─────────────────────────────────────────────────

// Extract known CJK words (from SYNONYM_MAP) out of unsegmented CJK text.
// Greedy longest-match: "数据库的全文搜索" → ["数据库", "搜索"] (skips particles/unknown).
const _cjkSynonymKeys = [...SYNONYM_MAP.keys()]
  .filter(k => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(k))
  .sort((a, b) => b.length - a.length); // longest first

export function extractCjkSynonymTokens(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const key of _cjkSynonymKeys) {
      if (text.startsWith(key, i)) {
        found.push(key);
        i += key.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return found;
}

// ─── FTS5 Token Formatting ──────────────────────────────────────────────────

// Format a term for FTS5: quote if it contains spaces, hyphens, or special chars
function ftsToken(term) {
  // Bare tokens are safe if purely alphanumeric or CJK characters
  if (/^[a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf]+$/.test(term)) return term;
  return `"${term.replace(/"/g, '""')}"`;
}

export function expandToken(token) {
  const synonyms = SYNONYM_MAP.get(token.toLowerCase());
  if (!synonyms || synonyms.size === 0) return ftsToken(token);
  // FTS5 OR group: (original OR synonym1 OR "multi word synonym")
  const parts = [ftsToken(token)];
  for (const syn of synonyms) {
    parts.push(ftsToken(syn));
  }
  return `(${parts.join(' OR ')})`;
}

// ─── Stop Words ──────────────────────────────────────────────────────────────

export const FTS_STOP_WORDS = new Set([...BASE_STOP_WORDS]);

// ─── FTS5 Query Sanitization ─────────────────────────────────────────────────

/**
 * Sanitize and expand a user query into a valid FTS5 query string.
 * Strips special characters, expands synonyms, and joins with AND/space.
 * @param {string} query Raw user search query
 * @returns {string|null} FTS5-safe query or null if empty
 */
export function sanitizeFtsQuery(query) {
  if (!query) return null;
  const cleaned = query
    .replace(/[{}()[\]^~*:"\\]/g, ' ')
    .replace(/(^|\s)-/g, '$1')
    .trim();
  if (!cleaned) return null;
  let tokens = cleaned.split(/\s+/).filter(t =>
    t && !/^-+$/.test(t) && !FTS5_KEYWORDS.has(t.toUpperCase()) && !/^NEAR\/\d+$/i.test(t)
    // Skip single ASCII-letter tokens — too noisy for FTS5 (CJK single chars handled separately below)
    && !(t.length === 1 && /^[a-zA-Z]$/.test(t))
  );
  // Filter stop words (but keep all if filtering would empty the query)
  const filtered = tokens.filter(t => !FTS_STOP_WORDS.has(t.toLowerCase()));
  if (filtered.length > 0) tokens = filtered;
  // Split unsegmented CJK tokens into known vocabulary words for synonym expansion.
  // e.g. "数据库的全文搜索" → ["数据库", "搜索"] (both have EN synonyms in SYNONYM_MAP)
  const expandedTokens = [];
  let cjkExtracted = false;
  for (const t of tokens) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(t) && t.length > 2) {
      const cjkWords = extractCjkSynonymTokens(t);
      if (cjkWords.length > 0) {
        expandedTokens.push(...cjkWords);
        cjkExtracted = true;
        continue;
      }
    }
    expandedTokens.push(t);
  }
  tokens = expandedTokens;
  if (tokens.length === 0) return null;
  // Replace single CJK character tokens with bigrams for better phrase matching.
  // Individual CJK chars ("系","统") are too noisy; bigrams ("系统") capture compound words.
  // Skip bigrams when CJK synonym extraction already produced meaningful tokens —
  // bigrams joined with AND would make the query too restrictive.
  const bigrams = cjkExtracted ? null : cjkBigrams(cleaned);
  const bigramSet = new Set(bigrams ? bigrams.split(' ').filter(Boolean) : []);
  const hasBigrams = bigramSet.size > 0;
  const finalTokens = [];
  const seen = new Set();
  const rawTokensSeen = new Set(); // track raw tokens to prevent bigram duplicates
  for (const t of tokens) {
    // Skip single CJK characters when we have bigrams — they're subsumed by bigram tokens
    if (hasBigrams && /^[\u4e00-\u9fff\u3400-\u4dbf]$/.test(t)) continue;
    const expanded = expandToken(t);
    if (!seen.has(expanded)) { seen.add(expanded); rawTokensSeen.add(t); finalTokens.push(expanded); }
  }
  for (const bg of bigramSet) {
    if (!seen.has(bg) && !rawTokensSeen.has(bg)) { seen.add(bg); finalTokens.push(bg); }
  }
  if (finalTokens.length === 0) return null;
  // FTS5 requires explicit AND after parenthesized OR groups
  const hasGroup = finalTokens.some(e => e.startsWith('('));
  return finalTokens.join(hasGroup ? ' AND ' : ' ');
}

/**
 * Relax an AND-joined FTS5 query to OR-joined for fallback search.
 * Only useful when the original query has multiple tokens (single-token queries
 * are already as relaxed as possible).
 * @param {string} ftsQuery Original AND-joined FTS5 query from sanitizeFtsQuery
 * @returns {string|null} OR-joined query, or null if relaxation wouldn't help
 */
export function relaxFtsQueryToOr(ftsQuery) {
  if (!ftsQuery) return null;
  // Replace AND joins with OR — handles both explicit " AND " and implicit space joins
  const orQuery = ftsQuery.replace(/ AND /g, ' OR ');
  // If no AND was present, tokens are space-joined (implicit AND); convert to OR
  if (orQuery === ftsQuery && !ftsQuery.includes(' OR ')) {
    const parts = ftsQuery.split(/\s+/);
    if (parts.length < 2) return null; // single token — OR won't help
    return parts.join(' OR ');
  }
  return orQuery !== ftsQuery ? orQuery : null;
}
