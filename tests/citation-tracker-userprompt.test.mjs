// v34.x: UserPromptSubmit injection extraction — closes the gap that
// extractInjectedFromPreToolUse only matched the `#NN [type]` pre-tool-recall
// emission shape and never saw the `<memory-context>` block emitted by
// hook.mjs handleUserPrompt via formatMemoryLine (`- [type] title (#NN)`).
//
// Disjoint regexes by design — pre-tool-recall format has `[type]` after `#NN`;
// UserPromptSubmit format has `(#NN)` at end-of-line. Tests below pin both
// shapes and confirm they don't cross-fire.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractInjectedFromUserPromptSubmit,
  extractAllInjected,
  extractInjectedFromPreToolUse,
  extractInjectedFromErrorRecall,
  extractInjectedFromFyi,
} from '../lib/citation-tracker.mjs';

describe('extractInjectedFromUserPromptSubmit', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-ups-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('extracts IDs from <memory-context> block emitted by hook.mjs handleUserPrompt', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /home/sds/.claude-mem-lite/hook.mjs user-prompt',
          stdout:
            '<memory-context relevance="high">\n' +
            '- [decision] picked X over Y | Lesson: Z (#8005)\n' +
            '- [bugfix] dropped Q | Lesson: W (#8154)\n' +
            '</memory-context>\n',
        },
      },
    ]);
    const ids = extractInjectedFromUserPromptSubmit(path);
    expect(ids.has(8005)).toBe(true);
    expect(ids.has(8154)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('handles formatMemoryLine with [verify-before-use] stale hint suffix', () => {
    // formatMemoryLine appends ` [verify-before-use]` after `(#NN)` for stale
    // file-bound obs. ID anchor must still be the (#NN) parens, not anything
    // after it.
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node hook.mjs user-prompt',
          stdout:
            '<memory-context relevance="high">\n' +
            '- [decision] old call (#42) [verify-before-use]\n' +
            '</memory-context>\n',
        },
      },
    ]);
    const ids = extractInjectedFromUserPromptSubmit(path);
    expect(ids.has(42)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('only matches lines starting with `- [` (so lesson bodies with (#N) refs are not pulled in)', () => {
    // If a lesson_learned contains a back-reference like "see (#999)", we must
    // NOT add 999 to the injected set — otherwise next-session decay would
    // streak-uncite 999 without us ever having shown it as a top-level entry.
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node hook.mjs user-prompt',
          stdout:
            '<memory-context relevance="high">\n' +
            '- [bugfix] fix similar to (#999) prior incident | Lesson: same root cause (#7)\n' +
            '</memory-context>\n',
        },
      },
    ]);
    const ids = extractInjectedFromUserPromptSubmit(path);
    // Anchor is the LAST `(#NN)` on the line — that's where formatMemoryLine puts the obs id.
    expect(ids.has(7)).toBe(true);
    expect(ids.has(999)).toBe(false);
    expect(ids.size).toBe(1);
  });

  it('ignores pre-tool-recall attachments (different command, different format)', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /home/sds/.claude-mem-lite/scripts/pre-tool-recall.js',
          stdout: '{"hookSpecificOutput":{"additionalContext":"  #42 [bugfix] body"}}',
        },
      },
    ]);
    const ids = extractInjectedFromUserPromptSubmit(path);
    expect(ids.size).toBe(0);
  });

  it('ignores non-attachment entries (user/assistant text outside hooks)', () => {
    const path = writeTranscript([
      { type: 'user', message: { content: [{ type: 'text', text: 'see (#99)' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'per (#42) it works' }] } },
    ]);
    const ids = extractInjectedFromUserPromptSubmit(path);
    expect(ids.size).toBe(0);
  });

  it('handles missing transcript file gracefully', () => {
    const ids = extractInjectedFromUserPromptSubmit(join(tmp, 'does-not-exist.jsonl'));
    expect(ids.size).toBe(0);
  });

  it('matches alternate hook command paths (plugin-cache vs symlinked-install)', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node ${CLAUDE_PLUGIN_ROOT}/hook.mjs user-prompt',
          stdout: '<memory-context relevance="high">\n- [decision] x (#7)\n</memory-context>',
        },
      },
    ]);
    const ids = extractInjectedFromUserPromptSubmit(path);
    expect(ids.has(7)).toBe(true);
  });

  it('matches the PRODUCTION quoted-path command shape (regression for the quoting bug)', () => {
    // Claude Code records the registered hook `node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" user-prompt`
    // verbatim with the path QUOTE-WRAPPED: `node "/abs/hook.mjs" user-prompt`.
    // The pre-fix suffix match `.includes('hook.mjs user-prompt')` failed because
    // the `"` sits between `hook.mjs` and ` user-prompt` — so the UPS surface was
    // invisible to citation-decay in EVERY real install. Tests previously only
    // used unquoted commands, so the bug was never caught. Pin the real shape.
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
          stdout: '<memory-context relevance="high">\n- [bugfix] real prod shape (#7972)\n</memory-context>',
        },
      },
    ]);
    const ids = extractInjectedFromUserPromptSubmit(path);
    expect(ids.has(7972)).toBe(true);
    expect(ids.size).toBe(1);
  });
});

