# Invited-Memory Template (for other Claude Code plugins)

Reusable blueprint for any Claude Code plugin that wants to raise its
MCP-tool invocation rate without polluting user memory. Based on the design
shipped in claude-mem-lite v2.32 — see
`docs/plans/2026-04-16-invited-memory-pattern.md` for the full rationale.

> **TL;DR** — one ≤150-char sentinel-wrapped line in `MEMORY.md`, version-tagged,
> hash-guarded, opt-in. Keep your passive hook / CLI layer unchanged as fallback.

---

## 1. Fork checklist

Replace `<plugin-slug>` with your plugin's kebab-case name (e.g. `my-plugin`).

- [ ] Copy `memdir.mjs` into your plugin (it has no plugin-specific code).
- [ ] Write your own `adopt-content.mjs` exporting:
      `PLUGIN_SLUG = '<plugin-slug>'`,
      `CURRENT_SENTINEL_VERSION = 'v1'`,
      `getIndexLine()` (≤150 chars; one animation-anchored line),
      `getDetailDoc()` (full contract — on-demand Read).
- [ ] Copy `adopt-cli.mjs` structure, substituting your slug.
- [ ] Register `adopt` / `unadopt` subcommands in your plugin's CLI.
- [ ] Add Claude Code slash commands `commands/adopt.md` + `commands/unadopt.md`
      that shell out to your CLI (`!<plugin-slug> adopt $ARGUMENTS`).
- [ ] In your MCP server / hook-injection builder, branch on
      `isAdopted(memdirPath(cwd), PLUGIN_SLUG)` to emit a slim version when
      the sentinel is present.

---

## 2. The sentinel block

Exact shape that `writePluginSection` renders:

```markdown
<!-- <plugin-slug>:begin v1 -->
## 插件契约
- [<plugin-slug>](plugin_<slug_snake>.md) — <trigger 1>; <trigger 2>
<!-- <plugin-slug>:end -->
```

Rules:
- The header line is always `## 插件契约` — this is the shared section other
  invited-memory plugins also append under, so users see one section per their
  file, not N scattered plugin blocks.
- The content line must be ≤150 characters and must name concrete tool
  invocations — not abstract intent. "Before X do Y" beats "consider using Y".
- Version tag `v<N>` in the sentinel lets adopters upgrade in-place.

---

## 3. Non-negotiables (lessons from claude-mem-lite)

1. **Never silent-write on install.** Only auto-adopt for your own dogfood
   repo (detected via `git remote get-url origin` matching your canonical
   URL). Other users opt in explicitly.

2. **Hash-guard via sidecar state.** Write `.plugin_<slug>_state.json` next
   to `MEMORY.md` containing the last body hash. If a user edits the sentinel
   body between adopts, refuse to overwrite unless `--force`.

3. **Budget-gate new inserts.** Refuse insertion when `MEMORY.md` already
   has > 180 lines. Claude Code truncates `MEMORY.md` content at ~200 lines,
   and other plugins may later need room too.

4. **Keep the fallback layer.** Your existing hook / MCP-instruction verbose
   output must stay in source. Conditional trim should be a runtime branch,
   not a delete. This is essential because auto-memory is not guaranteed in
   every Claude Code version or non-CC harness.

5. **Clean unadopt.** `unadopt` must touch only your sentinel block + your
   plugin doc + your state sidecar. Never remove user-authored lines or other
   plugins' sentinels.

6. **Path encoding = strip non-alphanumerics.** Claude Code mangles every
   `[^a-zA-Z0-9]` character to `-` when forming the project slug under
   `~/.claude/projects/<encoded>/`. Use the same regex — don't try to be
   clever with URL encoding or hashing.

---

## 4. Anti-patterns

- ❌ Writing content into `~/.claude/CLAUDE.md` — that's the user's global
  indicator file; modifying it affects every project and every conversation
  type (writing, chat, coding).
- ❌ Silent auto-adopt on every project.
- ❌ Writing multi-line prose to `MEMORY.md` — it's designed as a 150-char
  index, not an essay page.
- ❌ Removing your fallback hook layer "because adopt is better" — different
  users have different Claude Code versions / harnesses; fallback is cheap
  insurance.
- ❌ Cross-plugin shared sentinel protocol — each plugin manages its own
  sentinel scoped by its slug. Shared protocols invite turf wars.

---

## 5. Suggested CLI surface

```
<plugin> adopt                # this project
<plugin> adopt --all          # every memdir under ~/.claude/projects/*
<plugin> adopt --force        # override user-edit guard
<plugin> adopt --dry-run      # preview
<plugin> adopt --status       # list adopted projects + version
<plugin> unadopt              # remove, this project
<plugin> unadopt --all        # remove everywhere
```

Exit code 0 for benign states (`absent`, `unchanged`). Exit code 1 only for
hard failures (`UserEditedError` without `--force`, `BudgetExceededError`).

---

## 6. Reference implementation

`memdir.mjs`, `adopt-content.mjs`, `adopt-cli.mjs` in the claude-mem-lite
repo are the canonical reference. Tests covering path encoding, sentinel IO,
hash-guard, budget enforcement, and `--all` batch semantics live in
`tests/memdir.test.mjs` and `tests/adopt-cli.test.mjs`.
