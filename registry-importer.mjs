// claude-mem-lite: Registry importer — tree discovery, frontmatter parsing, keyword extraction
// Used by importFromGitHub() (Task 5) to process GitHub repos into registry entries
// GitHub API helpers (parseGitHubUrl, buildTreeUrl, buildContentUrl, buildHeaders)
// are in registry-github.mjs — imported by importFromGitHub when added.

// ─── Tree Discovery ─────────────────────────────────────────────────────────

// Patterns: flat (skills/name/SKILL.md), plugin (plugins/x/skills/y/SKILL.md),
// agent (agents/name/AGENT.md), root (./SKILL.md)
const SKILL_RE = /(?:^|\/)(skills\/([^/]+)\/SKILL\.md)$/;
const AGENT_RE = /(?:^|\/)(agents\/([^/]+)\/AGENT\.md)$/;
const PLUGIN_SKILL_RE = /^plugins\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/;
const ROOT_SKILL_RE = /^SKILL\.md$/;

/**
 * Discover skills/agents from a GitHub tree API response.
 * Supports flat (skills/name/SKILL.md), plugin (plugins/x/skills/y/SKILL.md),
 * and root (./SKILL.md) layouts.
 * @param {object} treeData GitHub API tree response { tree: [{ path, type }] }
 * @param {string} pathFilter Only include paths under this prefix (empty = all)
 * @returns {Array<{ name: string, type: 'skill'|'agent', filePath: string }>}
 */
export function discoverFromTree(treeData, pathFilter) {
  const results = [];
  if (!treeData?.tree) return results;

  for (const item of treeData.tree) {
    if (item.type !== 'blob') continue;
    const p = item.path;

    // Apply path filter
    if (pathFilter && !p.startsWith(pathFilter)) continue;

    // Plugin-nested skill: plugins/x/skills/y/SKILL.md → name = "x/y"
    const pluginMatch = p.match(PLUGIN_SKILL_RE);
    if (pluginMatch) {
      results.push({ name: `${pluginMatch[1]}/${pluginMatch[2]}`, type: 'skill', filePath: p });
      continue;
    }

    // Flat skill: skills/name/SKILL.md → name = "name"
    const skillMatch = p.match(SKILL_RE);
    if (skillMatch) {
      results.push({ name: skillMatch[2], type: 'skill', filePath: p });
      continue;
    }

    // Agent: agents/name/AGENT.md → name = "name"
    const agentMatch = p.match(AGENT_RE);
    if (agentMatch) {
      results.push({ name: agentMatch[2], type: 'agent', filePath: p });
      continue;
    }

    // Root-level SKILL.md
    if (ROOT_SKILL_RE.test(p)) {
      results.push({ name: 'root', type: 'skill', filePath: p });
      continue;
    }
  }

  return results;
}

// ─── YAML Frontmatter Parser ────────────────────────────────────────────────
// Lightweight YAML subset parser for skill/agent frontmatter.
// Known limitations: does not handle YAML arrays (- item), nested objects,
// or unquoted values containing colons (e.g. bare URLs). For such fields,
// wrap the value in quotes in the frontmatter: url: "https://..."

