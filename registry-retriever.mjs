// claude-mem-lite: Resource retriever — FTS5 search + composite scoring
// Tier 2 of the 3-tier dispatch intelligence architecture

import { debugCatch } from './utils.mjs';

// ─── Domain Synonyms ─────────────────────────────────────────────────────────

const DISPATCH_SYNONYMS = {
  // English intent synonyms
  'clean':    ['refactor', 'lint', 'format', 'organize', 'tidy', 'simplify', 'restructure', 'rewrite', 'smell', 'debt'],
  'test':     ['testing', 'unittest', 'e2e', 'coverage', 'tdd', 'qa', 'spec', 'jest', 'vitest', 'pytest', 'mocha', 'cypress', 'playwright'],
  'fix':      ['debug', 'bugfix', 'troubleshoot', 'diagnose', 'repair', 'error', 'crash', 'broken', 'issue', 'problem'],
  'fast':     ['performance', 'optimize', 'profile', 'benchmark', 'speed', 'latency', 'bottleneck', 'slow', 'cache'],
  'deploy':   ['release', 'publish', 'ci', 'cd', 'ship', 'rollout', 'staging', 'production'],
  'commit':   ['git', 'push', 'merge', 'pr', 'branch', 'version', 'rebase', 'stash', 'tag'],
  'secure':   ['security', 'vulnerability', 'audit', 'secrets', 'auth', 'xss', 'csrf', 'injection', 'encrypt', 'ssl', 'tls', 'cors', 'oauth', 'jwt', 'cve'],
  'review':   ['code-review', 'pr-review', 'quality', 'inspect', 'check', 'audit'],
  'doc':      ['documentation', 'readme', 'docs', 'comment', 'jsdoc', 'typedoc', 'changelog', 'wiki', 'guide'],
  'design':   ['ui', 'ux', 'frontend', 'layout', 'css', 'component', 'tailwind', 'responsive', 'theme'],
  'infra':    ['infrastructure', 'devops', 'docker', 'kubernetes', 'terraform', 'ansible', 'helm', 'aws', 'gcp', 'azure', 'nginx', 'pipeline', 'cloud'],
  'db':       ['database', 'sql', 'postgres', 'mysql', 'mongodb', 'schema', 'migration', 'orm', 'prisma', 'redis', 'sqlite', 'drizzle', 'sequelize'],
  'api':      ['endpoint', 'rest', 'graphql', 'route', 'backend', 'grpc', 'websocket', 'middleware', 'swagger', 'openapi'],
  'plan':     ['planning', 'architecture', 'spec', 'blueprint', 'rfc', 'proposal', 'roadmap'],
  'build':    ['compile', 'bundle', 'webpack', 'vite', 'typescript', 'tsc', 'esbuild', 'rollup', 'parcel', 'babel', 'swc', 'transpile'],
  'lint':     ['eslint', 'prettier', 'biome', 'stylelint', 'format', 'style'],
  // Chinese intent mappings
  '清理':     ['refactor', 'clean', 'lint', 'format', 'simplify'],
  '测试':     ['test', 'testing', 'tdd', 'qa', 'spec', 'jest', 'vitest', 'pytest'],
  '提交':     ['commit', 'git', 'push', 'pr'],
  '部署':     ['deploy', 'release', 'ci', 'ship'],
  '优化':     ['optimize', 'performance', 'fast', 'speed', 'cache'],
  '安全':     ['security', 'audit', 'vulnerability', 'auth', 'xss', 'csrf'],
  '审查':     ['review', 'code-review', 'pr-review', 'quality'],
  '修复':     ['fix', 'debug', 'bugfix', 'repair', 'error', 'crash'],
  '文档':     ['documentation', 'readme', 'docs'],
  '设计':     ['design', 'ui', 'ux', 'frontend', 'layout', 'component'],
  '构建':     ['build', 'compile', 'bundle', 'webpack', 'vite'],
  '重构':     ['refactor', 'restructure', 'simplify', 'clean'],
  '数据库':   ['database', 'sql', 'schema', 'migration', 'orm'],
  '接口':     ['api', 'endpoint', 'rest', 'route', 'backend'],
  '规划':     ['planning', 'architecture', 'spec', 'blueprint'],
  '格式化':   ['lint', 'format', 'eslint', 'prettier', 'style'],
  '编译':     ['compile', 'build', 'bundle', 'transpile'],
  '打包':     ['bundle', 'build', 'webpack', 'vite'],
  '容器':     ['docker', 'container', 'kubernetes', 'infrastructure'],
  '运维':     ['devops', 'infrastructure', 'deploy', 'docker'],
};

// ─── CJK Tokenization ───────────────────────────────────────────────────────
// Chinese text has no word boundaries (no spaces between words).
// Two-layer extraction:
//   1. DISPATCH_SYNONYMS CJK keys → synonym-expanded via expandToken()
//   2. CJK_INTENT_MAP → inject English equivalents for FTS5 matching

