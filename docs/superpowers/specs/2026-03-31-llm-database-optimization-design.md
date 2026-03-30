# LLM-Powered Database Optimization

**Date:** 2026-03-31
**Status:** Draft
**Scope:** New `hook-optimize.mjs` module + `mem_optimize` MCP tool + CLI command

## Problem

The current database maintenance system is entirely rule-based: decay, boost, dedup (Jaccard), compress (weekly bullet-list summaries). This leaves several data quality gaps:

1. **Degraded records** — When LLM is unavailable during ingestion, observations are saved without concepts, facts, lesson_learned, or search_aliases. These are never revisited.
2. **Low-quality summaries** — Compress creates "Weekly summary: N observations" with bullet lists. These are not semantically useful for search.
3. **Cross-session fragmentation** — The same topic (e.g., a multi-session bug investigation) is scattered across many observations with no unified view.
4. **Terminology inconsistency** — The same concept appears under different names ("FTS5" vs "full-text search" vs "全文搜索"), reducing search recall.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Trigger strategy | Progressive (auto 24h + manual) | Cost-controlled, user doesn't need to remember to trigger |
| Clustering approach | Hybrid (topic-based + time-window) | Preserves temporal context while grouping semantically |
| Model selection | Tiered (Haiku for simple, Sonnet for complex) | Cost-efficient; re-enrich reuses existing Haiku prompt |
| Architecture | Dedicated module + background worker | Follows existing hook-llm.mjs / hook-episode.mjs patterns |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Trigger Layer                         │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ auto-maintain │    │ mem_optimize │    │ CLI       │  │
│  │  (24h gate)   │    │  (MCP tool)  │    │ optimize  │  │
│  └──────┬───────┘    └──────┬───────┘    └─────┬─────┘  │
│         └────────┬──────────┴──────────────────┘        │
│                  ▼                                       │
│     spawnBackground('llm-optimize')                     │
└─────────────────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────┐
│              hook-optimize.mjs (new module)              │
│                                                         │
│  Pipeline (sequential, priority order):                 │
│                                                         │
│  1. re-enrich     — fix degraded records ——— Haiku      │
│  2. normalize     — concept unification —— Sonnet       │
│  3. cluster-merge — cross-session merge —— Sonnet       │
│  4. smart-compress— intelligent summaries — Sonnet      │
│                                                         │
│  Per-run limit: max_items=15 (configurable)             │
│  Each step independent: failure doesn't block next      │
└─────────────────────────────────────────────────────────┘
```

## Task Specifications

### Task 1: Re-enrich (Haiku)

**Goal:** Re-process degraded observations that were saved without LLM enrichment.

**Candidate query:**
```sql
SELECT id, title, narrative, type, subtitle
FROM observations
WHERE COALESCE(compressed_into, 0) = 0
  AND (concepts IS NULL OR concepts = '')
  AND (facts IS NULL OR facts = '')
  AND lesson_learned IS NULL
  AND search_aliases IS NULL
  AND optimized_at IS NULL
ORDER BY epoch DESC
LIMIT ?
```

**Processing:**
- Reuse the existing episode extraction prompt from `hook-llm.mjs`, adapted for title+narrative input instead of raw tool events
- Call Haiku (same model as current enrichment)
- Update: concepts, facts, lesson_learned, search_aliases, text (FTS field), importance
- Rebuild TF-IDF vector for the record
- If LLM returns `importance=0`, mark `compressed_into=COMPRESSED_AUTO`
- Set `optimized_at = Date.now()` on success

### Task 2: Normalize (Sonnet, 7-day gate)

**Goal:** Identify synonym groups across all concepts and unify terminology.

**Processing:**
1. Extract all unique concepts from active observations (up to 500)
2. Send to Sonnet with prompt requesting synonym group identification
3. Expected response:
   ```json
   {
     "groups": [
       {"canonical": "FTS5", "aliases": ["full-text search", "全文搜索", "FTS"]},
       ...
     ]
   }
   ```
4. For each group: update observations' concepts to use canonical form, append aliases to search_aliases
5. Optionally append new mappings to `synonyms.mjs` SYNONYM_MAP for future FTS query expansion
6. Set `optimized_at = Date.now()` on affected records

**Rate limit:** Independent gate file `runtime/last-normalize.json`, 7-day interval.

### Task 3: Cluster-merge (Sonnet)

**Goal:** Merge semantically related observations that are currently fragmented across sessions.

**Candidate identification (no LLM needed):**
- Use existing MinHash + Jaccard similarity
- Target range: 0.4–0.85 Jaccard (below 0.4 = unrelated, above 0.85 = already handled by auto-dedup)
- Time constraint: candidates must be within a 30-day window
- Group size: 2–5 observations per cluster

**LLM processing (per cluster):**
- Send all candidates' title + narrative to Sonnet
- Prompt asks: should these be merged? If yes, produce:
  ```json
  {
    "should_merge": true,
    "merged_title": "≤120 chars",
    "merged_narrative": "comprehensive summary ≤800 chars",
    "merged_concepts": ["..."],
    "merged_facts": ["..."],
    "merged_lesson": "synthesized lesson or null",
    "importance": 2
  }
  ```
- If `should_merge=false`, skip the cluster

**Execution:**
- Keep the observation with highest `access_count` as the keeper
- Update keeper with merged content
- Mark others: `compressed_into = keeper.id`
- Rebuild keeper's FTS text and TF-IDF vector
- Set `optimized_at = Date.now()` on keeper

### Task 4: Smart-compress (Sonnet)

**Goal:** Replace mechanical bullet-list compression with intelligent, searchable summaries.

**Candidate criteria:** Same as existing compress — `importance=1`, `access_count=0`, `30+ days old`, `COALESCE(compressed_into, 0) = 0`.

**Clustering (no LLM needed):**
1. Group candidates by project
2. Within each project, compute TF-IDF cosine similarity between all candidates
3. Cluster by similarity threshold (≥0.3 cosine = same cluster)
4. Split clusters that span more than 14 days into sub-clusters
5. Only process clusters with ≥3 observations

**LLM processing (per cluster):**
- Send all observations' title + narrative + lesson_learned to Sonnet
- Prompt asks for:
  ```json
  {
    "title": "descriptive summary title ≤120 chars",
    "narrative": "comprehensive summary ≤800 chars preserving key decisions and lessons",
    "concepts": ["..."],
    "facts": ["all specific facts preserved"],
    "lesson_learned": "most important synthesized lesson",
    "search_aliases": ["..."]
  }
  ```

**Execution:**
- Create new summary observation with `importance=2`
- Create/reuse synthetic session `compress-{project}`
- Mark originals: `compressed_into = summary.id`
- Compute FTS text and TF-IDF vector for summary

## LLM Call Layer Extension

**File: `haiku-client.mjs`**

Add `callLLMWithModel(prompt, model, opts)`:
```js
/**
 * Call LLM with explicit model selection.
 * @param {string} prompt
 * @param {'haiku'|'sonnet'} model - Model to use
 * @param {object} [opts] - { timeout, maxTokens }
 * @returns {Promise<{text: string}|null>}
 */
