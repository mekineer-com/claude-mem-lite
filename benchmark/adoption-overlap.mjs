#!/usr/bin/env node
// Task 7 (offline benchmark, 2026-07-05): adoption-overlap main — wires
// replay (T4) -> per-surface rankers (T6) -> dual-channel TF-IDF cosine (T3)
// -> RDD/cluster-bootstrap estimator (T5) into a per-bucket adoption report.
//
// For every replayed injection event, this re-scores the event's `shown` vs
// `nearMiss` candidates (T6's counterfactual "almost shown" set) against the
// assistant's post-injection output window, split into an `action` channel
// (Edit/Write/Bash tool_use payloads) and a `prose` channel (assistant text).
// Per event, per channel: cosShown = max cosine(output, shown-candidate);
// cosNearMiss = mean cosine(output, near-miss-candidate); the control-
// subtracted delta (cosShown - cosNearMiss) is the per-event adoption signal,
// aggregated per `${surface}:${channel}` bucket with a session-cluster
// bootstrap CI (events from the same session are NOT independent draws).
//
// DESIGN REFINEMENT (2026-07-05, supersedes the original plan's `effect: jump`):
// ci95 comes from cluster-bootstrapping the per-event control-subtracted
// deltas -- using the RDD jump as `effect` while `ci95` is bootstrapped over a
// DIFFERENT statistic is an effect/CI mismatch. Also, the RDD running
// variable is a real score with a fixed cutoff (50) only for `ups-fts`; for
// `imperative`/`subagent` (top-1 selection, running var = score) the "jump at
// x=0" extrapolation is rough. So:
//   - `effect` = clusterBootstrap(perEvent).mean -- PRIMARY, consistent with ci95.
//   - `rdd_jump` = localLinearRdd(points, cutoff).jump -- SECONDARY, the
//     gradient-corrected view (meaningful for ups-fts; informational for
//     imperative/subagent).
//
// IDF corpus is built ONCE over the whole run (every candidate text union
// every output window), not per-event -- per-event IDF would make cosine
// scores incomparable across events (different vocabulary universe each
// time).
//
// Usage:
//   node benchmark/adoption-overlap.mjs                    # last 30d, this project
//   node benchmark/adoption-overlap.mjs --start=ISO --end=ISO
//   node benchmark/adoption-overlap.mjs --json > out.json
//   node benchmark/adoption-overlap.mjs --dir=/path/to/transcripts
//
// Defaults: dir = ~/.claude/projects/-mnt-data-ssd-dev-projects-mem
//           db  = schema.mjs's DB_PATH (honors CLAUDE_MEM_DIR)
//           end = now, start = end - 30d.
import { readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { extractInjectionEvents } from './adoption-replay.mjs';
import { replayCandidates } from './adoption-rankers.mjs';
import { buildIdf, textToBag, cosine, dualChannelBags } from './adoption-cosine.mjs';
import { localLinearRdd, clusterBootstrap, mde } from './adoption-estimator.mjs';
import { DB_PATH } from '../schema.mjs';

// Running-var cutoff per surface: ups-fts's running var is |bm25 composite
// relevance| with a real production floor (TOP_REL_FLOOR, scripts/user-
// prompt-search.js); imperative/subagent's running var is the ranker score
// with no natural cutoff other than "top-1 wins", so 0 is a placeholder --
// rdd_jump for those two surfaces is informational, not a calibrated effect.
const CUTOFF = { 'ups-fts': 50, imperative: 0, subagent: 0 };

/**
 * @param {string} transcriptDir - directory of *.jsonl Claude Code transcripts
 * @param {import('better-sqlite3').Database} db
 * @param {{ start: number, end: number, project?: string, m?: number }} opts
 * @returns {{ perBucket: Array<{ surface: string, channel: 'action'|'prose', nEvents: number, nSessions: number, effect: number, ci95: [number, number], rdd_jump: number, mde: number }> }}
 */
export function computeAdoption(transcriptDir, db, { start, end, project = 'projects--mem', m = 3 } = {}) {
  const files = readdirSync(transcriptDir).filter((n) => n.endsWith('.jsonl')).map((n) => join(transcriptDir, n));
  const events = [];
  for (const f of files) for (const e of extractInjectionEvents(f, { start, end })) events.push(e);

  // Resolve shown/near-miss candidates once per event; also collect the
  // run-wide IDF corpus. Events with an empty `shown` are a coverage loss (no
  // observation crossed the ranker's floor at replay time) -- there is no
  // shown/near-miss control split to measure adoption against, so they are
  // excluded from both the corpus and the bucket aggregation, not counted as
  // a zero-effect event.
  const corpus = [];
  const resolved = [];
  for (const ev of events) {
    const { shown, nearMiss } = replayCandidates(ev.surface, db, ev, { m, project });
    if (shown.length === 0) continue; // coverage loss -- no control/shown split
    const { proseBag, actionBag } = dualChannelBags(ev.outputWindow);
    corpus.push(ev.outputWindow.prose, ev.outputWindow.actions, ...shown.map((c) => c.text), ...nearMiss.map((c) => c.text));
    resolved.push({ ev, shown, nearMiss, proseBag, actionBag });
  }
  const idf = buildIdf(corpus);

  // bucket key `${surface}:${channel}` -> { points: RDD input, perEvent: cluster-bootstrap input }
  const buckets = new Map();
  const bk = (surface, channel) => `${surface}:${channel}`;
  const get = (k) => { if (!buckets.has(k)) buckets.set(k, { points: [], perEvent: [] }); return buckets.get(k); };

  for (const { ev, shown, nearMiss, proseBag, actionBag } of resolved) {
    for (const [channel, outBag] of [['action', actionBag], ['prose', proseBag]]) {
      const cosOf = (c) => cosine(outBag, textToBag(c.text), idf);
      const cosShown = Math.max(...shown.map(cosOf));
      const nmCos = nearMiss.map(cosOf);
      // no near-miss counterfactual -> no base-rate to subtract (don't penalize)
      const cosNear = nmCos.length ? nmCos.reduce((s, v) => s + v, 0) / nmCos.length : 0;
      const b = get(bk(ev.surface, channel));
      // One point per candidate, each paired with its OWN cosine -- pairing
      // shown[0]'s x with cosShown's y (the MAX over all shown) mismatches
      // x/y whenever shown.length > 1 (possible for ups-fts). This only
      // taints the secondary RDD `points`; the per-event PRIMARY delta below
      // is untouched.
      for (const c of shown) b.points.push({ x: c.runningVar, y: cosOf(c), shown: true });
      for (const c of nearMiss) b.points.push({ x: c.runningVar, y: cosOf(c), shown: false });
      b.perEvent.push({ sessionId: ev.sessionId, value: cosShown - cosNear }); // control-subtracted per-event delta
    }
  }

  const perBucket = [];
  for (const [key, b] of buckets) {
    const [surface, channel] = key.split(':');
    const { jump } = localLinearRdd(b.points, CUTOFF[surface] ?? 0);
    const { mean, ci95 } = clusterBootstrap(b.perEvent, { seedTerms: key });
    // RMS around the bucket's OWN mean, not around zero -- centering on raw
    // zero folds a non-zero adoption signal's magnitude into the "noise" term,
    // inflating sd (and therefore mde, the pre-registered power-gate field).
    const sd = Math.sqrt(b.perEvent.reduce((s, r) => s + (r.value - mean) ** 2, 0) / Math.max(1, b.perEvent.length));
    const nSessions = new Set(b.perEvent.map((r) => r.sessionId)).size;
    perBucket.push({
      surface, channel,
      nEvents: b.perEvent.length,
      nSessions,
      effect: mean, // PRIMARY: cluster-bootstrap mean of control-subtracted deltas (consistent with ci95)
      ci95,
      rdd_jump: jump, // SECONDARY: RDD local-linear jump (calibrated cutoff for ups-fts only)
      mde: mde(b.perEvent.length, sd, {}),
    });
  }
  perBucket.sort((a, b) => (a.surface + a.channel).localeCompare(b.surface + b.channel));
  return { perBucket };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
  const dir = args.dir || join(homedir(), '.claude/projects/-mnt-data-ssd-dev-projects-mem');
  const end = args.end ? new Date(args.end).getTime() : Date.now();
  const start = args.start ? new Date(args.start).getTime() : end - 30 * 86400000;
  const dbPath = args.db || DB_PATH;
  const db = new Database(dbPath, { readonly: true });
  const res = computeAdoption(dir, db, { start, end, project: args.project });
  if (args.json) { console.log(JSON.stringify(res, null, 2)); return; }
  console.log('# adoption-overlap (effect = cluster-bootstrap mean of control-subtracted cosine deltas; rdd_jump = RDD gradient-corrected view, informational for imperative/subagent)');
  console.log('  surface:channel        nEv  nSess    effect     95% CI              rdd_jump    MDE');
  for (const r of res.perBucket) {
    console.log(`  ${(`${r.surface}:${r.channel}`).padEnd(22)} ${String(r.nEvents).padStart(4)} ${String(r.nSessions).padStart(5)}   ${r.effect.toFixed(4).padStart(8)}  [${r.ci95[0].toFixed(4)}, ${r.ci95[1].toFixed(4)}]  ${r.rdd_jump.toFixed(4).padStart(8)}  ${r.mde.toFixed(4)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
