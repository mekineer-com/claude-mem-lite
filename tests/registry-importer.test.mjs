import { describe, it, expect } from 'vitest';
import { discoverFromTree, parseFrontmatter, extractKeywords } from '../registry-importer.mjs';

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
