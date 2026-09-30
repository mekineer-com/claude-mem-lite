<!-- Archived from the session scratchpad: the E2E real-user round of 2026-09-29 (sub-report "bg"). Findings were fixed across v6.21.0; the ledger of what was fixed is the v6.21.0 CHANGELOG entry. Paths below pointed into that scratchpad and no longer exist. -->

# claude-mem-lite background/unattended flows — E2E report (2026-09-29)

Tree: `converge/20260929-e2e-user` @ `2aeb875` (v6.20.0), read-only. Sandbox `/run/user/1000/cml-e2e-bg` (deleted at the end).
Every repro script lives in this scratchpad and seeds its own sandbox project and mock:
`bg-mode.sh <mode> [scenario]` (fresh home per mock mode, runs a scenario, waits for workers, dumps rows),
`bg-b.mjs` (Edit + Write + passing `npm test` + Stop), `bg-c.mjs` (same, no Stop), `bg-d.mjs` (3 turns / 3 Stops),
`bg-age.sh` + `bg-age-passes.sh` (aged two-project corpus + 4 simulated daily passes), `bg-xp.sh` (cross-project dedup),
`bg-mock.mjs` (failure-mode `claude` CLI: MOCK_MODE = stock | vary | fixed | garbage | empty | nonzero | wrongtypes |
huge | hang | fenced | imp0 | nolesson-change | inject | sumwrong | suminject | merge-notitle | merge-full | slow | slowbug),
`bg-db.mjs` (sqlite helper), `bg-wait.sh` (waits for detached workers that belong to one sandbox HOME), and
`bg-netlog.mjs` (a NODE_OPTIONS preload that logs every outbound connection).

---

## P1-A: When the background LLM fails, a code-edit episode is lost, contradicting README "Zero data loss"

README.md:91 says: "Zero data loss -- If LLM fails, observations are saved with degraded (inferred) metadata instead of being discarded".

**Repro:** `for m in stock garbage empty nonzero wrongtypes huge hang; do $SP/bg-mode.sh $m; done`
The episode is `Edit src/server.js` + `Write src/validate.js` + a passing `npm test`, then Stop.

| mock | LLM calls | observations after workers finish |
|---|---|---|
| stock | episode + summary | 1 (`Mock episode summary`) |
| garbage (non-JSON prose) | episode | **0** |
| empty stdout | episode | **0** |
| exit 1 + `overloaded_error 529` | episode | **0** |
| wrong JSON types | episode | **0** |
| 8 MB reply (ENOBUFS) | episode | **0** |
| hang, killed at 45 s | episode | **0** |

Re-run from a wiped sandbox: stock gave 1 row, garbage 0, nonzero 0.

**Mechanism:** Stop's immediate pre-save builds `Modified server.js, validate.js`. `saveObservation` drops it as noise (`isNoiseObservation`). The stderr shows `saveObservation: dropped noise: Modified server.js, validate.js`. So `savedId` is never set. The worker's failure branch then calls `buildImmediateObservation` → `saveObservation`, which drops the same title again (hook-llm.mjs:1288-1298, noise gate hook-llm.mjs:303). A comment at hook-llm.mjs:310-318 admits that a dropped pre-save "loses" LLM-failure survival.

Only episodes that already qualify at importance ≥2 survive: config/schema/.env files, or an error at rule importance 2.

**Same loss, other triggers (verified):**
- `kill -9` of the llm-episode worker, which is the effect of a laptop sleep, reboot or OOM. The `ep-flush-*.json` stays on disk. The next SessionStart does not re-process it, and the 1 h orphan sweep later deletes it. Result: 0 rows.
- Semaphore timeout takes the same degraded branch.

**Invisible to the user:**
- `doctor` prints `✓ LLM provider: claude CLI` even with `CLAUDE_CODE_PATH=/nonexistent/claude`. `lib/llm-provider-probe.mjs` returns `ok` for CLI mode without probing.
- `stats` shows `Hook errors (last 24h): 0`.
- Worker stderr is `stdio: 'ignore'`.

**Confidence:** high on the mechanism. The drop is deliberate noise gating, so the defect is that the promise and `doctor` disagree with what the code does.

## P1-B: Fuzzy auto-dedup crosses projects, so project A's memory is tombstoned because project B has a near-copy

**Repro:** `$SP/bg-xp.sh`. Two projects (`app`, `app-worktree`) each save `Added title validation to addTodo in server.js` with the same body and lesson. Then SessionStart's `auto-maintain xp--app` runs.

**Observed:**
- `fuzzy auto-deduped 1`.
- Row #1 (project `xp--app`) gets `superseded_by='auto-dedup-fuzzy'`.
- `recent` in project app prints `No recent observations (xp--app)`.
- `get 1` shows "⚠ RETRACTED", even though the row carried a valid lesson.
- `recall src/server.js` from app lists only the other project's row.

**Expected:** dedup stays within a project. The exact-dedup channel already joins on `a.project = b.project`.

**Code:** hook.mjs:2089-2095. The `recent` SELECT has no project column. `selectFuzzyDedupeIds` (lib/maintain-core.mjs:127) never compares projects. This violates the CLAUDE.md invariant "cross-project ops must compare both rows' projects first".

**Real-world triggers:** git worktrees or two checkouts of one repo, and templated tasks such as "Bump version", "Update deps" or "Fix lint". The newer row wins (`keep = i`, scan is DESC), so the OLDER project loses.

**Confidence:** high.

## P1-C: Nightly maintenance hard-deletes an inactive project's old memories, but hides the booting project's identical rows

**Repro:** `$SP/bg-age.sh; $SP/bg-age-passes.sh`. This builds 45-day-old importance-1 rows with no lesson, never accessed, in `alpha` and in `beta`, then runs 4 daily `auto-maintain alpha` passes.

