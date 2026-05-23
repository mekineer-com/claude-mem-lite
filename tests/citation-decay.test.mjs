import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractInjectedFromPreToolUse, extractCitationsFromTranscript, applyCitationDecay } from '../lib/citation-tracker.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('extractInjectedFromPreToolUse', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-decay-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 't.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  function preToolAttachment(injectedIdsWithTypes) {
    const lines = ['[mem] PreToolUse recall — system-injected context, continue your planned action:', '[mem] Lessons for foo.js:'];
    for (const { id, type, body } of injectedIdsWithTypes) {
      lines.push(`  #${id} [${type}] ${body || 'placeholder lesson body'}`);
    }
    const stdout = JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') },
    });
    return {
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        hookName: 'PreToolUse:Read',
        command: 'node /home/u/.claude-mem-lite/scripts/pre-tool-recall.js',
        stdout,
        stderr: '',
        exitCode: 0,
      },
    };
  }

  it('extracts injected IDs from pre-tool-recall attachment stdout', () => {
    const path = writeTranscript([
      preToolAttachment([{ id: 42, type: 'bugfix' }, { id: 7556, type: 'decision' }]),
    ]);
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.has(42)).toBe(true);
    expect(ids.has(7556)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('ignores attachments from non-mem hooks', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          hookName: 'PreToolUse:Read',
          command: 'other-hook',
          stdout: 'mentions #99 but not from us',
          stderr: '',
          exitCode: 0,
        },
      },
    ]);
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.size).toBe(0);
  });

  it('ignores backfill-only "No prior lessons" lines (no #ID)', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: '[mem] No prior lessons for foo.js — if you solve a bug, run /lesson',
      },
    });
    const path = writeTranscript([
      { type: 'attachment', attachment: { type: 'hook_success', hookName: 'PreToolUse:Edit', command: 'pre-tool-recall.js', stdout, stderr: '', exitCode: 0 } },
    ]);
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.size).toBe(0);
  });

  it('returns empty set on missing file', () => {
    expect(extractInjectedFromPreToolUse('/no/such/file').size).toBe(0);
  });

  it('returns empty set when transcriptPath is null/undefined', () => {
    expect(extractInjectedFromPreToolUse(null).size).toBe(0);
    expect(extractInjectedFromPreToolUse(undefined).size).toBe(0);
  });
});

