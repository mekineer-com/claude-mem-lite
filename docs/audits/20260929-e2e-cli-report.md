<!-- Archived from the session scratchpad: the E2E real-user round of 2026-09-29 (sub-report "cli"). Findings were fixed across v6.21.0; the ledger of what was fixed is the v6.21.0 CHANGELOG entry. Paths below pointed into that scratchpad and no longer exist. -->

# CLI e2e report — claude-mem-lite @ e5085d4 (branch converge/20260929-e2e-user), 2026-09-29

Tester: e2e CLI agent. Sandbox `SBX=/run/user/1000/cml-e2e-cli` (deleted at the end).
Every repro assumes the preamble:

```
export SBX=/run/user/1000/cml-e2e-cli
SP=/tmp/claude-1000/-home-ai-dev-claude-mem-lite/95bd8d19-9f78-439f-bddd-a6792f984f32/scratchpad
. $SP/sbx-env.sh; cd "$PROJ"
git init -q . 2>/dev/null; mkdir -p src out; echo x > src/app.mjs; git add -A; git -c user.email=t@t -c user.name=t commit -qm init 2>/dev/null
```

Node v26.8.1. LLM = scripts/mock-claude.mjs (via CLAUDE_CODE_PATH).

---

## P0 — data loss

### P0-1 `restore` drops distinct rows as "duplicates", including rows OLDER than their "duplicate"; no override

Two shapes, same cause.

(a) Round trip into an EMPTY data dir loses rows:
```
for i in $(seq 1 25); do cml save "Pagination test entry number $i about widgets and gadgets" --force >/dev/null; done
cml export > $SBX/out/all.json            # 25 rows
CLAUDE_MEM_DIR=$SBX/fresh node $REPO/cli.mjs restore $SBX/out/all.json --dry-run
#  -> "25 would be restored (at most), 0 duplicate(s) would be skipped"
CLAUDE_MEM_DIR=$SBX/fresh node $REPO/cli.mjs restore $SBX/out/all.json
#  -> re-run exactly as written: "Restore: 1 restored, 24 duplicate(s) skipped, 0 malformed/failed from 25 row(s)."
#     (24 of 25 distinct rows lost; the titles and bodies all differ)
```
(b) Restoring an OLD backup into a live DB drops an old row when a NEWER row looks similar:
```
export CLAUDE_MEM_DIR=$SBX/win
cml save "Pagination test entry number 1 about widgets and gadgets"      # saved today
node -e 'require("fs").writeFileSync(process.env.SBX+"/out/june2.json",JSON.stringify([{project:"cml-e2e-cli--proj",type:"change",title:"Pagination test entry number 99 about widgets and gadgets",narrative:"Pagination test entry number 99 about widgets and gadgets",importance:2,created_at:"2026-06-01T10:00:00.000Z",created_at_epoch:Date.parse("2026-06-01T10:00:00Z"),lesson_learned:"june lesson unique"}]))'
cml restore $SBX/out/june2.json     # -> "0 restored, 1 duplicate(s) skipped"
cml search "june lesson unique"     # the June row (and its lesson) is gone
```
Expected: a backup restores every row it holds, or at least names the rows it skipped and offers `--force`.
The skip is shown only as a count, labelled "duplicate" even though these rows are not duplicates.
Cause (checked in the code): `mem-cli.mjs:cmdRestore` calls `saveObservation` with `now: new Date(createdEpoch)` and no `force`.
The near-dup window in `lib/save-observation.mjs` (~l.233) is `created_at_epoch > now-5min` with no UPPER bound.
With a past `now`, every later row (top 50 in the project) is compared, not just the rows from the 5 minutes around it.
Population: `--force` saves, the weekly summaries (the code comment itself measured 10→9), and any old backup row resembling a recent row.
Confidence: high (both reproduced).

---

## P1 — wrong behaviour

### P1-1 `fts-check check` reports "healthy" when the FTS index has drifted from its content
```
# on a COPY of a DB: drop the observations_* triggers, UPDATE observations SET title='zzz',text='...',narrative='nothing' WHERE id=1, then recreate the triggers
cml fts-check check     # -> "FTS5 indexes are healthy — all integrity checks passed." exit 0
cml search race         # -> still returns #1 (title now "zzz"; the word "race" is no longer in the row's text)
```
On the same file, SQL `INSERT INTO observations_fts(observations_fts, rank) VALUES('integrity-check',1)` fails with "database disk image is malformed".
The rank-0 form, which is the one the CLI runs, passes.
Cause (checked in the code): `schema.mjs:checkFTSIntegrity` runs integrity-check without `rank=1`.
For `content='observations'` (external-content) tables, SQLite then does not compare the index against its content table.
`fts-check rebuild` does fix the drift.
Confidence: high on the mechanism. I produced the drift by hand; how often it happens in the wild is unmeasured.

