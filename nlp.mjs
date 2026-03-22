// nlp.mjs -- FTS5 query building, synonym expansion, CJK tokenization.
// Extracted from utils.mjs for focused module boundaries.

import { BASE_STOP_WORDS } from './stop-words.mjs';
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
