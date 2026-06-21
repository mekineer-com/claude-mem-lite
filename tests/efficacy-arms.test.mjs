// tests/efficacy-arms.test.mjs
import { describe, it, expect } from 'vitest';
import { armConfig, INJECTED_ARMS } from '../lib/efficacy-arms.mjs';

describe('efficacy arm semantics (single tested source of truth — cf. #8711 env floor)', () => {
  it('F: bind-salience injection', () => {
    expect(armConfig('F')).toEqual({ inject: true, salience: 'bind', appendRequirement: false });
  });
  it('A: default (current) salience injection — empty salience = unset', () => {
    expect(armConfig('A')).toEqual({ inject: true, salience: '', appendRequirement: false });
  });
  it('AL: legacy-format injection', () => {
    expect(armConfig('AL')).toEqual({ inject: true, salience: 'legacy', appendRequirement: false });
  });
  it('C: empty control', () => {
    expect(armConfig('C')).toEqual({ inject: false, salience: '', appendRequirement: false });
  });
  it('T: empty sandbox + spelled-out requirement (positive control)', () => {
    expect(armConfig('T')).toEqual({ inject: false, salience: '', appendRequirement: true });
  });
  it('INJECTED_ARMS is exactly {A, AL, F}', () => {
    expect([...INJECTED_ARMS].sort()).toEqual(['A', 'AL', 'F']);
  });
});
