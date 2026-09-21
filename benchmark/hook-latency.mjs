#!/usr/bin/env node
// Hook ENTRY-POINT latency — the only ruler for what a tool call costs the user.
//
// Every other ruler in this directory measures what retrieval RETURNS. None of them can see
// what the hooks COST, and that cost is paid on every tool call whether or not any memory is
// returned: Claude Code spawns a fresh Node process per hook fire, so the price is a cold
// start plus a module graph plus whatever work the handler does.
//
// WHAT IT MEASURES, and what it cannot
//
// Wall time of a cold `spawnSync` per arm, from a sandboxed HOME and CLAUDE_MEM_DIR. It is a
// LATENCY ruler and says nothing about quality — a change that halves the hook and destroys
// recall reads as a win here. Pair it with denoise-ab before shipping anything that touches
// retrieval.
//
// The two arms that make the rest readable are the FLOOR and the IMPORTS arm:
//
//   * `node -e ''` is the floor — Node's own start, which no change to this repo can move.
//     Every "our cost" figure below is measured ABOVE it, because quoting a raw column as
//     though it were all ours would credit Node's whole boot — the floor row, 16.4ms on the
//     standing read below — to the code under test.
//   * `hook.mjs` with NO event argument loads the whole top-level import graph and then
//     matches no `case`, so it is the import cost with the work subtracted. The dispatcher's
//     switch falling through is what makes this arm possible; if a future default: arm does
//     work, this arm stops meaning "imports only" and the docblock here is wrong.
//
// Standing reading — this ruler's own output, 2026-09-14, branch
// converge/20260914-setup-sh-runtime-dir @ 06386ed, Node v26.8.1, empty sandbox DB, n=15,
// min column (ms). Re-measure rather than carry it; it is a machine and a tree, not a
// property:
//
//     node -e ''                        16.4      floor
//     hook.mjs <no event>               73.6      +57.2 = the import graph
//     hook.mjs post-tool-use (Edit)     83.6      +67.2; the work itself is 10.0
//     post-tool-use.sh Read              5.1      never starts Node
//     post-tool-use.sh Glob              4.2      never starts Node
//     pre-tool-recall.js                32.8      +16.4
//     user-prompt-search.js             46.5      +30.1
//     hook.mjs session-start            99.1      +82.8
//
// The shape to read off that table: on the hottest path, roughly FIVE SIXTHS of what this
// repo costs per tool call is loading modules, not doing the work. The single biggest item is
// the DB graph (hook-shared.mjs -> schema.mjs -> better-sqlite3's native addon, ~30ms
// marginal / ~38ms in isolation), which a typical PostToolUse never uses — it appends to a
// JSON buffer and opens no database. Deferring it is NOT a small change: `openDb` is
// synchronous by contract at 15 call sites including a signal handler, and a dynamic import
// would make it async. Recorded rather than attempted.
//
// SELF-CHECKS (a ruler must be able to say NO)
//
//  1. Every arm must exit 0. A hook that crashes on bad input is FAST, and a crash would
//     otherwise be published as an improvement.
//  2. The post-tool-use arm must leave an episode buffer behind in the sandbox. Without it a
//     no-op — a disabled plugin, a mis-set env var, a changed stdin shape — reports the bare
//     import cost wearing a "did the work" label, which is the one error this ruler could
//     make that looks exactly like a win.
//  3. The floor must come in measurably under the hook arm. If they converge, the harness is
//     timing spawn noise and no arm below it means anything.
//
// POLLUTION (doctrine rule 6): HOME and CLAUDE_MEM_DIR are a fresh mkdtemp tree, every
// SKIP flag is set so no detached worker outlives the run, MEM_NO_AUTO_ADOPT=1 so it cannot
// rewrite a CLAUDE.md, and the tree is removed on exit.
//
// Usage:
//   node benchmark/hook-latency.mjs [-n 15] [--db <path>] [--json] [--keep]
//     -n      spawns per arm (default 15)
//     --db    seed the sandbox from a copy of this DB instead of letting the hook create an
//             empty one. Use it to price a real corpus; the file is COPIED, never opened in
//             place. State which you used — the two are different populations.
//     --keep  leave the sandbox tree for inspection (prints the path)

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// D#207: join(), never new URL('../x.mjs', import.meta.url) — the URL form drops the named
// module out of knip's report.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_PREFIX = 'hook-latency-';

function parseArgs(argv) {
  const out = { n: 15, db: null, json: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n') out.n = Number(argv[++i]);
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--keep') out.keep = true;
  }
  if (!Number.isFinite(out.n) || out.n < 3) out.n = 15;
  return out;
}

