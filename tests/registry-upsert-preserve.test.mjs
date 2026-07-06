// Regression: a PARTIAL re-import (metadata edit — the only registry edit path; see
// commands/tools.md "Modifying a tool → import (upsert)") must NOT wipe the columns the
// caller didn't pass. cmdRegistry/mem_registry default local_path/repo_url to '' and
// source to 'user', and the UPSERT clobbered local_path/repo_url with bare excluded.* and
// flipped source github→user — orphaning the resource (mem_use/enrich read local_path,
// scanner needs it to disable, and 'user' grants the -0.15 rank boost to a broken row).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { ensureRegistryDb, upsertResource } from '../registry.mjs';

const CLI_PATH = resolve('cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-reg-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function runCli(args, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, CLAUDE_MEM_DIR: dataDir, CLAUDE_PROJECT_DIR: dataDir, CLAUDE_MEM_HOOK_RUNNING: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', exitCode: e.status ?? 1 };
  }
}

describe('registry partial re-import preserves un-passed columns', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('upsertResource keeps existing local_path/repo_url when the re-upsert passes them empty', () => {
    const db = ensureRegistryDb(join(dir, 'reg.db'));
    try {
      upsertResource(db, {
        name: 'gh-skill', type: 'skill', status: 'active', source: 'github',
        repo_url: 'https://github.com/foo/bar', local_path: '/managed/skills/gh-skill/SKILL.md',
        capability_summary: 'original',
      });
      // Partial re-upsert — caller passes '' / null for the untouched columns.
      upsertResource(db, {
        name: 'gh-skill', type: 'skill', status: 'active', source: 'github',
        repo_url: null, local_path: '', capability_summary: 'updated summary',
      });
      const row = db.prepare("SELECT local_path, repo_url, capability_summary FROM resources WHERE type='skill' AND name='gh-skill'").get();
      expect(row.local_path).toBe('/managed/skills/gh-skill/SKILL.md'); // preserved, not blanked
      expect(row.repo_url).toBe('https://github.com/foo/bar');          // preserved, not nulled
      expect(row.capability_summary).toBe('updated summary');           // the one field that WAS passed
    } finally { db.close(); }
  });

  it('CLI metadata edit preserves source/local_path/repo_url (no github→user flip)', () => {
    const create = runCli(['registry', 'import', '--name', 'gh-skill', '--resource-type', 'skill',
      '--source', 'github', '--repo-url', 'https://github.com/foo/bar', '--local-path', '/managed/skills/gh-skill/SKILL.md',
      '--capability-summary', 'original'], dir);
    expect(create.exitCode).toBe(0);
    // Metadata-only edit: no --source/--repo-url/--local-path.
    const edit = runCli(['registry', 'import', '--name', 'gh-skill', '--resource-type', 'skill',
      '--capability-summary', 'updated'], dir);
    expect(edit.exitCode).toBe(0);

    const db = new Database(join(dir, 'resource-registry.db'), { readonly: true });
    const row = db.prepare("SELECT source, local_path, repo_url FROM resources WHERE type='skill' AND name='gh-skill'").get();
    db.close();
    expect(row.source).toBe('github');                                    // not flipped to 'user'
    expect(row.local_path).toBe('/managed/skills/gh-skill/SKILL.md');      // not blanked
    expect(row.repo_url).toBe('https://github.com/foo/bar');              // not nulled
  });

  it('rejects an invalid --source with a clean error, not a raw SqliteError stacktrace', () => {
    const r = runCli(['registry', 'import', '--name', 'foo', '--resource-type', 'skill', '--source', 'bogus'], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + (r.stderr || '')).toContain('Invalid --source');
    expect(r.stdout + (r.stderr || '')).not.toContain('SqliteError'); // no leaked stacktrace
  });
});