export async function callLLMWithModel(prompt, model = 'haiku', opts = {}) {
  // Reuse existing API/CLI dual-mode logic with model override
}
```

- Re-enrich calls `callLLMWithModel(prompt, 'haiku')`
- Normalize, cluster-merge, smart-compress call `callLLMWithModel(prompt, 'sonnet')`
- Existing `callHaiku()` unchanged (backward compatible)

## Database Changes

**New column (migration in `schema.mjs`):**
```sql
ALTER TABLE observations ADD COLUMN optimized_at INTEGER DEFAULT NULL;
```

- Set to current epoch after successful re-enrich/normalize/merge
- Prevents re-processing already-optimized records
- Candidate queries include `AND optimized_at IS NULL`

**New gate file:**
- `runtime/last-normalize.json` — 7-day interval for normalize task

## MCP Tool: mem_optimize

```json
{
  "name": "mem_optimize",
  "description": "LLM-powered database optimization: re-enrich degraded records, normalize concepts, merge related observations, smart-compress old data",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["preview", "run", "run_all"],
        "default": "preview",
        "description": "preview=scan candidates, run=execute with limits, run_all=bypass gates"
      },
      "tasks": {
        "type": "array",
        "items": { "type": "string", "enum": ["re-enrich", "normalize", "cluster-merge", "smart-compress"] },
        "description": "Which optimization tasks to run (default: all)"
      },
      "max_items": {
        "type": "integer",
        "default": 15,
        "description": "Maximum records to process across all tasks"
      }
    }
  }
}
```

## CLI Command

```bash
claude-mem-lite optimize                              # preview all tasks
claude-mem-lite optimize --run                        # execute all tasks
claude-mem-lite optimize --task re-enrich --max 30    # specific task with limit
claude-mem-lite optimize --run-all                    # bypass gate limits
```

## Auto-trigger Integration

In `hook.mjs`, after the existing `spawnBackground('auto-compress')` in the auto-maintain block:

```js
spawnBackground('llm-optimize');
```

The `llm-optimize` background event is added to `BG_EVENTS` set and the main switch case.

## File Change Summary

| File | Change | Description |
|------|--------|-------------|
| `hook-optimize.mjs` | **New** | Core optimization pipeline (4 tasks) |
| `haiku-client.mjs` | Modify | Add `callLLMWithModel()` for model selection |
| `hook.mjs` | Modify | Add `spawnBackground('llm-optimize')` + switch case |
| `server.mjs` | Modify | Register `mem_optimize` MCP tool |
| `tool-schemas.mjs` | Modify | Add mem_optimize schema |
| `mem-cli.mjs` | Modify | Add `optimize` subcommand |
| `schema.mjs` | Modify | Migration: add `optimized_at` column |
| `tests/hook-optimize.test.mjs` | **New** | Unit tests for all 4 tasks |
| `CLAUDE.md` | Modify | Update architecture table and CLI command list |

## Error Handling

- Each task wrapped in independent try/catch; failure logged via `debugLog`, next task proceeds
- LLM semaphore (`acquireLLMSlot`) used for all calls; timeout = skip gracefully
- If DB is unavailable, entire pipeline exits early
- Background worker failures never affect the main Claude session

## Budget Distribution

The `max_items` limit applies to the total number of **LLM calls** across all tasks in a single run (not the number of affected records). Distribution strategy:

1. Re-enrich gets up to `ceil(max_items * 0.4)` calls (e.g., 6 of 15)
2. Normalize gets 1 call regardless (bulk operation, 7-day gate)
3. Cluster-merge gets up to `ceil(max_items * 0.3)` calls (e.g., 5 of 15)
4. Smart-compress gets the remainder (e.g., 4 of 15)

If a task has no candidates, its budget is redistributed to the next task.

## Cost Estimation

Per auto-trigger cycle (every 24h):
- Re-enrich: ~5 Haiku calls (cheap)
- Normalize: 0-1 Sonnet call (7-day gate)
- Cluster-merge: ~3-5 Sonnet calls
- Smart-compress: ~2-3 Sonnet calls
- Total: ~10 LLM calls max per day, mostly Haiku
