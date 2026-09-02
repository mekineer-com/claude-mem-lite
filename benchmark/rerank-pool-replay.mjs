#!/usr/bin/env node
// benchmark/rerank-pool-replay.mjs — the ruler for the `fyi` face's candidate-pool bounds
// (RERANK_POOL_SAME_PROJECT / RERANK_POOL_CROSS_PROJECT in hook-memory.mjs, audit ALGO-3).
//
// WHY THIS EXISTS AS A COMMITTED FILE. v3.85.0's first draft published five live-corpus
// numbers from a scratch script that was never committed, and the pre-tag claims review
// could not reproduce any of them. It turned out the harness was right and the SAMPLE
// PREDICATE was the whole difference — the draft sampled `LENGTH(prompt_text) BETWEEN 20
// AND 2000`, the reviewer sampled unfiltered, and on this corpus 1200-row samples of the
// same table span 11.9%–20.2% depending on which predicate you pick. A number nobody else
// can re-derive is not evidence, and a number whose sample predicate is a free parameter
// is barely better. Hence: DEFAULT IS THE WHOLE CORPUS, no sampling decision at all, and
// `--sample N` prints a warning saying so.
//
// WHAT IT MEASURES. `searchRelevantMemories` takes its candidate pool with
// `ORDER BY <raw bm25> LIMIT n` and then picks what to inject with a JS composite spanning
// 281× (type × lesson × importance × cross × OR × noise × cite). The LIMIT is therefore a
// REACHABILITY bound, not a ranking bound — D#172's shape. This replays every real user
// prompt through BOTH the shipped module and a twin with the pre-v3.85.0 pool values, and
// reports how often the injected set differs.
//
// USAGE
//   node benchmark/rerank-pool-replay.mjs                  whole corpus (the quotable number)
//   node benchmark/rerank-pool-replay.mjs --sample 1200    newest N prompts (a sampling decision)
//   node benchmark/rerank-pool-replay.mjs --baseline-same 10 --baseline-cross 5
//   node benchmark/rerank-pool-replay.mjs --cross-arm      cross-leg truncation rates only
//   node benchmark/rerank-pool-replay.mjs --json
//
// IT CANNOT POLLUTE THE CORPUS, and proves it rather than promising it.
// `searchRelevantMemories` bumps `injection_count` on every row it returns — replaying it
// against the live DB would permanently move the very noise signal `noisePenaltyClause`
// reads, and arm A's bumps would change arm B's scores. The DB is opened `readonly`, so
// that UPDATE raises SQLITE_READONLY and is swallowed by the shipped line's own bare catch.
// `assertCannotWrite()` below executes the bump against the handle and FAILS THE RUN if it
// succeeds — a promise in a comment is not a guarantee.

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import { DB_DIR } from '../schema.mjs';
import { join } from 'path';
import { upsFtsQuery } from '../lib/ups-query.mjs';
import { relaxFtsQueryToOr, notLowSignalTitleClause, OBS_BM25 } from '../utils.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';

const SHIPPED_URL = new URL('../hook-memory.mjs', import.meta.url);
// The twin has to sit at the REPO ROOT, not in benchmark/, or hook-memory's own relative
// imports ('./utils.mjs', './lib/...') resolve against the wrong directory. Relative
// specifier on purpose: tests/import-graph.test.mjs fails any absolute import spec, which
// is exactly how the review round's own scratch replay broke the suite.
const TWIN_URL = new URL('../.tmp-rerank-pool-twin.mjs', import.meta.url);

const DEFAULT_BASELINE_SAME = 10;
const DEFAULT_BASELINE_CROSS = 5;
const LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

/**
 * Build a twin of the shipped module with the two pool constants replaced.
 * Throws when either replacement is a no-op: a twin that silently failed to patch would
 * compare the shipped module against itself and report a reassuring 0% — the failure mode
 * this whole file exists to prevent.
 */
function patchConst(src, name, value) {
  // Match on the DECLARATION, not on "did the text change". The first version of this
  // guard compared before/after strings, so holding one pool at its shipped value while
  // sweeping the other (`--baseline-same 30 --baseline-cross 50`) produced a no-op
  // replacement and the guard reported "constant not found" — a true failure with a false
  // cause. "The edit changed nothing" and "the anchor is gone" are different faults and a
  // guard that cannot tell them apart sends you to the wrong file.
  const re = new RegExp(`const ${name} = (\\d+);`);
  const m = src.match(re);
  if (!m) throw new Error(`twin patch failed: ${name} not found in hook-memory.mjs (renamed?)`);
  return { out: src.replace(re, `const ${name} = ${value};`), previous: Number(m[1]) };
}

