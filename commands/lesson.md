---
name: lesson
description: "Use when: capturing a non-obvious lesson/gotcha/workaround after a tricky fix or surprising behavior. Writes to the mem events table (NOT memdir). Skip for typos, renames, or user-preference rules."
---

# /lesson

Record a lesson / gotcha / workaround. Writes to the mem `events` table
with `event_type='lesson'`. Does NOT touch memdir — so lessons never end up
in the L1 system-prompt memory section and do not conflict with the
`WHAT_NOT_TO_SAVE` semantics sdscc enforces.

## When to use

After you (or the user) solve a tricky bug or discover a non-obvious behavior:

- "you need to call X before Y or the test hangs"
- "don't use this import path — it shadows the real module"
- "the API returns null when you pass empty string, even though docs say it throws"

Don't use for trivial fixes (typos, renames), for rules that belong in memdir
(user preferences, project-wide conventions), or for general project notes
(use `/mem:memory` or `mem_save` instead).

## Arguments

- Positional text: the lesson description (what went wrong + root cause + fix).
- `--file <path>`: scope to a specific file. The lesson will surface via
  pre-tool-recall the next time the file is opened via Edit/Write.
- `--files f1,f2,f3`: comma-separated list for multiple files.
- `--importance <1|2|3>`: default `2`. Use `3` for critical lessons you always
  want surfaced; `1` for minor gotchas.

## Execution

Run via Bash — the CLI takes the lesson text as positional args and stores
the full text as the title (the `activity save` command uses title-as-body
when `--body` is absent):

    claude-mem-lite activity save \
      --type lesson \
      --title "<first 60 chars of text>" \
      --body "<full text>" \
      [--file <path> | --files f1,f2,...] \
      --importance <1|2|3>

Confirm to user with: `Lesson saved: activity #<id>`.

## Examples

- `/lesson fix a bug now` — stores a short lesson for the current project; no file scope.
- `/lesson --file src/auth.mjs "session cookies must be httpOnly or the e2e tests bleed across browsers"` — file-scoped.
- `/lesson --files src/a.mjs,src/b.mjs --importance 3 "both modules share a cache via WeakMap; clearing one invalidates the other"` — multi-file, high importance.