const CJK_INTENT_MAP = {
  // test
  '测试': 'test', '写测试': 'test', '单测': 'test', '单元测试': 'test',
  '用例': 'test', '覆盖率': 'coverage',
  // fix/debug — synced with extractIntent CJK patterns
  '修复': 'fix', '调试': 'debug', '排错': 'debug', '报错': 'error',
  '出错': 'error', '修bug': 'fix', '改bug': 'fix', '找bug': 'debug',
  '有bug': 'fix', '有问题': 'fix', '不工作': 'fix', '跑不起来': 'fix',
  '不能用': 'fix', '挂了': 'crash', '崩溃': 'crash',
  // commit
  '提交': 'commit', '推送': 'push', '上传': 'push',
  // deploy
  '部署': 'deploy', '上线': 'deploy', '发布': 'release', '回滚': 'rollback',
  // review
  '审查': 'review', '审核': 'review', '评审': 'review', '代码审查': 'review',
  '代码审核': 'review', '看看代码': 'review',
  // clean
  '重构': 'refactor', '清理': 'clean', '整理': 'clean', '简化': 'simplify',
  '太烂': 'refactor', '乱七八糟': 'refactor', '看不懂': 'refactor',
  // performance
  '优化': 'optimize', '性能': 'performance', '卡顿': 'performance', '太慢': 'performance',
  '耗时': 'performance', '慢死了': 'performance', '好慢': 'performance', '缓存': 'cache',
  // security
  '安全': 'security', '漏洞': 'vulnerability', '鉴权': 'auth', '认证': 'auth',
  '授权': 'auth', '权限': 'auth', '泄露': 'security', '暴露': 'security',
  '不安全': 'vulnerability',
  // lint
  '格式化': 'format', '代码风格': 'lint', '代码规范': 'lint', '类型检查': 'typecheck',
  // design
  '设计': 'design', '界面': 'ui', '前端': 'frontend', '样式': 'css',
  '页面': 'frontend', '组件': 'component', '布局': 'layout',
  // build
  '构建': 'build', '编译': 'compile', '打包': 'bundle', '依赖': 'dependency',
  // doc
  '文档': 'documentation', '写文档': 'documentation', '文档化': 'documentation',
  '注释': 'comment',
  // infra
  '容器': 'docker', '服务器': 'server', '运维': 'devops', '集群': 'cluster',
  '监控': 'monitoring', '配置': 'config', '日志': 'logging',
  // db
  '数据库': 'database', '建表': 'database', '索引': 'database', '迁移': 'migration',
  '查询慢': 'performance',
  // api
  '接口': 'api', '路由': 'route',
  // plan
  '规划': 'planning', '架构': 'architecture', '方案': 'plan', '设计方案': 'architecture',
};

// Merge all CJK keys from both maps, longest-first to avoid partial matches
const ALL_CJK_KEYS = [...new Set([
  ...Object.keys(DISPATCH_SYNONYMS).filter(k => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(k)),
  ...Object.keys(CJK_INTENT_MAP),
])].sort((a, b) => b.length - a.length);

function extractCJKTokens(text) {
  const found = [];
  const seen = new Set();
  for (const key of ALL_CJK_KEYS) {
    if (text.includes(key)) {
      if (!seen.has(key)) { seen.add(key); found.push(key); }
      // Also inject English equivalent for direct FTS5 matching
      const en = CJK_INTENT_MAP[key];
      if (en && !seen.has(en)) { seen.add(en); found.push(en); }
    }
  }
  return found;
}

// ─── Query Building ──────────────────────────────────────────────────────────

/**
 * Expand a single token with synonyms for FTS5.
 * @param {string} token Input token
 * @returns {string} FTS5 OR group or bare token
 */
const MAX_SYNONYM_EXPANSION = 8;

function expandToken(token) {
  const lower = token.toLowerCase();
  const synonyms = DISPATCH_SYNONYMS[lower];
  // CJK characters: pass through unquoted — FTS5 unicode61 tokenizer handles them natively.
  // Quoting CJK tokens can interfere with tokenization.
  const isSafe = t => /^[a-zA-Z0-9]+$/.test(t) || /[\u4e00-\u9fff\u3400-\u4dbf]/.test(t);
  if (!synonyms || synonyms.length === 0) {
    return isSafe(token) ? token : `"${token.replace(/"/g, '""')}"`;
  }
  // Cap synonym expansion to prevent BM25 precision dilution from overly broad OR groups
  const capped = synonyms.slice(0, MAX_SYNONYM_EXPANSION);
  const parts = [token, ...capped].map(t =>
    isSafe(t) ? t : `"${t.replace(/"/g, '""')}"`
  );
  return `(${parts.join(' OR ')})`;
}

