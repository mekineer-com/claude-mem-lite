// A filter flag this command does not read must SAY SO, not quietly widen the answer.
//
// `parseArgs`'s own docblock names this harm twice and fixes two of its three causes:
// `--include_noise` (underscore spelling) and `--obs_type` (an MCP field name) both parsed,
// matched no reader, and "the command then answers the unfiltered question with no signal".
// `suggestUnknownFlags` fixes a third case, flags unknown to the whole CLI.
//
// The cause left open is the one where nothing is misspelled at all: the flag is canonical
// and valid — for a DIFFERENT command. `--type` is real on `search`, `save` and `export`, so
// it clears the global known-flag set, and `browse` never reads it. Measured on a seeded
// corpus before the fix (three rows, one per type):
//
//     $ claude-mem-lite browse --type bugfix
//     📊 Memory Dashboard (work--proj)
//       #3 🟢 [feature] FEATURE ROW
//       #2 🟡 [decision] DECISION ROW
//       #1 🔴 [bugfix] BUGFIX ROW      ← exit 0, no warning, filter silently dropped
//
// while `search "row" --type bugfix` on the same corpus correctly returns the bugfix alone —
// which is exactly why the user has no reason to doubt the browse output.
//
// The check is a read-tracking one, not a per-command flag manifest: `parseArgs` hands back a
// flags object that records which keys anything actually looked at, so a flag forwarded into
// a core helper counts as read and cannot produce a false alarm. Scope is deliberately the
// SELECTION-shaped flags (`FILTER_FLAGS`) — those are the ones whose silent drop returns a
// wider set that reads as the answer. A `--confirm` that a short-circuited branch never
// reached is not in scope, because there the output is not wrong.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FILTER_FLAGS, KNOWN_CLI_FLAGS } from '../cli/common.mjs';

// D#207: join(), never new URL('../x.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'cli.mjs');

let ROOT, WORK, ENV;

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: WORK,
    env: ENV,
    encoding: 'utf8',
    timeout: 60000,
  });
}

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'inert-flag-'));
  WORK = join(ROOT, 'work', 'proj');
  for (const d of [join(ROOT, 'home'), join(ROOT, 'data'), WORK]) mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  ENV = {
    ...env,
    HOME: join(ROOT, 'home'),
    CLAUDE_MEM_DIR: join(ROOT, 'data'),
    // Without this the seeding `save` rewrites THIS repo's own CLAUDE.md and sidecar.
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_NO_DELAY: '1',
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
  };
  for (const [text, type, title] of [
    ['the parser crashed on empty input', 'bugfix', 'BUGFIX ROW'],
    ['we chose sqlite over postgres', 'decision', 'DECISION ROW'],
    ['added a retry loop', 'feature', 'FEATURE ROW'],
  ]) {
    const r = cli(['save', text, '--type', type, '--title', title]);
    if (r.status !== 0) throw new Error(`seed failed: ${r.stdout}\n${r.stderr}`);
  }
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

describe('FILTER_FLAGS is a subset of the catalogued flags', () => {
  it('every selection flag is one the CLI already knows', () => {
    // The two guards must not disagree about what exists. A name here that is absent from
    // KNOWN_CLI_FLAGS would be reported by suggestUnknownFlags AND by this one — two notices
    // for one mistake — and it would mean the catalogue is missing a flag some command reads.
    const strays = [...FILTER_FLAGS].filter((f) => !KNOWN_CLI_FLAGS.has(f));
    expect(strays, `not in KNOWN_CLI_FLAGS: ${strays.join(', ')}`).toEqual([]);
    expect(FILTER_FLAGS.size).toBeGreaterThan(5);
  });

  it('covers the inclusion toggles, whose harm runs the other way', () => {
    // These widen or narrow the SET rather than filter within it, and an ignored
    // `--include-noise` hands back FEWER rows than the user asked for. "I searched and it was
    // not there" is the worst answer a memory tool can give, so silence costs more here than
    // on a narrowing filter, not less.
    for (const f of ['include-noise', 'include-compressed', 'deep', 'no-deep', 'or', 'rerank', 'all']) {
      expect(FILTER_FLAGS.has(f), `${f} is not covered`).toBe(true);
    }
  });

  it('excludes flags that are read off raw argv instead of the flags object', () => {
    // `doctor --benchmark --prompts-limit N` is parsed straight out of process.argv in
    // cli/doctor.mjs and never touches a flags object, so read-tracking cannot see it being
    // used. Including it here would call a documented, working flag inert. The same applies
    // to any future argv-parsed flag — this case is the reminder, not an exhaustive check.
    expect(FILTER_FLAGS.has('prompts-limit')).toBe(false);
  });
});

