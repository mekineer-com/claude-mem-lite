// End-to-end proof that a real Stop event lands citation_surface_log rows.
//
// tests/citation-surface-funnel.test.mjs covers the recorder in isolation (14
// cases) and asserts the hook.mjs wiring by MATCHING hook.mjs SOURCE TEXT. Source
// matching cannot see a chain that breaks between the call site and the table:
// a schema pass that never creates the table (#10650), a debugCatch that renders
// "no such table" as "no rows", a stdin field renamed upstream, or an env guard
// that short-circuits the whole block. Each of those keeps every source assertion
// green while the funnel silently reports nothing.
//
// So: spawn `node hook.mjs stop` against a sandboxed HOME with a real DB and a
// real transcript, and read the table back. This is the only assertion in the
// repo that the four faces survive an actual Stop.
//
// ISOLATION: HOME *and* CLAUDE_MEM_DIR are pointed at a mkdtemp sandbox, and
// CLAUDE_CODE_PATH at a nonexistent binary so no LLM spend or network can occur.
// CLAUDE_MEM_DIR is set explicitly rather than left to HOME: the env strip below
// removes the developer's own value, after which resolution falls back to
// os.homedir(), which honours HOME only on POSIX — on Windows it reads
// USERPROFILE and this suite would write to the real ~/.claude-mem-lite.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');
const PROJECT = 'stopE2e--proj';

/** hook_success attachment shaped like the real hook stdout for each face. */
const att = (command, stdout) => ({
  type: 'attachment',
  isSidechain: false,
  attachment: { type: 'hook_success', command, stdout },
});

