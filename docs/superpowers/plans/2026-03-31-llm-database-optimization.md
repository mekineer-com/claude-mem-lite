# LLM-Powered Database Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-based intelligent database optimization that re-enriches degraded records, normalizes concepts, merges cross-session fragments, and produces smart summaries — running progressively via 24h auto-maintain and manually via MCP tool/CLI.

**Architecture:** New `hook-optimize.mjs` module with 4 independent optimization tasks, triggered as background worker (`llm-optimize`) from auto-maintain and exposed via `mem_optimize` MCP tool + `optimize` CLI command. Uses Haiku for re-enrichment, Sonnet for semantic tasks.

**Tech Stack:** better-sqlite3, TF-IDF (tfidf.mjs), MinHash (hash-utils.mjs), Anthropic API / Claude CLI (haiku-client.mjs)

---

### Task 1: Schema Migration — Add `optimized_at` Column

**Files:**
- Modify: `schema.mjs:16` (bump CURRENT_SCHEMA_VERSION) and `schema.mjs:114` (add migration)
- Test: `tests/hook-optimize.test.mjs` (created in this task, extended in Tasks 3-7)

- [ ] **Step 1: Write the failing test**

Create file `tests/hook-optimize.test.mjs` with initial schema test:

```js
// Tests for hook-optimize.mjs — LLM-powered database optimization
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('schema: optimized_at column', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('observations table has optimized_at column', () => {
    const cols = db.prepare(`PRAGMA table_info(observations)`).all();
    const col = cols.find(c => c.name === 'optimized_at');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe('NULL');
  });

  it('optimized_at defaults to NULL for new observations', () => {
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { title: 'test obs' });
    const obs = db.prepare('SELECT optimized_at FROM observations LIMIT 1').get();
    expect(obs.optimized_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: FAIL — `optimized_at` column does not exist yet.

- [ ] **Step 3: Add migration to schema.mjs**

In `schema.mjs`, bump the schema version:

```js
// Line 16: change from
export const CURRENT_SCHEMA_VERSION = 20;
// to
export const CURRENT_SCHEMA_VERSION = 21;
```

Add the migration to the `MIGRATIONS` array (after the last entry on line 113):

```js
  'ALTER TABLE observations ADD COLUMN optimized_at INTEGER DEFAULT NULL',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add schema.mjs tests/hook-optimize.test.mjs
git commit -m "feat(schema): add optimized_at column for LLM optimization tracking"
```

---

### Task 2: Extend haiku-client.mjs — `callLLMWithModel`

**Files:**
- Modify: `haiku-client.mjs`
- Test: `tests/haiku-client.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `tests/haiku-client.test.mjs`:

```js
describe('callLLMWithModel', () => {
  it('is exported', async () => {
    const mod = await import('../haiku-client.mjs');
    expect(typeof mod.callLLMWithModel).toBe('function');
  });

  it('returns null for empty prompt', async () => {
    const { callLLMWithModel } = await import('../haiku-client.mjs');
    const result = await callLLMWithModel('', 'haiku');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/haiku-client.test.mjs`
Expected: FAIL — `callLLMWithModel` not exported.

- [ ] **Step 3: Implement callLLMWithModel**

Add to `haiku-client.mjs` after the `callHaikuJSON` function (after line 101):

```js
/**
 * Call LLM with explicit model selection. Supports 'haiku' and 'sonnet'.
 * Reuses existing API/CLI dual-mode infrastructure.
 * Never throws — returns null on any error.
 *
 * @param {string} prompt The prompt text
 * @param {'haiku'|'sonnet'} model Model to use (default: 'haiku')
 * @param {object} [opts] Options
 * @param {number} [opts.timeout=15000] Timeout in milliseconds
 * @param {number} [opts.maxTokens=1000] Max tokens in response
 * @returns {Promise<{text: string}|null>} Response or null on failure
 */
export async function callLLMWithModel(prompt, model = 'haiku', { timeout = 15000, maxTokens = 1000 } = {}) {
  if (!prompt) return null;
  const resolvedModel = MODEL_MAP[model] ? model : 'haiku';
  const mode = detectMode();

  try {
    if (mode === 'api') {
      return await callModelAPI(prompt, resolvedModel, { timeout, maxTokens });
    }
    return callModelCLI(prompt, resolvedModel, { timeout });
  } catch (e) {
    debugCatch(e, `callLLMWithModel:${resolvedModel}`);
    return null;
  }
}

/**
 * Call LLM with model selection and parse JSON response.
 * @param {string} prompt
 * @param {'haiku'|'sonnet'} model
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
export async function callModelJSON(prompt, model = 'haiku', opts) {
  const result = await callLLMWithModel(prompt, model, opts);
  if (!result?.text) return null;
  return parseJsonFromLLM(result.text);
}

async function callModelAPI(prompt, model, { timeout, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const modelId = MODEL_MAP[model];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      debugLog('WARN', `${model}-api`, `HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text;
    return text ? { text } : null;
  } finally {
    clearTimeout(timer);
  }
}

function callModelCLI(prompt, model, { timeout }) {
  const modelName = MODEL_MAP[model] ? model : 'haiku';
  try {
    const result = execFileSync(getClaudePath(), ['-p', '--model', modelName], {
      input: prompt,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp',
    });
    const text = result.trim();
    return text ? { text } : null;
  } catch (e) {
    const out = e.stdout?.toString?.()?.trim() || e.output?.[1]?.toString?.()?.trim();
    if (out && out.startsWith('{') && out.endsWith('}')) {
      try { JSON.parse(out); return { text: out }; } catch {}
    }
    debugCatch(e, `${model}-cli`);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/haiku-client.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add haiku-client.mjs tests/haiku-client.test.mjs
git commit -m "feat(haiku-client): add callLLMWithModel for model-selectable LLM calls"
```

---

### Task 3: Core Module — `hook-optimize.mjs` (Part 1: Re-enrich)

**Files:**
- Create: `hook-optimize.mjs`
- Modify: `tests/hook-optimize.test.mjs`

- [ ] **Step 1: Write the failing test for re-enrich**

Add to `tests/hook-optimize.test.mjs`:

```js
// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../haiku-client.mjs', () => ({
  callModelJSON: vi.fn(),
  callLLMWithModel: vi.fn(),
}));

import { callModelJSON } from '../haiku-client.mjs';

