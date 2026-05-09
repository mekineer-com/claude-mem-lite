// Tests for install.mjs::bumpJsonField — the pure JSON-version field bumper
// extracted to fix the pre-2.63.0 plugin.json log glitch ("X → X" instead
// of "prev → X" because the field was read after assignment) and to give
// syncVersions a single point of truth for the 3 JSON files it touches.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bumpJsonField, buildDoctorSummary } from '../install.mjs';

describe('bumpJsonField', () => {
  let dir, file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bumpfield-'));
    file = join(dir, 'thing.json');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('returns {changed:false} and does not rewrite when value unchanged', () => {
    writeFileSync(file, JSON.stringify({ version: '1.2.3' }, null, 2) + '\n');
    const before = readFileSync(file, 'utf8');
    const r = bumpJsonField(file, ['version'], '1.2.3');
    expect(r).toEqual({ changed: false, prev: '1.2.3' });
    // Content untouched
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('captures prev BEFORE mutation (the pre-fix bug)', () => {
    writeFileSync(file, JSON.stringify({ version: '1.2.3' }, null, 2) + '\n');
    const r = bumpJsonField(file, ['version'], '1.3.0');
    // The pre-fix code logged "1.3.0 → 1.3.0" because it read `pluginJson.version`
    // AFTER `pluginJson.version = version`. The helper guarantees prev is captured first.
    expect(r.prev).toBe('1.2.3');
    expect(r.changed).toBe(true);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.version).toBe('1.3.0');
  });

  it('walks nested keyPath (e.g., marketplace.json plugins[0].version)', () => {
    writeFileSync(file, JSON.stringify({ plugins: [{ name: 'p', version: '0.1.0' }] }, null, 2) + '\n');
    const r = bumpJsonField(file, ['plugins', 0, 'version'], '0.2.0');
    expect(r).toEqual({ changed: true, prev: '0.1.0' });
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.plugins[0].version).toBe('0.2.0');
    expect(after.plugins[0].name).toBe('p'); // siblings preserved
  });

  it('returns {changed:false, prev:undefined} when keyPath unreachable', () => {
    writeFileSync(file, JSON.stringify({ other: 'thing' }, null, 2) + '\n');
    const r = bumpJsonField(file, ['plugins', 0, 'version'], '1.0.0');
    expect(r.changed).toBe(false);
    expect(r.prev).toBeUndefined();
  });

  it('writes file with 2-space indent + trailing newline (matches existing convention)', () => {
    writeFileSync(file, JSON.stringify({ version: '1.0.0' }) + '\n'); // no indent
    bumpJsonField(file, ['version'], '1.0.1');
    const out = readFileSync(file, 'utf8');
    // Re-pretty-printed with 2-space indent + trailing newline
    expect(out).toBe('{\n  "version": "1.0.1"\n}\n');
  });
});

describe('package.json::packageManager pin', () => {
  it('declares npm@10.9.2 so corepack-aware tooling matches CI', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.packageManager).toBe('npm@10.9.2');
  });
});

// Belt-and-suspenders: the previously-shipped buildDoctorSummary helper still works
// after the install.mjs refactor (caught the case where reordering exports breaks something).
describe('buildDoctorSummary (regression after install.mjs refactor)', () => {
  it('still returns the all-passed string', () => {
    expect(buildDoctorSummary(0, 0)).toBe('All checks passed!');
  });
});