describe('extractCitationsFromTranscript — mainOnly option', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-side-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 't.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('default behavior unchanged: includes sidechain (existing callers)', () => {
    const path = writeTranscript([
      { type: 'assistant', isSidechain: true,  message: { content: [{ type: 'text', text: 'sub-agent saw #100' }] } },
      { type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: 'main cited #200' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(100)).toBe(true);
    expect(ids.has(200)).toBe(true);
  });

  it('with {mainOnly:true}: drops sidechain text', () => {
    const path = writeTranscript([
      { type: 'assistant', isSidechain: true,  message: { content: [{ type: 'text', text: 'sub-agent saw #100' }] } },
      { type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: 'main cited #200' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path, { mainOnly: true });
    expect(ids.has(100)).toBe(false);
    expect(ids.has(200)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('with {mainOnly:true}: treats missing isSidechain as main thread', () => {
    const path = writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'no isSidechain field → assume main, count #300' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path, { mainOnly: true });
    expect(ids.has(300)).toBe(true);
  });
});

describe('applyCitationDecay', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
  });
  afterEach(() => { try { db.close(); } catch {} });

  function makeObs(overrides = {}) {
    const id = insertObs(db, {
      sessionId: 'sess-1',
      project: 'p',
      type: 'bugfix',
      title: 't',
      importance: 2,
      ...overrides,
    }).lastInsertRowid;
    // Post-INSERT updates for citation-decay columns (not in insertObs yet)
    if (overrides.uncited_streak !== undefined || overrides.cited_count !== undefined || overrides.last_decided_session_id !== undefined) {
      db.prepare(`
        UPDATE observations
        SET uncited_streak = ?, cited_count = ?, last_decided_session_id = ?
        WHERE id = ?
      `).run(
        overrides.uncited_streak ?? 0,
        overrides.cited_count ?? 0,
        overrides.last_decided_session_id ?? null,
        id
      );
    }
    return id;
  }

  it('cited obs gets +1 importance and cited_count += 1, streak reset to 0', () => {
    const id = makeObs({ importance: 2, uncited_streak: 1, cited_count: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');
    const row = db.prepare('SELECT importance, cited_count, uncited_streak, last_decided_session_id FROM observations WHERE id=?').get(id);
    expect(row.importance).toBe(3);
    expect(row.cited_count).toBe(1);
    expect(row.uncited_streak).toBe(0);
    expect(row.last_decided_session_id).toBe('sess-1');
  });

  it('importance cap: cited at importance=3 stays at 3', () => {
    const id = makeObs({ importance: 3 });
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');
    expect(db.prepare('SELECT importance FROM observations WHERE id=?').get(id).importance).toBe(3);
  });

  it('uncited streak increment without demotion when streak < 3', () => {
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const r = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    expect(r.importance).toBe(2);
    expect(r.uncited_streak).toBe(1);
  });

  it('uncited at streak=2 → demotion (importance -1) and streak reset to 0', () => {
    const id = makeObs({ importance: 2, uncited_streak: 2 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const r = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    expect(r.importance).toBe(1);
    expect(r.uncited_streak).toBe(0);
  });

  it('importance floor: uncited at importance=0 stays at 0, streak still resets', () => {
    const id = makeObs({ importance: 0, uncited_streak: 2 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const r = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    expect(r.importance).toBe(0);
    expect(r.uncited_streak).toBe(0);
  });

  it('partial cite: of injected {100, 200}, cited={100} → 100 promoted, 200 streak++', () => {
    const id100 = makeObs({ importance: 2, uncited_streak: 0 });
    const id200 = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id100, id200]), new Set([id100]), 'sess-1');
    const a = db.prepare('SELECT importance, cited_count, uncited_streak FROM observations WHERE id=?').get(id100);
    const b = db.prepare('SELECT importance, cited_count, uncited_streak FROM observations WHERE id=?').get(id200);
    expect(a.importance).toBe(3);  expect(a.cited_count).toBe(1);  expect(a.uncited_streak).toBe(0);
    expect(b.importance).toBe(2);  expect(b.cited_count).toBe(0);  expect(b.uncited_streak).toBe(1);
  });

  it('idempotency: running twice for same session is a no-op the second time', () => {
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const after1 = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const after2 = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    expect(after2.importance).toBe(after1.importance);
    expect(after2.uncited_streak).toBe(after1.uncited_streak);
  });

  it('cross-project IDs silently ignored (no rows touched)', () => {
    insertSession(db, { id: 'sess-2', project: 'other' });
    const id = insertObs(db, { sessionId: 'sess-2', project: 'other', type: 'bugfix', title: 't', importance: 2 }).lastInsertRowid;
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id).importance).toBe(2);
  });

  it('returns summary { promoted, demoted, touched } for telemetry', () => {
    const a = makeObs({ importance: 2 });
    const b = makeObs({ importance: 2, uncited_streak: 2 });  // will demote
    const result = applyCitationDecay(db, 'p', new Set([a, b]), new Set([a]), 'sess-1');
    expect(result).toEqual({ promoted: 1, demoted: 1, touched: 2 });
  });

  it('escape hatch: MEM_DISABLE_CITATION_DECAY=1 → no writes, returns zeros', () => {
    const id = makeObs({ importance: 2 });
    process.env.MEM_DISABLE_CITATION_DECAY = '1';
    try {
      const result = applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');
      expect(result).toEqual({ promoted: 0, demoted: 0, touched: 0 });
      expect(db.prepare('SELECT importance FROM observations WHERE id=?').get(id).importance).toBe(2);
    } finally { delete process.env.MEM_DISABLE_CITATION_DECAY; }
  });

  it('null/empty injected set → no-op', () => {
    const id = makeObs({ importance: 2 });
    applyCitationDecay(db, 'p', new Set(), new Set([id]), 'sess-1');
    expect(db.prepare('SELECT importance, last_decided_session_id FROM observations WHERE id=?').get(id).importance).toBe(2);
  });

  it('session dedup: same obs injected twice in one session resolves once', () => {
    // Mirrors spec Test #1: Read→Edit both inject #100 in one session.
    // The caller assembles ONE injected set per session — passing it twice
    // mimics the Stop hook firing twice (idempotent skip on second call).
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(id).uncited_streak).toBe(1);
    // Second invocation (whether from another Stop fire or a duplicate scan) — no change.
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(id).uncited_streak).toBe(1);
  });
});

