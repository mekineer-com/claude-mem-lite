---
name: mem
description: "Use when: querying past work, managing memories, checking project history, or saving session findings"
---

# Memory

## Commands

- `/mem search <query>` — FTS5 full-text search
- `/mem recent [n]` — Recent observations (default 5)
- `/mem recall <file>` — File history before editing
- `/mem timeline <id>` — Browse around an observation
- `/mem save <text>` — Save a note
- `/mem stats` — Memory statistics
- `/mem cleanup [Nd]` — Purge stale data

## Efficient Workflow (saves 10x tokens)

1. `mem_search(query)` → compact ID index
2. `mem_timeline(anchor=ID)` → surrounding context
3. `mem_get(ids=[...])` → full content only when needed
