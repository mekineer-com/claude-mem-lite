// claude-mem-lite: Secret pattern detection and scrubbing
// Extracted from utils.mjs for focused responsibility

// ─── Secret Patterns ──────────────────────────────────────────────────────

export const SECRET_PATTERNS = [
  // Key-value assignments: password=xxx, token=xxx, api_key=xxx, secret=xxx, etc.
  // Excludes code-like values: null, undefined, true, false, None, empty, function calls (word()),
  // and short values (<6 chars) that are typically variable names not secrets.
  //
  // Split into two patterns so prose mentions don't get scrubbed:
  //   1. Bare credential nouns (password|passwd|token|bearer) commonly appear in
  //      English prose — "Marker token: xyzpdq", "the bearer: alice". We require
  //      the keyword NOT to be preceded by an English-word + horizontal-space
  //      (the prose mention shape). Code/config has the keyword at start-of-line,
  //      after a separator, or in object-literal context — none of which match
  //      "letter-then-space" preceding the keyword.
  //   2. Structured keys (api_key, auth_token, …) keep the original behavior —
  //      a separator/compound key is unambiguous config syntax even when
  //      preceded by prose ("see auth_token: shhhhhh").
  // `(?:\b|_)` before the keyword: a plain word-boundary misses the single most
  // common credential shape — underscore-cased env vars (DB_PASSWORD, GH_TOKEN,
  // MY_AUTH_TOKEN) — because `_` is a \w char, so there is NO \b between it and the
  // keyword. Allowing a leading `_` catches those while the prose lookbehind still
  // excludes "Marker token: …". `secret` added so a bare SECRET=… with a mixed-alnum
  // value is covered (the hex-only assignment pattern below misses non-hex values).
  [/((?<![A-Za-z][ \t])(?:\b|_)(?:password|passwd|token|bearer|secret)\s*[=:]\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi, '$1***'],
  // access_token / refresh_token are the canonical OAuth2 field names — they were
  // missing from this KV list (drift vs the JSON list below). `(?:\b|_)` for the same
  // underscore-prefix reason.
  [/((?:\b|_)(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi, '$1***'],
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
  // JSON-quoted secrets — error payloads / API responses commonly carry creds
  // as `{"api_key": "..."}`. The base key=value pattern stops at quotes, so
  // these slip through. Match the value-quoted form explicitly. Length floor
  // (6) avoids tripping on intentional placeholder shorts ("...", "secret").
  [/("(?:password|passwd|token|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|refresh[_-]?token|session[_-]?id|sessionid)"\s*:\s*")[^"]{6,}(")/gi, '$1***$2'],
  // Session cookies in headers / urlencoded bodies (sessionid=, session_id=, JSESSIONID=, PHPSESSID=).
  // 16+ chars filters out short test fixtures like sessionid=abc.
  [/\b((?:session[_-]?id|sessionid|jsessionid|phpsessid)\s*[=:]\s*)[^\s,;'"}\]]{16,}/gi, '$1***'],
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
