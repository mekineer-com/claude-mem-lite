// tfidf.mjs — TF-IDF vector search engine
// Pure JS implementation, zero external dependencies.
// Provides tokenization, vocabulary building, vector computation,
// cosine similarity, vector search, and RRF merging.

import { cjkBigrams } from './utils.mjs';
import { createHash } from 'crypto';

export const VOCAB_DIM = 512;

const VOCAB_STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','can','shall','to','of','in','for',
  'on','with','at','by','from','as','into','about','between',
  'after','before','above','below','and','or','but','not','no',
  'this','that','these','those','it','its','my','your','his',
  'her','our','their','me','him','us','them','i','you','he',
  'she','we','they','what','which','who','when','where','how',
  'all','each','every','both','few','more','most','other','some',
  'such','than','too','very','just','also','then','so','if',
  'now','only','still','here','there','up','out','am',
]);

function isNoiseTerm(term) {
  if (VOCAB_STOP_WORDS.has(term)) return true;
  if (/^\d+$/.test(term)) return true;
  return false;
}

// ─── Tokenization ───────────────────────────────────────────────────────────

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Tokenize text into terms for TF-IDF.
 * ASCII: lowercase + split on non-alphanumeric.
 * CJK: reuse cjkBigrams() for consistency with FTS5.
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
      // ASCII: split on non-alphanumeric
      for (const t of part.split(/[^a-z0-9]+/)) {
        if (t.length >= 2) tokens.push(t);
      }
    }
  }

  return tokens;
}

// ─── Vocabulary ─────────────────────────────────────────────────────────────

let _vocabCache = null;

/** Reset vocabulary cache (for testing). */
export function _resetVocabCache() { _vocabCache = null; }

/**
 * Build global vocabulary (IDF table) from all active observations.
 * @param {object} db - better-sqlite3 database
 * @returns {{ terms: Map<string, {index: number, idf: number}>, version: string, dim: number } | null}
 */
export function buildVocabulary(db) {
  const rows = db.prepare(`
    SELECT title, narrative, concepts FROM observations
    WHERE COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
  `).all();

  const N = rows.length;
  if (N === 0) return null;

  // Count document frequency for each term
  const df = new Map();
  for (const row of rows) {
    const text = [row.title || '', row.narrative || '', row.concepts || ''].join(' ');
    const docTerms = new Set(tokenize(text));
    for (const term of docTerms) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  // Sort by DF descending, filter noise, take top VOCAB_DIM
  const sortedTerms = [...df.entries()]
    .filter(([term]) => !isNoiseTerm(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, VOCAB_DIM);

  // Build terms map with index and IDF
  const terms = new Map();
  sortedTerms.forEach(([term, freq], index) => {
    terms.set(term, { index, idf: Math.log(1 + N / (1 + freq)) });
  });

  // Version hash for staleness detection
  const termList = sortedTerms.map(([t]) => t).join(',');
  const version = createHash('md5').update(termList).digest('hex').slice(0, 12);

  const vocab = { terms, version, dim: VOCAB_DIM };
  _vocabCache = vocab;
  return vocab;
}

/**
 * Rebuild vocabulary from corpus AND persist to vocab_state table.
 * @param {object} db - better-sqlite3 database
 * @returns {object|null} The new vocabulary
 */
export function rebuildVocabulary(db) {
  const vocab = buildVocabulary(db);
  if (!vocab) return null;

  const insertStmt = db.prepare(
    'INSERT INTO vocab_state (term, term_index, idf, version, created_at_epoch) VALUES (?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM vocab_state').run();
    for (const [term, entry] of vocab.terms) {
      insertStmt.run(term, entry.index, entry.idf, vocab.version, now);
    }
  })();

  _vocabCache = vocab;
  return vocab;
}

/**
 * Get cached vocabulary, load from DB, or rebuild from corpus.
 * @param {object} db - better-sqlite3 database
 * @returns {object|null} vocabulary
 */
export function getVocabulary(db) {
  if (_vocabCache) return _vocabCache;

  // Try loading from persisted vocab_state
  try {
    const rows = db.prepare(
      'SELECT term, term_index, idf, version FROM vocab_state ORDER BY term_index'
    ).all();
    if (rows.length > 0) {
      const terms = new Map();
      for (const r of rows) {
        terms.set(r.term, { index: r.term_index, idf: r.idf });
      }
      const vocab = { terms, version: rows[0].version, dim: VOCAB_DIM };
      _vocabCache = vocab;
      return vocab;
    }
  } catch { /* table may not exist in old/test DBs */ }

  // Fallback: compute and persist (first run)
  return rebuildVocabulary(db);
}

// ─── Vector Computation ─────────────────────────────────────────────────────

/**
 * Compute TF-IDF vector for a text string.
 * @returns {Float32Array | null} L2-normalized vector, or null if empty/no matching terms
 */
export function computeVector(text, vocab) {
  if (!vocab || !text) return null;

  const tokens = tokenize(text);
  if (tokens.length === 0) return null;

  // Compute term frequency
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }

  // Build TF-IDF vector
  const vec = new Float32Array(vocab.dim);
  let hasNonZero = false;
  for (const [term, freq] of tf) {
    const entry = vocab.terms.get(term);
    if (entry) {
      vec[entry.index] = freq * entry.idf;
      hasNonZero = true;
    }
  }

  if (!hasNonZero) return null;

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;

  return vec;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

/**
 * Dot product of two L2-normalized Float32Arrays = cosine similarity.
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

// ─── Vector Search ──────────────────────────────────────────────────────────

/**
 * Search observation_vectors by cosine similarity.
 * @param {object} db - better-sqlite3 database
 * @param {Float32Array} queryVec - query vector
 * @param {object} opts - { project?, type?, vocabVersion, limit? }
 * @returns {{ id: number, similarity: number }[]}
 */
export function vectorSearch(db, queryVec, { project, type, vocabVersion, limit = 500 }) {
  if (!queryVec) return [];

  const wheres = [
    'COALESCE(o.compressed_into, 0) = 0',
    'o.superseded_at IS NULL',
    'ov.vocab_version = ?',
  ];
  const params = [vocabVersion];

  if (project) { wheres.push('o.project = ?'); params.push(project); }
  if (type) { wheres.push('o.type = ?'); params.push(type); }
  params.push(limit);

  const rows = db.prepare(`
    SELECT ov.observation_id, ov.vector
    FROM observation_vectors ov
    JOIN observations o ON ov.observation_id = o.id
    WHERE ${wheres.join(' AND ')}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...params);

  const results = [];
  for (const row of rows) {
    const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    const sim = cosineSimilarity(queryVec, vec);
    if (sim > 0.05) results.push({ id: row.observation_id, similarity: sim });
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 20);
}

// ─── RRF Merge ──────────────────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion: merge two ranked result lists.
 * @param {{ id: number }[]} bm25Results - FTS5 results (ranked by position)
 * @param {{ id: number }[]} vectorResults - Vector results (ranked by position)
 * @param {number} k - RRF constant (default 60)
 * @returns {{ id: number, rrfScore: number }[]}
 */
export function rrfMerge(bm25Results, vectorResults, k = 60) {
  const scores = new Map();
  bm25Results.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
  });
  vectorResults.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, rrfScore: score }));
}
