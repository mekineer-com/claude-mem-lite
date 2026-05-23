// Tests for lib/cite-back-hint.mjs — pure builder for the PostToolUse cite-back
// nudge that fires when an episode edits a file that PreToolUse:Read/Edit had
// nudged earlier in the same session.
//
// Behavior contract:
//   - Input: episode (entries with tool/files), session cooldown object
//   - Output: hint string ready to push into the flushEpisode `lines` array,
//     or null when no cite-back signal exists.
//   - Cooldown schema (post-v2.81): { "<path>": { ts: <number>, lessonIds: [#NN, ...] } }
//   - Legacy schema (pre-v2.81):    { "<path>": <number> } — must be tolerated, never emit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCiteBackHint, loadCiteBackForEpisode } from '../lib/cite-back-hint.mjs';

const editEntry = (file, tool = 'Edit') => ({ tool, files: [file], isError: false });
const readEntry = (file) => ({ tool: 'Read', files: [file], isError: false });

describe('buildCiteBackHint', () => {
  it('returns a hint when an edited file has prior lessons in cooldown', () => {
    const episode = { entries: [editEntry('/p/src/foo.mjs')] };
    const cooldown = {
      '/p/src/foo.mjs': { ts: Date.now(), lessonIds: [8447] },
    };
    const hint = buildCiteBackHint(episode, cooldown);
    expect(hint).not.toBeNull();
    expect(hint).toContain('foo.mjs');
    expect(hint).toContain('#8447');
    expect(hint).toContain('/lesson --file');
  });

  it('returns null when no edited file is present in cooldown', () => {
    const episode = { entries: [editEntry('/p/src/bar.mjs')] };
    const cooldown = { '/p/src/foo.mjs': { ts: Date.now(), lessonIds: [8447] } };
    expect(buildCiteBackHint(episode, cooldown)).toBeNull();
  });

  it('returns null on legacy number-only cooldown entries (no lessonIds)', () => {
    const episode = { entries: [editEntry('/p/src/foo.mjs')] };
    const cooldown = { '/p/src/foo.mjs': Date.now() };
    expect(buildCiteBackHint(episode, cooldown)).toBeNull();
  });

  it('returns null when lessonIds is empty (empty-pre-recall case)', () => {
    const episode = { entries: [editEntry('/p/src/foo.mjs')] };
    const cooldown = { '/p/src/foo.mjs': { ts: Date.now(), lessonIds: [] } };
    expect(buildCiteBackHint(episode, cooldown)).toBeNull();
  });

  it('returns null when the file was only Read, never Edited', () => {
    const episode = { entries: [readEntry('/p/src/foo.mjs')] };
    const cooldown = { '/p/src/foo.mjs': { ts: Date.now(), lessonIds: [8447] } };
    expect(buildCiteBackHint(episode, cooldown)).toBeNull();
  });

  it('lists every lesson id when a file has multiple', () => {
    const episode = { entries: [editEntry('/p/src/foo.mjs')] };
    const cooldown = {
      '/p/src/foo.mjs': { ts: Date.now(), lessonIds: [8447, 8256] },
    };
    const hint = buildCiteBackHint(episode, cooldown);
    expect(hint).toContain('#8447');
    expect(hint).toContain('#8256');
  });

  it('caps at 2 matched files and drops the rest silently', () => {
    const episode = {
      entries: [
        editEntry('/p/a.mjs'),
        editEntry('/p/b.mjs'),
        editEntry('/p/c.mjs'),
      ],
    };
    const cooldown = {
      '/p/a.mjs': { ts: Date.now(), lessonIds: [1] },
      '/p/b.mjs': { ts: Date.now(), lessonIds: [2] },
      '/p/c.mjs': { ts: Date.now(), lessonIds: [3] },
    };
    const hint = buildCiteBackHint(episode, cooldown);
    expect(hint).toContain('a.mjs');
    expect(hint).toContain('b.mjs');
    expect(hint).not.toContain('c.mjs');
  });

  it('returns null on empty episode', () => {
    expect(buildCiteBackHint({ entries: [] }, {})).toBeNull();
  });

  it('returns null on empty cooldown', () => {
    expect(buildCiteBackHint({ entries: [editEntry('/p/foo.mjs')] }, {})).toBeNull();
  });

  it('accepts NotebookEdit as an edit tool', () => {
    const episode = { entries: [editEntry('/p/n.ipynb', 'NotebookEdit')] };
    const cooldown = { '/p/n.ipynb': { ts: Date.now(), lessonIds: [42] } };
    const hint = buildCiteBackHint(episode, cooldown);
    expect(hint).toContain('#42');
  });

  it('accepts Write as an edit tool', () => {
    const episode = { entries: [editEntry('/p/new.mjs', 'Write')] };
    const cooldown = { '/p/new.mjs': { ts: Date.now(), lessonIds: [99] } };
    expect(buildCiteBackHint(episode, cooldown)).toContain('#99');
  });

  it('dedupes the same file edited multiple times', () => {
    const episode = {
      entries: [editEntry('/p/foo.mjs'), editEntry('/p/foo.mjs')],
    };
    const cooldown = { '/p/foo.mjs': { ts: Date.now(), lessonIds: [7] } };
    const hint = buildCiteBackHint(episode, cooldown);
    // Dedup invariant: one bullet line per file even if the same file appears
    // in multiple entries. (Filename intentionally appears twice per line —
    // once in the bullet header, once in the `/lesson --file <name>` template.)
    const bulletLines = hint.split('\n').filter(l => l.trim().startsWith('•'));
    expect(bulletLines.length).toBe(1);
  });

  it('tolerates null/undefined inputs without throwing', () => {
    expect(buildCiteBackHint(null, {})).toBeNull();
    expect(buildCiteBackHint({ entries: [editEntry('/p/foo.mjs')] }, null)).toBeNull();
    expect(buildCiteBackHint(null, null)).toBeNull();
  });
});