describe('premise: --type really does filter on a command that reads it', () => {
  it('search --type bugfix returns the bugfix row and not the others', () => {
    // Without this the whole file could pass on a corpus where nothing matches anything,
    // and "browse showed every type" would say nothing about a dropped filter.
    const r = cli(['search', 'row', '--type', 'bugfix']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('BUGFIX ROW');
    expect(r.stdout).not.toContain('DECISION ROW');
    expect(r.stdout).not.toContain('FEATURE ROW');
  });
});

describe('a selection flag the command never reads is reported', () => {
  it('browse --type warns that the results are unfiltered', () => {
    const r = cli(['browse', '--type', 'bugfix']);
    // The output itself is unchanged — browse has never filtered by type and this is not a
    // new feature. What changes is that the user is told.
    expect(r.stdout).toContain('BUGFIX ROW');
    expect(r.stdout).toContain('DECISION ROW');
    expect(r.stderr, `stderr was:\n${r.stderr}`).toMatch(/--type/);
    expect(r.stderr).toMatch(/browse/);
  });

  it('citation-stats --project warns', () => {
    const r = cli(['citation-stats', '--project', 'no-such-project']);
    expect(r.stderr, `stderr was:\n${r.stderr}`).toMatch(/--project/);
  });

  it('reports an inclusion toggle the command does not read', () => {
    // `--all` is real, and belongs to `memdir-audit` (_resolveMemdirsForAudit). `defer list`
    // never reads it, so a user asking for the full deferred list silently gets the default
    // page. Found by the correct-usage sweep for this batch — the sweep line was the mistake,
    // not the product, and the warning it produced was right.
    const r = cli(['defer', 'list', '--all']);
    expect(r.status, `defer list should succeed:\n${r.stderr}`).toBe(0);
    expect(r.stderr, `stderr was:\n${r.stderr}`).toMatch(/--all/);
  });

  it('stays quiet for a command that parses its own raw argv', () => {
    // The false alarm this batch shipped and then fixed. `unadopt --all` is documented in
    // adopt-cli.mjs's own header and implemented by unadoptAll(), but adopt/unadopt receive
    // the raw `cmdArgs` array and never touch the object parseArgs returns — so read-tracking
    // cannot see the flag being consumed and reported a working flag as ignored. Blindness
    // must present as silence. Same class as `prompts-limit`, which FILTER_FLAGS excludes by
    // name; this is the per-COMMAND half of that rule.
    const r = cli(['unadopt', '--all', '--dry-run']);
    expect(r.stderr, `stderr was:\n${r.stderr}`).not.toMatch(/ignored|UNFILTERED/);
  });

  it('stays quiet for optimize, the one DB command that parses its own argv', () => {
    // Found by the pre-ship review, not by the sweep that shipped the list: the sweep
    // enumerated the DB-command family and `optimize` reads --project and --scope with
    // args.indexOf() at mem-cli.mjs:3505,3518, so read-tracking sees them supplied and never
    // read. The notice said "the results above are UNFILTERED" directly under stdout's own
    // `Project filter: demo`.
    const r = cli(['optimize', '--project', 'demo']);
    expect(r.stderr, `optimize --project warned:\n${r.stderr}`).not.toMatch(/was ignored/);
    const r2 = cli(['optimize', '--scope', 'wide']);
    expect(r2.stderr, `optimize --scope warned:\n${r2.stderr}`).not.toMatch(/were? ignored/);
  });

  it('stays quiet for a flag that LOST a precedence contest', () => {
    // `--deep` and `--no-deep` are both real `search` flags and `--deep` wins. The resolution
    // was a ternary, so the winning arm short-circuited before `flags['no-deep']` was ever
    // touched, and read-tracking concluded nobody read it. The notice then said `search`
    // "does not filter on" --no-deep and that the results were UNFILTERED — both false.
    // Losing a contest is not the same as not being read.
    const r = cli(['search', 'row', '--deep', '--no-deep']);
    expect(r.stderr, `search --deep --no-deep warned:\n${r.stderr}`).not.toMatch(/was ignored/);
  });

  it('stays quiet for doctor, which selects its mode off raw argv', () => {
    const r = cli(['doctor', '--metrics']);
    expect(r.stderr, `stderr was:\n${r.stderr}`).not.toMatch(/ignored|UNFILTERED/);
  });

  it('stays quiet for an inclusion toggle the command DOES read', () => {
    // Control for the case above, on the same flag family: search consumes --include-noise.
    const r = cli(['search', 'row', '--include-noise']);
    expect(r.status, `search should succeed:\n${r.stderr}`).toBe(0);
    expect(r.stderr, `stderr was:\n${r.stderr}`).not.toMatch(/had no effect|unfiltered/i);
  });

  it('names every inert flag, not just the first', () => {
    const r = cli(['browse', '--type', 'bugfix', '--since', '7d']);
    expect(r.stderr).toMatch(/--type/);
    expect(r.stderr).toMatch(/--since/);
  });
});

describe('it stays quiet where the flag is read', () => {
  // These are the controls. A warning that fires on correct usage is worse than the silence
  // it replaces, so each one below is a command that DOES consume the flag — through its own
  // body (`browse --tier`) or by forwarding the whole flags object into a core helper
  // (`search --type`, `export --type`), which is the case a per-command manifest would have
  // got wrong.
  for (const [name, args] of [
    ['browse --tier (read in its own body)', ['browse', '--tier', 'working']],
    ['browse --limit', ['browse', '--limit', '3']],
    ['browse --project', ['browse', '--project', 'work--proj']],
    ['search --type (forwarded to the pipeline)', ['search', 'row', '--type', 'bugfix']],
    ['search --source', ['search', 'row', '--source', 'obs']],
    ['export --type (forwarded)', ['export', '--type', 'bugfix']],
    ['recent --type', ['recent', '5', '--type', 'bugfix']],
    ['recall --limit', ['recall', 'nothing.mjs', '--limit', '3']],
    ['stats --project', ['stats', '--project', 'work--proj']],
    ['timeline --anchor', ['timeline', '--anchor', '1']],
    ['no flags at all', ['browse']],
  ]) {
    it(name, () => {
      const r = cli(args);
      expect(r.stderr, `${name} warned on correct usage:\n${r.stderr}`).not.toMatch(
        /had no effect|unfiltered/i,
      );
    });
  }

  it('stays quiet when the command FAILED before anything could read the flag', () => {
    // The one false alarm the correct-usage sweep turned up. `activity search` requires a
    // query; without one it fails its own usage check before `flags.limit` is ever touched,
    // so the flag really is unread — and the notice said "the results above are UNFILTERED"
    // under an error message, about results that do not exist.
    const r = cli(['activity', 'search', '--limit', '3']);
    expect(r.status, 'premise: this invocation must fail, or the case proves nothing').toBe(1);
    expect(r.stderr).toMatch(/query required/);
    expect(r.stderr, `stderr was:\n${r.stderr}`).not.toMatch(/UNFILTERED/);
  });

  it('still warns on the same command when it succeeds with an inert flag', () => {
    // The other half of the exit-code gate: suppressing on failure must not suppress
    // everything. `activity recent` succeeds and does not filter by --branch.
    const r = cli(['activity', 'recent', '--branch', 'main']);
    expect(r.status, `activity recent should succeed:\n${r.stderr}`).toBe(0);
    expect(r.stderr, `stderr was:\n${r.stderr}`).toMatch(/--branch/);
  });
});

describe('the warning is a warning', () => {
  it('goes to stderr and leaves stdout and the exit code alone', () => {
    const withFlag = cli(['browse', '--type', 'bugfix']);
    const without = cli(['browse']);
    expect(withFlag.status).toBe(without.status);
    // Byte-identical stdout: a consumer piping `browse` into another program must not see
    // the notice. Titles and ids are stable across the two runs on a frozen corpus.
    expect(withFlag.stdout).toBe(without.stdout);
    expect(without.stderr).not.toMatch(/had no effect|unfiltered/i);
  });
});