describe('extractInjectedFromErrorRecall', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-err-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('extracts IDs from the PostToolUse error-recall hint (triggerErrorRecall raw stdout)', () => {
    // hook.mjs:352 writes `[claude-mem-lite] Related memories found for this error:`
    // followed by `  #NN [type] title` lines, delivered via post-tool-use.sh.
    // Neither pre-tool-recall nor UserPromptSubmit extractor matched this surface,
    // so 22+ distinct obs/transcript were invisible to decay.
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'bash "/home/sds/.claude-mem-lite/scripts/post-tool-use.sh"',
          stdout:
            '[claude-mem-lite] Related memories found for this error:\n' +
            '  #7933 [bugfix] some prior failure title\n' +
            '  #8455 [decision] related design note\n' +
            '  → Use mem_get(ids=[7933,8455]) for details.\n',
        },
      },
    ]);
    const ids = extractInjectedFromErrorRecall(path);
    expect(ids.has(7933)).toBe(true);
    expect(ids.has(8455)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('does NOT match the bare ids=[...] mem_get line (no #NN [type] anchor)', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'bash post-tool-use.sh',
          stdout:
            '[claude-mem-lite] Related memories found for this error:\n' +
            '  #100 [bugfix] x\n' +
            '  → Use mem_get(ids=[100,200,300]) for details.\n',
        },
      },
    ]);
    const ids = extractInjectedFromErrorRecall(path);
    expect([...ids].sort((a, b) => a - b)).toEqual([100]);
  });

  it('ignores episode-flushed receipts (no error-recall header)', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'bash post-tool-use.sh',
          stdout: '[mem] episode flushed: 6 entries (Bash×6)\n',
        },
      },
    ]);
    const ids = extractInjectedFromErrorRecall(path);
    expect(ids.size).toBe(0);
  });
});

describe('extractInjectedFromFyi', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-fyi-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('extracts obs IDs from user-prompt-search.js [mem] FYI block (line-leading #NN)', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node "/home/sds/.claude-mem-lite/scripts/user-prompt-search.js"',
          stdout:
            '[mem] FYI — Related memories (continue your task):\n' +
            '#8587 🔴 env-gate cross-check — bugfix lesson\n' +
            '#8586 🟡 auto-adopt sentinel change\n',
        },
      },
    ]);
    const ids = extractInjectedFromFyi(path);
    expect(ids.has(8587)).toBe(true);
    expect(ids.has(8586)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('does NOT match P#NN past-question rows (user_prompts, not observations)', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node scripts/user-prompt-search.js',
          stdout:
            '[mem] FYI — Past similar questions (continue your task):\n' +
            'P#4448 💬 review the CLAUDE.md formatting\n',
        },
      },
    ]);
    const ids = extractInjectedFromFyi(path);
    expect(ids.size).toBe(0);
  });

  it('only takes the line-leading id, not #NN inside lesson text', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node scripts/user-prompt-search.js',
          stdout:
            '[mem] FYI — Related memories (continue your task):\n' +
            '#500 🔵 fix relates to #999 prior incident\n',
        },
      },
    ]);
    const ids = extractInjectedFromFyi(path);
    expect(ids.has(500)).toBe(true);
    expect(ids.has(999)).toBe(false);
    expect(ids.size).toBe(1);
  });
});

describe('extractAllInjected (union wrapper)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-all-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('unions pre-tool-recall + UserPromptSubmit injection IDs', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /opt/scripts/pre-tool-recall.js',
          stdout: JSON.stringify({
            hookSpecificOutput: {
              additionalContext: '[mem] Lessons for x.mjs:\n  #100 [bugfix] body',
            },
          }),
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /opt/hook.mjs user-prompt',
          stdout: '<memory-context relevance="high">\n- [decision] y (#200)\n</memory-context>',
        },
      },
    ]);
    const ids = extractAllInjected(path);
    expect(ids.has(100)).toBe(true);
    expect(ids.has(200)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('dedupes overlap when same ID appears in both surfaces', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /opt/scripts/pre-tool-recall.js',
          stdout: JSON.stringify({
            hookSpecificOutput: { additionalContext: '  #42 [bugfix] body' },
          }),
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /opt/hook.mjs user-prompt',
          stdout: '<memory-context relevance="high">\n- [bugfix] same (#42)\n</memory-context>',
        },
      },
    ]);
    const ids = extractAllInjected(path);
    expect(ids.size).toBe(1);
    expect(ids.has(42)).toBe(true);
  });

  it('unions all four injection surfaces (PTR + UPS + error-recall + FYI), production quoted paths', () => {
    const path = writeTranscript([
      { type: 'attachment', attachment: { type: 'hook_success', command: 'node "/p/scripts/pre-tool-recall.js"', stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: '  #100 [bugfix] a' } }) } },
      { type: 'attachment', attachment: { type: 'hook_success', command: 'node "/p/hook.mjs" user-prompt', stdout: '<memory-context relevance="high">\n- [decision] b (#200)\n</memory-context>' } },
      { type: 'attachment', attachment: { type: 'hook_success', command: 'bash "/p/scripts/post-tool-use.sh"', stdout: '[claude-mem-lite] Related memories found for this error:\n  #300 [bugfix] c\n' } },
      { type: 'attachment', attachment: { type: 'hook_success', command: 'node "/p/scripts/user-prompt-search.js"', stdout: '[mem] FYI — Related memories (continue your task):\n#400 🟡 d\n' } },
    ]);
    const ids = extractAllInjected(path);
    expect([...ids].sort((a, b) => a - b)).toEqual([100, 200, 300, 400]);
  });

  it('returns empty Set on missing transcript path', () => {
    const ids = extractAllInjected(null);
    expect(ids.size).toBe(0);
  });

  it('agrees with sole-PTR extraction when only PTR attachments present', () => {
    // Regression-guard: union must not double-count a single attachment.
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /opt/scripts/pre-tool-recall.js',
          stdout: JSON.stringify({
            hookSpecificOutput: { additionalContext: '  #11 [bugfix] a\n  #22 [decision] b' },
          }),
        },
      },
    ]);
    const ptr = extractInjectedFromPreToolUse(path);
    const all = extractAllInjected(path);
    expect([...all].sort()).toEqual([...ptr].sort());
  });
});
