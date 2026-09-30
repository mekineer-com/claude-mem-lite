<!-- Archived from the session scratchpad: the E2E real-user round of 2026-09-29 (sub-report "install"). Findings were fixed across v6.21.0; the ledger of what was fixed is the v6.21.0 CHANGELOG entry. Paths below pointed into that scratchpad and no longer exist. -->

# install/adopt/doctor lifecycle E2E — full report (2026-09-29, tree e5085d4, v6.20.0)

Sandbox: `SBX=/run/user/1000/cml-e2e-install`, HOME=$SBX/home, code copy `$SBX/code` (git archive HEAD + repo node_modules),
fake `claude` (logs argv, keeps `scope:name` MCP state in $SBX/mcp-state.txt), fake `curl`, Node v26.8.1, npm 11.19.0.
Helpers used below: `I() { node $SBX/code/install.mjs "$@"; }`, `C() { node $SBX/code/cli.mjs "$@"; }`.
Real `~/.claude/settings.json` sha256 unchanged before/after (85b9825b…); repo `git status` clean; nothing written to
`~/.local/bin` or `/usr/local/bin` outside the sandbox; curl never invoked.

## P1

### P1-1 Install-family subcommands run for real on `--help`, `-h`, `--dry-run` and unknown flags (confidence: high)
```
I install; C uninstall --dry-run     # also: C uninstall -h / C uninstall --help
  ✓ MCP server removed: mem-lite
  ✓ CLI symlink removed: …/.local/bin/claude-mem-lite
  ✓ Hooks and plugin settings cleaned            -> hook-launcher refs 8 -> 0, MCP state emptied
I install; C cleanup-hooks --dry-run
  ✓ Removed 10 claude-mem-lite hook configurations from settings.json
C install --help   -> performs a full install (hooks 0 -> 8)
C cleanup --help   -> runs the deleting cleanup (incl. the /tmp prefix sweep, P1-4)
C doctor --help / doctor --bogus -> run doctor, rc 0
```
Expected: help text, or reject unknown flags with rc!=0. `cleanup` alone honours `--dry-run`, so users will assume the others do.
Static: `release --help` would run syncVersions + lockfile regen (not executed, forbidden).
Hint: `main()` builds `flags = new Set(argv.slice(1))`; `dispatch` never validates flags or checks help.

### P1-2 install / uninstall / cleanup-hooks delete user-authored hooks (confidence: high)
Setup settings.json with user hooks, then:
```
(a) SessionEnd: {hooks:[{command:"claude-mem-lite export > ~/backups/mem-$(date +%F).jsonl"}]}
    C uninstall  -> that SessionEnd group LOST (other user hooks kept)
(b) user appends {command:"/home/u/bin/log-stop.sh"} into OUR Stop group (natural hand-edit)
(c) user adds its own UserPromptSubmit group: "python3 ~/tools/claude-mem-lite-prompt-audit.py"
    I install    -> both (b) and (c) gone; grep count 2 -> 0; rc 0, output says only "Hooks configured"
    C cleanup-hooks -> "Removed 11 claude-mem-lite hook configurations" (10 are ours)
```
`settings.json.bak` is written once (first-ever overwrite) and did not contain (b)/(c): unrecoverable.
Expected: remove only hook entries we wrote (exact command/path match), per-hook not per-group.
Hint: `lib/hook-prune.mjs isMemHook` = group-level `.some()` + bare substring `claude-mem-lite`.

### P1-3 install and uninstall silently delete any user-scope MCP server named `mem` (confidence: high on the call; fake claude)
```
printf 'user:github\nuser:mem\nproject:other\n' > $SBX/mcp-state.txt
I install     -> claude-calls.log: "claude mcp remove -s user mem"; state now: user:github project:other user:mem-lite
```
No output line mentions it in the non-plugin branch. `mem` is a generic name; nothing checks that the entry points at
claude-mem-lite. Same call in `uninstall` and in the plugin branch (which does print "Removed stale global MCP").
Expected: `claude mcp get mem` and remove only if its command names server.mjs/claude-mem-lite.

### P1-4 `cleanup` deletes other tools' temp dirs by generic prefix (confidence: high)
```
mkdir -p $TMPDIR/mem-profiler-snapshots/run1; echo data > $TMPDIR/mem-profiler-snapshots/run1/heap.json
mkdir $TMPDIR/cite-bibtex-cache $TMPDIR/adopt-a-pet-scrape; touch -d '3 days ago' $TMPDIR/{mem-profiler-snapshots,cite-bibtex-cache,adopt-a-pet-scrape}
C cleanup
  ✓ Removed: …/tmp/adopt-a-pet-scrape
  ✓ Removed: …/tmp/cite-bibtex-cache
  ✓ Removed: …/tmp/mem-profiler-snapshots        (recursive, contents gone)
```
Roots: os.tmpdir(), ~/.claude/tmp, ~/.cache/tmp. `lib/tmp-fixture-sweep.mjs` TEST_FIXTURE_PREFIXES includes `mem-`, `cite-`,
`adopt-` — its own comment warns generic prefixes risk collateral deletion. This is the repo's test-fixture reaper
exposed in a user command that doctor recommends. `--dry-run` does list them first.

### P1-5 Permission problem on the data dir is misdiagnosed; `install` reports a phantom concurrent install and exits 0 (confidence: high)
```
chmod 000 ~/.claude-mem-lite
C doctor (rc 1): "✗ server.mjs: missing", "✗ hook.mjs: missing", "⚠ Database: not found (will be created)",
  "no claude-mem-lite code is deployed … this is a data directory with no install behind it, not a damaged one",
  "✗ Orphan hooks: 8 … Repair: node …/install.mjs uninstall"      -- never says "permission denied"
C status: "⚠ Database: not found"
I install -> "[install] Another install/repair is in progress — skipping to avoid a torn write."  rc=0
```
DB (258048 bytes, 1 row) intact after chmod 755. Expected: EACCES named with a chmod hint; install rc!=0.
Hint: `existsSync` is false on EACCES; `acquireLock` returns null for fs errors same as a live peer.