function makeSandbox(seedDb) {
  const root = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const work = join(root, 'work', 'probe');
  for (const d of [home, data, work]) mkdirSync(d, { recursive: true });
  if (seedDb && existsSync(seedDb)) copyFileSync(seedDb, join(data, 'claude-mem-lite.db'));
  const target = join(work, 'sample.mjs');
  writeFileSync(target, 'export function f() {\n  return 1;\n}\n'.repeat(120));
  return { root, home, data, work, target };
}

/**
 * Remove the sandbox (§8.V4: the creating task disposes of its own artifacts).
 *
 * The path is re-validated here rather than trusted: it must sit under the OS temp dir AND
 * carry this ruler's mkdtemp prefix. A recursive delete driven by a variable is the one
 * operation in this file that can reach outside the sandbox at all.
 */
function removeSandbox(root) {
  const base = join(tmpdir(), SANDBOX_PREFIX);
  if (!root || !root.startsWith(base) || root.length <= base.length) return false;
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function childEnv(sbx) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  return {
    ...env,
    HOME: sbx.home,
    CLAUDE_MEM_DIR: sbx.data,
    // No reachable LLM: haiku-client falls back to the `claude` CLI with no API key, and a
    // ruler that spawns a real model call is timing the network.
    CLAUDE_CODE_PATH: join(sbx.root, 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_SUMMARY: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
    MEM_NO_AUTO_ADOPT: '1',
  };
}

function timeArm(arm, sbx, n) {
  const env = childEnv(sbx);
  const ms = [];
  let code = null;
  let firstStderr = '';
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(arm.cmd, arm.args, { cwd: sbx.work, env, input: arm.stdin, encoding: 'utf8' });
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    code = r.status;
    if (i === 0 && r.stderr) firstStderr = r.stderr.split('\n')[0].slice(0, 140);
  }
  ms.sort((a, b) => a - b);
  return {
    label: arm.label,
    code,
    firstStderr,
    min: ms[0],
    p50: ms[Math.floor(ms.length / 2)],
    p90: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))],
  };
}

function buildArms(sbx) {
  const node = process.execPath;
  const hook = join(REPO, 'hook.mjs');
  const editIn = JSON.stringify({
    session_id: 'hook-latency',
    tool_name: 'Edit',
    tool_input: { file_path: sbx.target, old_string: 'a', new_string: 'b' },
    tool_response: { filePath: sbx.target },
  });
  const readIn = JSON.stringify({
    session_id: 'hook-latency',
    tool_name: 'Read',
    tool_input: { file_path: sbx.target },
    tool_response: 'x',
  });
  const globIn = JSON.stringify({
    session_id: 'hook-latency',
    tool_name: 'Glob',
    tool_input: { pattern: '*' },
    tool_response: 'x',
  });
  return [
    { key: 'floor', label: "node -e '' (floor)", cmd: node, args: ['-e', ''], stdin: '' },
    { key: 'imports', label: 'hook.mjs <no event> = imports', cmd: node, args: [hook], stdin: '' },
    {
      key: 'postToolUse',
      label: 'hook.mjs post-tool-use (Edit)',
      cmd: node,
      args: [hook, 'post-tool-use'],
      stdin: editIn,
    },
    {
      key: 'shRead',
      label: 'post-tool-use.sh Read fast path',
      cmd: 'bash',
      args: [join(REPO, 'scripts/post-tool-use.sh')],
      stdin: readIn,
    },
    {
      key: 'shSkip',
      label: 'post-tool-use.sh skip list (Glob)',
      cmd: 'bash',
      args: [join(REPO, 'scripts/post-tool-use.sh')],
      stdin: globIn,
    },
    {
      key: 'preToolRecall',
      label: 'pre-tool-recall.js',
      cmd: node,
      args: [join(REPO, 'scripts/pre-tool-recall.js')],
      stdin: editIn,
    },
    {
      key: 'userPrompt',
      label: 'user-prompt-search.js',
      cmd: node,
      args: [join(REPO, 'scripts/user-prompt-search.js')],
      stdin: JSON.stringify({ session_id: 'hook-latency', prompt: 'how does the episode buffer flush' }),
    },
    {
      key: 'sessionStart',
      label: 'hook.mjs session-start',
      cmd: node,
      args: [hook, 'session-start'],
      stdin: JSON.stringify({ session_id: 'hook-latency', source: 'startup' }),
    },
  ];
}

