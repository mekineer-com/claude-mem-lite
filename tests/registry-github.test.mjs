import { describe, it, expect } from 'vitest';
import { parseGitHubUrl, buildTreeUrl, buildContentUrl, buildRepoUrl, buildHeaders } from '../registry-github.mjs';

describe('parseGitHubUrl', () => {
  it('parses standard repo URL', () => {
    const r = parseGitHubUrl('https://github.com/user/repo');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: '' });
  });

  it('parses URL with branch', () => {
    const r = parseGitHubUrl('https://github.com/user/repo/tree/develop');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'develop', path: '' });
  });

  it('parses URL with branch and path', () => {
    const r = parseGitHubUrl('https://github.com/user/repo/tree/main/skills/foo');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: 'skills/foo' });
  });

  it('returns null for invalid URL', () => {
    expect(parseGitHubUrl('https://gitlab.com/foo/bar')).toBeNull();
    expect(parseGitHubUrl('not-a-url')).toBeNull();
    expect(parseGitHubUrl('')).toBeNull();
  });

  it('handles trailing slash', () => {
    const r = parseGitHubUrl('https://github.com/user/repo/');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: '' });
  });

  it('handles .git suffix', () => {
    const r = parseGitHubUrl('https://github.com/user/repo.git');
    expect(r).toEqual({ owner: 'user', repo: 'repo', branch: 'main', path: '' });
  });
});

describe('URL builders', () => {
  it('buildTreeUrl returns correct API URL', () => {
    expect(buildTreeUrl('user', 'repo', 'main'))
      .toBe('https://api.github.com/repos/user/repo/git/trees/main?recursive=1');
  });

  it('buildContentUrl returns correct raw URL', () => {
    expect(buildContentUrl('user', 'repo', 'main', 'skills/foo/SKILL.md'))
      .toBe('https://raw.githubusercontent.com/user/repo/main/skills/foo/SKILL.md');
  });

  it('buildRepoUrl returns correct API URL', () => {
    expect(buildRepoUrl('user', 'repo'))
      .toBe('https://api.github.com/repos/user/repo');
  });
});

describe('buildHeaders', () => {
  it('includes User-Agent', () => {
    const h = buildHeaders();
    expect(h['User-Agent']).toBe('claude-mem-lite');
  });

  it('includes Accept header', () => {
    const h = buildHeaders();
    expect(h.Accept).toBe('application/vnd.github.v3+json');
  });
});
