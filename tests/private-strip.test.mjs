import { describe, it, expect } from 'vitest';
import { stripPrivate } from '../lib/private-strip.mjs';

describe('stripPrivate', () => {
  it('replaces a single well-formed block with [redacted]', () => {
    expect(stripPrivate('foo <private>secret</private> bar')).toBe('foo [redacted] bar');
  });

  it('replaces multiple blocks independently (non-greedy)', () => {
    expect(stripPrivate('a <private>x</private> b <private>y</private> c')).toBe(
      'a [redacted] b [redacted] c',
    );
  });

  it('handles multiline content inside the block', () => {
    expect(stripPrivate('pre\n<private>line1\nline2\nline3</private>\npost')).toBe('pre\n[redacted]\npost');
  });

  it('is case-insensitive on the tag name', () => {
    expect(stripPrivate('<PRIVATE>x</PRIVATE>')).toBe('[redacted]');
    expect(stripPrivate('<Private>x</Private>')).toBe('[redacted]');
    expect(stripPrivate('<private>x</PRIVATE>')).toBe('[redacted]');
  });

  it('replaces empty block', () => {
    expect(stripPrivate('a<private></private>b')).toBe('a[redacted]b');
  });

  // D13 (2026-09-29): fail CLOSED. A submitted prompt is not "mid-typing", and the old
  // fail-open kept `<private>my secret` (no close), `<private reason="pii">…` and the tail of a
  // nested block in the DB, the background LLM input and later injections — while the episode
  // description path (utils makeEntryDesc) already cut at an unclosed opener.
  it('redacts from an unclosed opener to the end', () => {
    expect(stripPrivate('hello <private>not closed yet')).toBe('hello [redacted]');
  });

  it('accepts attributes and whitespace in the tags', () => {
    expect(stripPrivate('a <private reason="pii">x</private> b')).toBe('a [redacted] b');
    expect(stripPrivate('a <private >x</private > b')).toBe('a [redacted] b');
    expect(stripPrivate('<privatex>y</privatex>')).toBe('<privatex>y</privatex>'); // not the tag
    expect(stripPrivate('<private/>x</private>')).toBe('<private/>x</private>'); // self-closing: neither
  });

  it('pairs nested blocks by depth, so nothing inside the outer block survives', () => {
    expect(stripPrivate('<private>a<private>b</private>c</private>d')).toBe('[redacted]d');
    expect(stripPrivate('<private>a<private>b</private>c')).toBe('[redacted]');
  });

  it('leaves stray closing tag intact', () => {
    expect(stripPrivate('hello </private> tail')).toBe('hello </private> tail');
  });

  it('leaves text without any tag unchanged (fast path)', () => {
    const plain = 'just a normal user prompt about pagination cursors';
    expect(stripPrivate(plain)).toBe(plain);
  });

  it('non-string input passes through unchanged', () => {
    expect(stripPrivate(undefined)).toBe(undefined);
    expect(stripPrivate(null)).toBe(null);
    expect(stripPrivate(42)).toBe(42);
  });

  it('empty string returns empty string', () => {
    expect(stripPrivate('')).toBe('');
  });

  it('block at the very start of the string', () => {
    expect(stripPrivate('<private>X</private> rest')).toBe('[redacted] rest');
  });

  it('block at the very end of the string', () => {
    expect(stripPrivate('prefix <private>X</private>')).toBe('prefix [redacted]');
  });

  it('two adjacent blocks with no separator', () => {
    expect(stripPrivate('<private>a</private><private>b</private>')).toBe('[redacted][redacted]');
  });

  it('preserves surrounding punctuation around the block', () => {
    expect(stripPrivate('Compare X with <private>token123</private>.')).toBe('Compare X with [redacted].');
  });
});

// ── SEC-1 (2026-08-29 audit) linearity, and the D13 fail-closed semantics as properties ──
//
// The pre-D13 guard was a differential oracle against the original block regex; D13 changed
// the semantics on purpose (unclosed → to end, nesting by depth, attributes), so the oracle is
// now a set of properties over generated tag soup whose private regions are KNOWN: text the
// generator writes inside a region is 'S', outside it 'o'. Nothing inside may survive, and
// nothing outside may be eaten.
describe('stripPrivate — fail-closed properties and linearity', () => {
  it('never lets text inside a region through and never eats text outside one', () => {
    let seed = 0x5eed1234;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const OPEN = ['<private>', '<PRIVATE>', '<private reason="pii">', '<Private >'];
    const CLOSE = ['</private>', '</PRIVATE>', '</Private >'];
    for (let iter = 0; iter < 2000; iter++) {
      let s = '';
      let depth = 0;
      let outside = 0;
      const n = 1 + Math.floor(rnd() * 14);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        if (r < 0.25) {
          s += OPEN[Math.floor(rnd() * OPEN.length)];
          depth++;
        } else if (r < 0.45) {
          s += CLOSE[Math.floor(rnd() * CLOSE.length)]; // a close at depth 0 is a stray: kept
          if (depth > 0) depth--;
        } else if (depth > 0) {
          s += 'S';
        } else {
          s += 'o';
          outside++;
        }
      }
      const out = stripPrivate(s);
      expect(out, `iter=${iter} input: ${JSON.stringify(s)}`).not.toContain('S');
      expect((out.match(/o/g) || []).length, `iter=${iter} input: ${JSON.stringify(s)}`).toBe(outside);
    }
  });

  it('stays linear on opener-dense input that made the old regex quadratic', () => {
    // Both shapes measured 456-891ms before the SEC-1 rewrite. The second one exists because
    // it defeats the naive fix ("bail out when there is no closing tag") — it HAS one.
    const inputs = [
      ['<private>'.repeat(28000), '[redacted]'], // ~252KB, the hook stdin cap; unclosed → to end
      ['</private>' + '<private>'.repeat(28000), '</private>[redacted]'],
      // D13's attribute form made each `<private ` scan to the END of the input for a `>` that
      // never comes: 360KB took 4.7s (pre-tag review). Not a tag, so nothing is redacted.
      ['<private '.repeat(28000), '<private '.repeat(28000)],
      ['</private '.repeat(25200), '</private '.repeat(25200)],
    ];
    for (const [input, want] of inputs) {
      const started = process.hrtime.bigint();
      const out = stripPrivate(input);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(out).toBe(want);
      expect(ms, `stripPrivate took ${ms.toFixed(1)}ms on ${input.length} bytes`).toBeLessThan(120);
    }
  });
});
