// `doctor` is one command name with TWO implementations, and the router between them is a
// hand-written flag list that the code itself predicts will rot.
//
//   install.mjs doctor()   — install health check, 1007 lines, OWNS `--json`
//   cli/doctor.mjs cmdDoctor() — the DB-layer modes, 117 lines
//
// cli.mjs forwards to mem-cli only when one of three flags is present, and its own comment
// says: "Adding a NEW DB-layer mode requires extending this list — a deliberate trade for a
// working --json." Nothing checked that. `tests/cli-routing-contract.test.mjs` knows `doctor`
// is rerouted, but only lists it in ROUTED_OUTSIDE_CLI_COMMANDS; it never compares the three
// flags against the modes cli/doctor.mjs actually implements. So adding a fourth mode and
// forgetting the router sends it silently into the INSTALL health check — a real command
// answering as if it were a different one, which is the "criterion right, surface never ran"
// shape this repo has paid for before.
//
// WHAT THE DERIVATION MODELS, and why `--json` is excluded. A MODE is a top-level branch of
// `cmdDoctor` — `if (args.includes('--x'))` at two-space indentation. `--json` appears twice
// as well, at four spaces, INSIDE a mode, where it selects that mode's output format. It must
// NOT be in the router: `doctor --json` is install.mjs's documented install-health JSON, and
// forwarding it is the exact regression the router comment describes. Indentation is a model
// of this codebase's formatting rather than of JavaScript — prettier is gated in CI and
// pre-commit, so the model is enforced — and the premise cases below make a broken extractor
// fail loudly instead of quietly agreeing with an empty set.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCTOR_DB_MODES } from '../lib/doctor-modes.mjs';

// D#207: join(), never new URL('../x.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Modes cli/doctor.mjs implements: top-level `if (args.includes('--x'))` branches. */
function implementedModes() {
  const src = readFileSync(join(REPO, 'cli/doctor.mjs'), 'utf8');
  const out = new Set();
  for (const line of src.split('\n')) {
    const m = /^ {2}if \(args\.includes\('--([a-z-]+)'\)\)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Flags cli.mjs's router forwards to mem-cli's doctor.
 *
 * Read from lib/doctor-modes.mjs, which the router derives its condition from, rather than
 * from the condition's text. The separate case below asserts the router actually uses it --
 * without that, this guard would pin a constant nothing consults.
 */
function routedModes() {
  return new Set(DOCTOR_DB_MODES);
}

describe('the doctor router and the DB-layer modes describe the same set', () => {
  it('both extractors find something, and the known mode is in both', () => {
    // Premise. Two empty sets are equal, so without this the guard passes hardest exactly
    // when its extractors have stopped working.
    const impl = implementedModes();
    const routed = routedModes();
    expect(impl.size, 'no top-level mode branch found in cli/doctor.mjs').toBeGreaterThan(0);
    expect(routed.size, 'no router list found in cli.mjs').toBeGreaterThan(0);
    expect(impl.has('benchmark')).toBe(true);
    expect(routed.has('benchmark')).toBe(true);
  });

  it('every implemented mode is routed, and every routed flag is implemented', () => {
    const impl = [...implementedModes()].sort();
    const routed = [...routedModes()].sort();
    expect(
      routed,
      'cli.mjs routes `doctor --<flag>` to mem-cli for exactly these flags, and cli/doctor.mjs ' +
        'implements exactly those modes. A mode missing from the router is silently answered by ' +
        "install.mjs's health check instead; a routed flag with no mode reaches a handler that " +
        'falls through. Update cli.mjs:132-146 and cli/doctor.mjs together.',
    ).toEqual(impl);
  });

  it('the router condition is built from the constant, not from its own list', () => {
    // Otherwise routedModes() describes something the router does not consult, and the two
    // could disagree silently -- the exact failure this file exists for, one level up.
    const src = readFileSync(join(REPO, 'cli.mjs'), 'utf8');
    const router = src.split('\n').find((l) => l.includes('.some(') && l.includes('argv.slice(3)'));
    expect(router, 'no doctor router condition found in cli.mjs').toBeTruthy();
    expect(router).toContain('DOCTOR_DB_MODES');
  });

  it('--json stays with install.mjs and is never routed', () => {
    // `--json` is a per-mode output switch inside cmdDoctor, not a mode. Routing it would
    // shadow install.mjs's documented install-health JSON — the regression the router comment
    // in cli.mjs was written for.
    expect(routedModes().has('json')).toBe(false);
    // …and it really is present in cli/doctor.mjs, nested, so its exclusion is a decision the
    // extractor made rather than an accident of it not being there.
    expect(readFileSync(join(REPO, 'cli/doctor.mjs'), 'utf8')).toMatch(
      /^ {4}if \(args\.includes\('--json'\)\)/m,
    );
  });
});