describe('Stop hook integration — fixture transcript composition', () => {
  let db, tmp;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-int', project: 'p' });
    tmp = mkdtempSync(join(tmpdir(), 'cite-int-'));
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  function makeObs(overrides = {}) {
    const result = insertObs(db, {
      sessionId: 'sess-int', project: 'p', type: 'bugfix', title: 't', importance: 2,
      ...overrides,
    });
    const id = result.lastInsertRowid;
    // Apply the citation-decay defaults via raw update (test-helpers doesn't know about new columns).
    if (overrides.uncited_streak !== undefined || overrides.cited_count !== undefined || overrides.last_decided_session_id !== undefined) {
      db.prepare(`
        UPDATE observations
        SET uncited_streak = ?, cited_count = ?, last_decided_session_id = ?
        WHERE id = ?
      `).run(
        overrides.uncited_streak ?? 0,
        overrides.cited_count ?? 0,
        overrides.last_decided_session_id ?? null,
        id
      );
    }
    return id;
  }

  it('fixture transcript with one injected #ID and a citation → promotion', () => {
    const id = makeObs({ importance: 2 });
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, [
      // PreToolUse mem injection
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success', hookName: 'PreToolUse:Read',
          command: 'pre-tool-recall.js',
          stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `  #${id} [bugfix] sample` } }),
          stderr: '', exitCode: 0,
        },
      }),
      // Assistant cites it (main thread)
      JSON.stringify({
        type: 'assistant', isSidechain: false,
        message: { content: [{ type: 'text', text: `applied #${id}, all good` }] },
      }),
    ].join('\n'));

    const injected = extractInjectedFromPreToolUse(path);
    const cited = extractCitationsFromTranscript(path, { mainOnly: true });
    const result = applyCitationDecay(db, 'p', injected, cited, 'sess-int');
    expect(result).toEqual({ promoted: 1, demoted: 0, touched: 1 });
    expect(db.prepare('SELECT importance FROM observations WHERE id=?').get(id).importance).toBe(3);
  });

  it('fixture transcript: injection from sidechain agent does NOT promote main', () => {
    const id = makeObs({ importance: 2 });
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success', hookName: 'PreToolUse:Read',
          command: 'pre-tool-recall.js',
          stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `  #${id} [bugfix] sample` } }),
          stderr: '', exitCode: 0,
        },
      }),
      // Only the sub-agent cites it — main thread silent
      JSON.stringify({
        type: 'assistant', isSidechain: true,
        message: { content: [{ type: 'text', text: `sub-agent used #${id}` }] },
      }),
    ].join('\n'));

    const injected = extractInjectedFromPreToolUse(path);
    const cited = extractCitationsFromTranscript(path, { mainOnly: true });
    const result = applyCitationDecay(db, 'p', injected, cited, 'sess-int');
    expect(result.touched).toBe(1);
    expect(result.promoted).toBe(0);
    expect(db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(id).uncited_streak).toBe(1);
  });
});

describe('regression: extractor + decay defensive paths (D#21)', () => {
  let tmp, db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cite-reg-'));
    db = createTestDb();
    insertSession(db, { id: 'sess-r', project: 'p' });
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('extractInjectedFromPreToolUse: falls back to raw-text scan when stdout is not JSON', () => {
    const path = join(tmp, 't.jsonl');
    writeFileSync(path, JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        hookName: 'PreToolUse:Read',
        command: 'pre-tool-recall.js',
        stdout: '[mem] Lessons for foo.js:\n  #404 [bugfix] raw-text fallback path',
        stderr: '',
        exitCode: 0,
      },
    }));
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.has(404)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('applyCitationDecay: silently skips IDs that are not in observations (events-table ID case)', () => {
    const realId = insertObs(db, { sessionId: 'sess-r', project: 'p', type: 'bugfix', title: 't', importance: 2 }).lastInsertRowid;
    const ghostId = 99999999;
    const result = applyCitationDecay(db, 'p', new Set([realId, ghostId]), new Set(), 'sess-r');
    expect(result.touched).toBe(1);
    expect(result.demoted).toBe(0);
    expect(result.promoted).toBe(0);
    const realRow = db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(realId);
    expect(realRow.uncited_streak).toBe(1);
    const ghost = db.prepare('SELECT id FROM observations WHERE id=?').get(ghostId);
    expect(ghost).toBeUndefined();
  });
});
