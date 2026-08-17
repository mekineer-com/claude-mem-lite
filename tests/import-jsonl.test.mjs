import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, truncateSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl, MAX_IMPORT_BYTES } from '../lib/import-jsonl.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures/sample-claude-jsonl/sample.jsonl');

describe('importJsonl — fixture', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('imports 2 user prompts from fixture', async () => {
    const r = await importJsonl(db, FIXTURE, { project: 'proj' });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get();
    expect(cnt.n).toBe(2);
    expect(r.prompts).toBe(2);
  });

  it('imports 2 observations (one per tool_use+tool_result pair)', async () => {
    await importJsonl(db, FIXTURE, { project: 'proj' });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM observations').get();
    expect(cnt.n).toBe(2);
  });

  it('creates exactly one sdk_sessions row for the fixture sessionId', async () => {
    await importJsonl(db, FIXTURE, { project: 'proj' });
    const rows = db.prepare('SELECT content_session_id FROM sdk_sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].content_session_id).toBe('sess-fix-1');
  });

  it('is idempotent — re-running on the same file does not duplicate', async () => {
    await importJsonl(db, FIXTURE, { project: 'proj' });
    await importJsonl(db, FIXTURE, { project: 'proj' });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM observations').get();
    expect(cnt.n).toBe(2);
  });

  // recognized > 0 on a valid transcript even when fully deduped — this is the
  // signal cmdImportJsonl uses to NOT mislabel an idempotent re-run as "wrong shape".
  it('reports recognized transcript events on both first import and re-run', async () => {
    const first = await importJsonl(db, FIXTURE, { project: 'proj' });
    expect(first.recognized).toBeGreaterThan(0);
    const second = await importJsonl(db, FIXTURE, { project: 'proj' });
    expect(second.recognized).toBeGreaterThan(0); // still recognized, just all deduped
    expect(second.prompts).toBe(0);
    expect(second.observations).toBe(0);
  });

  // A wrong-shape file (e.g. `export` output: observation-shaped JSON with no
  // user/assistant/tool_result events) yields recognized === 0 — the genuine
  // "wrong shape" signal that must still fire the warning.
  it('reports recognized === 0 for non-transcript (export-shaped) input', async () => {
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/export-shaped.jsonl');
    const fs = await import('fs');
    fs.writeFileSync(tmpPath, [
      '{"id":1,"type":"bugfix","title":"obs one","narrative":"body"}',
      '{"id":2,"type":"decision","title":"obs two","narrative":"body"}',
    ].join('\n') + '\n');
    try {
      const r = await importJsonl(db, tmpPath, { project: 'proj' });
      expect(r.recognized).toBe(0);
      expect(r.prompts).toBe(0);
      expect(r.observations).toBe(0);
      expect(r.skipped).toBe(2);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('scrubs secrets from imported text fields', async () => {
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/with-secret.jsonl');
    const fs = await import('fs');
    const orig = fs.readFileSync(FIXTURE, 'utf8');
    const evil = `\n{"type":"user","sessionId":"sess-fix-1","cwd":"/home/u/proj","message":{"role":"user","content":"key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"timestamp":"2026-04-01T10:10:00Z"}\n`;
    fs.writeFileSync(tmpPath, orig + evil);
    try {
      await importJsonl(db, tmpPath, { project: 'proj' });
      const last = db.prepare('SELECT prompt_text FROM user_prompts ORDER BY id DESC LIMIT 1').get();
      expect(last.prompt_text).not.toContain('sk-ant-api03-AAAAAAAAAAA');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('imports transcripts whose sessionId is a real Claude Code UUID without tripping the v2.33.1 mix-trigger', async () => {
    // Regression: the schema's sdk_sessions_id_mix_check trigger aborts when
    // memory_session_id == content_session_id and both look like a CC UUID
    // (length 36 + hyphenated 8-4-4-4-12). Earlier importJsonl wrote the raw
    // UUID into both columns, which fired the trigger and crashed the import
    // for every real ~/.claude/projects/* transcript. Fixture sessionIds
    // ('sess-fix-1', 'trunc-1') don't match the UUID shape so they slipped
    // through the original test pass.
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/uuid-sess.jsonl');
    const fs = await import('fs');
    const uuidLines = [
      '{"type":"user","sessionId":"4dfa195d-8da2-48f2-818b-38a1a7436514","cwd":"/p","message":{"role":"user","content":"hi"},"timestamp":"2026-04-01T12:00:00Z"}',
    ].join('\n') + '\n';
    fs.writeFileSync(tmpPath, uuidLines);
    try {
      await expect(importJsonl(db, tmpPath, { project: 'proj' })).resolves.toBeDefined();
      const session = db.prepare("SELECT content_session_id, memory_session_id FROM sdk_sessions WHERE content_session_id = '4dfa195d-8da2-48f2-818b-38a1a7436514'").get();
      expect(session).toBeDefined();
      expect(session.memory_session_id).not.toBe(session.content_session_id);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('pairs tool_use with tool_result wrapped inside a user-typed event (real Claude Code shape)', async () => {
    // Regression: real ~/.claude/projects/* transcripts emit tool_result as
    // a part inside `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}`,
    // not as a top-level `{"type":"tool_result",...}` line. Earlier importer
    // only matched the top-level shape, so every real tool_use orphaned.
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/wrapped-result.jsonl');
    const fs = await import('fs');
    const realShape = [
      '{"type":"user","sessionId":"wrap-1","cwd":"/p","message":{"role":"user","content":"Read foo"},"timestamp":"2026-04-01T13:00:00Z"}',
      '{"type":"assistant","sessionId":"wrap-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"u1","name":"Read","input":{"file_path":"/p/foo.mjs"}}]},"timestamp":"2026-04-01T13:00:01Z"}',
      '{"type":"user","sessionId":"wrap-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"u1","content":"foo file body"}]},"timestamp":"2026-04-01T13:00:02Z"}',
    ].join('\n') + '\n';
    fs.writeFileSync(tmpPath, realShape);
    try {
      const r = await importJsonl(db, tmpPath, { project: 'proj' });
      expect(r.observations).toBe(1);
      expect(r.orphans).toBe(0);
      const obs = db.prepare("SELECT text, title FROM observations WHERE memory_session_id = 'import-wrap-1'").get();
      expect(obs).toBeDefined();
      expect(obs.text).toContain('foo file body');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('writes orphan observation when tool_use has no matching tool_result (truncated)', async () => {
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/truncated.jsonl');
    const fs = await import('fs');
    const truncated = [
      '{"type":"user","sessionId":"trunc-1","cwd":"/p","message":{"role":"user","content":"Read the file"},"timestamp":"2026-04-01T11:00:00Z"}',
      '{"type":"assistant","sessionId":"trunc-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"orphan","name":"Read","input":{"file_path":"/p/a.mjs"}}]},"timestamp":"2026-04-01T11:00:01Z"}',
      // no tool_result
    ].join('\n') + '\n';
    fs.writeFileSync(tmpPath, truncated);
    try {
      const r = await importJsonl(db, tmpPath, { project: 'proj' });
      expect(r.orphans).toBe(1);
      const obs = db.prepare("SELECT text FROM observations WHERE memory_session_id = 'import-trunc-1'").get();
      expect(obs.text).toContain('transcript truncated');
      // The reported observation count must equal the rows actually written. `orphans` is
      // a SUBSET of `observations`, not a sibling: before this fix the import reported
      // "+0 observations, 1 orphan tool_use" while writing one observation row, so a user
      // backfilling a still-open (therefore truncated) transcript read it as a no-op.
      const written = db.prepare('SELECT count(*) AS c FROM observations').get().c;
      expect(r.observations).toBe(written);
      expect(r.observations).toBeGreaterThanOrEqual(r.orphans);
      // The body belongs in `narrative`, not only in `text`. `text` is a DERIVED search
      // blob that applyObsUpdate recomputes from narrative — an imported row that leaves
      // narrative empty loses its payload the first time anything calls `update` on it
      // (see tests/update-preserves-body.test.mjs). Pre-tag review found that reverting
      // this to `narrative: ''` left the ENTIRE suite green, so the ingest half of that
      // fix had no guard at all; the rebuild repair silently masked it.
      const stored = db.prepare(
        "SELECT narrative, text FROM observations WHERE memory_session_id = 'import-trunc-1'").get();
      expect(stored.narrative).toContain('transcript truncated');
      expect(stored.narrative).toBe(stored.text);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

describe('importJsonl — oversized-file guard', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('rejects a transcript above the size cap before reading it (no OOM)', async () => {
    // Sparse file: logical size > cap, ~0 real disk blocks. statSync sees the
    // logical size, so the guard throws before readFileSync materializes it.
    const dir = mkdtempSync(join(tmpdir(), 'mem-import-big-'));
    const big = join(dir, 'huge.jsonl');
    writeFileSync(big, '');
    truncateSync(big, MAX_IMPORT_BYTES + 1024);
    try {
      await expect(importJsonl(db, big, { project: 'proj' })).rejects.toThrow(/too large/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
