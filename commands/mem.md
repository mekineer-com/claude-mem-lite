---
description: "Search and manage project memory (observations, sessions, prompts). Use when: user asks about past work, wants to find a previous bugfix, check project history, save a decision, or manage stored memories"
---

# Memory

Search and browse your project memory efficiently.

## Quick Commands

- `/mem search <query>` — Search all memories (FTS5 full-text search)
- `/mem recent [n]` — Show recent N observations (default 5)
- `/mem recall <file>` — History for a file before editing
- `/mem timeline <id>` — Browse timeline around an observation
- `/mem save <text>` — Save a manual memory/note
- `/mem stats` — Show memory statistics
- `/mem cleanup` — Scan and interactively purge stale data
- `/mem cleanup [N]d` — Purge stale data older than N days (e.g. `cleanup 60d`)
- `/mem cleanup keep [N]d` — Purge stale data but retain last N days (e.g. `cleanup keep 14d`)

## Instructions

When the user invokes `/mem`, parse their intent:

- `/mem search <query>` → run `claude-mem-lite search <query>` via Bash
- `/mem recent` or `/mem recent 20` → run `claude-mem-lite recent [N]` via Bash
- `/mem recall <file>` → run `claude-mem-lite recall <file>` via Bash
- `/mem timeline <id>` → run `claude-mem-lite timeline --anchor <id>` via Bash
- `/mem save <text>` → call `mem_save` MCP tool with the text as content
- `/mem stats` → run `claude-mem-lite stats` via Bash
- `/mem get <ids>` → run `claude-mem-lite get <ids>` via Bash
- `/mem cleanup` → run `mem_maintain(action="scan")`, report pending purge count and stale items to user, ask for confirmation, then run `mem_maintain(action="execute", operations=["purge_stale"])` if confirmed
- `/mem cleanup Nd` (e.g. `60d`) → same as above but use `retain_days=N` to only purge items older than N days
- `/mem cleanup keep Nd` (e.g. `keep 14d`) → same as above with `retain_days=N`
- `/mem <query>` (no subcommand) → treat as search, run `claude-mem-lite search <query>` via Bash

Use Bash commands first. For detailed data, use `claude-mem-lite get <id>` via Bash.
