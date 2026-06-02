# Experiment corpus

One `*.task.json` per task (schema: `../task-schema.json`). Plus `shuffled-pool.json`
— a bank of irrelevant memories for the negative-control arm.

## Selecting tasks (avoid survivorship bias)

The unit is the `mem_save` contract's own test: *could a future session touching
this file have avoided this bug if it saw the lesson?* Mine real history for cases
where a bug/decision was captured **and** a later task touched the same
file/subsystem.

- **SEEDED set** — the memory exists in DB (the normal case).
- **HOLDOUT set** — withhold the memory deliberately, to counter the survivorship
  bias the citation-decay loop introduces (it keeps what gets cited).
- **STALE probe** — include a few tasks whose `capturedMemory` references
  now-deleted/renamed code (`"stale": true`) to measure whether stale injection is
  net-negative (Claude wastes turns chasing dead references).

Aim for **≥ 20 complete pairs** before trusting bootstrap CIs.

## Writing a task

- `startCommit` — a SHA in the state **before** the captured bug was fixed.
- `prompt` — the coding task, phrased as a user would (don't leak the fix).
- `regressionCheck` — a shell command, run in the sandbox after the task, that
  **exits 0 when the bug is absent**. Make it depend on behavior, not on the
  presence of a specific test file (the agent may not write the same test).
- `capturedMemory` — what a prior session would have saved. Seeded into treatment
  via the production `saveObservation` pipeline, so it is indexed exactly like a
  real memory.

See `example-fk-cascade.task.json` — it uses this repo's own warm-start FK bug as
a worked example, with a behavioral `regressionCheck`.
