// claude-mem-lite: Secret pattern detection and scrubbing
// Extracted from utils.mjs for focused responsibility

// ─── Secret Patterns ──────────────────────────────────────────────────────

export const SECRET_PATTERNS = [
  // Key-value assignments: password=xxx, token=xxx, api_key=xxx, secret=xxx, etc.
  // Excludes code-like values: null, undefined, true, false, None, empty, function calls (word()),
  // and short values (<6 chars) that are typically variable names not secrets.
  [/(\b(?:password|passwd|token|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer)\s*[=:]\s*)(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?!\w+\()(?!new\s)(?!process\.env\.)[^\s,;'"}\]]{6,}/gi, '$1***'],
  // AWS access keys (AKIA...)
  [/\bAKIA[A-Z0-9]{16}\b/g, '***'],
  // OpenAI / Anthropic keys (sk-...) — specific prefixes have lower length threshold
  [/\bsk-(?:proj|ant|ant-api\d{2})-[a-zA-Z0-9_-]{8,}\b/g, '***'],
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
  // Basic auth in URLs (https://user:password@host)
  [/https?:\/\/[^@/\s]+:[^@/\s]+@/gi, 'https://***:***@'],
  // Database connection strings (postgres, mysql, mongodb, redis, amqp)
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s,;'"}\]]+/gi, '$1://***'],
  // npm tokens (npm_...)
  [/\bnpm_[a-zA-Z0-9]{36,}\b/g, '***'],
  // Stripe keys (sk_live_, rk_live_, pk_live_, sk_test_, pk_test_)
  [/\b[srp]k_(?:live|test)_[a-zA-Z0-9]{20,}\b/g, '***'],
];

/**
 * Scrub known secret patterns (API keys, tokens, credentials) from text.
 * @param {string} text Input text potentially containing secrets
 * @returns {string} Text with secrets replaced by '***'
 */
export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