/**
 * Buffers the PostToolUse arm should have written, proving it did work and not just imports.
 *
 * READ THIS IMMEDIATELY AFTER THAT ARM, never at the end of the run. The `session-start` arm
 * below it is a real SessionStart: its first spawn finds the leftover buffer, flushes it and
 * unlinks it, and the rest of the run's spawns (fourteen at the default n=15) find nothing.
 * Sampling at the end therefore reports
 * "the hook never buffered" for a hook that buffered correctly — which is how the first
 * version of this file failed its own self-check.
 *
 * The same ordering is why `session-start`'s `min` is its steady-state cost: only one spawn
 * in the arm pays for a leftover flush, and `min` is taken over the rest.
 */
function episodeBuffers(sbx) {
  try {
    return readdirSync(join(sbx.data, 'runtime')).filter((f) => f.startsWith('ep-') && f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * The three ways this ruler is allowed to refuse. Returns the failures; an empty array is a
 * usable reading. See the SELF-CHECKS block at the top for why each one exists.
 */
function assertRulerCanSayNo(byKey, buffers) {
  const fail = [];
  for (const r of Object.values(byKey)) {
    if (r.code !== 0)
      fail.push(`${r.label}: exit ${r.code} — a crashing hook is fast, not faster. ${r.firstStderr}`);
  }
  if (buffers.length === 0) {
    fail.push(
      'the post-tool-use arm left no ep-*.json in the sandbox runtime dir — it returned ' +
        'without buffering, so its number is import cost wearing a work label',
    );
  }
  const floor = byKey.floor;
  const hook = byKey.postToolUse;
  if (floor && hook && hook.min - floor.min < 2) {
    fail.push(
      `floor ${floor.min.toFixed(1)}ms vs post-tool-use ${hook.min.toFixed(1)}ms — the two have ` +
        'converged, so this run is timing spawn noise rather than this repo',
    );
  }
  return fail;
}

function report(rows, byKey, opts, buffers) {
  const floor = byKey.floor.min;
  if (opts.json) {
    console.log(
      JSON.stringify({ floorMs: floor, n: opts.n, seededDb: Boolean(opts.db), arms: rows }, null, 2),
    );
    return;
  }
  console.log(`hook entry-point latency — n=${opts.n} per arm, ms, sandboxed HOME + CLAUDE_MEM_DIR`);
  console.log(`corpus: ${opts.db ? `copy of ${opts.db}` : 'empty DB created by the run'}`);
  console.log(`buffers written by the post-tool-use arm: ${buffers.join(', ') || '(none)'}\n`);
  console.log('arm'.padEnd(34) + 'min'.padStart(7) + 'p50'.padStart(8) + 'p90'.padStart(8) + '   vs floor');
  for (const r of rows) {
    // The two bash arms exit before starting Node at all, so the Node floor is not their
    // floor — they are marked rather than given a delta that invites the wrong subtraction.
    const noNode = r.key === 'shRead' || r.key === 'shSkip';
    const d = r.min - floor;
    const over =
      r.key === 'floor'
        ? ''
        : noNode
          ? '(never starts Node)'
          : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
    console.log(
      r.label.padEnd(34) +
        r.min.toFixed(1).padStart(7) +
        r.p50.toFixed(1).padStart(8) +
        r.p90.toFixed(1).padStart(8) +
        '   ' +
        over,
    );
  }
  const imports = byKey.imports.min - floor;
  const work = byKey.postToolUse.min - byKey.imports.min;
  const ours = byKey.postToolUse.min - floor;
  console.log(
    `\nPostToolUse costs ${ours.toFixed(1)}ms above the floor: ${imports.toFixed(1)}ms loading modules, ` +
      `${work.toFixed(1)}ms doing the work (${((imports / ours) * 100).toFixed(0)}% is the import graph).`,
  );
  console.log('Read the floor row first — quoting the raw column credits Node’s boot to this repo.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sbx = makeSandbox(opts.db);
  let exitCode = 0;
  try {
    const rows = [];
    let buffers = [];
    for (const arm of buildArms(sbx)) {
      rows.push({ key: arm.key, ...timeArm(arm, sbx, opts.n) });
      // Sampled here, not after the loop — see episodeBuffers' docblock.
      if (arm.key === 'postToolUse') buffers = episodeBuffers(sbx);
    }
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const fail = assertRulerCanSayNo(byKey, buffers);
    if (fail.length > 0) {
      console.error('SELF-CHECK FAILED — this run has no usable reading:');
      for (const f of fail) console.error('  - ' + f);
      exitCode = 1;
    } else {
      report(rows, byKey, opts, buffers);
    }
  } finally {
    if (opts.keep) console.log('\nsandbox kept at ' + sbx.root);
    else removeSandbox(sbx.root);
  }
  process.exit(exitCode);
}

await main();
