// Tests for dispatch-patterns.mjs — failure pattern detection
import { describe, it, expect } from 'vitest';
import { detectFailurePattern } from '../dispatch-patterns.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function editEvent(file = '/src/app.ts') {
  return { tool_name: 'Edit', tool_input: { file_path: file }, tool_response: 'ok' };
}

function writeEvent(file = '/src/app.ts') {
  return { tool_name: 'Write', tool_input: { file_path: file }, tool_response: 'ok' };
}

function bashTestFail(cmd = 'npx vitest run') {
  return { tool_name: 'Bash', tool_input: { command: cmd }, tool_response: 'FAIL src/app.test.ts\nError: expected 1 to be 2' };
}

function bashTestPass(cmd = 'npx vitest run') {
  return { tool_name: 'Bash', tool_input: { command: cmd }, tool_response: 'Tests: 5 passed, 5 total' };
}

function bashError(resp = 'TypeError: Cannot read properties of undefined') {
  return { tool_name: 'Bash', tool_input: { command: 'node app.js' }, tool_response: resp };
}

function bashCompileError() {
  return { tool_name: 'Bash', tool_input: { command: 'tsc' }, tool_response: 'error TS2345: Argument of type string' };
}

function bashOk() {
  return { tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: 'total 42\ndrwxr-xr-x' };
}

function readEvent() {
  return { tool_name: 'Read', tool_input: { file_path: '/src/app.ts' }, tool_response: 'file contents' };
}

function grepEvent() {
  return { tool_name: 'Grep', tool_input: { pattern: 'TODO' }, tool_response: 'found 3 matches' };
}

function globEvent() {
  return { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, tool_response: 'src/app.ts' };
}

function agentEvent() {
  return { tool_name: 'Agent', tool_input: { description: 'investigate' }, tool_response: 'done' };
}

// ─── Basic cases ─────────────────────────────────────────────────────────────

