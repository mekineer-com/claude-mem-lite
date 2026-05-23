import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractInjectedFromPreToolUse, extractCitationsFromTranscript } from '../lib/citation-tracker.mjs';

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
