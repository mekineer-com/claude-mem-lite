// A reader that leaves is not an error.
//
// `claude-mem-lite search x | head -1`, `| grep -q`, or quitting `less` closes the read end
// while the CLI is still writing. Node then emits 'error' on the stdout Socket, and with no
// listener that is an UNHANDLED error event: a ~20-line stack ending in `outVerbatim` where
// the user expected their prompt back.
//
// NOT every command, measured rather than generalised (20 trials each, pre-fix, `| head -1`):
// `search` / `export` / `recent` / `stats` / `doctor` / `timeline` / `citation-stats` 20/20,
// `browse` 19/20, and `help` / `status` / `context` / `get` / `memdir-audit` 0/20. What
// decides it is whether a write is still pending when the reader goes — a function of how
// many lines the consumer takes and how the output is batched, NOT of the 64 KB pipe buffer:
// pre-ship review found `stats` crashing at `head -20` on an output far under that buffer
// (its size is corpus dependent, so no byte count is quoted). An earlier draft of this
// header said "every stdout-bearing command" and blamed the buffer; both were wrong, and
// the pre-ship claims lens measured them.
//
// WHAT THIS FILE CAN AND CANNOT SAY NO ABOUT — stated because the first draft shipped an arm
// that could not, and it looked identical to one that could.
//
// The fix is one listener in `cli.mjs`, the published `bin`, rather than at
// `cli/common.mjs`'s `out()` chokepoint. The reason is a claim about population: `doctor`
// writes through `console.log` inside `install.mjs` and never passes through
// `cli/common.mjs`, so a chokepoint fix would have covered the mem-cli half and left the
// installer half loud. That claim is MEASURED, outside this suite, against a
// listener-removed mutant of cli.mjs: `doctor | head -1` crashed 10/10 with the stack ending
// `console.log → ok()` inside install.mjs, and 0/10 with the listener restored. (Named by
// function, not by line: a line number in a file this diff also edits is stale on arrival.)
//
// It is measured outside the suite because it cannot be measured inside it. In a vitest
// worker the same spawn reads `epipe=false, outLen=0, errLen=0` on the MUTANT, against
// `epipe=true` standalone — reproducible in both directions. WHY is not established: the
// obvious explanation (the write fails synchronously in-worker and `console.log`'s
// `ignoreErrors: true` swallows it) was probed directly by the pre-ship claims lens and did
// NOT hold — that probe read sync=false / async=EPIPE in both contexts. So the reading is
// the finding and the mechanism is open; do not repeat the swallowed-sync story as if it
// were settled. Either way a `doctor` arm here would be GREEN on a build with no listener at
// all — a structurally blind ruler, whose NEUTRAL says nothing. The shell-pipe shape is blind
// in-suite too (0/5 on the mutant for BOTH commands). The only in-suite shape that
// discriminates is closing the read end immediately after spawn, and only on the mem-cli
// route.
//
// So the installer route is pinned by the source arm below rather than behaviourally: it
// fails if the listener is moved, narrowed, or turned into a swallow, which is the whole set
// of edits that would re-open the install.mjs half.
//
// Two further shapes are recorded so the next edit does not reach for them: `status` never
// reaches a failing write in any shape (0/10 on the mutant), and `search` on an EMPTY data
// dir emits one line, so `| head -1` consumes all of it and nothing ever writes to a closed
// pipe. A guard built on either would be vacuous and would look exactly like this one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// D#207: join(), not new URL(...) — the URL form drops the named module out of knip's
// report entirely. Pinned for the class by tests/no-url-module-paths.test.mjs.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

let dir;

beforeAll(() => {
  // HOME and CLAUDE_MEM_DIR both sandboxed: the CLI resolves an install shape out of HOME,
  // and an unsandboxed run would read (and `adopt` would write to) the machine running the
  // suite.
  dir = mkdtempSync(join(tmpdir(), 'cli-broken-pipe-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the CLI with its stdout read end closed before it can write, and return whatever
 * reached stderr so an assertion can name what it rejected.
 */
function runWithClosedStdout(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: dir,
        CLAUDE_MEM_DIR: join(dir, 'data'),
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.destroy();
    child.on('close', (code) => resolve({ stderr, code }));
  });
}

describe('CLI survives a consumer that closes the pipe', () => {
  it('mem-cli route does not surface an unhandled EPIPE', async () => {
    // 10/10 red against the listener-removed mutant, 10/10 green with it — the one arm here
    // that is behavioural AND discriminating in-suite.
    const { stderr } = await runWithClosedStdout(['help']);
    expect(stderr).not.toMatch(/EPIPE/);
    expect(stderr).not.toMatch(/Unhandled 'error' event/);
  });

  it('keeps the listener at the bin entry, covering the install.mjs route too', () => {
    // Stands in for the behavioural doctor arm the suite cannot run (see the header). It is
    // a source assertion, so it pins placement and shape — not the runtime effect — and that
    // is exactly the set of regressions that would re-open the installer half: moving the
    // listener out of cli.mjs, or widening it so every stdout fault is discarded.
    const src = readFileSync(CLI, 'utf8');
    expect(src).toMatch(/process\.stdout\.on\('error'/);
    expect(src).toMatch(/err\.code === 'EPIPE'/);
    // EPIPE is dropped; everything else is rethrown. A classifier, not a blanket swallow —
    // the same charter `explainBrokenInstall` follows one screen above it. Dropping this
    // rethrow would silence every non-EPIPE stdout fault.
    expect(src).toMatch(/throw err;/);
  });

  it('does not force-exit on EPIPE, which would discard the process verdict', () => {
    // The first cut called `process.exit(0)` here. `runDoctor` assigns
    // `process.exitCode = 1` AFTER its last print, so the forced exit landed first and
    // `doctor | head -1` under `pipefail` read 0 on 10/10 runs while the unpiped command
    // reads 1 — silently turning a failing `claude-mem-lite doctor || alert`, the wrapper
    // install.mjs's own exit-code contract names, into a passing one. Pinned in source
    // because reproducing it needs a shell with `pipefail` around a pipeline, which the
    // in-suite probe shapes cannot express (see the header).
    const src = readFileSync(CLI, 'utf8');
    const listener = src.match(/process\.stdout\.on\('error',[\s\S]*?\n\}\);/);
    expect(listener).not.toBeNull();
    expect(listener[0]).not.toMatch(/process\.exit\(/);
  });
});