### P1-6 `adopt` overwrites a hand-edited managed block without `--force` (confidence: high)
```
cd $SBX/nogit; C adopt; (insert "MY OWN NOTE: never save secrets" inside the block); C adopt
[adopt] … → updated          grep -c "MY OWN NOTE" -> 0
```
Help: "--force  Overwrite a manually-edited managed block". Hint: `adoptOne` passes `force` only to
`migrateLegacyMemoryDir`; `writeBlockAt` always replaces.

### P1-7 `uninstall` with an unparseable settings.json is half-done but says "nothing was written" (confidence: high)
```
I install; (insert a stray comma into settings.json); C uninstall
  ✓ MCP server removed: mem-lite
  ✓ CLI symlink removed: …
  ✗ …settings.json is not valid JSON (…) — fix it first; nothing was written.      rc=1
```
MCP registration and CLI symlink are gone; hooks remain. Expected: read/validate settings before step 1.

### P1-8 `cleanup-hooks` on a plugin + direct machine leaves zero hooks (confidence: medium — plugin layout simulated by copying repo files)
```
(installed_plugins.json has claude-mem-lite@sdsrss, cache/<ver>/hooks/hooks.json 7 events, marketplace clone, enabledPlugins true)
I install  -> "✓ Marketplace plugin: hooks cleared", "1 stale hooks.json cleared"  (cache hooks events 7 -> 0)
C cleanup-hooks -> "Removed 10 …"
C doctor -> "✗ Plugin lifecycle: plugin manifest v6.20.0 registers NO hooks (empty) … every hook is unregistered
            Repair: no usable marketplace copy to restore from — reinstall the plugin"
```
cleanup-hooks is documented as "Remove only claude-mem-lite hooks from settings.json"; install destroyed the restore source too.

## P2
1. Doctor after a non-purge uninstall (code still on disk, no hooks, no MCP): "All critical checks passed (4 warnings)", rc 0, while
   `status` prints ✗ for both. Pre-install doctor exits 1. A settings.json that lost its hooks is indistinguishable and green.
2. `status` exits 0 with ✗ lines; on unparseable settings it says "fix it first; nothing was written" (a read-only command).
3. adopt → unadopt adds a trailing `\n` to a CLAUDE.md that had none (114 → 115 bytes); git shows ` M CLAUDE.md`. CRLF file was restored byte-identical.
4. adopt/unadopt write through a 0444 CLAUDE.md (mode kept, content changed) — atomic rename ignores the user's read-only intent.
5. Failed `repair` leaks `$TMPDIR/claude-mem-lite-repair-XXXXXX` (observed). Hint: `process.exit(1)` in catch skips `finally`.
6. adopt target is `$PWD` before `process.cwd()`: `execFileSync(cli,['adopt','--dry-run'],{cwd:X})` from a parent whose PWD=Y targets Y (observed).
7. `adopt --help` / `unadopt --help` print the 200-line global help; `adopt --disable/--enable` absent from help; `adopt --disable` on an
   adopted project prints "→ disabled" but leaves the block in CLAUDE.md.
8. BOM settings.json refused with an invisible char in the message ("Unexpected token '﻿'"); empty and whitespace-only settings.json also refused (nothing to lose there).
9. Fresh healthy direct install shows 3 warnings: "Plugin: not present in enabledPlugins", "Update state: no state file (first run?)",
   "Database: not found". Pre-install doctor: "all 7 hook commands name absolute paths under it" while 0 hooks are configured.
10. uninstall advises `unadopt --all` "best done BEFORE uninstall, while the CLI is still on PATH" after it already removed the symlink.
11. `adopt` prints "→ created" when it appends to an existing CLAUDE.md.
12. The garbage-DB remedy line includes `rm -f …db-wal …db-shm`; the `-wal` can hold committed rows.

## Worked
- Fresh install rc 0 (9.5 s, real npm); doctor "All critical checks passed (3 warnings)" rc 0; status all ✓/⚠.
- Reinstall idempotent: settings.json byte-identical, one `mem-lite` registration.
- Non-purge uninstall kept DB (canary obs #1 survived); reinstall reused it ("Database accessible: 1 observations").
- Unrelated keys (permissions, env with unicode, statusLine, enabledPlugins, key order) and hooks without the product name preserved
  through install/uninstall (content-equal; re-indented 4 → 2 spaces).
- Malformed settings (trailing comma, empty, BOM, null, array, whitespace) × install/uninstall/cleanup-hooks/status/doctor: all refuse,
  file byte-identical (except P1-7's side effects).
- adopt idempotent (2nd run "unchanged", bytes identical); unadopt keeps user CLAUDE.local.md notes and the user's own
  `.git/info/exclude` line; `unadopt --all` (+ `--dry-run`) correct over 3 projects, ~/.claude.json untouched; `--disable` stops
  SessionStart auto-adopt, `--enable` re-arms (writes CLAUDE.local.md + exclude entry); read-only project dir → clean EACCES rc 1.
- Garbage DB: doctor rc 1 with mv-aside remedy; no command changed the file (sha equal). Zero-byte DB untouched.
- Damaged FTS5 index: doctor detected and rebuilt it losslessly (1/1 rows, search OK).
- `repair` offline fails closed (rc 1, no curl call); `rebuild-binding` verified both trees in 0.09 s.
- `uninstall --purge` removed ~/.claude-mem-lite, left only settings.json `{}` + .bak and ~/.cache/node-gyp.
