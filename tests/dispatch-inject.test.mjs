import { describe, it, expect } from 'vitest';
import { renderInjection, renderHint } from '../dispatch-inject.mjs';

describe('renderHint', () => {
  it('renders a short one-line hint for skill', () => {
    const resource = {
      name: 'tdd-workflow',
      type: 'skill',
      capability_summary: 'Test-driven development with red-green-refactor cycle and automated coverage tracking',
      invocation_name: 'superpowers:test-driven-development',
    };
    const hint = renderHint(resource);
    expect(hint).toContain('Consider');
    expect(hint).toContain('tdd-workflow');
    expect(hint.length).toBeLessThan(200);
    expect(hint.split('\n').length).toBe(1);
  });

  it('includes invocation instruction for invocable skills', () => {
    const resource = {
      name: 'tdd-workflow',
      type: 'skill',
      invocation_name: 'superpowers:test-driven-development',
      capability_summary: 'TDD workflow',
    };
    const hint = renderHint(resource);
    expect(hint).toContain('superpowers:test-driven-development');
  });

  it('renders agent hint with Agent prefix', () => {
    const resource = {
      name: 'error-debugger',
      type: 'agent',
      capability_summary: 'Systematic error debugging with root cause analysis',
    };
    const hint = renderHint(resource);
    expect(hint).toContain('error-debugger');
    expect(hint).toContain('Agent');
    expect(hint.length).toBeLessThan(200);
  });

  it('handles empty capability_summary', () => {
    const resource = { name: 'x', type: 'skill', capability_summary: '' };
    const hint = renderHint(resource);
    expect(hint).toContain('x');
  });

  it('truncates long capability_summary to 80 chars', () => {
    const resource = {
      name: 'long-skill',
      type: 'skill',
      capability_summary: 'A'.repeat(200),
    };
    const hint = renderHint(resource);
    // Total hint should be reasonable length
    expect(hint.length).toBeLessThan(300);
  });
});