/**
 * Build enhanced FTS5 query from context signals.
 * Expands synonyms and joins with OR for broad matching.
 * @param {object} signals Context signals from Tier 1
 * @returns {string|null} FTS5 query string or null
 */
export function buildEnhancedQuery(signals) {
  const parts = [];

  // Column-targeted: route primary intent to intent_tags column (highest signal)
  if (signals.primaryIntent) {
    const expanded = expandToken(signals.primaryIntent.toLowerCase());
    parts.push(`intent_tags:${expanded}`);
  }

  // Secondary intents → also column-targeted to intent_tags (not general query).
  // Previously these were general tokens that matched trigger_patterns (BM25 weight 5.0),
  // causing secondary domain words (e.g. "api" in "Write documentation for the API module")
  // to overpower the primary intent. Column-targeting keeps intent signal in the right lane.
  //
  // Note: signals.action (tool type: edit/bash/write) is NOT included — it's metadata
  // about the tool being used, not what the user needs help with.
  const generalTokens = new Set();
  if (signals.intent) {
    const intents = signals.intent.split(/[\s,]+/).filter(Boolean);
    // Secondary intents: column-targeted but WITHOUT synonym expansion.
    // This gives primary intent (expanded) higher BM25 weight than secondary intents (single token).
    for (const t of intents.slice(signals.primaryIntent ? 1 : 0)) {
      parts.push(`intent_tags:${t.toLowerCase()}`);
    }
  }
  if (signals.errorDomain) {
    for (const t of signals.errorDomain.split(/[\s,]+/).filter(Boolean)) {
      generalTokens.add(t.toLowerCase());
    }
  }

  // Column-targeted: route tech stack to domain_tags column
  if (signals.techStack) {
    for (const t of signals.techStack.split(/[\s,]+/).filter(Boolean)) {
      parts.push(`domain_tags:${expandToken(t.toLowerCase())}`);
    }
  }

  // Add general tokens (expanded with synonyms)
  for (const t of generalTokens) {
    parts.push(expandToken(t));
  }

  if (parts.length === 0) return null;
  return parts.join(' OR ');
}

/**
 * Build FTS5 query from raw text (user prompt, tool description).
 * Tokenizes, filters stop words, expands synonyms.
 * @param {string} text Raw text input
 * @returns {string|null} FTS5 query string or null
 */
export function buildQueryFromText(text) {
  if (!text || typeof text !== 'string') return null;

  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
    'after', 'before', 'above', 'below', 'and', 'or', 'but', 'not', 'no',
    'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'his',
    'her', 'our', 'their', 'me', 'him', 'us', 'them', 'i', 'you', 'he',
    'she', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'how',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
    'such', 'than', 'too', 'very', 'just', 'also', 'then', 'so', 'if',
    '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都',
    '一', '一个', '上', '也', '这', '那', '你', '他', '她', '它', '们',
    '把', '让', '给', '用', '来', '去', '做', '说', '要', '会', '能',
    '帮', '帮我', '请', '下', '吧',
  ]);

  const cleaned = text.replace(/[{}()[\]^~*:@#$%&]/g, ' ').trim();

  // Extract CJK compound words before whitespace split (Chinese has no spaces)
  const cjkTokens = extractCJKTokens(cleaned);

  const wsTokens = cleaned.split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t.toLowerCase()) && !/^\d+$/.test(t));

  // Merge: CJK tokens first (high signal), then whitespace tokens, deduplicated
  const seen = new Set();
  const tokens = [];
  for (const t of [...cjkTokens, ...wsTokens]) {
    if (!seen.has(t)) { seen.add(t); tokens.push(t); }
  }
  tokens.splice(8); // Limit to 8 most relevant tokens

  if (tokens.length === 0) return null;

  const expanded = tokens.map(t => expandToken(t));
  return expanded.join(' OR ');
}

// ─── FTS5 Retrieval ──────────────────────────────────────────────────────────

// BM25 weights (8 columns, positional — must match FTS5 column order in registry.mjs):
//   trigger_patterns(5), keywords(3), capability_summary(3),
//   intent_tags(2), use_cases(2), domain_tags(1), tech_stack(1), name(1)
//
// Composite ranking formula:
//   40% BM25 text relevance
//   15% Star popularity (saturation normalization — diminishing returns after ~500 stars)
//   15% Success rate (Laplace smoothing — Beta prior α=1, β=1 for small-sample robustness)
//   10% Adoption rate (Laplace smoothing)
//   10% Cold start exploration bonus (UCB1-inspired — decays as recommend_count grows)
//   -10% Negative feedback penalty (zombie recommendations: high recommend, near-zero adopt)