// Each takes a LIST of ids so a face can carry a distinct count (see FACE_SIZES).
const faceAttachment = {
  pretool: (ids) => att('node "/home/sds/.claude-mem-lite/scripts/pre-tool-recall.js"',
    `[mem] Lessons for utils.mjs:\n${ids.map((id) => `  #${id} [bugfix] boundary match beats suffix LIKE\n`).join('')}`),
  ups: (ids) => att('node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
    `<memory-context relevance="high">\n${ids.map((id) => `- [decision] picked X | Lesson: Y (#${id})\n`).join('')}</memory-context>\n`),
  error_recall: (ids) => att('bash "/home/sds/.claude-mem-lite/scripts/post-tool-use.sh"',
    `[claude-mem-lite] Related memories found for this error:\n${ids.map((id) => `  #${id} [bugfix] EPIPE on forced exit\n`).join('')}`),
  fyi: (ids) => att('node "/home/sds/.claude-mem-lite/scripts/user-prompt-search.js"',
    `[mem] FYI — Related memories (continue your task):\n${ids.map((id) => `#${id} 🔴 superseded invariant reopened\n`).join('')}`),
};

/** Main-thread assistant text — both the text floor and the citation numerator. */
const assistantText = (text) => ({
  type: 'assistant',
  isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('Stop end-to-end: citation_surface_log really receives rows (b2)', () => {
  let root, home, projDir, dbPath, baseEnv;
  let caseN = 0;

  // Per-case dirs live under ONE root removed after the whole file, with a grace
  // period. A per-case rmSync in afterEach does delete the tree — and then the
  // hook's detached background workers, which outlive execFileSync, recreate
  // `<home>/.claude-mem-lite/` behind it. The result is a leaked skeleton dir per
  // case (13 of them before this was noticed), invisible because rmSync is
  // best-effort and its failure is swallowed. Same shape as the fix in
  // tests/audit-fixes-20260816.test.mjs.
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mem-stop-e2e-')); });

  // A fixed grace is a RACE, not a barrier, and the post-tag review observed it
  // lose: handleStop's spawnBackground('llm-summary') is gated by no
  // CLAUDE_MEM_SKIP_* this test sets, and on a busy machine that detached child
  // recreated the tree 432ms after rmSync — past a 300ms sleep. Delete in a
  // bounded loop until it stays gone, then ASSERT it is gone: rmSync is
  // best-effort and its failure is swallowed, so without the assertion the leak
  // is invisible and comes back as the 13 stray dirs this file already once left.
  afterAll(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* retry */ }
      if (!existsSync(root)) {
        await new Promise((r) => setTimeout(r, 200)); // give a straggler time to recreate
        if (!existsSync(root)) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(root), `sandbox root leaked: ${root}`).toBe(false);
  });

  beforeEach(() => {
    home = join(root, `case-${++caseN}`);
    mkdirSync(home, { recursive: true });
    projDir = join(home, 'stopE2e', 'proj');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(home, '.claude-mem-lite');
    mkdirSync(join(dbDir, 'runtime'), { recursive: true });
    dbPath = join(dbDir, 'claude-mem-lite.db');

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('cc-stop-e2e', 'mem-stop-e2e', ?, ?, ?, 'active')
    `).run(PROJECT, new Date(now).toISOString(), now);
    db.close();

    baseEnv = { ...process.env };
    // Strip the developer's own plugin flags so no default-OFF surface flips on
    // in the child (#8608 leak class).
    for (const k of Object.keys(baseEnv)) {
      if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete baseEnv[k];
    }
    Object.assign(baseEnv, {
      HOME: home,
      CLAUDE_MEM_DIR: dbDir,
      CLAUDE_PROJECT_DIR: projDir,
      CLAUDE_CODE_PATH: join(home, 'no-such-claude-binary'), // no LLM spend, no network
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      CLAUDE_MEM_SKIP_SUMMARY: '1',   // the detached worker that recreated the sandbox behind cleanup
      CLAUDE_MEM_NO_DELAY: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
    });
    delete baseEnv.CLAUDE_MEM_HOOK_RUNNING;
  });

  // Distinct COUNTS per face, deliberately: with one obs each, the uncited rows
  // are interchangeable and a swapped attribution is undetectable. Post-tag
  // review proved it — relabelling ups<->fyi at hook.mjs's recordCitationSurfaces
  // call left this file 3/3 and citation-surface-funnel.test.mjs 32/32 green.
  // A per-face funnel exists to answer "which face", so the counts must identify
  // the label.
  const FACE_SIZES = { pretool: 2, ups: 3, error_recall: 1, fyi: 4 };

  /** Seed FACE_SIZES[face] observations per face; returns { face: [ids] }. */
  function seedObservations() {
    const db = new Database(dbPath);
    const now = Date.now();
    const ids = {};
    const stmt = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
      VALUES ('mem-stop-e2e', ?, ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 2, 0, ?, ?)
    `);
    for (const [face, n] of Object.entries(FACE_SIZES)) {
      ids[face] = [];
      for (let i = 0; i < n; i++) {
        ids[face].push(Number(stmt.run(
          PROJECT, `${face} body text ${i}`, `Observation ${i} for the ${face} face`,
          new Date(now).toISOString(), now,
        ).lastInsertRowid));
      }
    }
    db.close();
    return ids;
  }

  function runStop(transcriptPath) {
    execFileSync(process.execPath, [HOOK_PATH, 'stop'], {
      input: JSON.stringify({ session_id: 'cc-stop-e2e', transcript_path: transcriptPath }),
      timeout: 30000, encoding: 'utf8', env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  function surfaceRows() {
    const db = new Database(dbPath, { readonly: true });
    // A detached background worker may still hold a write txn. WAL makes readers
    // non-blocking today, but a busy_timeout costs nothing and removes the
    // dependency on that staying true.
    db.pragma('busy_timeout = 2000');
    try {
      return db.prepare(
        'SELECT surface, session_id, injected_n, cited_n FROM citation_surface_log WHERE project = ? ORDER BY surface'
      ).all(PROJECT);
    } finally { db.close(); }
  }

  // FAILS IF: the table is never created, the recorder is never reached from
  // Stop, the row key is wrong, a swallowed error turns the write into a no-op,
  // or ANY TWO FACES ARE ATTRIBUTED TO EACH OTHER. Every one of those keeps
  // tests/citation-surface-funnel.test.mjs's source-text wiring assertions green.
  it('writes one row per injected face, attributed to the right face, with cites counted', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      faceAttachment.pretool(ids.pretool),
      faceAttachment.ups(ids.ups),
      faceAttachment.error_recall(ids.error_recall),
      faceAttachment.fyi(ids.fyi),
      // Cite one obs from TWO different faces. With a single cited face, cited_n
      // is 1/0/0/0 and any pair of the three zeros can trade places unnoticed.
      assistantText(
        `Applying the boundary-match fix from #${ids.pretool[0]}, and #${ids.error_recall[0]} explains the EPIPE.`,
      ),
    ].map((e) => JSON.stringify(e)).join('\n'));

    runStop(transcriptPath);

    const rows = surfaceRows();
    expect(rows.map((r) => r.surface)).toEqual(['error_recall', 'fyi', 'pretool', 'ups']);
    const by = Object.fromEntries(rows.map((r) => [r.surface, r]));
    // Distinct (injected_n, cited_n) per face — no two rows share a pair, so a
    // relabelled attribution cannot satisfy this set.
    expect(by.pretool).toMatchObject({ injected_n: 2, cited_n: 1 });
    expect(by.ups).toMatchObject({ injected_n: 3, cited_n: 0 });
    expect(by.error_recall).toMatchObject({ injected_n: 1, cited_n: 1 });
    expect(by.fyi).toMatchObject({ injected_n: 4, cited_n: 0 });
  });

  // The counterpart to the recorder's overwrite-idempotency unit test, at the
  // process boundary: Claude Code fires Stop again on a resumed turn.
  it('a second Stop on the same session overwrites rather than doubling', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      faceAttachment.pretool(ids.pretool),
      assistantText(`Cited #${ids.pretool[0]} while fixing the builder.`),
    ].map((e) => JSON.stringify(e)).join('\n'));

    runStop(transcriptPath);
    runStop(transcriptPath);

    const rows = surfaceRows();
    expect(rows).toHaveLength(1);
    // injected_n stays at the seeded 2, not 4: the row is overwritten, not summed.
    expect(rows[0]).toMatchObject({ surface: 'pretool', injected_n: 2, cited_n: 1 });
  });

  // Text-floor gate: a tool-only Stop must record nothing, so an unfinished turn
  // cannot bank an "injected but uncited" verdict the next turn can't undo.
  it('records nothing when the turn produced no main-thread assistant text', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(transcriptPath, [faceAttachment.pretool(ids.pretool)]
      .map((e) => JSON.stringify(e)).join('\n'));

    runStop(transcriptPath);

    expect(surfaceRows()).toEqual([]);
  });
});
