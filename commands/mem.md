---
name: mem
description: Search and manage project memory (observations, sessions, prompts)
---

# Memory Skill

Search and browse your project memory efficiently.

## Commands

- `/mem search <query>` — FTS5 full-text search across all memories
- `/mem recent [n]` — Show recent N observations (default 10)
- `/mem save <text>` — Save a manual memory/note
- `/mem stats` — Show memory statistics
- `/mem timeline <query>` — Browse timeline around a matching observation
- `/mem cleanup` — Scan and interactively purge stale data
- `/mem cleanup [N]d` — Purge stale data older than N days (e.g. `cleanup 60d`)
- `/mem cleanup keep [N]d` — Purge stale data but retain last N days (e.g. `cleanup keep 14d`)

## Efficient Search Workflow (3 steps, saves 10x tokens)

1. **Search** → `mem_search(query="...")` → get compact ID index
2. **Browse** → `mem_timeline(anchor=ID)` → see surrounding context
3. **Detail** → `mem_get(ids=[...])` → get full content for specific IDs

## Instructions

When the user invokes `/mem`, parse their intent:

- `/mem search <query>` → call `mem_search` with the query
- `/mem recent` or `/mem recent 20` → call `mem_search` with no query, limit=N
- `/mem save <text>` → call `mem_save` with the text as content
- `/mem stats` → call `mem_stats`
- `/mem timeline <query>` → call `mem_timeline` with the query
- `/mem cleanup` → run `mem_maintain(action="scan")`, report pending purge count and stale items to user, ask for confirmation, then run `mem_maintain(action="execute", operations=["purge_stale"])` if confirmed
- `/mem cleanup Nd` (e.g. `60d`) → same as above but use `retain_days=N` to only purge items older than N days
- `/mem cleanup keep Nd` (e.g. `keep 14d`) → same as above with `retain_days=N`
- `/mem <query>` (no subcommand) → treat as search, call `mem_search`

Always use the compact index from mem_search first, then mem_get for details only when needed. This minimizes token usage.
