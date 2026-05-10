// nlp.mjs -- FTS5 query building, synonym expansion, CJK tokenization.
// Extracted from utils.mjs for focused module boundaries.

import { BASE_STOP_WORDS, CJK_STOP_WORDS } from './stop-words.mjs';
import { SYNONYM_MAP, CJK_COMPOUNDS } from './synonyms.mjs';

// Re-export for backward compatibility (consumers import from nlp.mjs or utils.mjs)
export { SYNONYM_MAP, CJK_COMPOUNDS };

// ─── FTS5 Constants ──────────────────────────────────────────────────────────

const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

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

// ─── CJK Keyword Extraction ─────────────────────────────────────────────────

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

// Merged CJK dictionary: CJK_COMPOUNDS + CJK keys from SYNONYM_MAP — sorted longest first.
// Gives broadest coverage: "搜索" from SYNONYM_MAP + "函数" from CJK_COMPOUNDS.
const _cjkMergedKeys = [...new Set([...CJK_COMPOUNDS, ..._cjkSynonymKeys])]
  .sort((a, b) => b.length - a.length);

/**
 * Extract CJK keywords using merged dictionary (CJK_COMPOUNDS + SYNONYM_MAP keys).
 * Broader than either source alone. Filters CJK stop words.
 * "这个函数是做什么的" → ["函数"] (not noisy bigrams)
 * "修复数据库性能优化" → ["修复", "数据库", "性能", "优化"]
 * "之前修复的FTS搜索排序" → ["修复", "搜索", "排序"]
 */
