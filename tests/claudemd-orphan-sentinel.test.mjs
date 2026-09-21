// QA round 1 — an unpaired sentinel makes the managed-block regex span arbitrary user text,
// and `unadopt` reports success over a file it did not clean.
//
// The block is located by ONE non-greedy regex over the whole file:
//   <!-- slug:begin (v\d+) -->\r?\n([\s\S]*?)\r?\n<!-- slug:end -->
// `[\s\S]*?` happily spans a SECOND begin marker, so the matched region is not necessarily
// one block. Drop the end marker by hand (a merge resolution, an editor, another tool) and
// the next two adopts do this — measured 2026-09-13 on a sandbox project:
//
//   [1] adopt, then the user appends "## Deployment runbook / STEP ONE…"   STEP ONE: 1
//   [2] the `:end` line is deleted by hand                                  STEP ONE: 1
//   [3] adopt  -> appends a second block below the user's text              STEP ONE: 1
//       file is now: begin1 body1 <no end> …USER TEXT… begin2 body2 end2
//   [4] adopt  -> the regex matches begin1 …lazily… end2, which SPANS the
//       user's text and begin2, and `raw.replace(m[0], section)` deletes it  STEP ONE: 0
//
// Four damage shapes measured over 40 adopt iterations each, counting adopts AFTER the
// damage. Two never return to one well-formed block, one converges on the SECOND such adopt
// by DESTROYING the user's text, and one was already fine:
//   end deleted        unadopt "absent" | adopt begin=2/end=1 | 2nd adopt DELETES user text
//   begin deleted      unadopt "absent" | adopt begin=1/end=2 | never converges
//   version tag broken unadopt "absent" | adopt begin=2/end=2 | never converges, block twice
//   blank line added   unadopt "removed" — fine, the body pattern already allows it
//
// Two fixes, one root cause each:
//   (a) the body may not contain another sentinel, so a match is always exactly one block;
//   (b) removeManaged must not answer 'absent' when it deleted the sidecar files or left an
//       orphan sentinel behind. That report is what silenced the SINGLE-project `unadopt`.
//       The `--all` sweep is a different surface: it gates on hasResidue and never reached
//       an orphan-only project at all — and after pre-ship review P2-3 it deliberately still
//       does not, because a sentinel in prose is not evidence the plugin ever wrote there.
//
// The shipped block body carries no `slug:begin` / `slug:end` literal (measured: 1304 bytes —
// 1296 UTF-16 units — the slug appearing twice, never as a sentinel), so (a) cannot reject a
// legitimate block. A test now pins that property; it is what the tightened pattern rests on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'node:url';
import {
  writeManaged,
  removeManaged,
  readBlock,
  hasResidue,
  claudeMdPath,
  detailDocPath,
} from '../claudemd.mjs';
import { buildClaudeMdBlock } from '../adopt-content.mjs';

// dirname(fileURLToPath(...)) + join, never new URL('../x', import.meta.url): the URL form
// drops the module out of knip's report (tests/no-url-module-paths.test.mjs guards this).
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const SLUG = 'claude-mem-lite';
const BLOCK = '## managed\n\nsteering line one\nsteering line two';
const DOC = '# detail\n\nbody';
const V = 'v1';
const args = () => ({ slug: SLUG, version: V, block: BLOCK, doc: DOC });
const USER_TAIL = '\n## Deployment runbook\n\nSTEP ONE: rotate the key.\nSTEP TWO: drain the queue.\n';

