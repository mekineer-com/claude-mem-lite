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
// ISOLATION: HOME / CLAUDE_MEM_DIR point at a mkdtemp sandbox; nothing touches
// the live ~/.claude-mem-lite, and CLAUDE_CODE_PATH points at a nonexistent
// binary so no LLM spend or network can occur.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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

const faceAttachment = {
  pretool: (id) => att('node "/home/sds/.claude-mem-lite/scripts/pre-tool-recall.js"',
    `[mem] Lessons for utils.mjs:\n  #${id} [bugfix] boundary match beats suffix LIKE\n`),
  ups: (id) => att('node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
    `<memory-context relevance="high">\n- [decision] picked X | Lesson: Y (#${id})\n</memory-context>\n`),
  error_recall: (id) => att('bash "/home/sds/.claude-mem-lite/scripts/post-tool-use.sh"',
    `[claude-mem-lite] Related memories found for this error:\n  #${id} [bugfix] EPIPE on forced exit\n`),
  fyi: (id) => att('node "/home/sds/.claude-mem-lite/scripts/user-prompt-search.js"',
    `[mem] FYI — Related memories (continue your task):\n#${id} 🔴 superseded invariant reopened\n`),
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
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300)); // let detached workers exit first
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
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
      CLAUDE_MEM_NO_DELAY: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
    });
    delete baseEnv.CLAUDE_MEM_HOOK_RUNNING;
  });

  /** Seed one observation per face; returns { face: id }. */
  function seedObservations() {
    const db = new Database(dbPath);
    const now = Date.now();
    const ids = {};
    for (const face of ['pretool', 'ups', 'error_recall', 'fyi']) {
      ids[face] = Number(db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
          concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
        VALUES ('mem-stop-e2e', ?, ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 2, 0, ?, ?)
      `).run(PROJECT, `${face} body text`, `Observation for the ${face} face`,
        new Date(now).toISOString(), now).lastInsertRowid);
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
    try {
      return db.prepare(
        'SELECT surface, session_id, injected_n, cited_n FROM citation_surface_log WHERE project = ? ORDER BY surface'
      ).all(PROJECT);
    } finally { db.close(); }
  }

  // FAILS IF: the table is never created, the recorder is never reached from
  // Stop, the row key is wrong, or a swallowed error turns the write into a
  // no-op. Every one of those keeps tests/citation-surface-funnel.test.mjs's
  // source-text wiring assertions green.
  it('writes one row per injected face, with the cited face counted', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      faceAttachment.pretool(ids.pretool),
      faceAttachment.ups(ids.ups),
      faceAttachment.error_recall(ids.error_recall),
      faceAttachment.fyi(ids.fyi),
      // Cites the pretool obs only — so `cited` must differentiate the faces
      // rather than mirroring `injected` for all four.
      assistantText(`Applying the boundary-match fix from #${ids.pretool} to the query builder.`),
    ].map((e) => JSON.stringify(e)).join('\n'));

    runStop(transcriptPath);

    const rows = surfaceRows();
    expect(rows.map((r) => r.surface)).toEqual(['error_recall', 'fyi', 'pretool', 'ups']);
    const by = Object.fromEntries(rows.map((r) => [r.surface, r]));
    expect(by.pretool).toMatchObject({ injected_n: 1, cited_n: 1 });
    expect(by.ups).toMatchObject({ injected_n: 1, cited_n: 0 });
    expect(by.error_recall).toMatchObject({ injected_n: 1, cited_n: 0 });
    expect(by.fyi).toMatchObject({ injected_n: 1, cited_n: 0 });
  });

  // The counterpart to the recorder's overwrite-idempotency unit test, at the
  // process boundary: Claude Code fires Stop again on a resumed turn.
  it('a second Stop on the same session overwrites rather than doubling', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      faceAttachment.pretool(ids.pretool),
      assistantText(`Cited #${ids.pretool} while fixing the builder.`),
    ].map((e) => JSON.stringify(e)).join('\n'));

    runStop(transcriptPath);
    runStop(transcriptPath);

    const rows = surfaceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'pretool', injected_n: 1, cited_n: 1 });
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
