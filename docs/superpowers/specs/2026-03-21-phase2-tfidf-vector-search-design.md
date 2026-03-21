# Phase 2: TF-IDF Vector Search + RRF Hybrid Scoring

## Goal

Add lightweight local vector search using TF-IDF sparse vectors (zero new dependencies) and combine it with existing FTS5 BM25 search via Reciprocal Rank Fusion (RRF) for significantly better retrieval quality.

## Architecture

**TF-IDF sparse vectors** computed from observation text (title + narrative + concepts), stored as `Float32Array` BLOBs in a new `observation_vectors` table. A global vocabulary (IDF table) is built from all observations and cached in memory. Vectors are computed synchronously on write. Search combines BM25 rank + vector cosine similarity rank via RRF.

**Zero new dependencies.** TF-IDF, tokenization, and cosine similarity are pure JS. The `observation_vectors` table is in the same SQLite database as observations.

## TF-IDF Engine (`tfidf.mjs`)

### Vocabulary

Built from all non-archived observations' `title`, `narrative`, and `concepts` fields:
1. Tokenize: lowercase, split on non-alphanumeric (preserving CJK characters), filter tokens < 2 chars
2. Compute document frequency (DF) for each term across all documents
3. Compute IDF: `log(N / (1 + DF))` where N = total document count
4. Keep top-N terms by DF (N = 512) as the fixed vocabulary dimension
5. Store vocabulary version as hash of sorted term list (for staleness detection)

**Rebuild triggers:**
- Session start (hook.mjs session-start event)
- After mem_compress or mem_maintain operations (vocabulary may shift)
- Manual: `mem_maintain` with `operations: ['rebuild_vectors']`

**Caching:** Module-level `Map` cache, rebuilt when version changes or on session start.

### Vector Computation

For a given text string:
1. Tokenize (same pipeline as vocabulary)
2. Compute term frequency (TF) for each token
3. For each term in vocabulary: `weight = TF × IDF`
4. Normalize to unit vector (L2 norm)
5. Return as `Float32Array` of dimension N (512)

### Cosine Similarity

```javascript
function cosineSimilarity(a, b) {
  // Both are L2-normalized Float32Arrays — dot product = cosine similarity
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
```

### Exports

```javascript
export function buildVocabulary(db, project?)  // → { terms: Map<string, {index, idf}>, version: string, dim: number }
export function getVocabulary(db, project?)     // → cached vocabulary (builds if needed)
export function computeVector(text, vocab)      // → Float32Array
export function cosineSimilarity(a, b)          // → number
export function vectorSearch(db, queryVec, opts) // → [{id, similarity}]
export const VOCAB_DIM = 512
```

## Storage: `observation_vectors` Table

```sql
CREATE TABLE IF NOT EXISTS observation_vectors (
  observation_id INTEGER PRIMARY KEY,
  vector BLOB NOT NULL,
  vocab_version TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
```

Added to `schema.mjs` `initSchema()`. The CASCADE delete ensures vectors are cleaned up when observations are deleted.

Vector format: `Float32Array` of `VOCAB_DIM` (512) floats = 2048 bytes per observation.

## Write Path Integration

### `hook-llm.mjs` — `saveObservation`

After successful INSERT into `observations`, immediately:
```javascript
const vocab = getVocabulary(db);
const text = [obs.title, obs.narrative, obs.concepts?.join?.(' ')].filter(Boolean).join(' ');
const vec = computeVector(text, vocab);
if (vec) {
  db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
    .run(savedId, Buffer.from(vec.buffer), vocab.version, Date.now());
}
```

### `server.mjs` — `mem_save`

Same pattern after the INSERT.

### `mem-cli.mjs` — `cmdSave`

Same pattern after the INSERT.

### Failure handling

Vector write failures are non-critical — catch and log, don't fail the observation save. Missing vectors just mean that observation won't appear in vector search results (FTS5 still finds it).

## Search Path: RRF Hybrid

### Flow in `mem_search`

When a query is present:

1. **FTS5 search** (existing) → returns observations ranked by BM25 composite score → assign `rank_bm25 = 1, 2, 3, ...` by position
2. **Vector search** (new) → `computeVector(query, vocab)` → scan `observation_vectors` with cosine similarity → filter same constraints (project, type, date, not compressed, not superseded) → top-K results → assign `rank_vector = 1, 2, 3, ...`
3. **RRF fusion** → for each observation appearing in either result set:
   ```
   rrf_score = 1/(k + rank_bm25) + 1/(k + rank_vector)
   ```
   where `k = 60` (standard RRF constant). Missing rank = infinity (contributes 0).
