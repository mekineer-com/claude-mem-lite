---
name: adopt
description: "Use when: user asks to increase claude-mem-lite's tool-invocation rate in the current project, or wants to install the invited-memory sentinel so Claude Code auto-loads the contract as user-memory. Writes a single sentinel-wrapped line to ~/.claude/projects/<encoded>/memory/MEMORY.md plus a plugin_claude_mem_lite.md detail file. Run /unadopt to remove."
---

# /adopt

Install the **invited-memory** sentinel into the current project's Claude Code
memdir (`~/.claude/projects/<encoded>/memory/`). The sentinel line carries the
MCP-tool triggers (`mem_recall` / `mem_save`) at system-prompt authority
(framed as "user's auto-memory") so Claude Code is more likely to call them
proactively than when those same triggers live in MCP server instructions.

## What it writes

1. **`MEMORY.md`** — ONE sentinel-wrapped line under a `## 插件契约` header.
   Idempotent: re-running replaces the block only if the version bumped.
2. **`plugin_claude_mem_lite.md`** — Detailed contract (CLI cheatsheet +
   MCP decision rules). Not auto-loaded; Claude reads it on demand when the
   MEMORY.md pointer surfaces in context.
3. **`.plugin_claude_mem_lite_state.json`** — Sidecar with sentinel body hash
   for user-edit detection.

## Flags

- `--force` — overwrite a sentinel block that was manually edited
- `--dry-run` — print intended writes without touching disk
- `--all` — adopt every memdir under `~/.claude/projects/*/memory/`
- `--status` — list all adopted projects with their sentinel versions

## Removal

`/unadopt` precisely removes the sentinel block + plugin doc + state file.
User content outside the sentinel is preserved.

## Conservative layer still active

Adoption does NOT remove the hook-based injection (SessionStart context,
UserPromptSubmit related-memory). Those remain as fallback for older Claude
Code versions. Post-adopt the MCP `WHEN TO USE` section + the `File Lessons` /
`Key Context` sections auto-trim since the sentinel line already carries the
triggers at higher authority.

!claude-mem-lite adopt $ARGUMENTS