function writeTwin(sameLimit, crossLimit) {
  const src = readFileSync(SHIPPED_URL, 'utf8');
  const a = patchConst(src, 'RERANK_POOL_SAME_PROJECT', sameLimit);
  const b = patchConst(a.out, 'RERANK_POOL_CROSS_PROJECT', crossLimit);
  if (a.previous === sameLimit && b.previous === crossLimit) {
    throw new Error(`twin is identical to shipped (${sameLimit}/${crossLimit}) — the comparison `
      + 'would report 0% for reasons that have nothing to do with the pools. Pass a baseline '
      + 'that differs in at least one arm.');
  }
  writeFileSync(TWIN_URL, b.out);
  return { same: a.previous, cross: b.previous };
}

/** Proves the handle cannot write, so the replay cannot move the signal it measures. */
function assertCannotWrite(db) {
  let wrote = false;
  try {
    db.prepare('UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1 WHERE id = -1').run();
    wrote = true;
  } catch { /* expected: SQLITE_READONLY */ }
  if (wrote) {
    console.error('SELF-CHECK FAILED: the database handle accepted a write. Replaying '
      + 'searchRelevantMemories against a writable handle bumps injection_count on every '
      + 'returned row and permanently contaminates the noise signal. Refusing to run.');
    process.exit(1);
  }
}

function loadPrompts(db, sampleN) {
  const base = `
    SELECT up.prompt_text AS text, s.project AS project
    FROM user_prompts up
    JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
  `;
  if (!sampleN) return db.prepare(base).all();
  return db.prepare(`${base} ORDER BY up.created_at_epoch DESC LIMIT ?`).all(sampleN);
}

function compare(prompts, narrow, wide) {
  let n = 0, threw = 0, changed = 0, top1 = 0, gained = 0, lost = 0;
  let emptyNarrow = 0, emptyWide = 0, bothEmpty = 0;
  for (const { text, project } of prompts) {
    let a, b;
    try { a = narrow(db, text, project, []); b = wide(db, text, project, []); }
    catch { threw++; continue; }
    n++;
    const ai = a.map((r) => r.id), bi = b.map((r) => r.id);
    if (ai.length === 0) emptyNarrow++;
    if (bi.length === 0) emptyWide++;
    if (ai.length === 0 && bi.length === 0) bothEmpty++;
    if (JSON.stringify(ai) !== JSON.stringify(bi)) {
      changed++;
      if (ai[0] !== bi[0]) top1++;
      gained += bi.filter((x) => !ai.includes(x)).length;
      lost += ai.filter((x) => !bi.includes(x)).length;
    }
  }
  return { n, threw, changed, top1, gained, lost, emptyNarrow, emptyWide, bothEmpty };
}

/**
 * The ruler must be able to say NO. Comparing the shipped module against ITSELF must
 * report zero changes; anything else means the replay is not deterministic (a leaked
 * write, a stateful module, an unstable sort) and every other number it prints is noise.
 */
function assertRulerCanSayNo(prompts, wide) {
  const slice = prompts.slice(0, Math.min(200, prompts.length));
  const { changed } = compare(slice, wide, wide);
  if (changed !== 0) {
    console.error(`SELF-CHECK FAILED: shipped-vs-shipped reported ${changed} changed result `
      + 'sets over 200 prompts. The replay is not deterministic, so no delta it reports is '
      + 'attributable to the pool sizes. Refusing to report.');
    process.exit(1);
  }
}

/**
 * How often does the CROSS-PROJECT leg match more rows than its pool can hold?
 * Models the shipped leg including its OR fallback. Measuring the AND pass alone reports
 * this leg as firing on 5 of 1200 prompts and never truncating; the leg takes the OR
 * branch on the large majority of real prompts, where it matches up to 241 rows. The
 * first version of this measurement made exactly that mistake.
 */