---

## P2 — UX / misleading / inconsistent

1. **`recent N --limit M` gives a false warning.** The command reads `--limit`, but when both are given it prints "--limit was ignored — `recent` does not filter on it, so the results above are UNFILTERED". Help calls `--limit` an alias of `[N]`. Repro: `cml recent 3 --limit 5`. Confidence: high.
2. **`search --json` hides the "no valid terms" signal.** `cml search "AND"` exits 1 with "No valid search terms". `cml search "AND" --json` exits 0 and returns `{"total":0,…}` with no error/note field. Confidence: high.
3. **`search` silently drops FTS operators, sometimes flipping the meaning.** `cml search "NOT race"` and `cml search "race -writer"` both return #1, which contains "writer". Help says "FTS5 search" and there is no notice. Confidence: high.
4. **`get` truncates despite "Get full details by ID".** Narrative is cut at 1000 chars, title and files/concepts/aliases at 200, with "…" and no flag to see the rest. `--fields narrative` is truncated too. Repro: `cml save "$(node -e 'console.log("a ".repeat(3000))')"; cml get <id>`. Code: `mem-cli.mjs:renderObsRows` maxLen. Confidence: high.
5. **Export help says "complete backup by default", but compressed originals are left out silently.** The stderr note mentions only superseded rows. With `--include-compressed`, `restore` rejects those rows anyway ("12 compressed member(s) rejected"). Confidence: high.
6. **`search --source` and `get --source` use different words for the same thing.** `search` accepts only observations|sessions|prompts|events. `get` accepts only obs|session|prompt|event. Each rejects the other's spelling, and search JSON labels rows `"source":"obs"`. Confidence: high.
7. **`recall` matches on the basename only, across all directories and projects.** `recall src/app.mjs` also returns `tests/fixtures/app.mjs` rows and rows from other projects. `recall --project` is "ignored — UNFILTERED". The search path-hint also says "3 observation(s) are linked to that file" when only 1 is. This matches the intent of `lib/file-edge-match.mjs`; I am reporting the user-visible effect. Confidence: high.
8. **A save from a git subdirectory splits the project.** Run from `src/` with `CLAUDE_PROJECT_DIR` unset:
   - `recent` shows the root project `cml-e2e-cli--proj`;
   - `save` writes to a new project `proj--src`;
   - after that, `recent` from `src/` shows only `proj--src`, and the root memories drop out of view.

   This is deliberate according to `mem-cli.mjs:17-23`; I am reporting the effect on the user. Confidence: high.
9. **Bad `--project` values are handled inconsistently.** `recent --project` with no value quietly lists ALL projects, while `save`/`search` error out. `recent --project .` looks up a project literally named "." and returns nothing, while `optimize` documents `.` as meaning the current project. Confidence: high.
10. **`timeline` without an anchor is cross-project, but `recent` is scoped to the project.** The fallback list mixes in rows from `otherproj`. Confidence: high.
11. **Numeric-flag validation is inconsistent.**
    - Invalid `--limit`/`--days`/`--offset`/count on search, recent, browse, stats, citation-stats, defer list and activity recent → warning, default used, exit 0.
    - `compress --age-days`, `optimize --max` and `save --importance` → exit 1.
    - `recent 5000` falls back to 10 instead of clamping to the documented max of 1000.