describe('an unpaired managed sentinel must not eat user content or be reported as clean', () => {
  let tmpHome, cwd, origHome, md;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cml-orphan-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'CLAUDE.md'), '# My Project\n\n- Rule one: never force-push.\n');
    md = claudeMdPath(cwd);
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const read = () => readFileSync(md, 'utf8');
  const count = (re) => (read().match(re) || []).length;
  const adoptWithTail = () => {
    writeManaged(cwd, args());
    writeFileSync(md, read() + USER_TAIL);
  };

  it('adopt never deletes user text once the end sentinel is gone (the data-loss path)', () => {
    adoptWithTail();
    expect(count(/STEP ONE/g), 'premise: the user tail is there to lose').toBe(1);
    writeFileSync(md, read().replace(/<!-- claude-mem-lite:end -->\n?/, ''));
    expect(count(/claude-mem-lite:end/g), 'premise: the end sentinel is gone').toBe(0);

    writeManaged(cwd, args());
    expect(count(/STEP ONE/g), 'lost on the first re-adopt').toBe(1);
    writeManaged(cwd, args());
    expect(count(/STEP ONE/g), 'lost on the second re-adopt').toBe(1);
    expect(count(/STEP TWO/g)).toBe(1);
    expect(count(/Rule one/g)).toBe(1);
  });

  it('a begin sentinel inside the span stops the match — the block is exactly one block', () => {
    // The literal shape step [3] leaves behind. readBlock must pick the WELL-FORMED pair,
    // not the span from the orphan begin to the far end marker.
    writeFileSync(
      md,
      [
        '# My Project',
        '',
        `<!-- ${SLUG}:begin v1 -->`,
        'orphaned body',
        '',
        '## Deployment runbook',
        'STEP ONE: rotate the key.',
        '',
        `<!-- ${SLUG}:begin v1 -->`,
        'the real body',
        `<!-- ${SLUG}:end -->`,
        '',
      ].join('\n'),
    );
    const blk = readBlock(cwd, SLUG);
    expect(blk.body).toBe('the real body');
    expect(blk.body, 'the match swallowed the user runbook').not.toMatch(/STEP ONE/);
  });

  it('unadopt does not answer "absent" after deleting the detail doc and leaving an orphan', () => {
    writeManaged(cwd, args());
    expect(existsSync(detailDocPath(cwd, SLUG))).toBe(true);
    writeFileSync(md, read().replace(/<!-- claude-mem-lite:end -->\n?/, ''));

    const r = removeManaged(cwd, SLUG);
    expect(existsSync(detailDocPath(cwd, SLUG)), 'premise: the doc really was deleted').toBe(false);
    expect(r.action, 'reported as a no-op while it deleted files and left a block').not.toBe('absent');
    expect(r.action).toBe('partial');
    expect(r.residue, 'the caller cannot tell the user what is left').toMatch(/CLAUDE\.md/);
  });

  // Pre-ship review P2-1. The first cut returned 'partial' whenever an orphan remained,
  // INCLUDING when a well-formed block had just been removed in the same call — and
  // unadoptAll's else-branch prints "cleaned partial residue (detail doc/state, no block)"
  // and counts it under `partial`. So a sweep that removed a block reported "no block" and
  // tallied zero. `action` describes what happened to the BLOCK; `residue` is an independent
  // fact that rides alongside it.
  it('a block that WAS removed still reports removed, with the residue alongside', () => {
    writeManaged(cwd, args());
    writeFileSync(md, `<!-- ${SLUG}:begin v1 -->\nstray\n\n` + read());
    const r = removeManaged(cwd, SLUG);
    expect(read(), 'premise: the managed body really was removed').not.toMatch(/steering line one/);
    expect(r.action, 'a sweep that removed a block must not report "no block"').toBe('removed');
    expect(r.residue, 'the leftover sentinel still has to be named').toMatch(/unpaired/);
  });

  // Pre-ship review P2-3. Counting sentinel-shaped TEXT made hasResidue fire on a project
  // the plugin has never touched — one mention in prose is enough. unadoptAll's skip guard
  // then let the sweep in, and removeManaged unconditionally rmdir'd an empty .claude/ and
  // told the user to delete their own paragraph, forever, because it never converges.
  // An orphan alone is not evidence the plugin wrote here; the doc, the sidecar and a
  // well-formed block are. Reported when unadopt genuinely runs, not used to summon it.
  it('a never-adopted project that merely MENTIONS the sentinel is not swept', () => {
    const virgin = join(tmpHome, 'virgin');
    mkdirSync(join(virgin, '.claude'), { recursive: true });
    const vmd = join(virgin, 'CLAUDE.md');
    const prose = '# Docs\n\nPlugins wrap their block in `<!-- claude-mem-lite:begin v1 -->`.\n';
    writeFileSync(vmd, prose);
    expect(existsSync(detailDocPath(virgin, SLUG)), 'premise: never adopted').toBe(false);

    expect(hasResidue(virgin, SLUG), 'the sweep would enter a project it never adopted').toBe(false);
    // And the single-project `unadopt` path has no such guard, so removeManaged itself must
    // also stay quiet: no 'partial', no instruction aimed at the user's own paragraph.
    const r = removeManaged(virgin, SLUG);
    expect(r.action).toBe('absent');
    expect(r.residue, 'told a stranger to delete their own prose').toBeUndefined();
    expect(readFileSync(vmd, 'utf8'), 'user prose rewritten').toBe(prose);
    // NOT asserted here: that `.claude/` survives. removeManaged has always rmdir'd an
    // emptied `.claude/` unconditionally (the "unadopt leaves no trace" rule), and that
    // predates this change — pinning it either way would be this test claiming ground it
    // does not own. Filed as a separate question, not repaired in a patch release.
  });

  // Pre-ship review P2-4. The tightened pattern makes the shipped body load-bearing: a
  // template that ever documents its own delimiters can no longer match itself, and adopt
  // then appends a fresh copy every SessionStart — measured 200 -> 1070 bytes over 6 adopts,
  // with unadopt unable to clean any of it. That is the unbounded-growth failure the CRLF
  // fix exists to prevent, with its trigger moved rather than removed. This is the guard.
  it('the shipped template body carries no sentinel of its own', () => {
    expect(buildClaudeMdBlock()).not.toMatch(/<!-- claude-mem-lite:(?:begin|end)/);
  });

  it('every damage shape leaves the user rule and the user tail intact', () => {
    const damages = [
      ['end deleted', (s) => s.replace(/<!-- claude-mem-lite:end -->\n?/, '')],
      ['begin deleted', (s) => s.replace(/<!-- claude-mem-lite:begin v\d+ -->\n?/, '')],
      ['version tag broken', (s) => s.replace(/:begin v\d+ -->/, ':begin -->')],
    ];
    for (const [name, damage] of damages) {
      rmSync(cwd, { recursive: true, force: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(md, '# My Project\n\n- Rule one: never force-push.\n');
      adoptWithTail();
      writeFileSync(md, damage(read()));
      writeManaged(cwd, args());
      writeManaged(cwd, args());
      removeManaged(cwd, SLUG);
      writeManaged(cwd, args());
      expect(count(/STEP ONE/g), `${name}: user tail lost`).toBe(1);
      expect(count(/Rule one/g), `${name}: user rule lost`).toBe(1);
    }
  });

  // Guard against over-tightening: the undamaged round trip must be untouched.
  it('the healthy round trip is unchanged', () => {
    const pristine = read();
    const w = writeManaged(cwd, args());
    expect(w.action).toBe('created');
    expect(readBlock(cwd, SLUG).body).toBe(BLOCK);
    expect(writeManaged(cwd, args()).action).toBe('unchanged');
    const r = removeManaged(cwd, SLUG);
    expect(r.action).toBe('removed');
    expect(read()).toBe(pristine);
    expect(removeManaged(cwd, SLUG).action, 'a truly clean tree is still "absent"').toBe('absent');
  });

  it('a body containing a blank line still matches — the pattern must stay permissive there', () => {
    writeManaged(cwd, { ...args(), block: 'line one\n\nline two' });
    expect(readBlock(cwd, SLUG).body).toBe('line one\n\nline two');
  });

  // The two assertions above prove removeManaged RETURNS the residue. Nothing proved anyone
  // prints it — the shape where a function is verified and its only caller is not. Drive the
  // real binary: this is the sentence the user actually sees.
  it('the unadopt CLI prints the residue instead of a bare success line', () => {
    const env = {
      ...process.env,
      CLAUDE_MEM_DIR: join(tmpHome, 'data'),
      CLAUDE_PROJECT_DIR: cwd,
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_TEST_GUARD: '0',
    };
    const cli = (...a) =>
      execFileSync(process.execPath, [join(REPO, 'cli.mjs'), ...a], { cwd, env, encoding: 'utf8' });

    cli('adopt');
    writeFileSync(md, read() + USER_TAIL);
    writeFileSync(md, read().replace(/<!-- claude-mem-lite:end -->\n?/, ''));
    const out = cli('unadopt');
    expect(out).toMatch(/→ partial/);
    expect(out, 'the user is not told which file still carries the block').toMatch(/CLAUDE\.md/);
    expect(out).toMatch(/unpaired/);
    expect(count(/STEP ONE/g), 'the CLI path lost the user tail').toBe(1);
  });

  // Pre-ship review P2-2. The case above drives cmdUnadopt; `unadopt --all` is a SECOND
  // print site, and deleting its residue line left the entire suite green. Two callers, two
  // tests — the same "verified function, untested wiring" shape this file already calls out
  // once. Discovery is via ~/.claude.json `projects`, so HOME (already repointed by
  // beforeEach) is what makes the temp project visible to the sweep.
  it('the unadopt --all sweep prints the residue too, and still counts the block it removed', () => {
    // PWD and CLAUDE_PROJECT_DIR both, the way tests/unadopt-all-e2e.test.mjs does it.
    // execFileSync's `cwd` option changes the child's working directory but NOT the
    // inherited `PWD`, and detectCwd() reads PWD — so with only `cwd` set, this test
    // adopted /home/ai/dev/claude-mem-lite instead of the temp project. It printed
    // "unchanged" and looked harmless ONLY because this repo happens to be adopted
    // already; on a machine where it is not, the test would have written a managed block
    // into the developer's own CLAUDE.md.
    const env = {
      ...process.env,
      HOME: tmpHome,
      PWD: cwd,
      CLAUDE_PROJECT_DIR: cwd,
      CLAUDE_MEM_DIR: join(tmpHome, 'data'),
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_SKIP_REPOS: '1',
      CLAUDE_MEM_TEST_GUARD: '0',
    };
    writeFileSync(join(tmpHome, '.claude.json'), JSON.stringify({ projects: { [cwd]: {} } }));

    execFileSync(process.execPath, [join(REPO, 'cli.mjs'), 'adopt'], { cwd, env, stdio: 'ignore' });
    writeFileSync(md, read() + USER_TAIL);
    // An orphan ABOVE the healthy block: the sweep must remove the block, keep the user's
    // tail, name the orphan, and tally the removal as a removal.
    writeFileSync(md, `<!-- ${SLUG}:begin v1 -->\nstray\n\n` + read());

    const out = execFileSync(process.execPath, [join(REPO, 'cli.mjs'), 'unadopt', '--all'], {
      cwd,
      env,
      encoding: 'utf8',
    });
    expect(out, 'the sweep never visited the project').toMatch(
      new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    expect(out, 'the --all site does not print the residue').toMatch(/unpaired/);
    expect(out, 'a removed block was reported as "no block"').not.toMatch(/no block/);
    expect(out).toMatch(/removed 1 CLAUDE\.md block/);
    expect(count(/STEP ONE/g), 'the sweep lost the user tail').toBe(1);
  });
});