// Time-windowed behavioral signals: blend all-time rates (stability) with recent 30-day rates (freshness).
// recent_* subqueries return NULL when no recent invocations:
//   COUNT(*)=0 → SUM(...)=NULL → (NULL+1.0)/(0+2.0) = NULL → COALESCE falls back to all-time only.
//
// Sign convention: bm25() returns NEGATIVE (more negative = more relevant).
// We keep the negative direction and SUBTRACT positive behavioral signals to make
// better resources more negative. ORDER BY ... ASC puts most negative (best) first.
const COMPOSITE_ORDER = `
  ORDER BY (
    bm25(resources_fts, 5.0, 3.0, 3.0, 2.0, 2.0, 1.0, 1.0, 1.0) * 0.4
    - COALESCE(r.repo_stars * 1.0 / (r.repo_stars + 100.0), 0) * 0.15
    - (
        (r.success_count + 1.0) / (r.recommend_count + 2.0) * 0.5
        + COALESCE(
            (SELECT (SUM(CASE WHEN i.outcome='success' THEN 1 ELSE 0 END) + 1.0)
                  / (COUNT(*) + 2.0)
             FROM invocations i WHERE i.resource_id = r.id
               AND i.created_at > datetime('now', '-30 days')),
            (r.success_count + 1.0) / (r.recommend_count + 2.0)
          ) * 0.5
      ) * 0.15
    - (
        (r.adopt_count + 1.0) / (r.recommend_count + 2.0) * 0.5
        + COALESCE(
            (SELECT (SUM(CASE WHEN i.adopted=1 THEN 1 ELSE 0 END) + 1.0)
                  / (COUNT(*) + 2.0)
             FROM invocations i WHERE i.resource_id = r.id
               AND i.created_at > datetime('now', '-30 days')),
            (r.adopt_count + 1.0) / (r.recommend_count + 2.0)
          ) * 0.5
      ) * 0.10
    - CASE WHEN r.recommend_count < 10
        THEN 0.10 * (1.0 - r.recommend_count * 1.0 / 10.0)
        ELSE 0 END
    + CASE WHEN r.recommend_count > 15
           AND (r.adopt_count + 1.0) / (r.recommend_count + 2.0) < 0.1
        THEN 0.10
        ELSE 0 END
  ) ASC
`;

const SEARCH_SQL = `
  SELECT r.*,
    bm25(resources_fts, 5.0, 3.0, 3.0, 2.0, 2.0, 1.0, 1.0, 1.0) AS relevance
  FROM resources_fts
  JOIN resources r ON r.id = resources_fts.rowid
  WHERE resources_fts MATCH ?
    AND r.status = 'active'
  ${COMPOSITE_ORDER}
  LIMIT ?
`;

const SEARCH_BY_TYPE_SQL = `
  SELECT r.*,
    bm25(resources_fts, 5.0, 3.0, 3.0, 2.0, 2.0, 1.0, 1.0, 1.0) AS relevance
  FROM resources_fts
  JOIN resources r ON r.id = resources_fts.rowid
  WHERE resources_fts MATCH ?
    AND r.status = 'active'
    AND r.type = ?
  ${COMPOSITE_ORDER}
  LIMIT ?
`;

/**
 * Search for resources using FTS5 with composite scoring.
 * @param {Database} db Registry database
 * @param {string} query FTS5 query string (already expanded)
 * @param {object} [opts] Options
 * @param {'skill'|'agent'} [opts.type] Filter by type
 * @param {number} [opts.limit=3] Max results
 * @returns {object[]} Array of matching resources with relevance scores
 */
export function retrieveResources(db, query, { type, limit = 3 } = {}) {
  if (!query) return [];

  try {
    if (type) {
      return db.prepare(SEARCH_BY_TYPE_SQL).all(query, type, limit);
    }
    return db.prepare(SEARCH_SQL).all(query, limit);
  } catch (e) {
    // FTS5 query syntax error — try simpler query
    debugCatch(e, 'retrieveResources');
    try {
      const simpleQuery = query.replace(/[()]/g, '').split(/\s+OR\s+/).slice(0, 3).join(' OR ');
      if (type) {
        return db.prepare(SEARCH_BY_TYPE_SQL).all(simpleQuery, type, limit);
      }
      return db.prepare(SEARCH_SQL).all(simpleQuery, limit);
    } catch {
      return [];
    }
  }
}

/**
 * Search for resources using raw text (builds query automatically).
 * Convenience wrapper combining buildQueryFromText + retrieveResources.
 * @param {Database} db Registry database
 * @param {string} text Raw search text
 * @param {object} [opts] Options passed to retrieveResources
 * @returns {object[]} Matching resources
 */
export function searchResources(db, text, opts) {
  const query = buildQueryFromText(text);
  if (!query) return [];
  return retrieveResources(db, query, opts);
}
