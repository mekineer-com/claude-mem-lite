// Phase B (Invited-Memory plan, T5–T9): memdir.mjs primitives.
// Covers: project-path encoding, sentinel IO (read/write/remove), plugin
// doc file IO, adoption detection, hash-guard and 180-line budget.
// See docs/plans/2026-04-16-invited-memory-pattern.md.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  encodeProjectPath, memdirPath,
  readMemoryIndex, writePluginSection, removePluginSection,
  writePluginDoc, removePluginDoc,
  isAdopted,
  UserEditedError, BudgetExceededError,
} from '../memdir.mjs';

// ─── T5: encodeProjectPath ───────────────────────────────────────────────────

describe('encodeProjectPath', () => {
  it('matches ground-truth for the mem project itself (#7687)', () => {
    expect(encodeProjectPath('/mnt/data_ssd/dev/projects/mem'))
      .toBe('-mnt-data-ssd-dev-projects-mem');
  });

  it('mangles dots and underscores', () => {
    expect(encodeProjectPath('/Users/alice/Work/proj.v2'))
      .toBe('-Users-alice-Work-proj-v2');
    expect(encodeProjectPath('my_project'))
      .toBe('my-project');
  });

  it('mangles CJK and other non-alphanumeric to "-" per Claude Code policy', () => {
    // Memory ref #7687: EVERY non-alphanumeric char is replaced, including CJK
    const out = encodeProjectPath('/home/sds/项目');
    expect(out.startsWith('-home-sds-')).toBe(true);
    // Length must equal input length (one-to-one replacement)
    expect(out.length).toBe('/home/sds/项目'.length);
  });

  it('preserves alphanumerics exactly', () => {
    expect(encodeProjectPath('abc123XYZ')).toBe('abc123XYZ');
  });
});

// ─── T5: memdirPath ──────────────────────────────────────────────────────────

describe('memdirPath', () => {
  it('combines home + .claude/projects/<encoded>/memory/', () => {
    const p = memdirPath('/mnt/data_ssd/dev/projects/mem');
    expect(p).toBe(join(homedir(), '.claude', 'projects',
      '-mnt-data-ssd-dev-projects-mem', 'memory'));
  });
});

// ─── T6: sentinel IO ─────────────────────────────────────────────────────────

describe('sentinel IO (writePluginSection / readMemoryIndex / removePluginSection)', () => {
  let tmp, memdir;
  const slug = 'claude-mem-lite';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'memdir-sentinel-'));
    memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('creates MEMORY.md when absent and writes sentinel block', () => {
    const r = writePluginSection(memdir, { slug, version: 'v1', contentLine: '- [x](y.md) — demo' });
    expect(r.action).toBe('created');
    const body = readFileSync(join(memdir, 'MEMORY.md'), 'utf8');
    expect(body).toContain(`<!-- ${slug}:begin v1 -->`);
    expect(body).toContain('- [x](y.md) — demo');
    expect(body).toContain(`<!-- ${slug}:end -->`);
  });

  it('writes state sidecar alongside MEMORY.md', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    expect(existsSync(join(memdir, '.plugin_claude_mem_lite_state.json'))).toBe(true);
  });

  it('is idempotent — second write with same inputs returns unchanged', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const before = readFileSync(join(memdir, 'MEMORY.md'), 'utf8');
    const r = writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    expect(r.action).toBe('unchanged');
    expect(readFileSync(join(memdir, 'MEMORY.md'), 'utf8')).toBe(before);
  });

  it('upgrades v1 → v2 replacing the whole sentinel block', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'old' });
    const r = writePluginSection(memdir, { slug, version: 'v2', contentLine: 'new' });
    expect(r.action).toBe('updated');
    const body = readFileSync(join(memdir, 'MEMORY.md'), 'utf8');
    expect(body).toContain(`<!-- ${slug}:begin v2 -->`);
    expect(body).not.toContain(`<!-- ${slug}:begin v1 -->`);
    expect(body).toContain('new');
    expect(body).not.toContain('old');
  });

  it('throws UserEditedError when sentinel body was modified in place', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'original' });
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'I-hacked-this'));
    expect(() =>
      writePluginSection(memdir, { slug, version: 'v1', contentLine: 'auto-update' }),
    ).toThrow(UserEditedError);
  });

  it('force=true overrides UserEditedError', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'original' });
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'hand-edit'));
    const r = writePluginSection(memdir, {
      slug, version: 'v1', contentLine: 'auto-update', force: true,
    });
    expect(r.action).toBe('updated');
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('auto-update');
    expect(body).not.toContain('hand-edit');
  });

  it('throws UserEditedError when sentinel exists but state file is missing', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    rmSync(join(memdir, '.plugin_claude_mem_lite_state.json'));
    expect(() =>
      writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' }),
    ).toThrow(UserEditedError);
  });

  it('preserves user content outside the sentinel block', () => {
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, '# User memory\n\n## 用户偏好\n- 中文条目\n');
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('# User memory');
    expect(body).toContain('## 用户偏好');
    expect(body).toContain('- 中文条目');
    expect(body).toContain(`<!-- ${slug}:begin v1 -->`);
  });

  it('readMemoryIndex reports absent/present/lineCount/section', () => {
    // Absent
    const r0 = readMemoryIndex(memdir, slug);
    expect(r0.exists).toBe(false);
    expect(r0.section).toBeNull();

    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const r1 = readMemoryIndex(memdir, slug);
    expect(r1.exists).toBe(true);
    expect(r1.section).toMatch(/claude-mem-lite:begin v1/);
    expect(r1.version).toBe('v1');
    expect(r1.lineCount).toBeGreaterThan(0);
  });

  it('removePluginSection removes the block and leaves user content alone', () => {
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, '# User memory\n\n## 用户偏好\n- 中文条目\n');
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const r = removePluginSection(memdir, slug);
    expect(r.action).toBe('removed');
    const body = readFileSync(path, 'utf8');
    expect(body).not.toContain(slug);
    expect(body).toContain('# User memory');
    expect(body).toContain('- 中文条目');
  });

  it('removePluginSection cleans state sidecar', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    const state = join(memdir, '.plugin_claude_mem_lite_state.json');
    expect(existsSync(state)).toBe(true);
    removePluginSection(memdir, slug);
    expect(existsSync(state)).toBe(false);
  });

  it('removePluginSection is a no-op when sentinel is absent', () => {
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, '# preexisting\n');
    const r = removePluginSection(memdir, slug);
    expect(r.action).toBe('absent');
    expect(readFileSync(path, 'utf8')).toBe('# preexisting\n');
  });

  it('throws BudgetExceededError when inserting into >180 line MEMORY.md', () => {
    const big = Array.from({ length: 200 }, (_, i) => `- line ${i}`).join('\n') + '\n';
    writeFileSync(join(memdir, 'MEMORY.md'), big);
    expect(() =>
      writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' }),
    ).toThrow(BudgetExceededError);
  });

  it('budget does NOT block updates to an already-present sentinel', () => {
    // 1) initial write at normal size
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'initial' });
    // 2) balloon user content around our section past the budget
    const path = join(memdir, 'MEMORY.md');
    const prev = readFileSync(path, 'utf8');
    const filler = Array.from({ length: 200 }, (_, i) => `filler ${i}`).join('\n');
    writeFileSync(path, filler + '\n' + prev);
    // 3) update is still allowed (no new line growth)
    expect(() =>
      writePluginSection(memdir, { slug, version: 'v1', contentLine: 'updated' }),
    ).not.toThrow();
    expect(readFileSync(path, 'utf8')).toContain('updated');
  });
});

