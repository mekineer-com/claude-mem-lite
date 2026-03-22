// synonyms.mjs -- Unified synonym data for FTS5 search and dispatch.
// Consolidates SYNONYM_PAIRS/SYNONYM_MAP (from nlp.mjs) and DISPATCH_SYNONYMS (from registry-retriever.mjs).

// ─── Synonym Pairs (Bidirectional FTS5 expansion) ─────────────────────────────

export const SYNONYM_PAIRS = [
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
  ['报错', 'error'], ['崩溃', 'crash'],
  // Infrastructure
  ['容器', 'container'], ['容器', 'docker'],
  ['集群', 'cluster'], ['集群', 'kubernetes'],
  ['网关', 'gateway'], ['负载', 'load balancing'],
  ['队列', 'queue'], ['序列化', 'serialize'],
  // Code structure (missing from earlier CJK pairs)
  ['函数', 'function'], ['变量', 'variable'],
  ['模块', 'module'], ['框架', 'framework'],
  ['编译', 'compile'], ['服务器', 'server'],
  ['前端', 'frontend'], ['后端', 'backend'],
  ['优化', 'optimize'], ['优化', 'optimization'],
  ['架构', 'architecture'], ['设计', 'design'],
  ['文档', 'documentation'], ['文档', 'docs'],
  ['版本', 'version'], ['分支', 'branch'],
  ['提交', 'commit'], ['推送', 'push'],
  ['合并', 'merge'], ['升级', 'upgrade'],
  ['安装', 'install'], ['导入', 'import'],
  ['导出', 'export'], ['状态', 'state'],
  ['系统', 'system'], ['算法', 'algorithm'],
];

// ─── Bidirectional SYNONYM_MAP (case-insensitive) ──────────────────────────────

export const SYNONYM_MAP = new Map();
// Build bidirectional lookup (case-insensitive)
for (const [abbr, full] of SYNONYM_PAIRS) {
  const aLow = abbr.toLowerCase();
  const fLow = full.toLowerCase();
  if (!SYNONYM_MAP.has(aLow)) SYNONYM_MAP.set(aLow, new Set());
  SYNONYM_MAP.get(aLow).add(fLow);
  if (!SYNONYM_MAP.has(fLow)) SYNONYM_MAP.set(fLow, new Set());
  SYNONYM_MAP.get(fLow).add(aLow);
}

// ─── CJK Compound Words ────────────────────────────────────────────────────────

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
  '性能', '安全', '漏洞', '补丁', '系统', '算法',
]);

// ─── Dispatch Synonyms (unidirectional, broader groupings) ──────────────────

export const DISPATCH_SYNONYMS = {
  // English intent synonyms
  'clean':    ['refactor', 'lint', 'format', 'organize', 'tidy', 'simplify', 'restructure', 'rewrite', 'smell', 'debt'],
  'test':     ['testing', 'unittest', 'e2e', 'coverage', 'tdd', 'qa', 'spec', 'jest', 'vitest', 'pytest', 'mocha', 'cypress', 'playwright'],
  'fix':      ['debug', 'bugfix', 'troubleshoot', 'diagnose', 'repair', 'error', 'crash', 'broken', 'issue', 'problem'],
  'debug':    ['debugging', 'fix', 'bugfix', 'troubleshoot', 'diagnose', 'error', 'crash', 'bug', 'breakpoint'],
  'debugging':['debug', 'fix', 'bugfix', 'troubleshoot', 'diagnose', 'error', 'crash', 'bug', 'systematic'],
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
  'search':   ['lookup', 'latest', 'best-practices', 'perplexity'],
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
  '搜索':     ['search', 'lookup', 'latest', 'perplexity'],
};
