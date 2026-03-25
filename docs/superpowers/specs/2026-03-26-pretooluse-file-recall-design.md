# PreToolUse File Recall + SessionStart Actionable Rules

**Date**: 2026-03-26
**Status**: Approved
**Scope**: claude-mem-lite v2.25.0

## Problem

During Claude Code's autonomous coding loop (Read → Edit → Test → Fix), the memory system is effectively silent. Memory injection only occurs at session boundaries (SessionStart) and user prompts (UserPromptSubmit). The core value-creation phase — where Claude edits files and debugs — receives near-zero guidance from past experience.

### Root Cause Analysis

1. **No injection point before edits**: PostToolUse fires after edits (too late to prevent mistakes). No PreToolUse hook exists in the current system.
2. **SessionStart context becomes stale**: Injected once, covers broad topics, not specific to the file being edited.
3. **MCP tools are pull-based**: Claude must decide to call `mem_recall` — it rarely does during autonomous coding because built-in tools (Read/Edit/Grep) take priority.

### Quantified Impact

- Typical session: 10-30 Edit calls, 0 memory injections during this phase
- Each preventable bug costs 5-10 tool calls to debug (~1000-3000 tokens)
- Target: inject relevant lessons at the moment of highest value (before editing)

## Design

### Part A: PreToolUse File Recall

#### Architecture

```
Claude decides to Edit schema.mjs
  │
  ├─ hooks.json matcher: "Edit|Write" (only fires for these tools)
  │
  ├─ node scripts/pre-tool-recall.js (~30ms)
  │   ├─ Parse stdin JSON → extract file_path
  │   ├─ Check cooldown (same file within 5min → skip)
  │   ├─ Query DB: files LIKE '%basename%'
  │   │   AND lesson_learned IS NOT NULL
  │   │   AND importance >= 2
  │   │   ORDER BY updated_at DESC LIMIT 2
  │   ├─ Match found → stdout 1-2 lessons (~80 tokens)
  │   └─ No match → silent exit (0 tokens, 0 output)
  │
  └─ Claude sees lessons, then executes Edit
```

#### Output Format

When lessons are found:
```
[mem] Lessons for schema.mjs:
  #1234 [bugfix] Verify FTS5 integrity after schema changes — index corruption
  #3456 [decision] observations_fts uses default porter tokenizer, do not change
```

When no lessons: **no output at all**.

#### New File: `scripts/pre-tool-recall.js`

Lightweight standalone script (~30ms startup). Only imports:
- `better-sqlite3` (DB query)
- `fs` (existsSync, readFileSync, writeFileSync)
- `path` (basename, join)
- `os` (homedir)

Does NOT import: hook.mjs, schema.mjs, utils.mjs, tfidf.mjs, or any other heavy module.

Responsibilities:
1. Parse stdin JSON to extract `tool_input.file_path`
2. Read cooldown file (`runtime/pre-recall-cooldown.json`), skip if same file within 5 minutes
3. Open DB readonly, query for file-related lessons
4. Output formatted lessons to stdout
5. Update cooldown file
6. Exit 0 always (never blocks edits)

#### Cooldown Mechanism

File: `~/.claude-mem-lite/runtime/pre-recall-cooldown.json`
```json
{
  "schema.mjs": 1711468800000,
  "utils.mjs": 1711468500000
}
```

- Key: basename of file
- Value: timestamp of last injection
- TTL: 5 minutes (300000ms)
- Cleanup: entries older than 10 minutes removed on each write
- If file is corrupt/missing: skip cooldown check, proceed with query

#### Safety

- DB opened with `{ readonly: true }` — cannot corrupt data
- All exceptions caught silently → `process.exit(0)`
- PreToolUse exit codes: 0 = allow tool, 2 = block tool. We always exit 0.
- Timeout: 3 seconds (hooks.json)
- No recursive hooks: checks `CLAUDE_MEM_HOOK_RUNNING` env var

#### hooks.json Addition

```json
"PreToolUse": [
  {
    "matcher": "Edit|Write",
    "hooks": [
      {
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-recall.js\"",
        "timeout": 3
      }
    ]
  }
]
```

