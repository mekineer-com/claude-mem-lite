<!-- Archived from the session scratchpad: the E2E real-user round of 2026-09-29 (sub-report "session"). Findings were fixed across v6.21.0; the ledger of what was fixed is the v6.21.0 CHANGELOG entry. Paths below pointed into that scratchpad and no longer exist. -->

# Session-lifecycle e2e report — claude-mem-lite, branch converge/20260929-e2e-user, 2026-09-29

Tree: runs spanned 2aeb875 → 6261775 (another agent committed 4e7218c, 0facb10, 6261775 meanwhile: install/uninstall + maintain-dedup only; none touches the session-id, handoff, episode, pre-tool-recall or project-identity code tested here). Line refs are against 6261775.

Harness: `drive.mjs` (hooks fired exactly as `hooks/hooks.json` declares, real-format transcript JSONL),
sandbox `$SBX=/run/user/1000/cml-e2e-sess` (deleted at the end), host semantics checked against the
installed Claude Code bundle 2.1.284. LLM = `sess-e2e/mock2.mjs`, a mock that echoes the UPPER_UPPER
tracer tokens of its input into titles/summaries so attribution is visible in the DB.

Repro scripts: `<scratchpad>/sess-e2e/` — `. sess-e2e/env.sh` (rebuilds the sandbox git project),
then `reset_home; node $S/<script>.mjs`. Every P1 below was re-run from these copies in a fresh
sandbox before the sandbox was deleted.

Host facts used (from the 2.1.284 bundle, not from memory):
- Subagent hook payloads carry the PARENT's `session_id` plus `agent_id`/`agent_type`
  (`return{session_id:e.id,transcript_path:…,agent_id:s?.agentId,agent_type:g,…}`).
- SessionStart matcher values the host emits: `startup, resume, clear, compact, fork`. The plugin matches
  `startup|clear|compact` only, so on `claude --resume` and on `fork` **no plugin hook fires**.
- PreCompact exit-0 stdout = "appended as custom compact instructions"; UserPromptSubmit / SessionStart
  exit-0 stdout = "shown to Claude" (plain text is a valid form).

No P0 found (no crash, no hook non-zero exit on a realistic payload, well-formed `<private>` never stored).

---

## P1-1 A session's own earlier turn arms the handoff injector, which then injects a DIFFERENT session's handoff