**Observed:**
- Pass 1: alpha's rows #5/#6 → `compressed_into=-1` (COMPRESSED_AUTO, retained). Beta's identical-shape rows #10/#11 → `-2` (PENDING_PURGE).
- Pass 2: `purged 2 stale observations`, and beta reads `Total: 0 observations`.
- Before the purge, `stats --project beta` labelled the doomed rows `Compressed: 2`, which reads as "summarized".

**Mechanism:**
- `markAutoCompressible(db, project)` runs only for the project that booted (hook.mjs:1920, per-project gate).
- `decayAndMarkIdle` runs whole-DB under the global 24 h gate. Every other project's rows therefore get PENDING_PURGE instead of AUTO.
- `purgeStale` anchors retention on `created_at_epoch` (37 d). A backlog older than 37 d gets one day of grace, not 7.

**Consequences:**
- With two projects used daily, whichever project is opened second each day loses rows that the first one keeps.
- Pre-maintain `.bak` snapshots exist but `retain=3`, and nothing tells the user they exist.

**Confidence:** high on the mechanism. Intent unclear.

## P1-D: A weekly summary is itself hidden within 2 maintenance passes, so the whole compressed week becomes unsearchable

Same repro (`bg-age-passes.sh`).

**Observed:**
- Pass 2: auto-compress folds #1–#4 into #13 `Weekly summary: 4 discovery observations` (importance 2).
- Pass 3: `decayed 1` takes #13 from 2 to 1.
- Pass 4: `auto-compressed 1` sets #13 to `-1`.
- Afterwards `search "Parser nested brackets"` and `search "Weekly summary"` in alpha both return `No results`.

**Cause:** `compressGroup` backdates the summary to its sources' median epoch (lib/compress-core.mjs:95). The summary is therefore already past the 30-day `staleAge`, and the decay → mark path consumes it on the next two runs.

**Confidence:** high.

## P2

1. **Session-summary `lessons`/`key_decisions` elements are not type-checked.** Repro: `bg-mode.sh sumwrong`. The stored value is `[123,null,{"evil":"obj"},"real lesson here"]`, and SessionStart injects `Lessons: 123; ; [object Object]`. The one real lesson is displaced. hook-llm.mjs:1613-1616 only checks `Array.isArray`. A model that returns `[{"lesson":…}]` shapes would hit this.
2. **cluster-merge accepts `{"should_merge":true}` with no `merged_title`.** Repro: MOCK_MODE=merge-notitle with two similar bugfix saves, then `optimize --run --task cluster-merge`. The keeper's title becomes `''` and search/recent show `(untitled)`. smart-compress refuses the same shape (`if (!parsed.title) return`, hook-optimize.mjs:1561). A snapshot keeps the original, so it can be recovered.
3. **save-enrich writes a model-invented lesson onto a MANUAL save** without re-attribution or a grounding check. `save … --type bugfix` with no lesson → the CLI says "saved without a lesson — capture the root cause…" → about 1 s later `lesson_learned` holds model text. The row stays `memory_session_id=manual-…`, so search shows no 🤖 marker, at importance 2 (injectable). cluster-merge already re-attributes (D#138).
4. **The summary worker waits 15 s for flush files; a CLI-mode bugfix/decision episode with the lesson retry takes longer.** Two calls plus a 2–5 s delay. With 8 s per call (`MOCK_MODE=slowbug MOCK_SLOW=8`), or 20 s for one call (`slow`), the summary worker proceeds without the observation. Mostly moot today because of known D#95 (events are never fed to the summary: a bugfix-only session gives `no-obs` even when the LLM is fast, verified with MOCK_SLOW=0). It matters once D#95 is fixed.

## Known / by-design (not filed)

- PostToolUseFailure never feeds the episode buffer, so failed test runs are not in the episode prompt (findings.md:11, deliberate).
- D#95: the model summary reads only `observations`.
- COMPRESSED_AUTO rows are reachable only by `get <id>` (restore rejects -1 by design).
- `change` + no-lesson rows are dropped even when the LLM succeeds.

## Worked (evidence)

- Happy path: 1 episode → 1 enriched row, flush file removed, no leftovers.
- Three turns / three Stops → 3 observations, 1 summary row (no duplicates). Earlier summary workers were superseded.
- Secrets: 4 credential shapes (GitHub PAT, Anthropic key, AWS key id, postgres password in a URL) in prompt / command / error output → 0 hits in LLM prompt logs, 0 hits across all 34 tables.
- Prompt-injection text from the LLM (`</claude-mem-context>`, `<system-reminder>`) has its tags stripped in SessionStart and search. Only 1 closing tag in the envelope. LLM-origin events are capped at importance 1.
- Fenced JSON is parsed.
- `imp0` and `nolesson-change` replies drop the row as designed.
- No `ep-flush`/`pending` residue after any normal run.
- A dead worker's `llm-sem-<pid>` slot is reclaimed.
- The hung CLI is killed at 45 s and the worker exits.
- Offline: with `CLAUDE_MEM_SKIP_UPDATE=1`, a full session (start, tools, Stop, workers, search, save + enrich) made **0** outbound connections. Ruler positive-controlled: fetch/net.connect logged. **Disclosure:** my positive-control run with SKIP_UPDATE unset made one real read-only update check (GET `api.github.com/repos/sdsrss/claude-mem-lite/releases/latest` and `/tags?per_page=1`, via the configured proxy, allowInstall=false).
- auto-compress is idempotent (second run: nothing). Pre-maintain VACUUM snapshot is written when a purge is due.
- The update check stays offline under SKIP_UPDATE.