export function extractCjkKeywords(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text[i])) { i++; continue; }
    let matched = false;
    for (const word of _cjkMergedKeys) {
      if (text.startsWith(word, i) && !CJK_STOP_WORDS.has(word)) {
        found.push(word);
        i += word.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return found;
}

/**
 * Extract CJK patterns suitable for SQL LIKE fallback when FTS5 fails on CJK text.
 * Uses dictionary extraction + bigram fallback for unmatched portions.
 * @param {string} query Raw query text
 * @returns {string[]} CJK patterns (≥2 chars each), empty if no CJK content
 */
export function extractCjkLikePatterns(query) {
  if (!query || !/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/.test(query)) return [];
  const keywords = extractCjkKeywords(query);
  // Bigrams for unmatched CJK portions \u2014 but only from pure-CJK whitespace tokens.
  // Mixed-script tokens (e.g. "xyzAbc\u4e0d\u5b58\u5728neverhit") behave as identifier-like
  // literals; LIKE-OR'ing the CJK-suffix bigrams matches unrelated docs containing
  // common fragments. Mirrors the FTS-side guard in sanitizeFtsQuery.
  let remainder = query;
  for (const w of keywords) remainder = remainder.split(w).join(' ');
  const pureCjkOnly = remainder
    .split(/\s+/)
    .filter(t => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(t) && !/[A-Za-z0-9]/.test(t))
    .join(' ');
  const bigrams = pureCjkOnly ? cjkBigrams(pureCjkOnly).split(' ').filter(Boolean) : [];
  return [...new Set([...keywords, ...bigrams])];
}

/**
 * Post-FTS precision filter for CJK queries.
 *
 * Background: FTS5 unicode61 tokenizer splits every CJK character into its
 * own token. An application-layer bigram query like "我是" then reduces to
 * (我 AND 是) at match time — matching any document that happens to contain
 * both chars anywhere, which is extremely permissive in Chinese prose.
 *
 * Precision check: given the raw query and a candidate result's full text,
 * require that at least `threshold` fraction of the query's CJK bigrams
 * (or dictionary words, if any matched) appear as contiguous substrings in
 * the result. Non-CJK queries bypass this filter entirely.
 *
 * Applied only to the prompts/user-prompt path — observations have richer
 * rerank + low-signal filtering that already control noise there. Also,
 * obs-side synonym expansion ("查询"→"(查询 OR query OR search)") is a
 * legitimate recall mechanism that this filter would break.
 *
 * Threshold default 0.2 is tunable via `CLAUDE_MEM_CJK_PREC_MIN` env var.
 * Explicit threshold arg still overrides the env value — tests and in-code
 * callers with domain context stay authoritative.
 *
 * Default was tuned from 0.3 → 0.2 after a 20-query production-DB fixture
 * showed 0.3 over-rejected legitimate multi-bigram queries whose dict-
 * keyword coverage was incomplete (e.g. "同义词扩展" — neither compound
 * is in CJK_COMPOUNDS → 4 bigrams required, single-keyword match only
 * 25% < 30% rejected 19/20 real hits). At 0.2, pure-noise reduction stays
 * ≥85% on noise fixture while SIG-6 recall recovered to 100%.
 *
 * @param {string} query Raw query text
 * @param {string} text Candidate result text
 * @param {number} [threshold] Fraction of patterns that must match. If
 *   omitted, reads CLAUDE_MEM_CJK_PREC_MIN (default 0.2).
 * @returns {boolean}
 */
export function cjkPrecisionOk(query, text, threshold) {
  if (threshold === undefined) {
    const envVal = process.env.CLAUDE_MEM_CJK_PREC_MIN;
    const parsed = envVal ? parseFloat(envVal) : NaN;
    threshold = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.2;
  }
  if (!query || !text) return true;
  if (!/[一-鿿㐀-䶿]{2,}/.test(query)) return true;
  const keywords = extractCjkKeywords(query);
  const required = keywords.length > 0
    ? keywords
    : cjkBigrams(query).split(' ').filter(b => b && !CJK_STOP_WORDS.has(b));
  if (required.length === 0) return true;
  const hit = required.filter(w => text.includes(w)).length;
  return (hit / required.length) >= threshold;
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
    t && !/^-+$/.test(t) && !FTS5_KEYWORDS.has(t.toUpperCase()) && !/^NEAR(\/\d*)?$/i.test(t)
    // Skip single ASCII-letter tokens — too noisy for FTS5 (CJK single chars handled separately below)
    && !(t.length === 1 && /^[a-zA-Z]$/.test(t))
  );
  // Filter stop words (but keep all if filtering would empty the query)
  const filtered = tokens.filter(t => !FTS_STOP_WORDS.has(t.toLowerCase()));
  if (filtered.length > 0) tokens = filtered;
  // Split unsegmented CJK tokens into known vocabulary words using CJK_COMPOUNDS dictionary.
  // Uses broader dictionary than synonym-only extraction for better recall.
  // e.g. "这个函数是做什么的" → ["函数"] (not noisy bigrams)
  const expandedTokens = [];
  let cjkExtracted = false;
  for (const t of tokens) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(t) && t.length > 2) {
      const cjkWords = extractCjkKeywords(t);
      if (cjkWords.length > 0) {
        expandedTokens.push(...cjkWords);
        cjkExtracted = true;
        // Preserve unmatched CJK portions as bigrams (don't silently drop them)
        const matched = new Set(cjkWords);
        let remainder = t;
        for (const w of matched) remainder = remainder.split(w).join(' ');
        const gapBigrams = cjkBigrams(remainder);
        if (gapBigrams) {
          for (const bg of gapBigrams.split(' ')) {
            if (bg && !CJK_STOP_WORDS.has(bg) && !matched.has(bg)) expandedTokens.push(bg);
          }
        }
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
  // Also skip for mixed-script tokens (e.g. "xyzAbc不存在neverhit"): the latin portion
  // is already a strong literal anchor; bigramming the CJK suffix lets short fragments
  // like "存在" match alone after AND→OR fallback, exploding recall onto unrelated docs.
  let bigrams = null;
  if (!cjkExtracted) {
    const pureCjkTokens = tokens.filter(t =>
      /[一-鿿㐀-䶿]/.test(t) && !/[A-Za-z0-9]/.test(t)
    );
    if (pureCjkTokens.length > 0) bigrams = cjkBigrams(pureCjkTokens.join(' '));
  }
  const bigramSet = new Set(bigrams ? bigrams.split(' ').filter(b => b && !CJK_STOP_WORDS.has(b)) : []);
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
