#!/usr/bin/env node
// Events END-TO-END pipeline probes — G16 (three-face audit plan 2026-07-18).
//
// The G5 cross-source probes execute normalizeCrossSourceScores in ISOLATION on
// constructed rows — the banding math has teeth, but searchEventsFts (FTS query
// construction), shapeEvent (row shaping), and the coreRunSearchPipeline merge
// were still benchmark-blind (07-17 audit MED-2, second half): a regression in
// the FTS/shape layer reads NEUTRAL on every metric suite AND passes every
// isolated probe. These probes drive the REAL coreRunSearchPipeline over a
// seeded :memory: corpus (events written through saveEvent — the production
// write path, so the events_fts triggers are exercised too) and assert the
// direction invariants end-to-end.
//
// Teeth (archaeology replay, tests/events-pipeline-probes.test.mjs): wiping
// events_fts — the v3.44-era "events unsearchable" state — must turn
// `event-reachable-via-fts` red. tolerateMissingFts is false (MCP policy), so
// a broken FTS face throws instead of degrading silently.
//
// Dev tooling only — not shipped in SOURCE_FILES. Run standalone:
//   node benchmark/events-pipeline-probes.mjs   (exit 1 on any probe failure)

import { fileURLToPath } from 'url';
import { createTestDb, insertSession, insertObs } from '../tests/test-helpers.mjs';
import { saveEvent } from '../lib/activity.mjs';
import { coreRunSearchPipeline, buildSearchFtsQuery } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';

const PROJECT = 'parent--probeproj';

/**
 * Seed the mixed obs+events corpus. Distinct vocab per probe so hits can't
 * cross-contaminate. Events go through saveEvent (production write path →
 * events_fts triggers fire); obs go through the test-helper insert (FTS text
 * column populated).
 */
export function seedEventsPipelineCorpus(db) {
  insertSession(db, { id: 'probe-sess', project: PROJECT });

  // ① reachability: 'zirconium' lives ONLY in an event body.
  saveEvent(db, {
    project: PROJECT, event_type: 'bugfix', importance: 2,
    title: 'Fixed zirconium coupling regression',
    body: 'Root cause: the zirconium coupling flag was inverted in the parser. Fix: restore the guard.',
  });

  // ② strong event vs weak obs: 'chronograph' appears twice in a SHORT event
  // doc (high BM25 magnitude) and once each buried in two LONG obs docs.
  const padding = 'unrelated scaffolding vocabulary '.repeat(30);
  saveEvent(db, {
    project: PROJECT, event_type: 'decision', importance: 2,
    title: 'chronograph scheduler decision',
    body: 'Adopt the chronograph scheduler for retry pacing.',
  });
  insertObs(db, {
    sessionId: 'probe-sess', project: PROJECT, type: 'discovery', importance: 2,
    title: 'Session notes A', text: `${padding} chronograph ${padding}`,
  });
  insertObs(db, {
    sessionId: 'probe-sess', project: PROJECT, type: 'discovery', importance: 2,
    title: 'Session notes B', text: `${padding} chronograph mention ${padding}`,
  });

  // ③ supersession: 'palladium' lives only in a TOMBSTONED event.
  saveEvent(db, {
    project: PROJECT, event_type: 'bugfix', importance: 2,
    title: 'Old palladium fix (superseded)',
    body: 'The palladium handler leak, first attempt.',
  });
  db.prepare(`UPDATE events SET superseded_at_epoch = ? WHERE title LIKE '%palladium%'`).run(Date.now());

  // ④ type filter: 'vanadium' in one bugfix event and one decision event.
  saveEvent(db, {
    project: PROJECT, event_type: 'bugfix', importance: 2,
    title: 'vanadium bugfix event', body: 'vanadium fix detail.',
  });
  saveEvent(db, {
    project: PROJECT, event_type: 'decision', importance: 2,
    title: 'vanadium decision event', body: 'vanadium tradeoff detail.',
  });

  // ⑥ project scoping: 'osmium' only in a FOREIGN-project event.
  saveEvent(db, {
    project: 'parent--otherproj', event_type: 'bugfix', importance: 2,
    title: 'osmium fix elsewhere', body: 'osmium detail in another project.',
  });
}

