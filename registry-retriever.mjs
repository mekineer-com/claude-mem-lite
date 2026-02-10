// claude-mem-lite: Resource retriever — FTS5 search + composite scoring
// Tier 2 of the 3-tier dispatch intelligence architecture

import { debugCatch } from './utils.mjs';

// ─── Domain Synonyms ─────────────────────────────────────────────────────────

const DISPATCH_SYNONYMS = {
  // English intent synonyms
  'clean':    ['refactor', 'lint', 'format', 'organize', 'tidy', 'simplify'],
  'test':     ['testing', 'unittest', 'e2e', 'coverage', 'tdd', 'qa', 'spec'],
  'fix':      ['debug', 'bugfix', 'troubleshoot', 'diagnose', 'repair', 'error'],
  'fast':     ['performance', 'optimize', 'profile', 'benchmark', 'speed'],
  'deploy':   ['release', 'publish', 'ci', 'cd', 'build', 'ship'],
  'commit':   ['git', 'push', 'merge', 'pr', 'branch', 'version'],
  'secure':   ['security', 'vulnerability', 'audit', 'secrets', 'auth'],
  'review':   ['code-review', 'pr-review', 'quality', 'inspect', 'check'],
  'doc':      ['documentation', 'readme', 'docs', 'comment', 'jsdoc'],
  'design':   ['ui', 'ux', 'frontend', 'layout', 'css', 'component'],
  'infra':    ['infrastructure', 'devops', 'docker', 'kubernetes', 'terraform'],
  'db':       ['database', 'sql', 'postgres', 'mysql', 'mongodb', 'schema'],
  'api':      ['endpoint', 'rest', 'graphql', 'route', 'backend'],
  'plan':     ['planning', 'architecture', 'design', 'spec', 'blueprint'],
  'build':    ['compile', 'bundle', 'webpack', 'vite', 'typescript', 'tsc'],
  // Chinese intent mappings
  '清理':     ['refactor', 'clean', 'lint', 'format', 'simplify'],
  '测试':     ['test', 'testing', 'tdd', 'qa', 'spec'],
  '提交':     ['commit', 'git', 'push', 'pr'],
  '部署':     ['deploy', 'release', 'ci', 'ship'],
  '优化':     ['optimize', 'performance', 'fast', 'speed'],
  '安全':     ['security', 'audit', 'vulnerability'],
  '审查':     ['review', 'code-review', 'pr-review', 'quality'],
  '修复':     ['fix', 'debug', 'bugfix', 'repair', 'error'],
  '文档':     ['documentation', 'readme', 'docs'],
  '设计':     ['design', 'ui', 'ux', 'frontend'],
  '构建':     ['build', 'compile', 'bundle'],
  '重构':     ['refactor', 'restructure', 'simplify', 'clean'],
};

// ─── Query Building ──────────────────────────────────────────────────────────

/**
 * Expand a single token with synonyms for FTS5.
 * @param {string} token Input token
 * @returns {string} FTS5 OR group or bare token
 */
function expandToken(token) {
  const lower = token.toLowerCase();
  const synonyms = DISPATCH_SYNONYMS[lower];
  if (!synonyms || synonyms.length === 0) {
    return /^[a-zA-Z0-9]+$/.test(token) ? token : `"${token.replace(/"/g, '""')}"`;
  }
  const parts = [token, ...synonyms].map(t =>
    /^[a-zA-Z0-9]+$/.test(t) ? t : `"${t.replace(/"/g, '""')}"`
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
  const tokens = new Set();

  if (signals.intent) {
    for (const t of signals.intent.split(/[\s,]+/).filter(Boolean)) {
      tokens.add(t.toLowerCase());
    }
  }
  if (signals.techStack) {
    for (const t of signals.techStack.split(/[\s,]+/).filter(Boolean)) {
      tokens.add(t.toLowerCase());
    }
  }
  if (signals.action) {
    for (const t of signals.action.split(/[\s,]+/).filter(Boolean)) {
      tokens.add(t.toLowerCase());
    }
  }
  if (signals.errorDomain) {
    for (const t of signals.errorDomain.split(/[\s,]+/).filter(Boolean)) {
      tokens.add(t.toLowerCase());
    }
  }

  if (tokens.size === 0) return null;

  const expanded = [...tokens].map(t => expandToken(t));
  return expanded.join(' OR ');
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
  const tokens = cleaned.split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t.toLowerCase()) && !/^\d+$/.test(t))
    .slice(0, 8); // Limit to 8 most relevant tokens

  if (tokens.length === 0) return null;

  const expanded = tokens.map(t => expandToken(t));
  return expanded.join(' OR ');
}

// ─── FTS5 Retrieval ──────────────────────────────────────────────────────────

// BM25 weights: trigger_patterns(5), capability_summary(3), intent_tags(2), domain_tags(1), name(1)
const SEARCH_SQL = `
  SELECT r.*,
    bm25(resources_fts, 5.0, 3.0, 2.0, 1.0, 1.0) AS relevance
  FROM resources_fts
  JOIN resources r ON r.id = resources_fts.rowid
  WHERE resources_fts MATCH ?
    AND r.status = 'active'
  ORDER BY (
    bm25(resources_fts, 5.0, 3.0, 2.0, 1.0, 1.0) * -0.4
    + COALESCE(CAST(r.repo_stars AS REAL) / NULLIF((SELECT MAX(repo_stars) FROM resources WHERE repo_stars > 0), 0), 0) * 0.15
    + CASE WHEN r.recommend_count > 0
        THEN CAST(r.success_count AS REAL) / r.recommend_count * 0.15
        ELSE 0.05 END
    + CASE WHEN r.recommend_count > 0
        THEN CAST(r.adopt_count AS REAL) / r.recommend_count * 0.10
        ELSE 0.05 END
  ) ASC
  LIMIT ?
`;

const SEARCH_BY_TYPE_SQL = `
  SELECT r.*,
    bm25(resources_fts, 5.0, 3.0, 2.0, 1.0, 1.0) AS relevance
  FROM resources_fts
  JOIN resources r ON r.id = resources_fts.rowid
  WHERE resources_fts MATCH ?
    AND r.status = 'active'
    AND r.type = ?
  ORDER BY (
    bm25(resources_fts, 5.0, 3.0, 2.0, 1.0, 1.0) * -0.4
    + COALESCE(CAST(r.repo_stars AS REAL) / NULLIF((SELECT MAX(repo_stars) FROM resources WHERE repo_stars > 0), 0), 0) * 0.15
    + CASE WHEN r.recommend_count > 0
        THEN CAST(r.success_count AS REAL) / r.recommend_count * 0.15
        ELSE 0.05 END
    + CASE WHEN r.recommend_count > 0
        THEN CAST(r.adopt_count AS REAL) / r.recommend_count * 0.10
        ELSE 0.05 END
  ) ASC
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