12. **Bad ids in `--closes-deferred` and `--supersedes` are handled differently.** A bad `--closes-deferred` aborts the save (exit 1). A bad `--supersedes` saves anyway and exits 0 with a warning.
13. **`maintain scan` "Total active: 50" counts superseded rows.** The live count is 48 (browse and recent agree with 48; stats' tier line says "live 48 … + 2 superseded").
14. **`maintain execute --ops dedup` without `--merge-ids` does nothing silently.** It prints only "FTS5 index optimized". `--merge-ids 31:9999` and cross-project `31:48` print "Merged 0" with no reason.
15. **`restore` exits 0 when no row could be restored.** A file where every row is malformed (`[{"foo":1}]`) gives "0 restored … 1 malformed/failed" and exit 0.
16. **The CLI gives no next step on a corrupt DB.** On a damaged file, every memory command prints only "Cannot open database: database disk image is malformed". `doctor` has the remedy (set the file aside / the backup path), but the CLI does not point to it. Code: `mem-cli.mjs` ~l.3828 generic branch.
17. **A read-only DB blocks reads too.** With the DB and its directory chmod'ed read-only, even `search`, `recent`, `get`, `stats` and `export` fail with "attempt to write a readonly database".
18. **`CLAUDE_MEM_DIR=/proc/x` hangs.** `node cli.mjs recent` spins at 99% CPU forever. This is Node's own `mkdirSync(recursive)` looping on persistent ENOENT; `node -e 'fs.mkdirSync("/proc/x",{recursive:true})'` hangs the same way. It only matters for exotic paths; a dangling symlink errors cleanly.
19. **`activity save` output format is inconsistent.** It prints raw `{"ok":true,"id":1}` where every other save prints "[mem] Saved #N".
20. **Minor text issues:**
    - a decision saved without a lesson is nudged to "capture the root cause + fix";
    - `stats --quality` shows internal jargon ("R-2 watchdog", "R-6 manual-save contract");
    - `get` shows the label `files:`, but `--fields files` is rejected (it must be `files_modified`);
    - `delete abc` does not name the bad token (`get` does);
    - `update` on a retracted row gives no warning;
    - the `timeline --anchor` error text leaves out E#N;
    - text starting with `--` can be saved only via `--text=--x` (`--` and `--text "--x"` both fail);
    - `search --json` `files_modified` is a JSON-encoded string, not an array.

---

## Worked correctly (coverage)

- **help**, and save across all 6 types:
  - importance, --files, --lesson (the 500-char cap is enforced), --title, CJK text, emoji, quotes, newlines, 10k-char text (stored intact, searchable);
  - near-dup guard, and --force;
  - --closes-deferred (valid, missing, abc);
  - --supersedes: valid, missing, abc, already-superseded, and cross-project (refused with a reason).
- **Secret scrubbing** (sk-ant, ghp_, AKIA, password=) on save, update, defer and activity, including the title, lesson and files.
- **search:**
  - --type, --since, --from/--to (invalid dates rejected, a reversed range gets a note), --sort, --or, --project, --importance, --tier, --branch;
  - offset/limit pagination: 5 pages × 5 covered all 25 rows with no duplicates, and total stayed consistent;
  - FTS special characters: no crashes and no SQL injection; a 10k-char query returns in about 0.1s with the header truncated;
  - CJK↔English expansion.
- **get:** N, #N, S#/P#/E#/D#, mixed, partial miss (note on stderr), abc/#/0/-1/1e3 (exit 1).
- **Other read commands:** timeline --anchor / --query / P#, E# anchors, and retracted-anchor redirect; recall --json; browse (text and JSON); stats (text and JSON; totals agree with browse, recent and export when superseded rows are accounted for); context and --chars; citation-stats.
- **Every `--json` output parsed as valid JSON**, including the error shapes of timeline.
- **Writes and lifecycle:**
  - update: all fields, plus the empty/invalid guards; FTS re-indexes after update;
  - delete: preview vs --confirm, and missing ids;
  - defer: add/list/drop, by ordinal and D#, reason required; drop of a non-open item is refused;
  - activity: save/recent/search/show/delete/promote.
- **Backup and import:**
  - export: json/jsonl, filters, invalid format/type/date;
  - restore: idempotent re-run (0 restored, 45 skipped), --project override, JSONL with a bad line, missing/empty/broken files;
  - fields that survive a round trip: every exported field except subtitle (null→""), including access_count, memory_session_id, created_at, lesson, aliases;
  - import-jsonl: file and directory; a re-run is a no-op; an export file is rejected with a clear hint.
- **Maintenance:** fts-check check/rebuild; maintain scan/execute and merge-ids; compress preview/execute on 60-day-old rows; optimize preview, bad flags, and a cluster-merge run with the mock LLM.
- **Concurrency and project detection:**
  - 20 concurrent saves: all exit 0 and 21/21 rows are present;
  - subdirectory and non-git project detection;
  - a data dir that is a file, and a 0-byte DB file, both handled cleanly.
