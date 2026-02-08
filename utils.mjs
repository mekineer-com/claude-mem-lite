// claude-mem-lite shared utilities
// Used by server.mjs, hook.mjs, and tests

import { basename, dirname } from 'path';

// ─── String Utilities ────────────────────────────────────────────────────────

export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function truncate(str, max = 80) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ─── Secret Scrubbing ──────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  // Key-value assignments: password=xxx, token=xxx, api_key=xxx, secret=xxx, etc.
  [/(\b(?:password|passwd|token|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer)\s*[=:]\s*)[^\s,;'"}\]]+/gi, '$1***'],
  // AWS access keys (AKIA...)
  [/\bAKIA[A-Z0-9]{16}\b/g, '***'],
  // OpenAI / Anthropic keys (sk-...)
  [/\bsk-[a-zA-Z0-9_-]{20,}\b/g, '***'],
  // GitHub tokens (ghp_, gho_, github_pat_)
  [/\b(?:ghp_|gho_|ghs_|ghr_)[a-zA-Z0-9_]{30,}\b/g, '***'],
  [/\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g, '***'],
  // GitLab tokens (glpat-)
  [/\bglpat-[a-zA-Z0-9_-]{20,}\b/g, '***'],
  // Slack tokens (xox[bpas]-)
  [/\bxox[bpas]-[a-zA-Z0-9-]{10,}\b/g, '***'],
  // JWT tokens (eyJ...eyJ...)
  [/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g, '***'],
  // PEM private key blocks
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, '***PEM_KEY***'],
  // Long hex strings in assignments (e.g. SECRET_KEY=abc123def456...)
  [/(\b(?:key|secret|token|hash)\s*[=:]\s*)[0-9a-f]{32,}\b/gi, '$1***'],
  // Google Cloud API keys (AIza...)
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '***'],
  // Generic Bearer tokens in Authorization headers
  [/(Authorization:\s*Bearer\s+)[^\s,;'"}\]]+/gi, '$1***'],
  // Supabase / generic long base64 keys (40+ chars, common in env vars)
  [/(\b(?:SUPABASE_KEY|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|REDIS_URL)\s*[=:]\s*)[^\s,;'"}\]]+/gi, '$1***'],
];

export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Token Estimation ─────────────────────────────────────────────────────

export function estimateTokens(text) {
  return Math.ceil(((text || '').length || 1) / 4);
}

// ─── MinHash Signatures ──────────────────────────────────────────────────

// FNV-1a hash: fast, non-cryptographic, ~10x faster than SHA-256 for MinHash
function fnv1a(str) {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
    hash >>>= 0; // Keep as uint32
  }
  return hash;
}

export function computeMinHash(text, numHashes = 64) {
  if (!text || typeof text !== 'string') return null;
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length > 2);
  // Require at least 3 tokens for meaningful signature (avoids high collision on short texts)
  if (tokens.length < 3) return null;

  const mins = new Array(numHashes).fill(0xFFFFFFFF);
  for (const token of tokens) {
    for (let i = 0; i < numHashes; i++) {
      const val = fnv1a(`${i}-${token}`);
      if (val < mins[i]) mins[i] = val;
    }
  }
  return mins.map(v => v.toString(16).padStart(8, '0')).join('');
}

export function estimateJaccardFromMinHash(sig1, sig2) {
  if (!sig1 || !sig2) return 0;
  if (sig1.length !== sig2.length) return 0;
  const numHashes = sig1.length / 8;
  if (numHashes === 0) return 0;
  let matches = 0;
  for (let i = 0; i < numHashes; i++) {
    const offset = i * 8;
    if (sig1.slice(offset, offset + 8) === sig2.slice(offset, offset + 8)) matches++;
  }
  return matches / numHashes;
}

export function typeIcon(type) {
  const icons = { decision: '🟡', bugfix: '🔴', feature: '🟢', refactor: '🔵', discovery: '🔍', change: '📝' };
  return icons[type] || '⚪';
}

// ─── FTS5 ────────────────────────────────────────────────────────────────────

const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

// Synonym/abbreviation map: query abbreviation → expanded full forms
// Bidirectional: both directions are registered so "K8s" finds "Kubernetes" and vice versa
const SYNONYM_MAP = new Map();
const SYNONYM_PAIRS = [
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

// Format a term for FTS5: quote if it contains spaces, hyphens, or special chars
function ftsToken(term) {
  // Bare tokens are safe only if purely alphanumeric
  if (/^[a-zA-Z0-9]+$/.test(term)) return term;
  return `"${term.replace(/"/g, '""')}"`;
}

function expandToken(token) {
  const synonyms = SYNONYM_MAP.get(token.toLowerCase());
  if (!synonyms || synonyms.size === 0) return ftsToken(token);
  // FTS5 OR group: (original OR synonym1 OR "multi word synonym")
  const parts = [ftsToken(token)];
  for (const syn of synonyms) {
    parts.push(ftsToken(syn));
  }
  return `(${parts.join(' OR ')})`;
}

export function sanitizeFtsQuery(query) {
  if (!query) return null;
  const cleaned = query
    .replace(/[{}()\[\]^~*:]/g, ' ')
    .replace(/(^|\s)-/g, '$1')
    .trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter(t => t && !/^-+$/.test(t) && !FTS5_KEYWORDS.has(t.toUpperCase()));
  if (tokens.length === 0) return null;
  const expanded = tokens.map(t => expandToken(t));
  // FTS5 requires explicit AND after parenthesized OR groups
  const hasGroup = expanded.some(e => e.startsWith('('));
  return expanded.join(hasGroup ? ' AND ' : ' ');
}

// ─── Importance ──────────────────────────────────────────────────────────────

export function clampImportance(val) {
  if (typeof val !== 'number' || isNaN(val)) return 1;
  return Math.max(1, Math.min(3, Math.round(val)));
}

export function computeRuleImportance(episode) {
  let importance = 1;
  for (const entry of episode.entries) {
    const sig = entry.bashSig;
    const files = entry.files || [];
    if (sig?.isError && (sig?.isTest || sig?.isBuild)) { importance = 3; break; }
    if (files.some(f => /\.(env|pem|key)$|\/auth\.|\/credential|\/password/i.test(f))) { importance = 3; break; }
    if (files.some(f => /migration|schema\.|prisma|alembic/i.test(f))) { importance = 3; break; }
    if (sig?.isError && importance < 2) importance = 2;
    if (sig?.isGit && importance < 2) importance = 2;
    if (sig?.isDeploy && importance < 2) importance = 2;
    if (files.some(f => /\.config\.|tsconfig|Dockerfile|docker-compose|package\.json|\.yml$|\.yaml$/i.test(basename(f))) && importance < 2) importance = 2;
  }
  return importance;
}

// ─── Project Inference ───────────────────────────────────────────────────────

export function inferProject() {
  const p = process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
  const base = basename(p);
  const parent = basename(dirname(p));
  return parent && parent !== '.' && parent !== '/' ? `${parent}--${base}` : base;
}

// ─── Bash Analysis ───────────────────────────────────────────────────────────

export function detectBashSignificance(input, response) {
  const cmd = (input.command || '').toLowerCase();
  const isError = /\berror\b|fail(ed|ure)?|exception|panic|traceback|errno|enoent|command not found/i.test(response)
    && response.length > 30;
  const isTest = /\b(test|jest|pytest|vitest|mocha|spec|cypress|playwright)\b/i.test(cmd);
  const isBuild = /\b(build|compile|tsc|webpack|vite|rollup|esbuild|make|cargo)\b/i.test(cmd);
  const isGit = /\bgit\s+(commit|merge|rebase|cherry-pick|push)\b/i.test(cmd);
  const isDeploy = /\b(deploy|docker|kubectl|terraform)\b/i.test(cmd);
  return {
    isError, isTest, isBuild, isGit, isDeploy,
    isSignificant: isError || isTest || isBuild || isGit || isDeploy,
  };
}

const ERROR_STOP_WORDS = new Set([
  'error', 'failed', 'cannot', 'could', 'with', 'from', 'that', 'this',
  'have', 'been', 'were', 'does', 'will', 'would', 'should', 'must',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'const',
  'node', 'require', 'stack', 'trace',
]);

export function extractErrorKeywords(cmd, response) {
  const words = new Set();
  const cmdParts = cmd.split(/[\s/\\|&;]+/).filter(w => w.length > 2 && !/^-/.test(w));
  for (const w of cmdParts.slice(0, 3)) {
    const lw = w.toLowerCase();
    if (!ERROR_STOP_WORDS.has(lw)) words.add(lw);
  }
  const errLines = response.split('\n').filter(l =>
    /error|fail|exception|cannot|not found|undefined|null/i.test(l)
  ).slice(0, 3);
  for (const line of errLines) {
    const tokens = line.replace(/[^a-zA-Z0-9_.-]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !/^\d+$/.test(w));
    for (const t of tokens.slice(0, 5)) {
      const lt = t.toLowerCase();
      if (!ERROR_STOP_WORDS.has(lt)) words.add(lt);
    }
  }
  const result = [...words].slice(0, 6);
  return result.length >= 1 ? result : null;
}

// ─── File Paths ──────────────────────────────────────────────────────────────

export function extractFilePaths(input) {
  const paths = [];
  if (input.file_path) paths.push(input.file_path);
  if (input.path) paths.push(input.path);
  if (input.filePath) paths.push(input.filePath);
  if (input.command) {
    // Match absolute paths; extension optional to support Makefile, Dockerfile etc.
    const match = input.command.match(/(?:^|\s)(\/[\w./-]+\w)/g);
    if (match) {
      for (const m of match) {
        const p = m.trim();
        if (!p.startsWith('/dev/') && !p.startsWith('/proc/') && !p.startsWith('/tmp/')) {
          paths.push(p);
        }
      }
    }
  }
  return [...new Set(paths)];
}

// ─── Episode Logic ───────────────────────────────────────────────────────────

export function isRelatedToEpisode(episode, newFiles) {
  // No files (Bash, Grep without file context) → always related
  if (newFiles.length === 0) return true;
  if (episode.files.length === 0) return true;
  // Check file or directory overlap
  for (const nf of newFiles) {
    for (const ef of episode.files) {
      if (nf === ef) return true;
      if (dirname(nf) === dirname(ef)) return true;
    }
  }
  return false;
}

// ─── Entry Description ──────────────────────────────────────────────────────

export function makeEntryDesc(toolName, input, resp) {
  switch (toolName) {
    case 'Edit':
      return `${basename(input.file_path || '')}: "${truncate(input.old_string || '', 40)}" → "${truncate(input.new_string || '', 40)}"`;
    case 'Write':
      return `Created ${basename(input.file_path || '')} (${(input.content || '').length} chars)`;
    case 'NotebookEdit':
      return `Notebook cell: ${truncate(input.new_source || '', 60)}`;
    case 'Bash': {
      const cmd = truncate(input.command || '', 50);
      const isErr = /error|fail|exception|panic/i.test(resp) && resp.length > 30;
      const snippet = truncate(resp, 60);
      return isErr ? `${cmd} → ERROR: ${snippet}` : `${cmd} → ${snippet}`;
    }
    case 'Grep':
      return `Search "${truncate(input.pattern || '', 20)}" → ${truncate(resp, 60)}`;
    case 'LSP':
      return `${input.operation || ''} ${basename(input.filePath || '')}`;
    case 'Task':
      return truncate(input.description || '', 60);
    case 'WebSearch':
      return `Web: ${truncate(input.query || '', 50)}`;
    case 'WebFetch':
      return `Fetch: ${truncate(input.url || '', 50)}`;
    default:
      return `${toolName}: ${truncate(resp, 50)}`;
  }
}

// ─── Debug Catch Helper ──────────────────────────────────────────────────────

export function debugCatch(e, context) {
  if (process.env.CLAUDE_MEM_DEBUG) {
    console.error(`[claude-mem-lite] ${context}:`, e?.message || e);
  }
}

// ─── JSON Parsing ────────────────────────────────────────────────────────────

export function parseJsonFromLLM(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) try { return JSON.parse(obj[0]); } catch {}
  return null;
}
