import { porterStem } from '../tfidf.mjs';
import { cjkBigrams } from '../utils.mjs';

// ─── Tokenization ───────────────────────────────────────────────────────────
//
// Moved here from tfidf.mjs, beside its only caller. It was built for the TF-IDF vocabulary,
// which was removed with the vector arm; every remaining consumer is in this directory
// (textToBag / buildIdf here, cosOf / computeAdoption in adoption-overlap.mjs) plus the unit
// test. Leaving it in the product tree meant tfidf.mjs exported two unrelated things under a
// name that describes neither, and one of them had no product caller at all.
//
// The stemmer itself stays in tfidf.mjs: `porterStem` has a live product consumer on the
// default retrieval path (search-scoring.mjs's PRF term extraction), and moving THAT would
// change a precision/recall premise and owe a denoise-ab run. This move does not — no product
// code path is touched by it.
//
// NOT aligned with FTS5, and the distinction is load-bearing: `observations_fts` uses the
// default unicode61 tokenizer with no stemming, so the terms this produces are STEMS while
// FTS5's are surface forms. Anything feeding these into a MATCH matches nothing.
const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Tokenize text into stemmed terms.
 * ASCII: lowercase + split + Porter stem.
 * CJK: reuse cjkBigrams() for consistency with FTS5 indexing.
 */
export function tokenize(text) {
  if (!text) return [];
  text = String(text).toLowerCase();

  const tokens = [];

  // Split into ASCII and CJK segments
  const parts = text.split(/([\u4e00-\u9fff\u3400-\u4dbf]+)/);
  for (const part of parts) {
    if (CJK_RANGE.test(part)) {
      // CJK: use bigrams for consistency with FTS5 indexing
      const bigrams = cjkBigrams(part);
      if (bigrams) {
        for (const t of bigrams.split(/\s+/)) {
          if (t.length >= 2) tokens.push(t);
        }
      }
    } else {
      // ASCII: split on non-alphanumeric, then Porter stem
      for (const t of part.split(/[^a-z0-9]+/)) {
        if (t.length >= 2) tokens.push(porterStem(t));
      }
    }
  }

  return tokens;
}

export function textToBag(text) {
  const bag = new Map();
  for (const t of tokenize(text || '')) bag.set(t, (bag.get(t) || 0) + 1);
  return bag;
}

export function buildIdf(corpusTexts) {
  const N = corpusTexts.length || 1;
  const df = new Map();
  for (const text of corpusTexts) {
    for (const term of new Set(tokenize(text || ''))) df.set(term, (df.get(term) || 0) + 1);
  }
  const idf = new Map();
  for (const [term, d] of df) idf.set(term, Math.log(1 + N / (1 + d)));
  idf.__default = Math.log(1 + N / 1); // unseen term: df=0
  return idf;
}

export function cosine(bagA, bagB, idf) {
  const w = (term, tf) => tf * (idf.get(term) ?? idf.__default ?? 0);
  let dot = 0,
    na = 0,
    nb = 0;
  for (const [t, tf] of bagA) {
    const x = w(t, tf);
    na += x * x;
    if (bagB.has(t)) dot += x * w(t, bagB.get(t));
  }
  for (const [t, tf] of bagB) {
    const y = w(t, tf);
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function dualChannelBags({ prose, actions }) {
  return { proseBag: textToBag(prose), actionBag: textToBag(actions) };
}
