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
  ├─ hooks.json matcher: "Edit|Write|NotebookEdit" (EDIT_TOOLS set)
  │
  ├─ node scripts/pre-tool-recall.js (~30ms)
  │   ├─ Parse stdin JSON → extract file_path
  │   ├─ Check cooldown (same full path within 5min → skip)
  │   ├─ Query DB via observation_files junction table:
  │   │   JOIN observation_files ON obs_id = o.id
  │   │   WHERE lesson_learned IS NOT NULL
  │   │     AND importance >= 2
  │   │     AND superseded_at IS NULL
  │   │     AND COALESCE(compressed_into, 0) = 0
  │   │   ORDER BY created_at_epoch DESC LIMIT 2
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
3. Open DB readonly, query for file-related lessons via `observation_files` junction table
4. Output formatted lessons to stdout
5. Update cooldown file
6. Exit 0 always (never blocks edits)

#### SQL Query

Follows the same pattern as `recallForFile()` in `hook-memory.mjs`, but readonly (no access_count update):

```sql
SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
FROM observations o
JOIN observation_files of2 ON of2.obs_id = o.id
WHERE o.project = ?
  AND o.importance >= 2
  AND o.lesson_learned IS NOT NULL
  AND o.lesson_learned != ''
  AND COALESCE(o.compressed_into, 0) = 0
  AND o.superseded_at IS NULL
  AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\')
ORDER BY o.created_at_epoch DESC
LIMIT 2
```

Parameters: `(project, fullPath, '%' + escapedBasename)`

**Design choice: `lesson_learned IS NOT NULL` filter.** This is an intentional narrowing vs the current PostToolUse file-history (which shows all importance>=2 observations). Rationale: PreToolUse injection should be high-signal only. Observations without lessons are informational — they don't tell Claude what to watch out for. The Pre-edit moment demands actionable guidance, not historical context.

**Design choice: readonly DB / no access_count update.** The PreToolUse script opens the DB readonly for safety and speed. This means injected observations don't get their `access_count` incremented. Acceptable tradeoff — access_count is used for decay scoring, and the marginal impact of missing these updates is negligible.

**Edge case: uninitialized DB.** If the script runs before any other hook has created the schema (e.g., first-ever session, PreToolUse fires before SessionStart completes), the query will fail with "no such table". The global try-catch handles this gracefully (silent exit 0).

#### Cooldown Mechanism

File: `~/.claude-mem-lite/runtime/pre-recall-cooldown.json`
```json
{
  "/absolute/path/to/schema.mjs": 1711468800000,
  "/absolute/path/to/utils.mjs": 1711468500000
}
```

- Key: **full file_path** (avoids basename collision for same-named files in different directories)
- Value: timestamp of last injection
- TTL: 5 minutes (300000ms)
- Cleanup: entries older than 10 minutes removed on each write
- If file is corrupt/missing: skip cooldown check, proceed with query
- Theoretical race: two near-simultaneous Edit calls could both read before either writes. Low-severity — duplicate injection is ~80 extra tokens, rare scenario.

#### Safety

- DB opened with `{ readonly: true }` — cannot corrupt data
- All exceptions caught silently → `process.exit(0)`
- PreToolUse exit codes: 0 = allow tool, 2 = block tool. We always exit 0.
- Timeout: 3 seconds (hooks.json)
- No recursive hooks: checks `CLAUDE_MEM_HOOK_RUNNING` env var

#### Project Inference

The script needs the `project` parameter for the DB query. It uses the same logic as `inferProject()` in `utils.mjs`:
```javascript
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const base = path.basename(dir);
const parent = path.basename(path.dirname(dir));
const project = (parent && parent !== '.' && parent !== '/')
  ? `${parent}--${base}` : base;
// Sanitize: replace non-alphanumeric with hyphens
```

This is inlined rather than imported to avoid loading utils.mjs.

#### hooks.json Addition

```json
"PreToolUse": [
  {
    "matcher": "Edit|Write|NotebookEdit",
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

Matcher covers all tools in `EDIT_TOOLS` set (`utils.mjs:74`): `Edit`, `Write`, `NotebookEdit`.

#### install.mjs Changes

1. **Remove PreToolUse cleanup code** (lines 461-464): Currently `install.mjs` actively removes PreToolUse hooks from settings.json as "stale from previous versions". This must be removed since PreToolUse is now intentional.

2. **Register PreToolUse hook** in the direct-install path (alongside existing SessionStart/PostToolUse/Stop/UserPromptSubmit registration), so both plugin-mode and direct-install users get the hook.

#### Remove PostToolUse File-History Hints

Remove the file-history injection from `hook.mjs` PostToolUse handler (lines 228-249). Rationale:
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
observations with (lesson_learned + files_modified) → "### File Lessons" section
  - Format: "- {basename}: {lesson_learned} (#{id})"
  - Max 5 entries, sorted by importance × recency

observations without lesson or files → "### Key Context" section
  - Format unchanged from current
```

#### Backwards Compatibility

- CLAUDE.md context block is parsed by `<claude-mem-context>` start/end tags, not by section headers — consumers won't break
- `### Key Context` section is retained (just potentially with fewer items) — test assertions that check for its existence still pass
- Tests in `handoff-simulation.test.mjs` may need minor updates if they assert on Key Context item counts

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
| `hook.mjs` | Modify | Split Key Context into File Lessons + Key Context (lines 650-669) |
| `install.mjs` | Modify | Remove PreToolUse cleanup, add PreToolUse registration |
| `package.json` | Modify | Add pre-tool-recall.js to files array |

## Token Budget

| Scenario | Current | After | Delta |
|----------|---------|-------|-------|
| Edit file with no history | 0 | 0 | 0 |
| Edit file with lessons (1st time) | ~100 (PostToolUse after) | ~80 (PreToolUse before) | -20 |
| Same file 2nd+ edit (same episode) | 0 (episode dedup) | 0 (cooldown) | 0 |
| Same file across episodes | ~100 per episode | 0 (5min cooldown) | **-100** |
| Typical session (15 edits, 5 with history) | ~300 | ~250 | -50 |
| Prevented 1 repeated bug | 0 saved | 5-10 debug rounds saved | **-1000~3000** |
| SessionStart context | ~2000 | ~2000 | 0 (format change only) |

**Net: 2-6x ROI on token investment.** Primary value is bug prevention, not token reduction.

## Testing Plan

1. **pre-tool-recall.js unit tests**: In-memory DB with observation_files table, mock stdin, verify output format and lesson content
2. **Cooldown tests**: Verify 5-min TTL, full-path keying, file corruption resilience, cleanup of stale entries
3. **hooks.json validation**: Existing plugin-manifest tests cover format; add PreToolUse matcher check
4. **hook-context.mjs tests**: Verify File Lessons / Key Context split rendering, empty-lesson fallback
5. **Integration test**: End-to-end PreToolUse → output verification
6. **Regression**: Ensure PostToolUse error-recall still works after file-history removal
7. **Edge case**: Uninitialized DB (no tables) → silent exit
8. **install.mjs**: Verify PreToolUse hook registration in direct-install path

## What We Explicitly Do NOT Do

| Rejected | Reason |
|----------|--------|
| PreToolUse for Read | Claude reads dozens of files per session → token explosion |
| Dynamic CLAUDE.md updates mid-session | Disrupts Claude, wastes tokens on re-read |
| Memory Agent autonomous search | Adds latency and complexity; hook model suffices |
| Auto-derived "rules" from observations | New data type + UI + maintenance; over-engineering |
| Notification hook injection | Not suited for memory context |
| Reduce MCP tool count | Low ROI, separate concern for later |
