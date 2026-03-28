import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverFromTree, parseFrontmatter, extractKeywords, importFromGitHub } from '../registry-importer.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MOCK_TREE = {
  tree: [
    { path: 'README.md', type: 'blob' },
    { path: 'skills/humanizer/SKILL.md', type: 'blob' },
    { path: 'skills/humanizer/README.md', type: 'blob' },
    { path: 'agents/reviewer/AGENT.md', type: 'blob' },
    { path: '.claude-plugin/plugin.json', type: 'blob' },
    { path: 'plugins/tdd/skills/tdd-workflow/SKILL.md', type: 'blob' },
    { path: 'SKILL.md', type: 'blob' },
  ],
};

describe('discoverFromTree', () => {
  it('discovers skills from flat layout', () => {
    const results = discoverFromTree(MOCK_TREE, '');
    const names = results.map(r => r.name);
    expect(names).toContain('humanizer');
  });

  it('discovers agents', () => {
    const results = discoverFromTree(MOCK_TREE, '');
    const agents = results.filter(r => r.type === 'agent');
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some(a => a.name === 'reviewer')).toBe(true);
  });

  it('discovers plugin-nested skills', () => {
    const results = discoverFromTree(MOCK_TREE, '');
    const names = results.map(r => r.name);
    expect(names).toContain('tdd/tdd-workflow');
  });

  it('discovers root-level SKILL.md', () => {
    const results = discoverFromTree({ tree: [{ path: 'SKILL.md', type: 'blob' }] }, '');
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('skill');
  });

  it('filters by path prefix', () => {
    const results = discoverFromTree(MOCK_TREE, 'skills/humanizer');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('humanizer');
  });

  it('returns empty for no skills', () => {
    const results = discoverFromTree({ tree: [{ path: 'src/index.js', type: 'blob' }] }, '');
    expect(results).toEqual([]);
  });
});

describe('parseFrontmatter', () => {
  it('extracts name and description', () => {
    const content = '---\nname: humanizer\nversion: 2.3.0\ndescription: |\n  Remove AI writing patterns\n---\n# Body';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('humanizer');
    expect(frontmatter.version).toBe('2.3.0');
    expect(frontmatter.description).toContain('Remove AI');
    expect(body).toContain('# Body');
  });

  it('returns empty frontmatter when none exists', () => {
    const { frontmatter, body } = parseFrontmatter('# Just a body');
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe('# Just a body');
  });

  it('parses allowed-tools JSON array', () => {
    const content = '---\nname: test\nallowed-tools: ["Read", "Write", "Edit"]\n---\nbody';
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter['allowed-tools']).toEqual(['Read', 'Write', 'Edit']);
  });
});

describe('extractKeywords', () => {
  it('extracts keywords from content', () => {
    const kw = extractKeywords('Build React components with TypeScript and Jest testing');
    expect(kw.keywords).toContain('react');
    expect(kw.keywords).toContain('typescript');
    expect(kw.keywords).toContain('jest');
  });

  it('infers domain tags', () => {
    const kw = extractKeywords('Use PostgreSQL with Docker for deployment');
    expect(kw.domainTags).toContain('database');
    expect(kw.domainTags).toContain('infrastructure');
  });

  it('infers intent tags', () => {
    const kw = extractKeywords('Debug and troubleshoot production errors');
    expect(kw.intentTags).toContain('debug');
  });
});

// ─── importFromGitHub ───────────────────────────────────────────────────────

describe('importFromGitHub', () => {
  const TMP = join(tmpdir(), 'importer-test-' + process.pid);
  let db;

  beforeEach(() => {
    db = createRegistryTestDb();
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('imports a single skill from mocked tree and content', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 42, forks_count: 5, updated_at: '2026-01-01' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('---\nname: test-skill\ndescription: A test skill\n---\n# Test\nDoes testing.') });

    const results = await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch, managedDir: TMP });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('test-skill');
    expect(results[0].type).toBe('skill');

    const row = db.prepare("SELECT * FROM resources WHERE name = 'test-skill'").get();
    expect(row).toBeTruthy();
    expect(row.repo_stars).toBe(42);
    expect(row.source).toBe('github');
    expect(row.status).toBe('active');
  });

  it('uses repo name for root SKILL.md', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('---\ndescription: Root skill\n---\n# Root') });

    const results = await importFromGitHub(db, 'https://github.com/user/my-tool', { fetchFn: mockFetch, managedDir: TMP });

    expect(results.length).toBe(1);
    // Root skill without explicit name should use repo name
    expect(results[0].name).toBe('my-tool');
  });

  it('returns empty for repo with no skills', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'src/index.js', type: 'blob' }] }) });

    const results = await importFromGitHub(db, 'https://github.com/user/empty', { fetchFn: mockFetch, managedDir: TMP });
    expect(results).toEqual([]);
  });

  it('rejects invalid GitHub URL', async () => {
    await expect(importFromGitHub(db, 'https://gitlab.com/foo/bar', { managedDir: TMP }))
      .rejects.toThrow('Invalid GitHub URL');
  });

  it('skips unchanged resources (hash dedup)', async () => {
    const content = '---\nname: dup\n---\n# Dup';
    // First import
    const mockFetch1 = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(content) });
    await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch1, managedDir: TMP });

    // Second import with same content
    const mockFetch2 = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(content) });
    const results2 = await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch2, managedDir: TMP });
    expect(results2).toEqual([]); // skipped, same hash
  });

  it('re-imports when content changes', async () => {
    // First import
    const mockFetch1 = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('---\nname: evolving\n---\n# V1') });
    await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch1, managedDir: TMP });

    // Second import with different content
    const mockFetch2 = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 10 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('---\nname: evolving\n---\n# V2 updated') });
    const results2 = await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch2, managedDir: TMP });
    expect(results2.length).toBe(1);
    expect(results2[0].name).toBe('evolving');

    const row = db.prepare("SELECT * FROM resources WHERE name = 'evolving'").get();
    expect(row.repo_stars).toBe(10);
  });

  it('throws on 404 repo', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(importFromGitHub(db, 'https://github.com/user/missing', { fetchFn: mockFetch, managedDir: TMP }))
      .rejects.toThrow('Repository not found');
  });

  it('sets repo_forks and repo_updated_at', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 10, forks_count: 3, updated_at: '2026-03-01T00:00:00Z' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ tree: [{ path: 'skills/myskill/SKILL.md', type: 'blob' }] }) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('---\nname: myskill\ndescription: A skill\n---\n# My Skill') });

    const results = await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch, managedDir: TMP });
    expect(results.length).toBe(1);

    const row = db.prepare("SELECT * FROM resources WHERE name = 'myskill'").get();
    expect(row.repo_forks).toBe(3);
    expect(row.repo_updated_at).toBe('2026-03-01T00:00:00Z');
    expect(row.quality_tier).toBe('community');
  });
});
