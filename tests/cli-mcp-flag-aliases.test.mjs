// CLI must not silently drop a filter flag it doesn't recognize.
//
// Mirror of tests/mcp-cli-filter-aliases.test.mjs (which pins the MCP direction).
//
// v3.59.0 taught the CLI to accept MCP *field* names for the required values
// (`--content`, `--query`, `--ids`) so a model can map a tool schema onto flags.
// The FILTER fields never got the same treatment: `--obs_type` / `--date_from` /
// `--date_to` / `--date_since` parse into `flags` and are then read by nobody, so
// the command answers the UNFILTERED question. Worse, the typo guard stayed quiet:
// suggestUnknownFlags() only reported a flag when it could name a near-miss within
// edit distance 2, and `obs_type` is nowhere near any real flag — so an ignored
// filter produced no output at all.
//
// Evidence that drove this (2026-08-13 dogfood, 6-row corpus):
//   search redis --type bugfix       → 0 results   (filter honored)
//   search redis --obs_type bugfix   → 1 result: the DECISION row (filter dropped)
//   search fixed --from 2099-01-01   → 0 results   (filter honored)
//   search fixed --date_from 2099-01-01 → 2 results (filter dropped)

import { describe, it, expect } from 'vitest';
import { parseArgs, suggestUnknownFlags, KNOWN_CLI_FLAGS } from '../cli/common.mjs';

describe('parseArgs — MCP field names normalize onto CLI flags', () => {
  it('maps the renamed filter fields onto their CLI spelling', () => {
    const { flags } = parseArgs(['--obs_type', 'bugfix', '--date_from', '2026-01-01',
      '--date_to', '2026-02-01', '--date_since', '7d']);
    expect(flags.type).toBe('bugfix');
    expect(flags.from).toBe('2026-01-01');
    expect(flags.to).toBe('2026-02-01');
    expect(flags.since).toBe('7d');
  });

  it('treats underscores as hyphens for every flag', () => {
    const { flags } = parseArgs(['--include_noise', '--lesson_learned', 'x', '--dry_run']);
    expect(flags['include-noise']).toBe(true);
    expect(flags['lesson-learned']).toBe('x');
    expect(flags['dry-run']).toBe(true);
  });

  it('works through the --key=value form too', () => {
    const { flags } = parseArgs(['--obs_type=decision', '--date_since=24h']);
    expect(flags.type).toBe('decision');
    expect(flags.since).toBe('24h');
  });

  it('an explicit canonical flag wins over its alias', () => {
    const { flags } = parseArgs(['--type', 'bugfix', '--obs_type', 'decision']);
    expect(flags.type).toBe('bugfix');
  });

  it('leaves ordinary flags and positionals untouched', () => {
    const { flags, positional } = parseArgs(['search', 'redis', '--type', 'decision', '--limit', '5']);
    expect(positional).toEqual(['search', 'redis']);
    expect(flags.type).toBe('decision');
    expect(flags.limit).toBe('5');
  });
});

describe('suggestUnknownFlags — no unknown flag is silently dropped', () => {
  it('reports a far-from-anything unknown flag (no suggestion available)', () => {
    const hits = suggestUnknownFlags(parseArgs(['--wibblefrotz', 'x']).flags);
    expect(hits).toHaveLength(1);
    expect(hits[0].flag).toBe('wibblefrotz');
    expect(hits[0].suggestion).toBeNull();
  });

  it('still names the near-miss when there is one', () => {
    const hits = suggestUnknownFlags(parseArgs(['--tpye', 'bugfix']).flags);
    expect(hits).toEqual([{ flag: 'tpye', suggestion: 'type' }]);
  });

  it('stays silent for every documented flag', () => {
    const flags = Object.fromEntries([...KNOWN_CLI_FLAGS].map(f => [f, 'v']));
    expect(suggestUnknownFlags(flags)).toEqual([]);
  });

  it('stays silent for the normalized MCP field names', () => {
    const { flags } = parseArgs(['--obs_type', 'bugfix', '--date_since', '7d', '--include_noise']);
    expect(suggestUnknownFlags(flags)).toEqual([]);
  });
});