describe('detectFailurePattern', () => {
  it('returns null for empty events', () => {
    expect(detectFailurePattern([])).toBeNull();
    expect(detectFailurePattern(null)).toBeNull();
    expect(detectFailurePattern(undefined)).toBeNull();
  });

  it('returns null for healthy sequence (edit then test pass)', () => {
    const events = [
      editEvent(),
      bashTestPass(),
      editEvent(),
      bashTestPass(),
    ];
    expect(detectFailurePattern(events)).toBeNull();
  });

  // ─── repeated-test-fail ──────────────────────────────────────────────────

  describe('repeated-test-fail', () => {
    it('detects 2 edit-then-test-fail cycles', () => {
      const events = [
        editEvent(), bashTestFail(),
        editEvent(), bashTestFail(),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-test-fail');
      expect(result.resource_intent).toBe('fix');
      expect(result.confidence).toBeCloseTo(0.7);
    });

    it('does not trigger with only 1 cycle', () => {
      const events = [
        editEvent(), bashTestFail(),
        editEvent(), bashTestPass(),
      ];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('works with Write tool as well as Edit', () => {
      const events = [
        writeEvent(), bashTestFail(),
        writeEvent(), bashTestFail(),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-test-fail');
    });

    it('counts cycles with different test runners', () => {
      const events = [
        editEvent(), bashTestFail('npx jest'),
        editEvent(), bashTestFail('pytest tests/'),
        editEvent(), bashTestFail('cargo test'),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-test-fail');
      expect(result.confidence).toBeCloseTo(0.8); // 3 cycles: 0.7 + (3-2)*0.1
    });

    it('confidence caps at 1.0', () => {
      const events = [];
      for (let i = 0; i < 8; i++) {
        events.push(editEvent(), bashTestFail());
      }
      const result = detectFailurePattern(events);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  // ─── repeated-bash-error ─────────────────────────────────────────────────

  describe('repeated-bash-error', () => {
    it('detects 3 bash errors', () => {
      const events = [
        bashError(), bashError(), bashError(),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-bash-error');
      expect(result.resource_intent).toBe('fix');
      expect(result.confidence).toBeCloseTo(0.6);
    });

    it('does not trigger with only 2 errors', () => {
      const events = [bashError(), bashError()];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('detects compilation errors via ERROR_CLASS_RE', () => {
      const events = [
        bashCompileError(),
        bashCompileError(),
        bashCompileError(),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-bash-error');
    });

    it('confidence increases with more errors', () => {
      const events = [
        bashError(), bashError(), bashError(), bashError(), bashError(),
      ];
      const result = detectFailurePattern(events);
      expect(result.confidence).toBeCloseTo(0.8); // 0.6 + (5-3)*0.1
    });

    it('confidence caps at 1.0', () => {
      const events = [];
      for (let i = 0; i < 12; i++) {
        events.push(bashError());
      }
      const result = detectFailurePattern(events);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  // ─── blind-editing ───────────────────────────────────────────────────────

  describe('blind-editing', () => {
    it('detects 5 consecutive edits to same file without verification', () => {
      const file = '/src/app.ts';
      const events = [
        editEvent(file), editEvent(file), editEvent(file),
        editEvent(file), editEvent(file),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('blind-editing');
      expect(result.resource_intent).toBe('test');
      expect(result.confidence).toBeCloseTo(0.5);
    });

    it('does not trigger with only 4 edits', () => {
      const file = '/src/app.ts';
      const events = [
        editEvent(file), editEvent(file), editEvent(file), editEvent(file),
      ];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('Read/Grep/Glob do not break the streak', () => {
      const file = '/src/app.ts';
      const events = [
        editEvent(file), readEvent(), editEvent(file),
        grepEvent(), editEvent(file), globEvent(),
        editEvent(file), editEvent(file),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('blind-editing');
    });

    it('does NOT trigger when tests are interspersed', () => {
      const file = '/src/app.ts';
      const events = [
        editEvent(file), editEvent(file),
        bashTestPass(),
        editEvent(file), editEvent(file),
        bashTestPass(),
        editEvent(file),
      ];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('Bash with lint/tsc breaks the streak', () => {
      const file = '/src/app.ts';
      const events = [
        editEvent(file), editEvent(file), editEvent(file),
        { tool_name: 'Bash', tool_input: { command: 'npx eslint .' }, tool_response: 'ok' },
        editEvent(file), editEvent(file),
      ];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('non-verify Bash breaks the streak', () => {
      const file = '/src/app.ts';
      const events = [
        editEvent(file), editEvent(file), editEvent(file),
        bashOk(), // ls -la — not a verify command, but breaks streak
        editEvent(file), editEvent(file),
      ];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('Agent tool breaks the streak', () => {
      const file = '/src/app.ts';
      const events = [
        editEvent(file), editEvent(file), editEvent(file),
        agentEvent(),
        editEvent(file), editEvent(file),
      ];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('different files reset the streak', () => {
      const events = [
        editEvent('/src/a.ts'), editEvent('/src/a.ts'), editEvent('/src/a.ts'),
        editEvent('/src/b.ts'), // different file — resets
        editEvent('/src/b.ts'),
      ];
      expect(detectFailurePattern(events)).toBeNull();
    });

    it('confidence increases with longer streak', () => {
      const file = '/src/app.ts';
      const events = [];
      for (let i = 0; i < 8; i++) events.push(editEvent(file));
      const result = detectFailurePattern(events);
      expect(result.confidence).toBeCloseTo(0.8); // 0.5 + (8-5)*0.1
    });

    it('confidence caps at 1.0', () => {
      const file = '/src/app.ts';
      const events = [];
      for (let i = 0; i < 15; i++) events.push(editEvent(file));
      const result = detectFailurePattern(events);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  // ─── Window and priority ─────────────────────────────────────────────────

  describe('window and priority', () => {
    it('only considers last 20 events (old events outside window)', () => {
      // 18 old OK events + 2 error events = only 2 errors in window → no trigger
      const events = [];
      for (let i = 0; i < 18; i++) events.push(bashOk());
      events.push(bashError(), bashError());
      expect(detectFailurePattern(events)).toBeNull();

      // Push 3 errors but with 18 ok events before → only the last 20 are considered
      const events2 = [];
      for (let i = 0; i < 25; i++) events2.push(bashOk());
      events2.push(bashError(), bashError(), bashError());
      // Window: last 20 = 17 ok + 3 errors → triggers
      const result = detectFailurePattern(events2);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-bash-error');
    });

    it('repeated-test-fail takes precedence over repeated-bash-error', () => {
      // This sequence triggers both patterns:
      // - 3 edit→test-fail cycles (repeated-test-fail)
      // - The 3 test failures also count as bash errors (repeated-bash-error)
      const events = [
        editEvent(), bashTestFail(),
        editEvent(), bashTestFail(),
        editEvent(), bashTestFail(),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-test-fail');
    });

    it('repeated-bash-error takes precedence over blind-editing', () => {
      // Mix of bash errors and blind edits — bash errors detected first
      const file = '/src/app.ts';
      const events = [
        bashError(), bashError(), bashError(),
        editEvent(file), editEvent(file), editEvent(file),
        editEvent(file), editEvent(file),
      ];
      const result = detectFailurePattern(events);
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('repeated-bash-error');
    });
  });
});
