import { describe, it, expect, beforeEach } from 'vitest';
import { getInjectionCount, incrementInjection, resetInjectionBudget, hasInjectionBudget, MAX_INJECTIONS_PER_SESSION } from '../hook-shared.mjs';

describe('Session injection budget', () => {
  beforeEach(() => resetInjectionBudget());

  it('starts at 0', () => {
    expect(getInjectionCount()).toBe(0);
  });

  it('increments correctly', () => {
    incrementInjection();
    expect(getInjectionCount()).toBe(1);
    incrementInjection();
    expect(getInjectionCount()).toBe(2);
  });

  it('MAX_INJECTIONS_PER_SESSION is 3', () => {
    expect(MAX_INJECTIONS_PER_SESSION).toBe(3);
  });

  it('hasBudget returns false when at cap', () => {
    for (let i = 0; i < MAX_INJECTIONS_PER_SESSION; i++) incrementInjection();
    expect(getInjectionCount()).toBe(MAX_INJECTIONS_PER_SESSION);
    expect(hasInjectionBudget()).toBe(false);
  });

  it('hasBudget returns true when under cap', () => {
    expect(hasInjectionBudget()).toBe(true);
    incrementInjection();
    expect(hasInjectionBudget()).toBe(true);
  });

  it('reset clears counter', () => {
    incrementInjection();
    incrementInjection();
    resetInjectionBudget();
    expect(getInjectionCount()).toBe(0);
    expect(hasInjectionBudget()).toBe(true);
  });
});