function crossArmTruncation(db, prompts, poolSizes) {
  const cutoff = Date.now() - LOOKBACK_MS;
  const stmt = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT o.id
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project != ?
        AND o.type IN ('decision', 'discovery')
        AND o.importance >= 2
        AND o.created_at_epoch > ?
        AND ${liveObsFilterSql('o')}
        AND ${notLowSignalTitleClause('o')}
      ORDER BY ${OBS_BM25}
    )
  `);
  let n = 0, fired = 0, orFired = 0, max = 0;
  const over = new Map(poolSizes.map((p) => [p, 0]));
  for (const { text, project } of prompts) {
    const q = upsFtsQuery(text);
    if (!q) continue;
    let c;
    try { c = stmt.get(q, project, cutoff).c; } catch { continue; }
    if (c === 0) {
      const orQuery = relaxFtsQueryToOr(q);
      const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
      const ascii = (text.match(/[A-Za-z]/g) || []).length;
      const tokens = q.includes(' AND ')
        ? q.split(' AND ').length
        : q.split(/\s+/).filter((x) => x && !x.startsWith('(') && !x.endsWith(')')).length;
      if (orQuery && ((cjk > 0 && cjk >= ascii) || tokens <= 8)) {
        try { c = stmt.get(orQuery, project, cutoff).c; orFired++; } catch { /* ignore */ }
      }
    }
    n++;
    if (c > 0) fired++;
    if (c > max) max = c;
    for (const p of poolSizes) if (c > p) over.set(p, over.get(p) + 1);
  }
  return { n, fired, orFired, max, over };
}

const sampleN = arg('--sample') ? Number(arg('--sample')) : null;
const baselineSame = Number(arg('--baseline-same', String(DEFAULT_BASELINE_SAME)));
const baselineCross = Number(arg('--baseline-cross', String(DEFAULT_BASELINE_CROSS)));
const asJson = has('--json');

const dbPath = process.env.CLAUDE_MEM_DB_PATH || join(DB_DIR, 'claude-mem-lite.db');
const db = new Database(dbPath, { readonly: true });
assertCannotWrite(db);

writeTwin(baselineSame, baselineCross);
let wide, narrow;
try {
  ({ searchRelevantMemories: wide } = await import(SHIPPED_URL.href));
  ({ searchRelevantMemories: narrow } = await import(`${TWIN_URL.href}?v=${Date.now()}`));
} finally {
  try { unlinkSync(TWIN_URL); } catch { /* already gone */ }
}

const prompts = loadPrompts(db, sampleN);
if (sampleN) {
  console.error(`NOTE: --sample ${sampleN} is a sampling decision. On this corpus, 1200-row `
    + 'samples of the same table span 11.9%-20.2% depending on the predicate. The default '
    + '(whole corpus) has no such free parameter — prefer it for anything you publish.');
}

if (has('--cross-arm')) {
  const r = crossArmTruncation(db, prompts, [baselineCross, 15, 50]);
  const pct = (x) => (r.fired ? `${((100 * x) / r.fired).toFixed(1)}%` : 'n/a');
  if (asJson) { console.log(JSON.stringify({ ...r, over: Object.fromEntries(r.over) }, null, 2)); }
  else {
    console.log(`\n─── cross-project leg truncation (n=${r.n}) ───`);
    console.log(`  leg fires (matched >0):            ${r.fired} (${((100 * r.fired) / r.n).toFixed(1)}%)   [OR fallback used on ${r.orFired}]`);
    for (const [p, c] of r.over) console.log(`  matched more than ${String(p).padStart(3)} rows:       ${c} (${pct(c)} of firings)`);
    console.log(`  largest single match count:        ${r.max}`);
    console.log('\n  Read as a reachability bound, not as harm: the OR penalty (0.4x), the');
    console.log('  cross penalty (0.7x) and the adaptive threshold drop nearly all of these');
    console.log('  rows downstream. Price the harm with the default mode, not with this one.');
  }
  process.exit(0);
}

assertRulerCanSayNo(prompts, wide);
const r = compare(prompts, narrow, wide);
const either = r.n - r.bothEmpty;
const pctAll = (x) => `${((100 * x) / r.n).toFixed(1)}%`;
const pctEither = (x) => (either ? `${((100 * x) / either).toFixed(1)}%` : 'n/a');

if (asJson) {
  console.log(JSON.stringify({ ...r, either, baselineSame, baselineCross, sample: sampleN || 'whole-corpus' }, null, 2));
} else {
  console.log(`\n─── rerank pool replay: ${baselineSame}/${baselineCross} vs shipped ───`);
  console.log(`  prompts replayed:        ${r.n}${r.threw ? `  (${r.threw} threw)` : ''}`);
  console.log(`  both arms empty:         ${r.bothEmpty} (${pctAll(r.bothEmpty)})`);
  console.log(`  injected set differs:    ${r.changed} (${pctAll(r.changed)} of all, ${pctEither(r.changed)} of the ${either} that retrieve anything)`);
  console.log(`  top-1 differs:           ${r.top1} (${pctAll(r.top1)} of all, ${pctEither(r.top1)} of ${either})`);
  console.log(`  rows newly reachable:    ${r.gained}   displaced: ${r.lost}`);
  console.log(`  empty injections:        ${r.emptyNarrow} -> ${r.emptyWide}`);
}