Mechanism: `detectContinuationIntent` counts the current session's OWN exit handoff (written by its own
previous Stop) as evidence — HEAD anchor `hook-handoff.mjs:724` `(type = 'exit' OR session_id = ?)`,
short-prompt shortcut `:743` (`promptText.length < 40 → true`), keyword stage `:809` (`OR type = 'exit'`,
then scores `validHandoffs[0]`, which is the session's own newest row). `pickHandoffToInject` `:878`
EXCLUDES own exit rows (`session_id != ?`) and returns the newest unconsumed exit handoff of any other
session within 7 days. Detect and pick disagree on the population.

Repros (all deterministic):
- `d2-chain.mjs`: Y (ECHO_FEATURE) → X (FOXTROT_DOCS) → Z: `继续` correctly injects X; Z's next prompt
  `ok do it` injects **Y's** handoff ("Resumed context from previous session (exit…)", ECHO_FEATURE), i.e.
  it walks back through history one unrelated session per short follow-up.
- `d-seq.mjs Y; age.mjs 20; d-seq.mjs X`: new task FOXTROT_DOCS, prompt 1 (long) correctly injects nothing;
  prompt 2 `also add a usage example` injects yesterday's ECHO_FEATURE handoff + its summary.
- `o-resume.mjs`: `claude --resume` of session R (QUEBEC_TASK) after Q ran; R's `now add the tests` gets
  **Q's** ROMEO_DOCS handoff.
- `d3-nogit.mjs` (no git): same via the keyword stage — a follow-up that overlaps the session's own task
  (`In the FOXTROT_DOCS README section, also explain…`) injects ECHO_FEATURE.
Observed vs expected: expected no injection for turns 2–3 of a session about its own task. Also consumes the
other session's row, so that session's real resume later finds nothing.
Frequency: any session whose 2nd/3rd prompt is short (<40 chars, same HEAD) while any other unconsumed exit
handoff < 7 days exists — i.e. most sessions. Confidence: high.

## P1-2 Concurrent same-project sessions share one internal session id → handoff, summary and episodes bleed

Mechanism: `runtime/session-<project>` (`hook-shared.mjs:380`) and `ep-<project>.json` (`hook-episode.mjs:46`)
are per PROJECT. The second session's SessionStart `createSessionId()` (`hook.mjs:2889`) overwrites the file,
so every later hook of the first session runs under the second session's id. The D#26 cc-scoping then falls
back to the UNSCOPED prompt set (`hook-handoff.mjs:137`, meant for /clear) because the first session has no
prompts under the new id.
Repro `a-concurrent.mjs` (A: ALPHA_ERR validation; B started while A open: BRAVO_DOCS README):
- A's exit handoff `working_on` = **B's prompt** ("Write a README section BRAVO_DOCS…").
- `session_summaries` has ONE row (B's internal id): A's Stop wrote A's report into it, B's next Stop
  overwrote it → A's summary text ("addTodo now throws ALPHA_ERR…") is gone from the table.
- A's later episode is stored under B's `memory_session_id`; the LLM summary of that id merges both
  (`REQ[ALPHA_ERR+BRAVO_DOCS]`).
- A's original `sdk_sessions` row stays `active` forever; A's Stops mark B's row completed.
Repro `a4-clear-concurrent.mjs`: A runs `/clear` while B is open → the new session's "Working State (from
/clear)" and its `继续` injection read `OSCAR_TASK … → Write PAPA_DOCS changelog entry` (B's prompt merged
into A's handoff). Confidence: high.

## P1-3 Subagent and main thread share lesson dedup/cooldown but not context → lessons never reach the thread that edits

Mechanism: pre-tool cooldown (`scripts/pre-tool-recall.js:283` `cooldownPathFor(sessionId)`) and the
injected-ids marker are keyed by `session_id`; subagents send the parent's `session_id` (host fact above)
but do not see the parent's context, and vice versa.
Repro `f3-subagent-edit.mjs` (seeded bugfix lesson #1 on src/server.js, `seed_lesson`):
- `main-first`: main Read ✓ / main Edit ✓ / **subagent Read ✗ / subagent Edit ✗**
- `sub-first`: subagent Read ✓ / subagent Edit ✓ / **main Read ✗ / main Edit ✗**
- `f2-subagent-dedup.mjs prompt-inject`: a lesson injected at UserPromptSubmit (main only) suppresses it for
  the subagent's Read too.
Expected: each thread gets the lesson once. Impact: implementer-subagent workflows edit files without the
recorded lesson. Confidence: high.

## P1-4 Project identity `parent--basename` collides across unrelated repos (monorepo subdirs, Claude Code worktrees)

Repro `run-identity.sh`: session in `work/shop/packages/api` saves work; a session in the unrelated
`work/blog/packages/api` gets it in SessionStart "Last Session" (2 hits) and on `继续` receives and CONSUMES
shop's handoff (3 hits). Same for `<repo>/.claude/worktrees/feat2` in two repos (`worktrees--feat2`).
Conversely the same repo's worktree (`../shop-feat`, `.claude/worktrees/feat2`) and root see nothing of each
other (the subdir split is documented at `project-utils.mjs`; the cross-repo collision is not).
Expected: no cross-repo context. Privacy-adjacent (text from one codebase injected into another).
Confidence: high on mechanism; frequency depends on monorepo/worktree usage.

## P1-5 Cross-session bugfix nudge: B is told to save a lesson for A's fix

Mechanism: `hook.mjs:603` builds the hint from the WHOLE mixed buffer (`buildUnsavedBugfixHint(episode)`),
not per cc-session sub, and delivers it to whichever session's hook caused the flush.
Repro `a3-nudge.mjs`: buffer `A:Bash(hard error) | B:Edit | A:Edit`; B's next unrelated edit flushes it and B
(writing docs) receives "⚠ Unsaved bugfix-shape … Save now … /lesson --file server.js"; A never gets it.
Confidence: high (needs two sessions in one project within one buffer window).

---

## P2

- **P2-1 Session open >12h loses its task statement from the handoff** (`q-12h.mjs`): SESSION_EXPIRY_MS
  rotates the internal id mid-session; the exit handoff (upserted per cc id) becomes
  `Working On: ok keep going`, and the first half's "Not done" disappears. Overnight sessions hit this.
- **P2-2 Crash (no Stop) leaves no handoff and no summary** (`g-crash.mjs`): the buffer IS saved as an
  observation (good), but the next SessionStart shows nothing about the crashed work and `继续` injects
  nothing; the crashed session's row stays `active`. The prev-session recovery branch in
  `handleSessionStart` is gated to `source != startup/resume`, so a crash followed by `startup` never
  reaches it. Only the crashed turn is lost when earlier turns stopped normally.
- **P2-3 Short new-task first prompt gets stale context**: `add a LICENSE file` (next day, same HEAD)
  injects yesterday's handoff as "Resumed context" — `<40 chars + HEAD unchanged ⇒ continue` heuristic
  (`hook-handoff.mjs:743`). `继续 / continue / where were we` correctly inject; a long unrelated prompt
  correctly does not.
- **P2-4 "### Last Session" has no age and no cap** (`hook-context.mjs:954`): a summary aged 100 days
  (`age.mjs 2400`) renders identically to one from an hour ago, "Remaining/Next" included.
- **P2-5 /compact**: every compaction rotates the internal id (one CC session → 3 `sdk_sessions` rows, the
  last `active` with 0 prompts, summaries fragmented); the post-compact Working State reads
  `Working on: 继续` (a meta prompt stored verbatim when it is the only prompt); a short post-compact prompt
  (if within the first 3 prompts) is framed "Resumed context from previous session (clear…)" for its own
  session (`e-clear-compact.mjs`).
- **P2-6 Malformed `<private>` fails open** (`j-private.mjs`): well-formed and case variants are stripped
  everywhere (DB, runtime, LLM input — 0 hits). Stored in the DB, sent to the summarizer and re-injected via
  "Past similar questions": unclosed `<private>PRIV…` (tested behaviour), attribute form
  `<private reason="pii">`, and the tail after an inner close in nested blocks.
- **P2-7 Protocol text stored as user prompts**: `/mem search X`, `<command-name>` blocks,
  `<local-command-stdout>`, `<bash-input>` all land in `user_prompts` and the summary's `request`;
  `<task-notification>` is correctly skipped.
- **P2-8 Same-session prompt echo**: "Past similar questions" returns the session's own earlier prompts
  (scenario A, `h-long.mjs`, `i-ups-race.mjs`: 1/12). No current-prompt self-echo under a parallel-hook race
  (0/12).
- **P2-9 Sidechain text becomes the session summary** (`f-subagent.mjs`): an `isSidechain:true` assistant
  entry written after the main reply becomes `completed`. Low impact: the repo measured 0 such records in
  parent transcripts of current hosts.
- **P2-10 `resume`/`fork` never reach the plugin**: matcher `startup|clear|compact` (hooks.json +
  install.mjs twin) vs host values incl. `resume, fork`; `hook.mjs:2875`'s `resume` branch is dead code.
  A forked session's first short prompt can then inject (and consume) the parent's exit handoff.
- **P2-11 setup.sh writes 2–3 `✓` lines to stderr on every successful SessionStart.**

## Worked (evidence)

- Hook contract (`chk.mjs contract()`): 869 hook runs over the 12 contract-checked runs (A+B 32, a2 11,
  a3 22, Y 11, X 13, E 27, F 18, G 16, H 641, J 28, K 23, M 27): every realistic payload exit 0, stdout
  empty / one JSON / plain text only on UserPromptSubmit and PreCompact (host takes text there), none over
  70% of its timeout. Flagged: setup.sh stderr (P2-11) and Stop with `transcript_path=/dev/zero` (not a
  real host payload) SIGKILLed at 12.9 s.
- Path-shaped `session_id` (`../../etc/passwd`) stays inside runtime/ (sanitised filename).
- Long session `h-long.mjs`: 300 tool calls, 13 Stops → 36 observations, 8 summary calls, p95 PostToolUse
  173 ms / 5 s, Stop p95 229 ms; runtime/ ended at 7 files, sandbox data dir 404 KB.
- Stop vs transcript size (`n-bigtranscript.mjs`): 24 MB 284 ms, 65 MB 447 ms, 121 MB 538 ms (timeout 5 s).
- Repeated Stops (`k-stops.mjs`, 9 Stops incl. `stop_hook_active`): 1 summary row, 1 handoff row.
- /clear (`e-clear-compact.mjs`): Working State + `继续` restore the pre-clear task.
- Subagent capture filter: subagent Read/Grep/Bash and out-of-project Edit stay out of the buffer; the
  in-project subagent Edit is kept. `pre-agent-inject.sh` drains stdin, exits 0 in 3 ms.
- Post-compact lesson delivery (`p-compact-cooldown.mjs`): SessionStart(compact) re-carries #1 and the next
  Edit re-surfaces it.
- PreCompact stdout premise holds on 2.1.284 (appended as compact instructions).
- Citation counting was NOT evaluated: the harness does not write hook output into the transcript the way
  the host does, so `access_count 0` there says nothing.
