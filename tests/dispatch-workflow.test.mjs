import { describe, it, expect } from 'vitest';
import {
  detectActiveSuite,
  shouldRecommendForStage,
  detectExplicitRequest,
  inferCurrentStage,
  SUITE_AUTO_FLOWS,
} from '../dispatch-workflow.mjs';

describe('detectActiveSuite', () => {
  it('returns null for empty events', () => {
    expect(detectActiveSuite([])).toBeNull();
  });

  it('detects superpowers suite from Skill event', () => {
    const events = [
      { tool_name: 'Read', tool_input: {} },
      { tool_name: 'Skill', tool_input: { skill: 'superpowers:brainstorming' } },
    ];
    const result = detectActiveSuite(events);
    expect(result).not.toBeNull();
    expect(result.suite).toBe('superpowers');
    expect(result.lastSkill).toBe('superpowers:brainstorming');
  });

  it('detects gsd suite', () => {
    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'gsd:start' } },
    ];
    const result = detectActiveSuite(events);
    expect(result.suite).toBe('gsd');
  });

  it('uses most recent Skill event', () => {
    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'gsd:start' } },
      { tool_name: 'Edit', tool_input: {} },
      { tool_name: 'Skill', tool_input: { skill: 'superpowers:writing-plans' } },
    ];
    const result = detectActiveSuite(events);
    expect(result.suite).toBe('superpowers');
  });

  it('returns null for non-suite skills', () => {
    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'claude-api' } },
    ];
    expect(detectActiveSuite(events)).toBeNull();
  });
});

describe('shouldRecommendForStage', () => {
  it('allows when no suite active', () => {
    const result = shouldRecommendForStage(null, 'PLAN');
    expect(result.shouldRecommend).toBe(true);
    expect(result.reason).toBe('no_suite');
  });

  it('blocks when suite covers the stage', () => {
    const suite = { suite: 'superpowers', flow: SUITE_AUTO_FLOWS.superpowers };
    const result = shouldRecommendForStage(suite, 'PLAN');
    expect(result.shouldRecommend).toBe(false);
    expect(result.reason).toBe('suite_covers_stage');
  });

  it('allows for suite gap stages', () => {
    const suite = { suite: 'superpowers', flow: SUITE_AUTO_FLOWS.superpowers };
    const result = shouldRecommendForStage(suite, 'REVIEW_PLAN');
    expect(result.shouldRecommend).toBe(true);
    expect(result.reason).toBe('suite_gap');
  });

  it('allows for unknown stages', () => {
    const suite = { suite: 'superpowers', flow: SUITE_AUTO_FLOWS.superpowers };
    const result = shouldRecommendForStage(suite, 'UNKNOWN');
    expect(result.shouldRecommend).toBe(true);
  });
});

describe('inferCurrentStage', () => {
  it('infers from suite lastSkill', () => {
    const suite = { lastSkill: 'superpowers:brainstorming' };
    expect(inferCurrentStage('plan', suite)).toBe('ANALYZE');
  });

  it('falls back to intent', () => {
    expect(inferCurrentStage('plan', null)).toBe('PLAN');
    expect(inferCurrentStage('test', null)).toBe('TEST');
    expect(inferCurrentStage('commit', null)).toBe('COMMIT');
  });

  it('returns null for unknown intent', () => {
    expect(inferCurrentStage('unknown', null)).toBeNull();
  });
});

describe('detectExplicitRequest', () => {
  it('detects "用ppt的技能做一个ppt"', () => {
    const result = detectExplicitRequest('帮我用ppt的技能做一个ppt');
    expect(result.isExplicit).toBe(true);
    expect(result.searchTerm).toBe('ppt');
  });

  it('detects "use the playwright skill"', () => {
    const result = detectExplicitRequest('use the playwright skill to test');
    expect(result.isExplicit).toBe(true);
    expect(result.searchTerm).toBe('playwright');
  });

  it('detects "有没有seo的skill"', () => {
    const result = detectExplicitRequest('有没有seo的skill');
    expect(result.isExplicit).toBe(true);
    expect(result.searchTerm).toBe('seo');
  });

  it('detects "recommend a testing agent"', () => {
    const result = detectExplicitRequest('recommend a testing agent');
    expect(result.isExplicit).toBe(true);
    expect(result.searchTerm).toBe('testing');
  });

  it('returns false for normal prompts', () => {
    expect(detectExplicitRequest('fix the login bug').isExplicit).toBe(false);
    expect(detectExplicitRequest('add user authentication').isExplicit).toBe(false);
    expect(detectExplicitRequest('帮我修复这个bug').isExplicit).toBe(false);
  });

  it('returns false for empty/null input', () => {
    expect(detectExplicitRequest('').isExplicit).toBe(false);
    expect(detectExplicitRequest(null).isExplicit).toBe(false);
  });
});
