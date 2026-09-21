// A search result must not echo an unbounded query back at its caller.
//
// Both faces label their output with the query verbatim — `Found N result(s) for "<query>"`,
// `No results for "<query>"`. The label is worth having: it is how a caller confirms what was
// actually searched after alias folding. But it was unbounded, so the size of the answer
// tracked the size of the question: measured on the CLI, a 1,000-character query produced
// 1,024 characters of output and a 50,000-character one produced 50,024. The MCP face has no
// argv ceiling, so it carries the whole thing into the model's context.
//
// That is worse here than it would be elsewhere. This product exists to spend context
// carefully; a tool result that returns several KB of the caller's own input has spent the
// budget it was invoked to protect, and the caller pays it on every call with a pasted stack
// trace or a long natural-language question.
//
// The cap is not a truncation for tidiness — the label still has to answer "what did you
// search", so the full length is reported alongside the prefix.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { handleSearchForTest } from '../server.mjs';
import { queryLabel, QUERY_LABEL_MAX } from '../format-utils.mjs';

const REPO = resolve(import.meta.dirname, '..');
const CLI = join(REPO, 'cli.mjs');
const LONG = 'z'.repeat(5000);

let sandbox;

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: join(sandbox, 'home'),
      CLAUDE_MEM_DIR: join(sandbox, 'home', '.claude-mem-lite'),
      CLAUDE_PROJECT_DIR: join(sandbox, 'proj'),
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
    },
  });
  return (r.stdout || '') + (r.stderr || '');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mem-query-echo-'));
  mkdirSync(join(sandbox, 'home', '.claude-mem-lite'), { recursive: true });
  mkdirSync(join(sandbox, 'proj'), { recursive: true });
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('queryLabel', () => {
  it('passes a normal query through unchanged', () => {
    expect(queryLabel('caching layer crash')).toBe('caching layer crash');
  });

  it('bounds a long one and still reports how long it really was', () => {
    const out = queryLabel(LONG);
    expect(out.length).toBeLessThan(QUERY_LABEL_MAX + 60);
    expect(out).toContain('5000');
  });
});

describe('the MCP search result does not carry the whole query', () => {
  it('bounds the label on a long query', async () => {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'test' });
    insertObs(db, { sessionId: 's', title: 'caching layer crash', project: 'test' });

    // The query has to MATCH. A long query that matches nothing lands on a third branch
    // ("No results found." + a spelling tip) which never renders the label at all, so the
    // arm passed with the fix reverted — the mutation is what exposed it.
    const longMatching = `caching ${LONG}`;
    const res = await handleSearchForTest(db, { query: longMatching, deep: false });
    const text = res.content[0].text;

    // Premise: this is the labelled results path, not one of the two label-less branches.
    expect(text).toMatch(/result\(s\) for "/);
    expect(text).not.toContain(LONG);
    expect(text.length).toBeLessThan(2000);
    db.close();
  });

  it('bounds it on the NO-RESULTS branch, where the echo is bigger than the query', async () => {
    // The third site, and the one the arm above explicitly waved off: its comment said a
    // long non-matching query "lands on a third branch which never renders the label at
    // all". True of the LABEL and false of the echo — that branch prints `Searched as:
    // ${expanded}`, the EXPANDED query, which synonym expansion makes larger than the input.
    // Measured before the fix: a 10,329-char query produced a 13,691-char MCP result, 1.33x
    // the input, on the tool whose purpose is to spend model context carefully.
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'test' });
    insertObs(db, { sessionId: 's', title: 'caching layer crash', project: 'test' });

    // Terms that expand (so `expanded !== query` and the branch is reached) and match
    // nothing, so it is the no-results path rather than the results path.
    const nonMatching = `database connection timeout ${Array.from({ length: 900 }, (_, i) => `errorword${i}`).join(' ')}`;
    const res = await handleSearchForTest(db, { query: nonMatching, deep: false });
    const text = res.content[0].text;

    // Premise: this really is the no-results branch AND the echo line was reached, or the
    // length assertion below passes by the branch never printing anything.
    expect(text).toMatch(/No results found/);
    expect(text).toMatch(/Searched as:/);

    expect(
      text.length,
      `MCP result is ${text.length} chars for a ${nonMatching.length}-char query`,
    ).toBeLessThan(nonMatching.length);
    expect(text.length).toBeLessThan(2000);
    db.close();
  });

  it('bounds it on the FILTERED-query branch too', async () => {
    // A second, separately-reached echo site: when a query tokenises to nothing, the hint
    // quotes it back. Found by sweeping for the ENTITY (`${args.query}` / `${query}`) rather
    // than by fixing the sites the report named — the first pass of this change missed it,
    // and the arms above cannot reach it because they take the results path instead.
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'test' });
    insertObs(db, { sessionId: 's', title: 'caching layer crash', project: 'test' });

    const punctuation = '*'.repeat(5000);
    const res = await handleSearchForTest(db, { query: punctuation, deep: false });
    const text = res.content[0].text;

    expect(text).toMatch(/was filtered/);
    expect(text).not.toContain(punctuation);
    expect(text.length).toBeLessThan(2000);
    db.close();
  });

  it('still echoes a normal query verbatim', async () => {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'test' });
    insertObs(db, { sessionId: 's', title: 'caching layer crash', project: 'test' });

    const res = await handleSearchForTest(db, { query: 'caching', deep: false });

    expect(res.content[0].text).toContain('for "caching"');
    db.close();
  });
});

describe('the CLI does not echo the whole query either', () => {
  it('bounds the label on a long query', () => {
    const out = runCli(['search', LONG]);

    expect(out).toMatch(/No results|Found/);
    expect(out).not.toContain(LONG);
    expect(out.length).toBeLessThan(2000);
  });

  it('still echoes a normal query verbatim', () => {
    const out = runCli(['search', 'caching']);

    expect(out).toContain('"caching"');
  });
});