4. Sort by `rrf_score` descending, apply existing re-ranking (context, supersession).

### Vector Search Scope

To avoid full-table scan, vector search is scoped:
```sql
SELECT ov.observation_id, ov.vector
FROM observation_vectors ov
JOIN observations o ON ov.observation_id = o.id
WHERE COALESCE(o.compressed_into, 0) = 0
  AND o.superseded_at IS NULL
  AND (? IS NULL OR o.project = ?)
  AND (? IS NULL OR o.type = ?)
  AND ov.vocab_version = ?
ORDER BY o.created_at_epoch DESC
LIMIT 500
```

Limit to 500 most recent matching observations for cosine scan. This keeps search <20ms.

### `vectorSearch` function

```javascript
function vectorSearch(db, queryVec, { project, type, vocabVersion, limit = 500 }) {
  const rows = db.prepare(scopedQuery).all(...params);
  const results = [];
  for (const row of rows) {
    const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    const sim = cosineSimilarity(queryVec, vec);
    if (sim > 0.05) results.push({ id: row.observation_id, similarity: sim });
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 20);
}
```

### RRF Integration

```javascript
function rrfMerge(bm25Results, vectorResults, k = 60) {
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
```

## Vocabulary Rebuild

### Trigger: session-start

In `hook.mjs` session-start handler, after DB open:
```javascript
import { rebuildVocabularyIfNeeded } from './tfidf.mjs';
rebuildVocabularyIfNeeded(db);
```

This checks if vocabulary cache exists and is fresh (by comparing stored version hash vs current term distribution). If stale, rebuilds in <50ms.

### Trigger: mem_maintain

Add `'rebuild_vectors'` to the `operations` enum in `memMaintainSchema`. When executed:
1. Rebuild vocabulary from current observations
2. Recompute all vectors with new vocabulary
3. Delete vectors for deleted/compressed observations

## Performance Budget

| Operation | Target | Notes |
|-----------|--------|-------|
| `buildVocabulary` (1K docs) | <50ms | One-time per session |
| `computeVector` (single doc) | <1ms | On write path |
| `vectorSearch` (500 docs) | <20ms | Cosine scan over BLOBs |
| `rrfMerge` | <1ms | Map operations |
| Total search overhead | <30ms | Added to existing ~10ms FTS5 |

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `tfidf.mjs` | Create | TF-IDF engine: vocabulary, vectorization, cosine similarity, vector search, RRF |
| `schema.mjs` | Modify | Add `observation_vectors` table to `initSchema()` |
| `server.mjs` | Modify | Hybrid search in `mem_search`, vector write in `mem_save` |
| `hook-llm.mjs` | Modify | Vector write after `saveObservation` |
| `mem-cli.mjs` | Modify | Vector write in `cmdSave`, hybrid search in `cmdSearch` |
| `tool-schemas.mjs` | Modify | Add `rebuild_vectors` to `memMaintainSchema` operations |
| `tests/tfidf.test.mjs` | Create | TF-IDF engine unit tests |
| `tests/hybrid-search.test.mjs` | Create | RRF hybrid search integration tests |

## Error Handling

- Vocabulary build failure: log warning, fall back to FTS5-only search
- Vector computation failure: log, skip vector insert (observation still saved)
- Vector search failure: log, return FTS5-only results
- Stale vectors (wrong vocab_version): excluded from vector search, rebuilt on next session start

## Testing

### `tests/tfidf.test.mjs`
- Tokenization: ASCII, CJK, mixed, special chars
- Vocabulary: correct IDF values, dimension capping at VOCAB_DIM
- Vector computation: normalized to unit length, correct dimensions
- Cosine similarity: identical texts = 1.0, orthogonal = 0.0, similar > dissimilar
- Vector serialization: Float32Array → BLOB → Float32Array roundtrip

### `tests/hybrid-search.test.mjs`
- RRF merge: correct score formula, handles missing ranks
- Hybrid search: returns results from both FTS5 and vector sources
- Vector search finds semantically similar documents that FTS5 misses (synonym test)
- Vocabulary rebuild doesn't break existing vectors
- observation_vectors CASCADE delete works

## Non-Goals

- No neural embeddings (future upgrade path — replace `computeVector` internals)
- No approximate nearest neighbor index (brute-force cosine scan is fast enough for <10K observations)
- No cross-project vocabulary (per-session, project-scoped by search query)
- No changes to hook-memory.mjs injection (future enhancement)
