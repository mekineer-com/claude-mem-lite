// scripts/pre-tool-recall.js must derive the SAME project string as the save path.
//
// Recall queries the project that observations were SAVED under, so the two derivations
// have to agree byte-for-byte. pre-tool-recall.js used to carry a hand-kept copy of the
// six lines, and that copy had already drifted once — it omitted the process.env.PWD
// fallback, so under a symlinked project dir (PWD = logical path, cwd = resolved) with
// CLAUDE_PROJECT_DIR unset it computed a DIFFERENT project than the save path and
// silently recalled nothing. It now imports the shared implementation; this pins that
// the two stay one implementation rather than two that happen to match today.
//
// Context: a git-work-tree anchoring change was written and REVERTED before shipping (it
// split the namespace for sessions rooted below the repo root — see the inferProject
// doc comment). The revert is why this file tests the invariant rather than the walk.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { inferProject } from '../project-utils.mjs';

const RECALL_SRC = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

describe('pre-tool-recall project derivation', () => {
  it('imports the shared inferProject instead of redefining it', () => {
    const src = readFileSync(RECALL_SRC, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\binferProject\b[^}]*\}\s*from\s*'\.\.\/project-utils\.mjs'/);
    // A local redefinition is what drifted before; reject its reappearance.
    expect(src).not.toMatch(/function\s+inferProject\s*\(/);
  });

  it('resolves CLAUDE_PROJECT_DIR ahead of PWD, and PWD ahead of cwd', () => {
    const saved = { p: process.env.CLAUDE_PROJECT_DIR, w: process.env.PWD };
    try {
      process.env.CLAUDE_PROJECT_DIR = '/srv/acme/web';
      process.env.PWD = '/somewhere/else';
      expect(inferProject()).toBe('acme--web');
      delete process.env.CLAUDE_PROJECT_DIR;
      expect(inferProject()).toBe('somewhere--else');
    } finally {
      if (saved.p === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.p;
      if (saved.w === undefined) delete process.env.PWD; else process.env.PWD = saved.w;
    }
  });

  it('does not walk up to a git work-tree root (reverted pre-tag — see the doc comment)', () => {
    // Guards the revert: re-introducing the walk would make a session rooted below the
    // repo root read a different project than its own hooks write.
    const saved = { p: process.env.CLAUDE_PROJECT_DIR, w: process.env.PWD };
    try {
      delete process.env.CLAUDE_PROJECT_DIR;
      // This repo IS a git work tree, so a walk would resolve to its root.
      process.env.PWD = resolve(import.meta.dirname, '../lib');
      expect(inferProject()).toBe('mem--lib');
    } finally {
      if (saved.p === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.p;
      if (saved.w === undefined) delete process.env.PWD; else process.env.PWD = saved.w;
    }
  });
});