/** Minimal MCP-policy pipeline invocation. Deep escalation stubbed OFF. */
async function runPipeline(db, query, { obsType = null, obsTypeScoped = false } = {}) {
  const ftsQuery = buildSearchFtsQuery(query);
  const res = await coreRunSearchPipeline(
    {
      db, currentProject: PROJECT, env: {},
      searchObservationsHybrid,
      deepSearch: async () => ({ rows: [] }),
      shouldEscalateToDeep: () => false,
      autoDeepLlmReady: () => false,
      reRankWithContext: async (rows) => rows,
      llm: null,
    },
    {
      query, ftsQuery, effectiveSource: null, deepMode: 'normal', rerank: false,
      limit: 10, offset: 0, project: PROJECT, obsType, sort: 'relevance',
      obsTypeScoped,
      obsTypeFallback: false,
      crossSourceEpochSortNoFts: false,
      rerankPolicy: 'mcp', rerankProject: PROJECT,
      recentListingNoFts: false,
      tolerateMissingFts: false, // MCP policy: a broken events FTS face THROWS → probe red
      tierPosition: 'late', tierProject: PROJECT,
    }
  );
  return res.page;
}

/**
 * Run all end-to-end events probes.
 * @param {import('better-sqlite3').Database} [dbIn] pre-seeded DB (tests inject
 *        a corrupted one to prove teeth); default builds a fresh healthy corpus.
 * @returns {Promise<Array<{name:string, pass:boolean, detail:string}>>}
 */
export async function runEventsPipelineProbes(dbIn = null) {
  const db = dbIn || createTestDb();
  if (!dbIn) seedEventsPipelineCorpus(db);
  const probes = [];
  const probe = async (name, fn) => {
    let pass = false, detail = '';
    try { ({ pass, detail } = await fn()); }
    catch (e) { detail = `threw: ${e.message}`; }
    probes.push({ name, pass, detail });
  };

  await probe('event-reachable-via-fts', async () => {
    const page = await runPipeline(db, 'zirconium');
    const evt = page.find((r) => r.source === 'event');
    return { pass: Boolean(evt), detail: evt ? `event#${evt.id}` : `sources=[${page.map((r) => r.source)}]` };
  });

  await probe('strong-event-outranks-weak-obs', async () => {
    const page = await runPipeline(db, 'chronograph');
    const evtIdx = page.findIndex((r) => r.source === 'event');
    const obsIdx = page.findIndex((r) => r.source === 'obs');
    const pass = evtIdx !== -1 && (obsIdx === -1 || evtIdx < obsIdx);
    return { pass, detail: `order=[${page.map((r) => r.source).join(',')}]` };
  });

  await probe('superseded-event-invisible', async () => {
    const page = await runPipeline(db, 'palladium');
    const evt = page.find((r) => r.source === 'event');
    return { pass: !evt, detail: evt ? `leaked event#${evt.id}` : 'no event rows' };
  });

  await probe('event-type-filter-maps', async () => {
    const page = await runPipeline(db, 'vanadium', { obsType: 'bugfix', obsTypeScoped: true });
    const evts = page.filter((r) => r.source === 'event');
    const pass = evts.length === 1 && evts[0].type === 'bugfix';
    return { pass, detail: `event types=[${evts.map((r) => r.type).join(',')}]` };
  });

  await probe('event-shape-contract', async () => {
    const page = await runPipeline(db, 'zirconium');
    const evt = page.find((r) => r.source === 'event');
    if (!evt) return { pass: false, detail: 'no event row' };
    const pass = Boolean(evt.lesson_learned) && evt.lesson_learned === evt.text
      && typeof evt.created_at === 'string' && evt.type === 'bugfix';
    return { pass, detail: `lesson=${Boolean(evt.lesson_learned)} text-parity=${evt.lesson_learned === evt.text} iso=${typeof evt.created_at}` };
  });

  await probe('project-scope-excludes-foreign', async () => {
    const page = await runPipeline(db, 'osmium');
    const evt = page.find((r) => r.source === 'event');
    return { pass: !evt, detail: evt ? `leaked ${evt.project}` : 'no foreign rows' };
  });

  if (!dbIn) db.close();
  return probes;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) {
  const results = await runEventsPipelineProbes();
  for (const p of results) console.error(`  ${p.pass ? '✓' : '✗'} ${p.name}${p.pass ? '' : ` — ${p.detail}`}`);
  const failed = results.filter((p) => !p.pass);
  if (failed.length) { console.error(`\n${failed.length} probe(s) FAILED`); process.exit(1); }
  console.error(`\nall ${results.length} probes pass`);
}