#### Remove PostToolUse File-History Hints

Remove the file-history injection from `hook.mjs` PostToolUse handler (approximately lines 228-249). Rationale:
- PreToolUse timing is strictly better (before edit > after edit)
- Keeping both causes duplicate injection for the same file
- Reduces PostToolUse processing time

Retain: error-triggered recall in PostToolUse (lines 259-290) — this covers a different trigger (Bash errors, not file edits).

### Part B: SessionStart Actionable Rules Format

#### Change

Modify `hook-context.mjs` rendering to split Key Context into two sections:

**Before** (passive observations):
```markdown
### Key Context
- [bugfix] Error: schema.mjs: FTS5 index broke after migration (#1234)
- [bugfix] Error: mem-cli.mjs: search crashes on empty query (#5061)
- [refactor] Route usage/error messages through fail() instead of out() (#5064)
```

**After** (actionable + contextual):
```markdown
### File Lessons
- schema.mjs: Verify FTS5 integrity after schema changes (#1234)
- mem-cli.mjs: Guard sanitizeFtsQuery input for empty queries (#5061)

### Key Context
- [refactor] Route usage/error messages through fail() instead of out() (#5064)
```

#### Rendering Logic

```
observations with (lesson_learned + files) → "### File Lessons" section
  - Format: "- {basename}: {lesson_learned} (#{id})"
  - Max 5 entries, sorted by importance × recency

observations without lesson or files → "### Key Context" section
  - Format unchanged from current
```

#### Synergy with PreToolUse

| Timing | Content | Purpose |
|--------|---------|---------|
| SessionStart | File Lessons overview (all files) | Claude knows which files have "landmines" during planning |
| PreToolUse | Single-file lesson (just-in-time) | Claude gets reminded at the exact moment of editing |

## Files Changed

| File | Operation | Description |
|------|-----------|-------------|
| `scripts/pre-tool-recall.js` | **Create** | Lightweight PreToolUse recall script |
| `hooks/hooks.json` | Modify | Add PreToolUse section |
| `hook.mjs` | Modify | Remove file-history hints from PostToolUse |
| `hook-context.mjs` | Modify | Split Key Context into File Lessons + Key Context |
| `package.json` | Modify | Add pre-tool-recall.js to files array |

## Token Budget

| Scenario | Current | After | Delta |
|----------|---------|-------|-------|
| Edit file with no history | 0 | 0 | 0 |
| Edit file with lessons (1st time) | ~100 (PostToolUse after) | ~80 (PreToolUse before) | -20 |
| Same file 2nd-Nth edit | ~100×N | 0 (cooldown) | **-100×(N-1)** |
| Typical session (15 edits, 5 with history) | ~500 | ~400 | -100 |
| Prevented 1 repeated bug | 0 saved | 5-10 debug rounds saved | **-1000~3000** |
| SessionStart context | ~2000 | ~2000 | 0 (format change only) |

**Net: 2-6x ROI on token investment.**

## Testing Plan

1. **pre-tool-recall.js unit tests**: In-memory DB, mock stdin, verify output format
2. **Cooldown tests**: Verify 5-min TTL, file corruption resilience, cleanup of stale entries
3. **hooks.json validation**: Existing plugin-manifest tests cover format
4. **hook-context.mjs tests**: Verify File Lessons / Key Context split rendering
5. **Integration test**: End-to-end PreToolUse → output verification
6. **Regression**: Ensure PostToolUse error-recall still works after file-history removal

## What We Explicitly Do NOT Do

| Rejected | Reason |
|----------|--------|
| PreToolUse for Read | Claude reads dozens of files per session → token explosion |
| Dynamic CLAUDE.md updates mid-session | Disrupts Claude, wastes tokens on re-read |
| Memory Agent autonomous search | Adds latency and complexity; hook model suffices |
| Auto-derived "rules" from observations | New data type + UI + maintenance; over-engineering |
| Notification hook injection | Not suited for memory context |
| Reduce MCP tool count | Low ROI, separate concern for later |