// ─── T8: isAdopted ───────────────────────────────────────────────────────────

describe('isAdopted', () => {
  let tmp, memdir;
  const slug = 'claude-mem-lite';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'memdir-adopt-'));
    memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns false when memdir is missing', () => {
    expect(isAdopted(join(tmp, 'nonexistent'), slug)).toBe(false);
  });

  it('returns false when MEMORY.md has no sentinel', () => {
    writeFileSync(join(memdir, 'MEMORY.md'), '# no sentinel here\n');
    expect(isAdopted(memdir, slug)).toBe(false);
  });

  it('returns true after writePluginSection', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    expect(isAdopted(memdir, slug)).toBe(true);
  });

  it('still true after user edits body (sentinel still present)', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'original' });
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'edited'));
    expect(isAdopted(memdir, slug)).toBe(true);
  });

  it('returns false after removePluginSection', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    removePluginSection(memdir, slug);
    expect(isAdopted(memdir, slug)).toBe(false);
  });
});

// ─── T7: plugin doc IO ───────────────────────────────────────────────────────

describe('plugin doc IO (writePluginDoc / removePluginDoc)', () => {
  let tmp, memdir;
  const slug = 'claude-mem-lite';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'memdir-doc-'));
    memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes plugin_<slug_snake>.md with given body', () => {
    writePluginDoc(memdir, slug, '# detail\n\nbody content\n');
    const path = join(memdir, 'plugin_claude_mem_lite.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('# detail');
  });

  it('creates memdir automatically when absent', () => {
    const newDir = join(tmp, 'fresh_memdir');
    writePluginDoc(newDir, slug, '# body');
    expect(existsSync(join(newDir, 'plugin_claude_mem_lite.md'))).toBe(true);
  });

  it('overwrites existing doc', () => {
    writePluginDoc(memdir, slug, '# v1');
    writePluginDoc(memdir, slug, '# v2');
    expect(readFileSync(join(memdir, 'plugin_claude_mem_lite.md'), 'utf8')).toContain('# v2');
  });

  it('removePluginDoc deletes the file', () => {
    writePluginDoc(memdir, slug, 'x');
    const path = join(memdir, 'plugin_claude_mem_lite.md');
    removePluginDoc(memdir, slug);
    expect(existsSync(path)).toBe(false);
  });

  it('removePluginDoc is a no-op when absent', () => {
    expect(() => removePluginDoc(memdir, slug)).not.toThrow();
  });
});
