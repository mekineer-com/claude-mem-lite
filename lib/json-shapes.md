# CLI `--json` shapes

Reference for every `claude-mem-lite <cmd> --json` output. Shapes are designed
to mirror the underlying MCP `mem_*` tool data so consumers can switch
between `agent | jq` (CLI) and the MCP tool (programmatic) without rewriting.

## Invariants

- **Stdout is structured-only when `--json` is set.** All friendly diagnostics
  (warnings, hints, "no results" messages) go to stderr. The pattern matches
  `cmdExport` (B6 fix in v2.66.0): empty results emit a format-respecting empty
  form (e.g. `{ "results": [] }`), never a friendly text fallback.
- **Field names use snake_case** to match SQL column names + MCP schemas.
- **`null` for absent fields**, not `undefined` or omission, so consumers can
  rely on key presence.
- **Epoch timestamps in `created_at_epoch`** alongside ISO `created_at` —
  callers automating against the API typically need the integer for math.

## `recent --json`

```jsonc
{
  "project": "projects--mem",  // or null when --project not set and no inferred project
  "limit": 10,
  "total": 8,                  // count of returned items (≤ limit)
  "results": [
    {
      "id": 8286,
      "type": "decision",
      "title": "v2.66.0 carry-forward: …",
      "importance": 3,
      "created_at": "2026-05-10T07:54:13.551Z",
      "created_at_epoch": 1778399653551
    }
  ]
}
```

Empty form: `{ "project": ..., "limit": N, "total": 0, "results": [] }`.

## `recall <file> --json`

```jsonc
{
  "file": "hook-handoff.mjs",  // basename of input
  "limit": 10,
  "include_noise": false,
  "total": 1,
  "results": [
    {
      "id": 8105,
      "type": "decision",
      "title": "Code-term questions: grep code first, search mem second",
      "lesson_learned": "…",     // null if absent
      "importance": 3,
      "project": "projects--mem",
      "created_at": "2026-04-22T20:15:07.369Z",
      "created_at_epoch": 1776888907369
    }
  ]
}
```

Side-effect: matches MCP `mem_recall` by bumping `access_count` on hit rows.

## `timeline --anchor N --json`

When anchor resolves to a real observation:

```jsonc
{
  "anchor": {
    "id": 8286,
    "type": "decision",
    "title": "…",
    "created_at": "…",
    "created_at_epoch": 1778399653551
  },
  "anchor_note": null,           // or "(anchored to #N, …)" when input was a P#/S#
                                 // or "(query \"...\" relaxed AND→OR — …)"
  "before": [{ /* row */ }, …],  // chronological (oldest → newest), up to --before N
  "after":  [{ /* row */ }, …]   // chronological (newest → newest), up to --after N
}
```

When no anchor and `--query` had no FTS hit, OR no anchor and no query:

```jsonc
{
  "anchor": null,
  "anchor_note": "no anchor matched query \"…\"" | null,
  "before": [],
  "after": [],
  "fallback": "recent",          // sentinel that this is the recent-fallback path
  "results": [{ /* row */ }, …]  // up to (before + after + 1) most recent rows
}
```

## `stats --json`

```jsonc
{
  "project": "projects--mem" | null,
  "days": 30,
  "totals":   { "observations": 3712, "sessions": 5024, "prompts": 6096 },
  "recent":   { "observations": 48,   "sessions": 281 },
  "type_distribution": [{ "type": "bugfix", "count": 19 }, …],
  "top_projects":      [{ "project": "projects--mem", "count": 3712 }, …], // empty when --project set
  "daily_activity":    [{ "day": "2026-05-10", "count": 12 }, …],
  "data_health": {
    "estimated_tokens": 1234567,
    "avg_importance": 1.42,
    "low_value_count": 88,
    "noise_ratio": 0.024,
    "compressed": 215,
    "superseded_only": 12
  },
  "tier_distribution": { "working": 39, "active": 412, "archive": 3034 }
}
```

`stats --quality --json` instead emits the quality-stats shape from
`lib/stats-quality.mjs::computeQualityStats(...)` — see that module for the
canonical structure.

`stats --retry --json` emits `{ days, total_attempts, total_recovered,
recovery_rate, per_day: [...] }` — pre-existing shape, unchanged.

## `browse --json`

```jsonc
{
  "project": "projects--mem",
  "limit": 5,
  "tier_filter": null | "working" | "active" | "archive",
  "totals": {
    "working": 39,
    "active":  412,
    "archive": 3034,            // only present when --tier=archive (otherwise 0 — text path skips fetching)
    "grand_total": 3485
  },
  "tiers": {
    "working": { "count": 39,  "results": [{ /* row */ }, …] },
    "active":  { "count": 412, "results": [{ /* row */ }, …] },
    "archive": { "count": 3034, "results": [] }   // unfiltered view skips archive rows
  }
}
```

When `--tier T` is set, only that tier appears in `tiers.{T}` and `totals.{T}`.

## MCP parity

These shapes are the source of truth for CLI output. MCP tool handlers
(`server.mjs::mem_recent`, `mem_recall`, `mem_timeline`, `mem_stats`,
`mem_browse`) currently format the same row data into text content; a future
release may add MCP `output_format: 'json'` mirroring these shapes one-to-one.
When MCP gains JSON output, this doc remains authoritative — both surfaces
must match.

## Adding `--json` to a new command

1. Branch on `flags.json === true || flags.json === 'true'` early in the handler.
2. Build the row data once; format-on-output (text vs JSON) — never duplicate the query.
3. Empty result must emit a parseable empty form, NOT a friendly text fallback.
4. Friendly diagnostics → `process.stderr.write(...)`, never stdout.
5. Add the cmd to `JSON_SUPPORTED_CMDS` in `mem-cli.mjs::run()` so the
   `--json` not-supported stderr note doesn't fire on it.
6. Update `--help` text with the shape sketch.
7. Document the shape here; any consumer breakage on shape change = SemVer minor (additive) or major (rename/remove).
