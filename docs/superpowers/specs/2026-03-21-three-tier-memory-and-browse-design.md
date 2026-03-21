# Three-Tier Virtual Memory Model + CLI Browse Command

## Goal

Add a virtual three-tier memory classification system (Working / Active / Archive) and a CLI `browse` command that presents a tier-grouped dashboard. Extend `mem_search` with tier filtering and `mem_stats` with tier distribution.

## Architecture

**Virtual computed tiers** — no new database columns. Tier is computed at query time from existing fields: `importance`, `access_count`, `last_accessed_at`, `created_at_epoch`, `type`, `compressed_into`, `superseded_at`, `memory_session_id`, and `project`. This preserves the zero-migration, lightweight design philosophy.

A new module `tier.mjs` provides both a JavaScript function (`computeTier`) and an inline SQL CASE expression (`TIER_CASE_SQL`) for efficient in-query classification.

## Tier Classification Rules

Evaluated in priority order (first match wins):

| Priority | Tier | Condition |
|----------|------|-----------|
| 1 | **archive** | `compressed_into ≠ 0` OR `superseded_at IS NOT NULL` |
| 2 | **working** | `memory_session_id = currentSessionId` (same session) |
| 3 | **working** | Same project + `importance ≥ 2` + `last_accessed_at` within 2 hours |
| 4 | **working** | Same project + `created_at_epoch` within 2 hours |
| 5 | **active** | Not archived, not superseded, age < type-specific decay window |
| 6 | **archive** | Everything else |

### Active Tier Decay Windows (type-specific half-life × 2)

| Type | Half-life | Active window |
|------|-----------|--------------|
| decision | 90 days | 180 days |
| discovery | 60 days | 120 days |
| feature | 30 days | 60 days |
| bugfix | 14 days | 28 days |
| refactor | 14 days | 28 days |
| change | 7 days | 14 days |

## Components

### 1. `tier.mjs` (new file)

Pure function module with no side effects or DB dependencies.

**Exports:**

```javascript
/**
 * Compute tier for a single observation row.
 * @param {object} obs - Row with: compressed_into, superseded_at, memory_session_id,
 *   project, importance, last_accessed_at, created_at_epoch, type
 * @param {object} ctx - { now: number, currentProject: string, currentSessionId: string }
 * @returns {'working' | 'active' | 'archive'}
 */
export function computeTier(obs, ctx)

/**
 * SQL CASE expression for inline tier computation.
 * Returns a parameterized SQL fragment. Caller must supply params:
 *   [currentSessionId, currentProject, now - 2h, now - 2h, now, now, ...]
 * (one param per type-specific active window threshold)
 * @returns {string} SQL CASE WHEN ... END expression aliased as `tier`
 */
export const TIER_CASE_SQL

/**
 * Build the params array for TIER_CASE_SQL.
 * @param {object} ctx - { now, currentProject, currentSessionId }
 * @returns {any[]}
 */
export function tierSqlParams(ctx)

/** Active window thresholds by type (half-life × 2, in ms) */
export const ACTIVE_WINDOWS
```

### 2. `mem-cli.mjs` — new `cmdBrowse` command

**Usage:** `claude-mem-lite browse [--tier working|active|archive] [--project name] [--limit N]`

**Output format:**

```
📊 Memory Dashboard (projects--mem)

🔴 Working Memory (5)
  #4401 🐛 [bugfix] Fixed auth token refresh | 2min ago
  #4399 🔄 [change] Modified server.mjs, utils.mjs | 15min ago
  ...

🟡 Active Memory (43)
  #4350 🏗️ [feature] Branch-scoped search | 2d ago
  #4342 🎯 [decision] Use virtual tiers over explicit column | 3d ago
  ...

🔵 Archive (312)
  156 compressed | 89 superseded | 67 expired

Totals: 360 observations | Working: 5 | Active: 43 | Archive: 312
```

**Behavior:**
- Default: show all tiers, limit 5 per tier
- `--tier X`: show only that tier with higher limit (20)
- Archive tier shows summary counts by sub-category (compressed/superseded/expired), not individual entries (unless `--tier archive` explicitly requested)
- Relative timestamps: "2min ago", "3d ago", "2mo ago"

### 3. `server.mjs` — `mem_search` tier filter

Add `tier` parameter to `memSearchSchema`:
```javascript
tier: z.enum(['working', 'active', 'archive']).optional()
  .describe('Filter by memory tier (default: working+active)')
```

**Query integration:**
- When `tier` is specified: add `TIER_CASE_SQL` to SELECT, filter by `HAVING tier = ?`
- When `tier` is omitted: exclude archive by default (existing `compressed_into` and `superseded_at` filters already handle most archive cases; add age-based filtering for expired-but-not-compressed)
- The tier filter is applied as a post-FTS5 filter since TIER_CASE_SQL cannot be used inside FTS5 MATCH

### 4. `server.mjs` — `mem_stats` tier distribution

Add tier counts to the stats output:
```
Tier distribution: Working: 5 | Active: 43 | Archive: 312
```

Uses a single query with TIER_CASE_SQL grouped by tier.

### 5. `cli.mjs` — route `browse` subcommand

Add `browse` to the command router alongside existing `search`, `recent`, etc.

## Data Flow

```
User: claude-mem-lite browse --project mem

  cli.mjs → cmdBrowse(db, args)
    │
    ├── Query observations with TIER_CASE_SQL
    │   SELECT *, {TIER_CASE_SQL} as tier FROM observations
    │   WHERE project = ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
    │   ... UNION ALL archive summary query ...
    │
    ├── Group results by tier
    ├── Format with relative timestamps
    └── Output dashboard
```

```
LLM: mem_search(query="auth bug", tier="working")

  server.mjs → searchObservations(ctx)
    │
    ├── FTS5 MATCH query (existing pipeline)
    ├── Post-filter: computeTier(row, ctx) === 'working'
    └── Return filtered results
```

## Error Handling

- `computeTier` never throws — unknown types default to `ACTIVE_WINDOWS.change` (14 days)
- `TIER_CASE_SQL` uses ELSE 'archive' as fallback
- `cmdBrowse` with no data: "No observations found. Start a coding session to build memory."
- Invalid `--tier` value: show usage help

## Testing

### `tests/tier.test.mjs`
- `computeTier` returns correct tier for each classification rule
- Edge cases: null fields, unknown types, boundary timestamps
- `TIER_CASE_SQL` produces same results as `computeTier` for sample data
- `tierSqlParams` returns correct param count and order

### `tests/browse.test.mjs`
- `cmdBrowse` output contains tier headers and observation lines
- `--tier` filter shows only specified tier
- `--project` filter scopes to project
- `--limit` caps entries per tier
- Archive summary shows correct sub-category counts
- Empty database shows friendly message

## Non-Goals

- No new database columns or migrations
- No interactive TUI (no new dependencies)
- No changes to hook-memory.mjs injection logic (existing scoring is sufficient)
- No tier-based injection priority changes (future enhancement)