// ─── loadCiteBackForEpisode ─────────────────────────────────────────────────
// Bridges the pure hint builder to the on-disk cooldown file that
// scripts/pre-tool-recall.js writes. Path scheme must match pre-tool-recall's
// cooldownPathFor() — drift here would silently zero cite-back across the
// release. These tests pin the contract.

describe('loadCiteBackForEpisode', () => {
  let runtimeDir;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'cite-back-runtime-'));
  });

  afterEach(() => {
    try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  });

  function seedCooldown(sessionId, data) {
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
    const cooldownPath = join(runtimeDir, `pre-recall-cooldown-${safe}.json`);
    writeFileSync(cooldownPath, JSON.stringify(data));
  }

  it('returns hint when cooldown file exists and matches edited file', () => {
    seedCooldown('sess-1', { '/p/foo.mjs': { ts: Date.now(), lessonIds: [8447] } });
    const episode = {
      sessionId: 'sess-1',
      entries: [{ tool: 'Edit', files: ['/p/foo.mjs'], isError: false }],
    };
    const hint = loadCiteBackForEpisode(episode, runtimeDir);
    expect(hint).toContain('#8447');
    expect(hint).toContain('foo.mjs');
  });

  it('returns null when cooldown file does not exist', () => {
    const episode = {
      sessionId: 'sess-missing',
      entries: [{ tool: 'Edit', files: ['/p/foo.mjs'], isError: false }],
    };
    expect(loadCiteBackForEpisode(episode, runtimeDir)).toBeNull();
  });

  it('returns null when episode has no sessionId', () => {
    seedCooldown('sess-x', { '/p/foo.mjs': { ts: Date.now(), lessonIds: [8447] } });
    const episode = {
      entries: [{ tool: 'Edit', files: ['/p/foo.mjs'], isError: false }],
    };
    expect(loadCiteBackForEpisode(episode, runtimeDir)).toBeNull();
  });

  it('returns null when cooldown JSON is malformed', () => {
    const safe = 'sess-bad';
    writeFileSync(join(runtimeDir, `pre-recall-cooldown-${safe}.json`), '{not json');
    const episode = {
      sessionId: safe,
      entries: [{ tool: 'Edit', files: ['/p/foo.mjs'], isError: false }],
    };
    expect(loadCiteBackForEpisode(episode, runtimeDir)).toBeNull();
  });

  it('sanitizes the sessionId the same way pre-tool-recall.js does', () => {
    // pre-tool-recall.js: replace non-[A-Za-z0-9_.-] with `-`, slice(0,64)
    // Verifies the path scheme stays in lockstep across the two files.
    const rawSessionId = 'sess/with:weird@chars';
    const safe = rawSessionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
    writeFileSync(
      join(runtimeDir, `pre-recall-cooldown-${safe}.json`),
      JSON.stringify({ '/p/foo.mjs': { ts: Date.now(), lessonIds: [42] } }),
    );
    const episode = {
      sessionId: rawSessionId,
      entries: [{ tool: 'Edit', files: ['/p/foo.mjs'], isError: false }],
    };
    expect(loadCiteBackForEpisode(episode, runtimeDir)).toContain('#42');
  });
});