/**
 * Parse YAML frontmatter from SKILL.md / AGENT.md content.
 * Handles basic key: value, multiline (|, >), JSON arrays ([...]), quoted strings.
 * @param {string} content Full file content
 * @returns {{ frontmatter: Record<string, any>, body: string }}
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = content.slice(match[0].length).trim();
  const fm = {};
  let currentKey = null, currentValue = '', inMultiline = false;

  for (const line of raw.split('\n')) {
    if (inMultiline && (line.startsWith('  ') || line.startsWith('\t') || line.trim() === '')) {
      currentValue += ' ' + line.trim();
      continue;
    }
    if (inMultiline && currentKey) { fm[currentKey] = currentValue.trim(); inMultiline = false; }

    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (kv) {
      currentKey = kv[1];
      let val = kv[2].trim();
      if (val === '|' || val === '>') { inMultiline = true; currentValue = ''; continue; }
      if (val.startsWith('[') && val.endsWith(']')) {
        try { fm[currentKey] = JSON.parse(val); } catch { fm[currentKey] = val; }
        continue;
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (currentKey === 'description' && val) { inMultiline = true; currentValue = val; continue; }
      fm[currentKey] = val;
    }
  }
  if (inMultiline && currentKey) fm[currentKey] = currentValue.trim();
  return { frontmatter: fm, body };
}

// ─── Keyword Extraction ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'up', 'about', 'into', 'through', 'during', 'before', 'after',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'it', 'its', 'as', 'such', 'which', 'who', 'whom', 'what', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'any',
  'can', 'use', 'using', 'used', 'also', 'just', 'very', 'only', 'own', 'same',
  'make', 'like', 'get', 'set', 'new', 'one', 'two', 'see', 'way', 'well',
]);

const INTENT_MAP = {
  test:       [/\btest\b/i, /\btdd\b/i, /\bunit\s*test/i, /\be2e\b/i, /\bspec\b/i, /\bcoverage\b/i],
  debug:      [/\bdebug\b/i, /\btroubleshoot\b/i, /\bdiagnose\b/i, /\berror\b/i, /\bbug\b/i],
  deploy:     [/\bdeploy\b/i, /\bci[\s/]*cd\b/i, /\bpipeline\b/i, /\brelease\b/i, /\bship\b/i, /\bpublish\b/i],
  review:     [/\breview\b/i, /\baudit\b/i, /\blint\b/i, /\binspect\b/i, /code\s*quality/i],
  generate:   [/\bcreate\b/i, /\bscaffold\b/i, /\bgenerate\b/i, /\bboilerplate\b/i],
  refactor:   [/\brefactor\b/i, /\boptimize\b/i, /\bclean\s*up\b/i, /\bsimplify\b/i],
  document:   [/\bdocument\b/i, /\bdocs?\b/i, /\breadme\b/i, /\bjsdoc\b/i],
  plan:       [/\bplan\b/i, /\bdesign\b/i, /\barchitect\b/i, /\bblueprint\b/i],
  security:   [/\bsecurity\b/i, /\bvulnerab/i, /\bauthenticat/i, /\bencrypt/i],
  performance:[/\bperformance\b/i, /\bprofil/i, /\bbenchmark\b/i, /\blatency\b/i],
  migrate:    [/\bmigrat/i, /\bupgrad/i, /\blegacy\b/i],
};

const DOMAIN_PATTERNS = {
  frontend:       [/\breact\b/i, /\bvue\b/i, /\bangular\b/i, /\bsvelte\b/i, /\bnext\.?js\b/i, /\bcss\b/i, /\btailwind\b/i, /\bhtml\b/i],
  backend:        [/\bexpress\b/i, /\bfastapi\b/i, /\bdjango\b/i, /\bflask\b/i, /\brails\b/i, /\bspring\b/i],
  database:       [/\bpostgres/i, /\bmysql\b/i, /\bmongodb\b/i, /\bredis\b/i, /\bsqlite\b/i, /\bsql\b/i],
  infrastructure: [/\bdocker\b/i, /\bkubernetes\b/i, /\bterraform\b/i, /\bansible\b/i, /\bcloud\b/i, /\baws\b/i, /\bgcp\b/i, /\bazure\b/i],
  javascript:     [/\bjavascript\b/i, /\btypescript\b/i, /\bnode\b/i, /\bnpm\b/i, /\besm\b/i],
  python:         [/\bpython\b/i, /\bpip\b/i, /\bpydantic\b/i, /\bpoetry\b/i],
  testing:        [/\bjest\b/i, /\bvitest\b/i, /\bpytest\b/i, /\bcypress\b/i, /\bplaywright\b/i],
  security:       [/\boauth\b/i, /\bjwt\b/i, /\bssl\b/i, /\btls\b/i, /\brbac\b/i],
  ml:             [/\bmachine\s*learning\b/i, /\bneural\b/i, /\btensor/i, /\bpytorch\b/i, /\bllm\b/i],
  mobile:         [/\bios\b/i, /\bandroid\b/i, /react.native/i, /\bflutter\b/i, /\bswift\b/i],
};

/**
 * Extract keywords, intent tags, and domain tags from content.
 * @param {string} content Full text
 * @returns {{ keywords: string, intentTags: string, domainTags: string }}
 */
export function extractKeywords(content) {
  if (!content) return { keywords: '', intentTags: '', domainTags: '' };

  const text = content.toLowerCase();

  // ── Keywords: stop-word filtered frequency counting, top 10 ────────────
  const words = text.match(/\b[a-z][a-z0-9]{2,}\b/g) || [];
  const freq = {};
  for (const w of words) {
    if (!STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  const keywords = Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([w]) => w)
    .join(' ');

  // ── Intent tags ───────────────────────────────────────────────────────
  const intents = [];
  for (const [intent, patterns] of Object.entries(INTENT_MAP)) {
    if (patterns.some(re => re.test(text))) intents.push(intent);
  }
  const intentTags = intents.join(' ');

  // ── Domain tags ───────────────────────────────────────────────────────
  const domains = [];
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    if (patterns.some(re => re.test(text))) domains.push(domain);
  }
  const domainTags = domains.join(' ');

  return { keywords, intentTags, domainTags };
}
