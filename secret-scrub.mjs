// claude-mem-lite: Secret pattern detection and scrubbing
// Extracted from utils.mjs for focused responsibility

import { stripPrivate } from './lib/private-strip.mjs';

// ─── Secret Patterns ──────────────────────────────────────────────────────

export const SECRET_PATTERNS = [
  // Key-value assignments: password=xxx, token=xxx, api_key=xxx, secret=xxx, etc.
  // Excludes code-like values: null, undefined, true, false, None, empty, function calls (word()),
  // and short values (<6 chars) that are typically variable names not secrets.
  //
  // Split into two patterns so prose mentions don't get scrubbed:
  //   1. Bare credential nouns (password|passwd|token|bearer|secret) commonly appear
  //      in English prose — "Marker token: xyzpdq", "the bearer: alice". The prose
  //      mention shape is the `:` form, so the prose lookbehind (NOT preceded by
  //      English-word + horizontal-space) guards ONLY the `:` separator. An `=` is
  //      config-assignment syntax, never prose, so `<word> password=<secret>` ALWAYS
  //      scrubs — without this split that leaked (the lookbehind skipped any noun
  //      after "word ", regardless of separator). No pinned prose case uses `=` (all
  //      are `:`), so the `=` arm is leak-closing with no FP shift on the protected set.
  //   2. Structured keys (api_key, auth_token, …) keep the original behavior —
  //      a separator/compound key is unambiguous config syntax even when
  //      preceded by prose ("see auth_token: shhhhhh").
  // `(?:\b|_)` before the keyword: a plain word-boundary misses the single most
  // common credential shape — underscore-cased env vars (DB_PASSWORD, GH_TOKEN,
  // MY_AUTH_TOKEN) — because `_` is a \w char, so there is NO \b between it and the
  // keyword. Allowing a leading `_` catches those while the prose lookbehind still
  // excludes "Marker token: …". `secret` added so a bare SECRET=… with a mixed-alnum
  // value is covered (the hex-only assignment pattern below misses non-hex values).
  //   1a. `=` assignment → ALWAYS scrub (config syntax, never prose):
  [/((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)\s*=\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi, '$1***'],
  //   1b. `:` separator → keep the prose lookbehind ("the token: alice" is prose):
  [/((?<![A-Za-z][ \t])(?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)\s*:\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi, '$1***'],
  // access_token / refresh_token are the canonical OAuth2 field names — they were
  // missing from this KV list (drift vs the JSON list below). `(?:\b|_)` for the same
  // underscore-prefix reason.
  // `pgpassword|pgpass|mysql_pwd` are well-known credential ENV-VAR names whose
  // keyword tail is unreachable via the noun list above (`PGPASSWORD`=PG+password has
  // no \b/_ before "password"; `MYSQL_PWD` has no "password"/"token" substring). They
  // live in THIS pattern (no prose lookbehind) so `export PGPASSWORD=x` / `env MYSQL_PWD=x`
  // scrub — a compound credential env-var name is unambiguous config even after a word.
  // Enumerating known names (not a blanket letter-prefix) preserves the deliberate
  // low-FP decision that `topsecret=` / `access_token_count:` are non-credentials
  // (#8283 + utils.test.mjs:1089-1100); bare `pwd` is omitted so `PWD=` (a path) survives.
  [/((?:\b|_)(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|pgpassword|pgpass|mysql_pwd)\s*[=:]\s*)(?!process\.env\.)(?!new\s)(?!\w+\()(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)[^\s,;'"}\]]{6,}/gi, '$1***'],
  // Bare-key QUOTED values — `api_key="..."`, `password: '...'`. The unquoted KV
  // patterns above stop at `'`/`"` (excluded from their value class), so a quoted
  // value matched 0 chars and slipped through. Consumes the opening quote, the value,
  // and the matching close quote (backref \2), replacing only the value. Unlike the
  // JSON pattern below it does NOT require the KEY to be quoted, covering `key="value"`
  // object-literal / YAML / quoted-.env shapes. Split into the SAME two patterns as the
  // unquoted KV pairs above so prose survives — a quoted value does not turn prose into
  // config (`the token: "x"` is still prose, must NOT scrub; #8283 / utils.test.mjs:1090).
  //   (a) bare credential nouns: `=` always scrubs; `:` keeps the prose lookbehind
  //       (mirrors the unquoted 1a/1b split — a quoted value doesn't turn `:` prose
  //       into config, but `<word> password="x"` is still a leak):
  [/((?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)\s*=\s*)(['"])[^'"]{6,}\2/gi, '$1$2***$2'],
  [/((?<![A-Za-z][ \t])(?:\b|_)(?:password|passwd|passphrase|token|bearer|secret)\s*:\s*)(['"])[^'"]{6,}\2/gi, '$1$2***$2'],
  //   (b) structured keys + named env vars are unambiguous config even after a word
  //       (`see api_key: "x"` DOES scrub, mirroring the unquoted structured-key path):
  [/((?:\b|_)(?:pgpassword|pgpass|mysql_pwd|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)(['"])[^'"]{6,}\2/gi, '$1$2***$2'],
  // AWS access keys: AKIA (long-term) + ASIA (STS temp) + AROA (role) + AIDA
  // (user) + ANPA/ANVA/AGPA (other principal types). All share the 4-letter
  // prefix + exactly 16 base32 chars shape — specific enough for near-zero FP.
  [/\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|AGPA)[A-Z0-9]{16}\b/g, '***'],
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
  // PEM private key blocks. `[A-Z0-9 ]*` covers every armor label — RSA/EC/DSA/
  // OPENSSH plus ENCRYPTED and PGP (… PRIVATE KEY BLOCK) — that the fixed
  // alternation missed; the block delimiters make FP impossible.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, '***PEM_KEY***'],
  // Long hex strings in assignments (e.g. SECRET_KEY=abc123def456...)
  [/(\b(?:key|secret|token|hash)\s*[=:]\s*)[0-9a-f]{32,}\b/gi, '$1***'],
  // Google Cloud API keys (AIza...)
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '***'],
  // Generic Bearer tokens in Authorization headers
  [/(Authorization:\s*Bearer\s+)[^\s,;'"}\]]+/gi, '$1***'],
  // Supabase / generic long base64 keys (40+ chars, common in env vars)
  [/(\b(?:SUPABASE_KEY|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|REDIS_URL)\s*[=:]\s*)[^\s,;'"}\]]+/gi, '$1***'],
  // Basic auth in URLs (https://user:password@host). ftp/ftps added — file-drop
  // creds are a common leak shape the https-only form missed.
  [/(https?|ftps?):\/\/[^@/\s]+:[^@/\s]+@/gi, '$1://***:***@'],
  // Database connection strings (postgres, mysql, mongodb, redis, amqp)
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s,;'"}\]]+/gi, '$1://***'],
  // npm tokens (npm_...)
  [/\bnpm_[a-zA-Z0-9]{36,}\b/g, '***'],
  // Stripe keys (sk_live_, rk_live_, pk_live_, sk_test_, pk_test_)
  [/\b[srp]k_(?:live|test)_[a-zA-Z0-9]{20,}\b/g, '***'],
  // SendGrid API keys: SG.<22>.<43> — two dots at fixed offsets make this
  // structurally unmistakable; near-zero false-positive risk.
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, '***'],
  // Twilio identifiers: Account SID (AC…) + API Key SID (SK…), each = prefix
  // + exactly 32 hex. The 2-letter prefix + 32-hex shape is specific: an MD5
  // is 32 hex (no AC/SK prefix → no match) and a 40-hex git SHA has no internal
  // \b so the trailing \b can't land mid-string. We deliberately do NOT scrub
  // the bare-hex Twilio *auth token* — see comment block at end re: SHA collision.
  [/\b(?:AC|SK)[0-9a-f]{32}\b/g, '***'],
  // Mailgun private API keys: key-<32 hex>. Prefix-anchored for the same reason;
  // bare 32-hex (no `key-`) is intentionally left alone to avoid hashing FPs.
  [/\bkey-[0-9a-f]{32}\b/g, '***'],
  // JSON-quoted secrets — error payloads / API responses commonly carry creds
  // as `{"api_key": "..."}`. The base key=value pattern stops at quotes, so
  // these slip through. Match the value-quoted form explicitly. Length floor
  // (6) avoids tripping on intentional placeholder shorts ("...", "secret").
  [/("(?:password|passwd|token|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|refresh[_-]?token|session[_-]?id|sessionid)"\s*:\s*")[^"]{6,}(")/gi, '$1***$2'],
  // JSON keys with vendor PREFIX/SUFFIX around the core credential noun —
  // `"x_api_key"`, `"aws_secret_access_key"`, `"my_password"`, `"gh_token"`.
  // The exact-name list above misses these. Anchored to the credential nouns
  // (password|secret|api_key|auth_token|access_token|private_key) so a benign
  // `"token_count"` value (numeric, <6 non-quote chars after scrub) and prose
  // keys stay low-FP; over-scrub is the safe direction for at-rest memory.
  [/("\w*(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w*"\s*:\s*")[^"]{6,}(")/gi, '$1***$2'],
  // Quoted-KEY credential values — Python dict reprs `{'api_key': '...'}`, single-quoted
  // JS/JSON, and any mixed quoting. The quoted-VALUE patterns above match an UNQUOTED key
  // (the key's closing quote sits between the key name and the `[=:]`, so `keyword\s*[=:]`
  // never fires); the JSON patterns require BOTH key and value DOUBLE-quoted. So a single-
  // quoted or mixed-quoted pair — the most common at-rest shape for opaque app secrets in
  // stored LLM output / error payloads / code snippets — slipped through unredacted (#8805
  // sibling). A quoted key is unambiguous config/data, so — like the JSON patterns — no prose
  // guard is needed. Key quote and value quote are matched independently (`['"]` each); the
  // value's close is a backref (\2) to its own opening quote. Same credential-noun set as the
  // vendor-prefix JSON pattern above (bare `token`/`bearer` deliberately excluded to avoid
  // `'token_count': 123456`); `passphrase` added here too (double-quoted JSON passphrase is
  // subsumed by this pattern since `['"]` matches `"`). Over-scrub is the safe direction.
  [/(['"]\w*(?:password|passwd|passphrase|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\w*['"]\s*:\s*)(['"])[^'"]{6,}\2/gi, '$1$2***$2'],
  // Session cookies in headers / urlencoded bodies (sessionid=, session_id=, JSESSIONID=, PHPSESSID=).
  // 16+ chars filters out short test fixtures like sessionid=abc.
  [/\b((?:session[_-]?id|sessionid|jsessionid|phpsessid)\s*[=:]\s*)[^\s,;'"}\]]{16,}/gi, '$1***'],
  // ── DELIBERATELY NOT COVERED: bare high-entropy / "raw N-char" tokens ──────
  // A generic `[A-Fa-f0-9]{40}` / high-entropy regex would scrub this repo's own
  // legitimate data: 40-hex git SHAs, 32-hex MD5s, 64-hex SHA256s, and stored
  // `minhash_sig` values. In a hash-heavy codebase the false-positive cost
  // (silent `***` over real content, lost recall) exceeds the marginal catch —
  // and an entropy gate doesn't help because git SHAs are themselves high-entropy.
  // The contextual forms (token=…, Authorization: Bearer …, "api_key":"…") above
  // already cover the dangerous *labelled* shapes. If you are tempted to add a
  // bare-token pattern here: don't — anchor it to a provider prefix instead.
];

/**
 * Scrub known secret patterns (API keys, tokens, credentials) from text.
 * Also strips user-marked `<private>...</private>` blocks first, so every
 * persistence/log path that scrubs secrets inherits the `<private>` opt-out —
 * previously stripPrivate ran only on the user-prompt hook, not on writes.
 * @param {string} text Input text potentially containing secrets
 * @returns {string} Text with secrets replaced by '***'
 */
export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = stripPrivate(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
