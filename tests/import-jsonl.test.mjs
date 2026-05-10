import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl } from '../lib/import-jsonl.mjs';

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
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