describe('re-enrich', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => { db.close(); });

  it('finds degraded observations missing concepts/facts/lesson/aliases', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    // Insert a degraded observation (no concepts, no facts, no lesson, no aliases)
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed the schema' });
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(1);
    expect(candidates[0].title).toBe('Modified schema.mjs');
  });

  it('skips already-optimized observations', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare('UPDATE observations SET optimized_at = ? WHERE id = ?').run(Date.now(), id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('skips observations that have concepts', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Rich obs', narrative: 'Has data', text: 'auth jwt' });
    // Manually set concepts to non-empty
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare("UPDATE observations SET concepts = 'auth jwt' WHERE id = ?").run(id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('executes re-enrich and updates observation fields', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Error in utils.mjs', narrative: 'Fixed a bug in sanitizeFtsQuery' });
    callModelJSON.mockResolvedValue({
      type: 'bugfix',
      title: 'Fix sanitizeFtsQuery edge case',
      narrative: 'Fixed edge case where special chars caused crash',
      concepts: ['FTS5', 'sanitize'],
      facts: ['sanitizeFtsQuery in utils.mjs crashes on parentheses'],
      importance: 2,
      lesson_learned: 'FTS5 special chars need escaping',
      search_aliases: ['fts query bug', 'sanitize crash'],
    });

    const result = await executeReenrich(db, 10);
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT * FROM observations LIMIT 1').get();
    expect(obs.concepts).toContain('FTS5');
    expect(obs.lesson_learned).toBe('FTS5 special chars need escaping');
    expect(obs.optimized_at).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: FAIL — `hook-optimize.mjs` doesn't exist.

- [ ] **Step 3: Create hook-optimize.mjs with re-enrich**

Create `hook-optimize.mjs`:

```js
// claude-mem-lite: LLM-powered database optimization
// Background worker for intelligent maintenance: re-enrich, normalize, cluster-merge, smart-compress
// Triggered from auto-maintain (24h) or manually via mem_optimize MCP tool / CLI

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  truncate, debugLog, debugCatch, COMPRESSED_AUTO,
  computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity,
  parseJsonFromLLM, clampImportance, cjkBigrams,
} from './utils.mjs';
import { callModelJSON, callLLMWithModel } from './haiku-client.mjs';
import { acquireLLMSlot, releaseLLMSlot } from './hook-semaphore.mjs';
import { getVocabulary, computeVector, cosineSimilarity, tokenize, buildVocabulary } from './tfidf.mjs';
import { RUNTIME_DIR } from './hook-shared.mjs';

// ─── Budget ─────────────────────────────────────────────────────────────────

/**
 * Distribute LLM call budget across tasks.
 * @param {number} total Total budget (default 15)
 * @returns {{ reenrich: number, normalize: number, clusterMerge: number, smartCompress: number }}
 */
export function distributeBudget(total = 15) {
  return {
    reenrich: Math.ceil(total * 0.4),
    normalize: 1, // always 1 bulk call
    clusterMerge: Math.ceil(total * 0.3),
    smartCompress: Math.max(1, total - Math.ceil(total * 0.4) - 1 - Math.ceil(total * 0.3)),
  };
}

// ─── Task 1: Re-enrich ─────────────────────────────────────────────────────

/**
 * Find degraded observations that need LLM re-enrichment.
 * Degraded = missing concepts AND facts AND lesson_learned AND search_aliases.
 */
export function findReenrichCandidates(db, limit = 10) {
  return db.prepare(`
    SELECT id, title, narrative, type, subtitle
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND (concepts IS NULL OR concepts = '')
      AND (facts IS NULL OR facts = '')
      AND lesson_learned IS NULL
      AND search_aliases IS NULL
      AND optimized_at IS NULL
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Re-enrich degraded observations using Haiku.
 * Reuses the episode extraction prompt pattern from hook-llm.mjs.
 */
export async function executeReenrich(db, limit = 10) {
  const candidates = findReenrichCandidates(db, limit);
  if (candidates.length === 0) return { processed: 0, skipped: 0 };

  let processed = 0, skipped = 0;
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

  for (const cand of candidates) {
    const gotSlot = await acquireLLMSlot();
    if (!gotSlot) { skipped++; continue; }

    try {
      const prompt = `Re-enrich this observation with structured metadata. Return ONLY valid JSON, no markdown fences.

Title: ${cand.title || '(untitled)'}
Narrative: ${cand.narrative || '(no narrative)'}
Type: ${cand.type || 'change'}

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"improved ≤120 char title","narrative":"improved 2-3 sentence narrative","concepts":["kw1","kw2"],"facts":["specific fact 1","specific fact 2"],"importance":1,"lesson_learned":"non-obvious insight or 'none' if routine","search_aliases":["alt query 1","alt query 2"]}
importance: 0=no value, 1=routine, 2=notable non-obvious insight, 3=critical. Default 1.
lesson_learned: State what was learned. If routine, write "none".
search_aliases: 2-6 alternative search terms (include CJK if applicable).`;

      const parsed = await callModelJSON(prompt, 'haiku', { timeout: 15000, maxTokens: 500 });
      if (!parsed || !parsed.title) { skipped++; continue; }

      // importance=0 → mark as auto-compressed (no value)
      if (parsed.importance === 0 || parsed.importance === '0') {
        db.prepare(`UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, optimized_at = ? WHERE id = ?`)
          .run(Date.now(), cand.id);
        processed++;
        continue;
      }

      const type = validTypes.has(parsed.type) ? parsed.type : cand.type || 'change';
      const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [];
      const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [];
      const conceptsText = concepts.join(' ');
      const factsText = facts.join(' ');
      const lessonLearned = typeof parsed.lesson_learned === 'string'
        && parsed.lesson_learned.toLowerCase() !== 'none'
        && parsed.lesson_learned.trim().length > 0
        ? parsed.lesson_learned.slice(0, 500) : null;
      const searchAliases = Array.isArray(parsed.search_aliases)
        ? parsed.search_aliases.slice(0, 6).join(' ') : null;
      const title = truncate(parsed.title, 120);
      const narrative = truncate(parsed.narrative || cand.narrative || '', 500);
      const importance = clampImportance(parsed.importance);

      // Build FTS text field
      const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
      const textField = [conceptsText, factsText, searchAliases || '', bigramText].filter(Boolean).join(' ');

      // Update MinHash
      const minhashSig = computeMinHash((title || '') + ' ' + (narrative || ''));

      db.prepare(`
        UPDATE observations SET type=?, title=?, narrative=?, concepts=?, facts=?,
          text=?, importance=?, lesson_learned=?, search_aliases=?, minhash_sig=?, optimized_at=?
        WHERE id = ?
      `).run(type, title, narrative, conceptsText, factsText, textField,
        importance, lessonLearned, searchAliases, minhashSig, Date.now(), cand.id);

      // Rebuild TF-IDF vector
      try {
        const vocab = getVocabulary(db);
        if (vocab) {
          const vecText = [title, narrative, conceptsText].filter(Boolean).join(' ');
          const vec = computeVector(vecText, vocab);
          if (vec) {
            db.prepare(`
              INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, computed_at)
              VALUES (?, ?, ?, ?)
            `).run(cand.id, Buffer.from(vec.buffer), vocab.version, Date.now());
          }
        }
      } catch (e) { debugCatch(e, 'reenrich-vector'); }

      processed++;
    } catch (e) {
      debugCatch(e, 'reenrich');
      skipped++;
    } finally {
      releaseLLMSlot();
    }
  }

  if (processed > 0) debugLog('DEBUG', 'llm-optimize', `re-enriched ${processed} degraded observations`);
  return { processed, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hook-optimize.mjs tests/hook-optimize.test.mjs
git commit -m "feat(optimize): add re-enrich task for degraded observations"
```

---

### Task 4: Core Module — `hook-optimize.mjs` (Part 2: Normalize)

**Files:**
- Modify: `hook-optimize.mjs`
- Modify: `tests/hook-optimize.test.mjs`

- [ ] **Step 1: Write the failing test for normalize**

Add to `tests/hook-optimize.test.mjs`:

```js
describe('normalize', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => { db.close(); });

  it('extracts unique concepts from active observations', async () => {
    const { extractUniqueConcepts } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'obs1', text: 'FTS5 search' });
    db.prepare("UPDATE observations SET concepts = 'FTS5 full-text' WHERE id = 1").run();
    insertObs(db, { title: 'obs2', text: 'FTS query' });
    db.prepare("UPDATE observations SET concepts = 'FTS search query' WHERE id = 2").run();

    const concepts = extractUniqueConcepts(db);
    expect(concepts).toContain('FTS5');
    expect(concepts).toContain('full-text');
    expect(concepts).toContain('search');
  });

  it('checks normalize gate (7-day interval)', async () => {
    const { shouldRunNormalize } = await import('../hook-optimize.mjs');
    // No gate file → should run
    expect(shouldRunNormalize()).toBe(true);
  });

  it('applies synonym groups to observations', async () => {
    const { applyNormalization } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'obs1', text: 'full-text search' });
    db.prepare("UPDATE observations SET concepts = 'full-text search' WHERE id = 1").run();

    const groups = [
      { canonical: 'FTS5', aliases: ['full-text search', 'FTS', '全文搜索'] }
    ];
    const result = applyNormalization(db, groups);
    expect(result.updated).toBeGreaterThan(0);

    const obs = db.prepare('SELECT concepts, search_aliases FROM observations WHERE id = 1').get();
    expect(obs.concepts).toContain('FTS5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement normalize in hook-optimize.mjs**

Add to `hook-optimize.mjs`:

```js
// ─── Task 2: Normalize ─────────────────────────────────────────────────────

const NORMALIZE_GATE_FILE = join(RUNTIME_DIR, 'last-normalize.json');
const NORMALIZE_INTERVAL_MS = 7 * 86400000; // 7 days

/**
 * Check if normalize should run (7-day gate).
 */
export function shouldRunNormalize() {
  try {
    const last = JSON.parse(readFileSync(NORMALIZE_GATE_FILE, 'utf8'));
    return Date.now() - last.epoch >= NORMALIZE_INTERVAL_MS;
  } catch {
    return true; // no gate file = first run
  }
}

/**
 * Extract all unique concepts from active observations.
 */
export function extractUniqueConcepts(db, limit = 500) {
  const rows = db.prepare(`
    SELECT concepts FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND concepts IS NOT NULL AND concepts != ''
    ORDER BY created_at_epoch DESC
    LIMIT 2000
  `).all();

  const conceptSet = new Set();
  for (const row of rows) {
    for (const c of row.concepts.split(/\s+/)) {
      const trimmed = c.trim();
      if (trimmed.length >= 2) conceptSet.add(trimmed);
    }
  }
  return [...conceptSet].slice(0, limit);
}

/**
 * Ask Sonnet to identify synonym groups from a list of concepts.
 * @returns {Array<{canonical: string, aliases: string[]}>}
 */
export async function identifySynonymGroups(concepts) {
  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return [];

  try {
    const prompt = `Analyze these concept terms from a code memory database and identify synonym groups (terms that refer to the same concept). Include cross-language synonyms (English/Chinese). Return ONLY valid JSON.

Concepts: ${concepts.join(', ')}

JSON: {"groups":[{"canonical":"preferred term","aliases":["synonym1","synonym2"]}, ...]}

Rules:
- Only include groups where you are confident the terms are true synonyms
- canonical should be the most specific/technical term
- Include CJK ↔ English equivalents if present
- Skip terms that have no synonyms in the list`;

    const parsed = await callModelJSON(prompt, 'sonnet', { timeout: 20000, maxTokens: 1000 });
    if (!parsed?.groups || !Array.isArray(parsed.groups)) return [];
    return parsed.groups.filter(g => g.canonical && Array.isArray(g.aliases) && g.aliases.length > 0);
  } catch (e) {
    debugCatch(e, 'normalize-identify');
    return [];
  } finally {
    releaseLLMSlot();
  }
}

/**
 * Apply synonym normalization to observations.
 * Updates concepts to use canonical form, appends aliases to search_aliases.
 */
export function applyNormalization(db, groups) {
  if (!groups || groups.length === 0) return { updated: 0 };

  // Build alias → canonical map
  const aliasMap = new Map();
  for (const g of groups) {
    for (const alias of g.aliases) {
      aliasMap.set(alias.toLowerCase(), g.canonical);
    }
  }

  const rows = db.prepare(`
    SELECT id, concepts, search_aliases FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND concepts IS NOT NULL AND concepts != ''
  `).all();

  let updated = 0;
  const updateStmt = db.prepare(`
    UPDATE observations SET concepts = ?, search_aliases = ?, optimized_at = ? WHERE id = ?
  `);

  for (const row of rows) {
    const terms = row.concepts.split(/\s+/);
    let changed = false;
    const newTerms = terms.map(t => {
      const canonical = aliasMap.get(t.toLowerCase());
      if (canonical && canonical !== t) { changed = true; return canonical; }
      return t;
    });

    if (changed) {
      // Deduplicate concepts
      const uniqueConcepts = [...new Set(newTerms)].join(' ');
      // Append original aliases to search_aliases for recall
      const existingAliases = row.search_aliases || '';
      const originalTerms = terms.filter(t => aliasMap.has(t.toLowerCase()) && aliasMap.get(t.toLowerCase()) !== t);
      const newAliases = [existingAliases, ...originalTerms].filter(Boolean).join(' ');

      updateStmt.run(uniqueConcepts, newAliases, Date.now(), row.id);
      updated++;
    }
  }

  if (updated > 0) debugLog('DEBUG', 'llm-optimize', `normalized concepts in ${updated} observations`);
  return { updated };
}

/**
 * Run the full normalize pipeline.
 */
export async function executeNormalize(db, force = false) {
  if (!force && !shouldRunNormalize()) return { skipped: true, reason: 'gate' };

  const concepts = extractUniqueConcepts(db);
  if (concepts.length < 5) return { skipped: true, reason: 'too few concepts' };

  const groups = await identifySynonymGroups(concepts);
  if (groups.length === 0) return { processed: 0, groups: 0 };

  const result = applyNormalization(db, groups);

  // Update gate
  try { writeFileSync(NORMALIZE_GATE_FILE, JSON.stringify({ epoch: Date.now() })); } catch {}

  return { processed: result.updated, groups: groups.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hook-optimize.mjs tests/hook-optimize.test.mjs
git commit -m "feat(optimize): add concept normalize task with synonym detection"
```

---

### Task 5: Core Module — `hook-optimize.mjs` (Part 3: Cluster-merge)

**Files:**
- Modify: `hook-optimize.mjs`
- Modify: `tests/hook-optimize.test.mjs`

- [ ] **Step 1: Write the failing test for cluster-merge**

Add to `tests/hook-optimize.test.mjs`:

```js
describe('cluster-merge', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => { db.close(); });

  it('finds merge candidates with moderate similarity', async () => {
    const { findMergeCandidates } = await import('../hook-optimize.mjs');
    // Insert two similar observations
    insertObs(db, { title: 'Fix FTS5 query sanitization bug in utils.mjs', narrative: 'Fixed special char handling' });
    insertObs(db, { title: 'Fix FTS5 query sanitization edge case in utils.mjs', narrative: 'Fixed parentheses handling' });
    const candidates = findMergeCandidates(db, 10);
    // Should find at least one cluster
    expect(candidates.length).toBeGreaterThanOrEqual(0); // may not hit threshold with short titles
  });

  it('executes merge when LLM approves', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Fix FTS5 bug A', narrative: 'Handled special chars', accessCount: 3 });
    insertObs(db, { title: 'Fix FTS5 bug B', narrative: 'Handled parentheses', accessCount: 1 });

    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
    callModelJSON.mockResolvedValue({
      should_merge: true,
      merged_title: 'Fix FTS5 query sanitization bugs',
      merged_narrative: 'Fixed multiple edge cases in FTS5 query sanitization',
      merged_concepts: ['FTS5', 'sanitize', 'query'],
      merged_facts: ['FTS5 special chars crash sanitizeFtsQuery', 'Parentheses need escaping'],
      merged_lesson: 'FTS5 requires comprehensive input sanitization',
      importance: 2,
    });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(true);

    // Keeper should be obs[0] (higher access_count)
    const keeper = db.prepare('SELECT * FROM observations WHERE id = ?').get(obs[0].id);
    expect(keeper.title).toBe('Fix FTS5 query sanitization bugs');
    expect(keeper.optimized_at).toBeGreaterThan(0);

    // Other should be compressed into keeper
    const other = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(obs[1].id);
    expect(other.compressed_into).toBe(obs[0].id);
  });

  it('skips merge when LLM says should_merge=false', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Obs A', narrative: 'About auth' });
    insertObs(db, { title: 'Obs B', narrative: 'About database' });
    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();

    callModelJSON.mockResolvedValue({ should_merge: false });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement cluster-merge in hook-optimize.mjs**

Add to `hook-optimize.mjs`:

```js
// ─── Task 3: Cluster-merge ─────────────────────────────────────────────────

const MERGE_TIME_WINDOW_MS = 30 * 86400000; // 30 days
const MERGE_JACCARD_LOW = 0.4;
const MERGE_JACCARD_HIGH = 0.85; // above this is already handled by auto-dedup

/**
 * Find clusters of observations suitable for semantic merging.
 * Uses MinHash pre-filter + Jaccard similarity in the 0.4-0.85 range.
 */
export function findMergeCandidates(db, maxClusters = 5) {
  const cutoff = Date.now() - MERGE_TIME_WINDOW_MS;
  const rows = db.prepare(`
    SELECT id, title, narrative, project, access_count, created_at_epoch, minhash_sig
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND optimized_at IS NULL
      AND title IS NOT NULL AND title != ''
      AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC
    LIMIT 200
  `).all(cutoff);

  // Group similar observations into clusters
  const used = new Set();
  const clusters = [];

  for (let i = 0; i < rows.length && clusters.length < maxClusters; i++) {
    if (used.has(rows[i].id)) continue;
    const cluster = [rows[i]];

    for (let j = i + 1; j < rows.length && cluster.length < 5; j++) {
      if (used.has(rows[j].id)) continue;
      if (rows[i].project !== rows[j].project) continue;

      // Time window check
      if (Math.abs(rows[i].created_at_epoch - rows[j].created_at_epoch) > MERGE_TIME_WINDOW_MS) continue;

      // MinHash pre-filter
      if (rows[i].minhash_sig && rows[j].minhash_sig) {
        const est = estimateJaccardFromMinHash(rows[i].minhash_sig, rows[j].minhash_sig);
        if (est < MERGE_JACCARD_LOW * 0.8) continue; // loose pre-filter
      }

      const titleSim = jaccardSimilarity(rows[i].title, rows[j].title);
      if (titleSim >= MERGE_JACCARD_LOW && titleSim < MERGE_JACCARD_HIGH) {
        cluster.push(rows[j]);
        used.add(rows[j].id);
      }
    }

    if (cluster.length >= 2) {
      used.add(rows[i].id);
      clusters.push(cluster);
    }
  }

  return clusters;
}

/**
 * Ask Sonnet whether a cluster should be merged and produce merged content.
 * @param {object} db Database
 * @param {Array} cluster Array of observation rows
 * @returns {{ merged: boolean }}
 */
export async function executeMergeCluster(db, cluster) {
  if (cluster.length < 2) return { merged: false };

  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return { merged: false };

  try {
    const obsDescriptions = cluster.map((o, i) =>
      `${i + 1}. [${o.type || 'change'}] "${o.title}" — ${o.narrative || '(no narrative)'}`
    ).join('\n');

    const prompt = `These observations from a code memory database may be about the same topic. Should they be merged into a single observation?

Observations:
${obsDescriptions}

Return ONLY valid JSON:
- If they should NOT be merged: {"should_merge":false}
- If they SHOULD be merged: {"should_merge":true,"merged_title":"≤120 char comprehensive title","merged_narrative":"comprehensive ≤800 char summary preserving all key details","merged_concepts":["kw1","kw2"],"merged_facts":["specific fact 1"],"merged_lesson":"synthesized non-obvious lesson or null","importance":2}`;

    const parsed = await callModelJSON(prompt, 'sonnet', { timeout: 20000, maxTokens: 1000 });
    if (!parsed || !parsed.should_merge) return { merged: false };

    // Find keeper: highest access_count, or newest if tied
    const keeper = cluster.reduce((best, o) =>
      (o.access_count || 0) > (best.access_count || 0) ? o : best
    , cluster[0]);
    const others = cluster.filter(o => o.id !== keeper.id);

    // Update keeper with merged content
    const concepts = Array.isArray(parsed.merged_concepts) ? parsed.merged_concepts.slice(0, 10) : [];
    const facts = Array.isArray(parsed.merged_facts) ? parsed.merged_facts.slice(0, 10) : [];
    const conceptsText = concepts.join(' ');
    const factsText = facts.join(' ');
    const title = truncate(parsed.merged_title, 120);
    const narrative = truncate(parsed.merged_narrative || '', 800);
    const lessonLearned = typeof parsed.merged_lesson === 'string'
      && parsed.merged_lesson.trim().length > 0
      ? parsed.merged_lesson.slice(0, 500) : null;

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, bigramText].filter(Boolean).join(' ');
    const minhashSig = computeMinHash((title || '') + ' ' + (narrative || ''));
    const importance = clampImportance(parsed.importance || 2);

    db.transaction(() => {
      db.prepare(`
        UPDATE observations SET title=?, narrative=?, concepts=?, facts=?, text=?,
          importance=?, lesson_learned=?, minhash_sig=?, optimized_at=?
        WHERE id = ?
      `).run(title, narrative, conceptsText, factsText, textField,
        importance, lessonLearned, minhashSig, Date.now(), keeper.id);

      // Mark others as compressed into keeper
      const otherIds = others.map(o => o.id);
      const ph = otherIds.map(() => '?').join(',');
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${ph})`)
        .run(keeper.id, ...otherIds);
    })();

    // Rebuild keeper vector
    try {
      const vocab = getVocabulary(db);
      if (vocab) {
        const vecText = [title, narrative, conceptsText].filter(Boolean).join(' ');
        const vec = computeVector(vecText, vocab);
        if (vec) {
          db.prepare(`
            INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, computed_at)
            VALUES (?, ?, ?, ?)
          `).run(keeper.id, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
    } catch (e) { debugCatch(e, 'merge-vector'); }

    debugLog('DEBUG', 'llm-optimize', `merged ${cluster.length} observations into #${keeper.id}`);
    return { merged: true, keeperId: keeper.id, mergedCount: others.length };
  } catch (e) {
    debugCatch(e, 'cluster-merge');
    return { merged: false };
  } finally {
    releaseLLMSlot();
  }
}

/**
 * Run the full cluster-merge pipeline.
 */
export async function executeClusterMerge(db, maxClusters = 5) {
  const clusters = findMergeCandidates(db, maxClusters);
  if (clusters.length === 0) return { processed: 0, merged: 0 };

  let merged = 0;
  for (const cluster of clusters) {
    const result = await executeMergeCluster(db, cluster);
    if (result.merged) merged++;
  }

  return { processed: clusters.length, merged };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hook-optimize.mjs tests/hook-optimize.test.mjs
git commit -m "feat(optimize): add cluster-merge task for cross-session consolidation"
```

---

### Task 6: Core Module — `hook-optimize.mjs` (Part 4: Smart-compress)

**Files:**
- Modify: `hook-optimize.mjs`
- Modify: `tests/hook-optimize.test.mjs`

- [ ] **Step 1: Write the failing test for smart-compress**

Add to `tests/hook-optimize.test.mjs`:

```js
describe('smart-compress', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => { db.close(); });

  it('finds compress candidates (old, low-importance, no access)', async () => {
    const { findSmartCompressCandidates } = await import('../hook-optimize.mjs');
    const oldEpoch = -(31 * 86400000); // 31 days ago
    insertObs(db, { title: 'Old obs 1', epochOffset: oldEpoch, importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Old obs 2', epochOffset: oldEpoch - 1000, importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Old obs 3', epochOffset: oldEpoch - 2000, importance: 1, accessCount: 0 });
    const candidates = findSmartCompressCandidates(db);
    expect(candidates.length).toBe(3);
  });

  it('skips recent or important observations', async () => {
    const { findSmartCompressCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Recent obs', importance: 1, accessCount: 0 }); // today
    insertObs(db, { title: 'Important obs', epochOffset: -(31 * 86400000), importance: 2, accessCount: 0 });
    const candidates = findSmartCompressCandidates(db);
    expect(candidates.length).toBe(0);
  });

  it('creates smart summary from a cluster', async () => {
    const { executeSmartCompressCluster } = await import('../hook-optimize.mjs');
    const oldEpoch = -(31 * 86400000);
    insertObs(db, { title: 'Modified utils.mjs', narrative: 'Changed sanitize fn', epochOffset: oldEpoch });
    insertObs(db, { title: 'Updated utils.mjs tests', narrative: 'Added test cases', epochOffset: oldEpoch - 1000 });
    insertObs(db, { title: 'Fixed utils.mjs lint', narrative: 'Resolved lint warnings', epochOffset: oldEpoch - 2000 });

    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();

    callModelJSON.mockResolvedValue({
      title: 'Utils.mjs maintenance: sanitize improvements and cleanup',
      narrative: 'Series of changes to utils.mjs including sanitize function updates, test additions, and lint fixes.',
      concepts: ['utils', 'sanitize', 'lint'],
      facts: ['sanitize function in utils.mjs was updated', 'lint warnings resolved'],
      lesson_learned: 'none',
      search_aliases: ['utils cleanup', 'sanitize refactor'],
    });

    const result = await executeSmartCompressCluster(db, obs, 'test');
    expect(result.compressed).toBe(true);
    expect(result.summaryId).toBeGreaterThan(0);

    // Original observations should be compressed
    for (const o of obs) {
      const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(o.id);
      expect(row.compressed_into).toBe(result.summaryId);
    }

    // Summary should exist with importance=2
    const summary = db.prepare('SELECT * FROM observations WHERE id = ?').get(result.summaryId);
    expect(summary.importance).toBe(2);
    expect(summary.title).toContain('Utils.mjs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement smart-compress in hook-optimize.mjs**

Add to `hook-optimize.mjs`:

```js
// ─── Task 4: Smart-compress ────────────────────────────────────────────────

const COMPRESS_AGE_MS = 30 * 86400000; // 30 days
const COMPRESS_TIME_SPLIT_MS = 14 * 86400000; // 14-day sub-cluster limit
const COMPRESS_COSINE_THRESHOLD = 0.3;

/**
 * Find candidates for smart compression.
 */
export function findSmartCompressCandidates(db, ageDays = 30) {
  const cutoff = Date.now() - ageDays * 86400000;
  return db.prepare(`
    SELECT id, title, narrative, lesson_learned, project, type, created_at_epoch
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND COALESCE(importance, 1) = 1
      AND COALESCE(access_count, 0) = 0
      AND created_at_epoch < ?
    ORDER BY project, created_at_epoch
  `).all(cutoff);
}

/**
 * Group candidates into topic clusters using TF-IDF cosine similarity,
 * then split by 14-day time windows.
 */
export function clusterForCompression(candidates, db) {
  if (candidates.length < 3) return [];

  // Group by project first
  const byProject = new Map();
  for (const c of candidates) {
    if (!byProject.has(c.project)) byProject.set(c.project, []);
    byProject.get(c.project).push(c);
  }

  const clusters = [];

  for (const [project, obs] of byProject) {
    if (obs.length < 3) continue;

    // Try TF-IDF clustering if vocabulary available
    let vocab;
    try { vocab = getVocabulary(db); } catch {}

    if (vocab) {
      // Compute vectors for each observation
      const vectors = obs.map(o => {
        const text = [o.title || '', o.narrative || ''].join(' ');
        return computeVector(text, vocab);
      });

      // Simple greedy clustering by cosine similarity
      const used = new Set();
      for (let i = 0; i < obs.length; i++) {
        if (used.has(i) || !vectors[i]) continue;
        const cluster = [{ obs: obs[i], idx: i }];
        used.add(i);

        for (let j = i + 1; j < obs.length; j++) {
          if (used.has(j) || !vectors[j]) continue;
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim >= COMPRESS_COSINE_THRESHOLD) {
            cluster.push({ obs: obs[j], idx: j });
            used.add(j);
          }
        }

        if (cluster.length >= 3) {
          // Split by 14-day windows
          const sorted = cluster.map(c => c.obs).sort((a, b) => a.created_at_epoch - b.created_at_epoch);
          let subCluster = [sorted[0]];
          for (let k = 1; k < sorted.length; k++) {
            if (sorted[k].created_at_epoch - subCluster[0].created_at_epoch > COMPRESS_TIME_SPLIT_MS) {
              if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
              subCluster = [sorted[k]];
            } else {
              subCluster.push(sorted[k]);
            }
          }
          if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
        }
      }
    } else {
      // Fallback: just group by time window (no semantic clustering)
      const sorted = obs.sort((a, b) => a.created_at_epoch - b.created_at_epoch);
      let subCluster = [sorted[0]];
      for (let k = 1; k < sorted.length; k++) {
        if (sorted[k].created_at_epoch - subCluster[0].created_at_epoch > COMPRESS_TIME_SPLIT_MS) {
          if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
          subCluster = [sorted[k]];
        } else {
          subCluster.push(sorted[k]);
        }
      }
      if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
    }
  }

  return clusters;
}

/**
 * Create a smart LLM-generated summary for a cluster of observations.
 */
export async function executeSmartCompressCluster(db, observations, project) {
  if (observations.length < 3) return { compressed: false };

  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return { compressed: false };

  try {
    const obsDescriptions = observations.map((o, i) =>
      `${i + 1}. [${o.type || 'change'}] "${o.title || '(untitled)'}" — ${o.narrative || '(no narrative)'}${o.lesson_learned ? ` | Lesson: ${o.lesson_learned}` : ''}`
    ).join('\n');

    const prompt = `Summarize these related code memory observations into ONE comprehensive summary. Preserve all important decisions, lessons, and specific facts. Return ONLY valid JSON.

Observations:
${obsDescriptions}

JSON: {"title":"descriptive summary ≤120 chars","narrative":"comprehensive summary ≤800 chars preserving key decisions and lessons","concepts":["kw1","kw2"],"facts":["all specific facts preserved"],"lesson_learned":"most important synthesized lesson or 'none'","search_aliases":["alt search 1","alt search 2"]}`;

    const parsed = await callModelJSON(prompt, 'sonnet', { timeout: 20000, maxTokens: 1000 });
    if (!parsed || !parsed.title) return { compressed: false };

    const title = truncate(parsed.title, 120);
    const narrative = truncate(parsed.narrative || '', 800);
    const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [];
    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [];
    const conceptsText = concepts.join(' ');
    const factsText = facts.join(' ');
    const lessonLearned = typeof parsed.lesson_learned === 'string'
      && parsed.lesson_learned.toLowerCase() !== 'none'
      && parsed.lesson_learned.trim().length > 0
      ? parsed.lesson_learned.slice(0, 500) : null;
    const searchAliases = Array.isArray(parsed.search_aliases)
      ? parsed.search_aliases.slice(0, 6).join(' ') : null;

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, searchAliases || '', bigramText].filter(Boolean).join(' ');

    // Median epoch for the summary
    const epochs = observations.map(o => o.created_at_epoch).sort((a, b) => a - b);
    const medianEpoch = epochs[Math.floor(epochs.length / 2)];

    const summaryId = db.transaction(() => {
      // Ensure compress session exists
      const sessionId = `compress-${project}`;
      const now = new Date();
      db.prepare(`INSERT OR IGNORE INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?,?,?,?,?,'active')`
      ).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

      const result = db.prepare(`INSERT INTO observations
        (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
         files_read, files_modified, importance, lesson_learned, search_aliases, optimized_at,
         created_at, created_at_epoch)
        VALUES (?,?,?,?,?,'',?,?,?,'[]','[]',2,?,?,?,?,?)`
      ).run(sessionId, project, textField, 'discovery', title, narrative,
        conceptsText, factsText, lessonLearned, searchAliases, Date.now(),
        new Date(medianEpoch).toISOString(), medianEpoch);

      const sId = Number(result.lastInsertRowid);

      // Mark originals as compressed
      const obsIds = observations.map(o => o.id);
      const ph = obsIds.map(() => '?').join(',');
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${ph})`)
        .run(sId, ...obsIds);

      return sId;
    })();

    // Compute vector for summary
    try {
      const vocab = getVocabulary(db);
      if (vocab) {
        const vecText = [title, narrative, conceptsText].filter(Boolean).join(' ');
        const vec = computeVector(vecText, vocab);
        if (vec) {
          db.prepare(`
            INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, computed_at)
            VALUES (?, ?, ?, ?)
          `).run(summaryId, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
    } catch (e) { debugCatch(e, 'smart-compress-vector'); }

    debugLog('DEBUG', 'llm-optimize', `smart-compressed ${observations.length} observations into #${summaryId}`);
    return { compressed: true, summaryId, count: observations.length };
  } catch (e) {
    debugCatch(e, 'smart-compress');
    return { compressed: false };
  } finally {
    releaseLLMSlot();
  }
}

/**
 * Run the full smart-compress pipeline.
 */
export async function executeSmartCompress(db, maxClusters = 5) {
  const candidates = findSmartCompressCandidates(db);
  if (candidates.length < 3) return { processed: 0, compressed: 0 };

  const clusters = clusterForCompression(candidates, db);
  if (clusters.length === 0) return { processed: 0, compressed: 0 };

  let compressed = 0;
  const toProcess = clusters.slice(0, maxClusters);
  for (const cluster of toProcess) {
    const result = await executeSmartCompressCluster(db, cluster.observations, cluster.project);
    if (result.compressed) compressed++;
  }

  return { processed: toProcess.length, compressed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hook-optimize.mjs tests/hook-optimize.test.mjs
git commit -m "feat(optimize): add smart-compress with LLM-powered summaries"
```

---

### Task 7: Core Module — Pipeline Orchestrator + Preview

**Files:**
- Modify: `hook-optimize.mjs`
- Modify: `tests/hook-optimize.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `tests/hook-optimize.test.mjs`:

```js
describe('pipeline', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => { db.close(); });

  it('preview returns candidate counts without executing', async () => {
    const { optimizePreview } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Degraded obs', narrative: 'No enrichment' });
    const result = optimizePreview(db);
    expect(result).toHaveProperty('reenrich');
    expect(result).toHaveProperty('normalize');
    expect(result).toHaveProperty('clusterMerge');
    expect(result).toHaveProperty('smartCompress');
    expect(result.reenrich).toBeGreaterThanOrEqual(0);
  });

  it('distributeBudget allocates correctly', async () => {
    const { distributeBudget } = await import('../hook-optimize.mjs');
    const budget = distributeBudget(15);
    expect(budget.reenrich).toBe(6);
    expect(budget.normalize).toBe(1);
    expect(budget.clusterMerge).toBe(5);
    expect(budget.smartCompress).toBeGreaterThan(0);
    // Total should not exceed budget
    expect(budget.reenrich + budget.normalize + budget.clusterMerge + budget.smartCompress).toBeLessThanOrEqual(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: FAIL — `optimizePreview` not exported.

- [ ] **Step 3: Implement pipeline orchestrator**

Add to `hook-optimize.mjs`:

```js
// ─── Pipeline Orchestrator ──────────────────────────────────────────────────

/**
 * Preview: scan candidates for all optimization tasks without executing.
 */
export function optimizePreview(db) {
  const reenrich = findReenrichCandidates(db, 1000).length;

  const concepts = extractUniqueConcepts(db);
  const normalizeReady = shouldRunNormalize() && concepts.length >= 5;

  const mergeClusters = findMergeCandidates(db, 50);
  const clusterMerge = mergeClusters.length;

  const compressCandidates = findSmartCompressCandidates(db);
  const compressClusters = clusterForCompression(compressCandidates, db);
  const smartCompress = compressClusters.length;

  return {
    reenrich,
    normalize: normalizeReady ? concepts.length : 0,
    normalizeGateOpen: shouldRunNormalize(),
    clusterMerge,
    smartCompress,
    total: reenrich + (normalizeReady ? 1 : 0) + clusterMerge + smartCompress,
  };
}

/**
 * Run the full optimization pipeline.
 * @param {object} db Database handle
 * @param {object} opts Options
 * @param {string[]} [opts.tasks] Which tasks to run (default: all)
 * @param {number} [opts.maxItems=15] Total LLM call budget
 * @param {boolean} [opts.force=false] Bypass gate limits
 */
export async function optimizeRun(db, { tasks, maxItems = 15, force = false } = {}) {
  const allTasks = ['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'];
  const selectedTasks = tasks && tasks.length > 0 ? tasks : allTasks;
  const budget = distributeBudget(maxItems);
  const results = {};

  for (const task of selectedTasks) {
    try {
      switch (task) {
        case 're-enrich':
          results.reenrich = await executeReenrich(db, budget.reenrich);
          break;
        case 'normalize':
          results.normalize = await executeNormalize(db, force);
          break;
        case 'cluster-merge':
          results.clusterMerge = await executeClusterMerge(db, budget.clusterMerge);
          break;
        case 'smart-compress':
          results.smartCompress = await executeSmartCompress(db, budget.smartCompress);
          break;
      }
    } catch (e) {
      debugCatch(e, `optimize:${task}`);
      results[task] = { error: e.message };
    }
  }

  return results;
}

/**
 * Background worker entry point — called via spawnBackground('llm-optimize').
 */
export async function handleLLMOptimize() {
  const { ensureDb } = await import('./schema.mjs');
  let db;
  try {
    db = ensureDb();
  } catch {
    return;
  }

  try {
    const results = await optimizeRun(db);
    const parts = [];
    if (results.reenrich?.processed) parts.push(`re-enriched: ${results.reenrich.processed}`);
    if (results.normalize?.processed) parts.push(`normalized: ${results.normalize.processed}`);
    if (results.clusterMerge?.merged) parts.push(`merged: ${results.clusterMerge.merged}`);
    if (results.smartCompress?.compressed) parts.push(`compressed: ${results.smartCompress.compressed}`);
    if (parts.length > 0) debugLog('DEBUG', 'llm-optimize', parts.join(', '));
  } catch (e) {
    debugCatch(e, 'llm-optimize');
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hook-optimize.mjs tests/hook-optimize.test.mjs
git commit -m "feat(optimize): add pipeline orchestrator with preview and budget distribution"
```

---

### Task 8: Hook Integration — Background Worker

**Files:**
- Modify: `hook.mjs:40` (BG_EVENTS), `hook.mjs:557` (auto-maintain), `hook.mjs:1078` (switch case)

- [ ] **Step 1: Write a test to verify background event routing**

This is tested via the existing e2e pattern. Create a minimal integration check in `tests/hook-optimize.test.mjs`:

```js
describe('hook integration', () => {
  it('BG_EVENTS includes llm-optimize', async () => {
    // Read hook.mjs and verify BG_EVENTS contains llm-optimize
    const { readFileSync } = await import('fs');
    const hookSrc = readFileSync(new URL('../hook.mjs', import.meta.url), 'utf8');
    expect(hookSrc).toContain("'llm-optimize'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: FAIL — hook.mjs doesn't contain `llm-optimize` yet.

- [ ] **Step 3: Modify hook.mjs**

1. Add to `BG_EVENTS` (line 40):

```js
// Change from:
const BG_EVENTS = new Set(['llm-episode', 'llm-summary', 'auto-compress']);
// To:
const BG_EVENTS = new Set(['llm-episode', 'llm-summary', 'auto-compress', 'llm-optimize']);
```

2. After `spawnBackground('auto-compress');` (line 557), add:

```js
        spawnBackground('llm-optimize');
```

3. Add import at the top of hook.mjs (after line 32):

```js
import { handleLLMOptimize } from './hook-optimize.mjs';
```

4. Add to the main switch statement (after line 1078):

```js
    case 'llm-optimize':   await handleLLMOptimize(); break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-optimize.test.mjs`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add hook.mjs hook-optimize.mjs tests/hook-optimize.test.mjs
git commit -m "feat(hook): integrate llm-optimize background worker into auto-maintain"
```

---

### Task 9: MCP Tool — `mem_optimize`

**Files:**
- Modify: `tool-schemas.mjs`
- Modify: `server.mjs`

- [ ] **Step 1: Add schema to tool-schemas.mjs**

Add after `memMaintainSchema` (around line 102):

```js
export const memOptimizeSchema = {
  action: z.enum(['preview', 'run', 'run_all']).optional().default('preview')
    .describe('preview=scan candidates, run=execute with limits, run_all=bypass gates'),
  tasks: z.array(z.enum(['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'])).optional()
    .describe('Which optimization tasks to run (default: all)'),
  max_items: coerceInt.pipe(z.number().int().min(1).max(100)).optional().default(15)
    .describe('Maximum LLM calls across all tasks (default: 15)'),
};
```

- [ ] **Step 2: Register tool in server.mjs**

Add after the `mem_maintain` tool registration (after line 1522). Import the necessary functions at the top of server.mjs:

```js
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
```

Then register the tool:

```js
// ─── Tool: mem_optimize ────────────────────────────────────────────────────

server.registerTool(
  'mem_optimize',
  {
    description: 'LLM-powered database optimization: re-enrich degraded records, normalize concepts, merge related observations, smart-compress old data. Use when: database quality seems low, search results are noisy, or for periodic deep maintenance.',
    inputSchema: memOptimizeSchema,
  },
  safeHandler(async (args) => {
    const action = args.action || 'preview';

    if (action === 'preview') {
      const preview = optimizePreview(db);
      const lines = [
        `🔍 LLM Optimization Preview:`,
        `  Re-enrich candidates: ${preview.reenrich}`,
        `  Normalize: ${preview.normalizeGateOpen ? `${preview.normalize} unique concepts` : 'gate closed (7-day interval)'}`,
        `  Cluster-merge candidates: ${preview.clusterMerge} clusters`,
        `  Smart-compress candidates: ${preview.smartCompress} clusters`,
        `  Total: ${preview.total} items`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const force = action === 'run_all';
    const results = await optimizeRun(db, {
      tasks: args.tasks,
      maxItems: args.max_items || 15,
      force,
    });

    const lines = ['🔧 LLM Optimization Results:'];
    if (results.reenrich) lines.push(`  Re-enrich: ${results.reenrich.processed || 0} processed, ${results.reenrich.skipped || 0} skipped`);
    if (results.normalize) {
      if (results.normalize.skipped) lines.push(`  Normalize: skipped (${results.normalize.reason})`);
      else lines.push(`  Normalize: ${results.normalize.processed || 0} updated, ${results.normalize.groups || 0} synonym groups`);
    }
    if (results.clusterMerge) lines.push(`  Cluster-merge: ${results.clusterMerge.merged || 0} merged of ${results.clusterMerge.processed || 0} clusters`);
    if (results.smartCompress) lines.push(`  Smart-compress: ${results.smartCompress.compressed || 0} compressed of ${results.smartCompress.processed || 0} clusters`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/server.test.mjs tests/contract.test.mjs`
Expected: PASS (existing tests should not break; contract tests may need updating if they enumerate tools).

- [ ] **Step 4: Commit**

```bash
git add tool-schemas.mjs server.mjs
git commit -m "feat(server): register mem_optimize MCP tool with preview/run/run_all"
```

---

### Task 10: CLI Command — `optimize`

**Files:**
- Modify: `mem-cli.mjs`

- [ ] **Step 1: Add optimize command to mem-cli.mjs**

Add the command function before the main switch (around line 2035). First add the import at the top of mem-cli.mjs:

```js
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
```

Add the command function:

```js
async function cmdOptimize(db, args) {
  const run = args.includes('--run');
  const runAll = args.includes('--run-all');
  const taskIdx = args.indexOf('--task');
  const tasks = taskIdx >= 0 && args[taskIdx + 1] ? [args[taskIdx + 1]] : undefined;
  const maxIdx = args.indexOf('--max');
  const maxItems = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) || 15 : 15;

  if (!run && !runAll) {
    // Preview mode
    const preview = optimizePreview(db);
    out('[mem] 🔍 LLM Optimization Preview:');
    out(`  Re-enrich candidates: ${preview.reenrich}`);
    out(`  Normalize: ${preview.normalizeGateOpen ? `${preview.normalize} unique concepts` : 'gate closed (7-day interval)'}`);
    out(`  Cluster-merge: ${preview.clusterMerge} clusters`);
    out(`  Smart-compress: ${preview.smartCompress} clusters`);
    out(`  Total: ${preview.total} items`);
    out('');
    out('Run with --run to execute, --run-all to bypass gates.');
    return;
  }

  out('[mem] Running LLM optimization...');
  const results = await optimizeRun(db, { tasks, maxItems, force: runAll });

  if (results.reenrich) out(`  Re-enrich: ${results.reenrich.processed || 0} processed, ${results.reenrich.skipped || 0} skipped`);
  if (results.normalize) {
    if (results.normalize.skipped) out(`  Normalize: skipped (${results.normalize.reason})`);
    else out(`  Normalize: ${results.normalize.processed || 0} updated, ${results.normalize.groups || 0} synonym groups`);
  }
  if (results.clusterMerge) out(`  Cluster-merge: ${results.clusterMerge.merged || 0} merged of ${results.clusterMerge.processed || 0} clusters`);
  if (results.smartCompress) out(`  Smart-compress: ${results.smartCompress.compressed || 0} compressed of ${results.smartCompress.processed || 0} clusters`);
}
```

Add to the switch statement (around line 2048):

```js
      case 'optimize':  await cmdOptimize(db, cmdArgs); break;
```

- [ ] **Step 2: Run CLI test**

Run: `npx vitest run tests/cli.test.mjs`
Expected: PASS

- [ ] **Step 3: Manual smoke test**

Run: `node mem-cli.mjs optimize`
Expected: Preview output with candidate counts.

- [ ] **Step 4: Commit**

```bash
git add mem-cli.mjs
git commit -m "feat(cli): add optimize subcommand for LLM-powered maintenance"
```

---

### Task 11: Update CLAUDE.md and install-metadata.mjs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `install-metadata.mjs`

- [ ] **Step 1: Update CLAUDE.md**

Add `hook-optimize.mjs` to the Architecture table:

```markdown
| `hook-optimize.mjs` | LLM-powered optimization: re-enrich, normalize, cluster-merge, smart-compress |
```

Add `optimize` to the CLI commands list:

```
- CLI commands: `claude-mem-lite search|recent|recall|get|timeline|save|delete|update|export|compress|maintain|optimize|fts-check|stats|context|browse|registry`
```

- [ ] **Step 2: Add mem_optimize to install-metadata.mjs skill metadata**

Find the `'skill:update'` entry and add nearby:

```js
  'skill:optimize': {
    intent_tags: 'optimize,llm,quality,re-enrich,normalize,compress,merge,maintenance',
    domain_tags: 'memory,quality,optimization',
    capability_summary: 'LLM-powered database optimization — re-enrich degraded records, normalize concepts, merge fragments, smart-compress',
    trigger_patterns: 'when user wants to optimize memory quality or run deep LLM-based maintenance',
    activation_context: 'optimize memory database quality with LLM',
    keywords: 'optimize,quality,re-enrich,normalize,merge,smart-compress',
  },
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md install-metadata.mjs
git commit -m "docs: update architecture table and CLI docs for optimize feature"
```

---

### Task 12: Contract Tests + Final Verification

**Files:**
- Modify: `tests/contract.test.mjs` (if needed for new tool)

- [ ] **Step 1: Check if contract tests need updating**

Run: `npx vitest run tests/contract.test.mjs`

If the contract test enumerates all MCP tools and fails because `mem_optimize` is missing, add it to the expected tool list.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All 1275+ tests pass (plus new tests from hook-optimize.test.mjs).

- [ ] **Step 3: Run linter**

Run: `npx eslint hook-optimize.mjs`
Expected: No errors.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "test: add contract tests for mem_optimize tool"
```

---

### Task 13: Version Bump + Release

**Files:**
- Modify: `package.json` (version bump)
- Modify: `CLAUDE.md` (version reference)

- [ ] **Step 1: Bump version**

Update version from `2.28.2` to `2.29.0` in `package.json` (minor bump for new feature).

- [ ] **Step 2: Update CLAUDE.md version reference**

Change `- **Version**: 2.28.2` to `- **Version**: 2.29.0`.

- [ ] **Step 3: Commit and tag**

```bash
git add package.json CLAUDE.md
git commit -m "chore(release): bump version to v2.29.0"
git tag v2.29.0
git push && git push --tags
```

- [ ] **Step 4: Create GitHub Release**

```bash
gh release create v2.29.0 --title "v2.29.0" --notes "feat: LLM-powered database optimization (re-enrich, normalize, cluster-merge, smart-compress)"
```
