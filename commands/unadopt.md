---
name: unadopt
description: "Use when: user wants to remove the invited-memory sentinel from the current project (or all projects with --all). Cleans MEMORY.md sentinel block + plugin_claude_mem_lite.md + state sidecar. User content outside the sentinel is preserved. Benign no-op on never-adopted memdirs."
---

# /unadopt

Remove the claude-mem-lite invited-memory sentinel from the current project's
Claude Code memdir. Opposite of `/adopt`.

## What it removes

1. The `<!-- claude-mem-lite:begin vN --> ... <!-- claude-mem-lite:end -->`
   block from `MEMORY.md` (plus the preceding `## 插件契约` header line it owns).
2. `plugin_claude_mem_lite.md` detail file.
3. `.plugin_claude_mem_lite_state.json` sidecar.

Everything else in `MEMORY.md` is preserved byte-for-byte.

## Flags

- `--all` — unadopt every memdir under `~/.claude/projects/*/memory/`

## Aftermath

Once unadopted, the conservative hook layer (SessionStart `File Lessons` /
`Key Context`, MCP instructions `WHEN TO USE`) goes back to verbose mode —
Claude Code will see the full injection again on the next session start.

!node ${CLAUDE_PLUGIN_ROOT}/cli.mjs unadopt $ARGUMENTS
