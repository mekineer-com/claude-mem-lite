// KNOWN_CLI_FLAGS must contain only flags a `claude-mem-lite` subcommand actually reads.
//
// suggestUnknownFlags() warns on EVERY flag outside the allowlist ("--x — ignored, it
// had no effect"). So a bogus allowlist entry does not merely fail to help — it
// SUPPRESSES the one signal the user would get. `out` sat in the list until the 2026-08-17
// e2e round, having been catalogued from `benchmark/longmemeval-rerank.mjs --out`, which is not a
// CLI flag: `claude-mem-lite export --out backup.json` dumped the whole export to
// stdout, wrote no file, and printed no warning.
//
// The guard is derived, not a hand-maintained second copy of the list: it re-reads the
// CLI sources and asks whether each allowlisted name appears there at all.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { KNOWN_CLI_FLAGS } from '../cli/common.mjs';

const ROOT = resolve(import.meta.dirname, '..');

// Every file that can consume a `claude-mem-lite <cmd>` flag. Deliberately excludes
// benchmark/ and scripts/ — a flag only those read is NOT a CLI flag, which is the
// exact confusion this suite exists to catch.
function cliSources() {
  const files = [join(ROOT, 'cli.mjs'), join(ROOT, 'mem-cli.mjs'), join(ROOT, 'adopt-cli.mjs')];
  for (const e of readdirSync(join(ROOT, 'cli'))) {
    if (e.endsWith('.mjs')) files.push(join(ROOT, 'cli', e));
  }
  return files;
}

describe('KNOWN_CLI_FLAGS', () => {
  it('every entry is referenced by CLI code outside the allowlist itself', () => {
    // Strip the allowlist literal so a name cannot vouch for itself.
    const common = readFileSync(join(ROOT, 'cli', 'common.mjs'), 'utf8');
    const listLiteral = common.match(/KNOWN_CLI_FLAGS = new Set\(\[[\s\S]*?\]\);/);
    expect(listLiteral, 'allowlist literal not found — update this test').toBeTruthy();
    const haystack = cliSources()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
      .split(listLiteral[0]).join('');

    const unread = [];
    for (const flag of KNOWN_CLI_FLAGS) {
      const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const forms = [
        `flags['${flag}']`, `flags["${flag}"]`, `flags.${flag}`,
        `flags['${camel}']`, `flags["${camel}"]`, `flags.${camel}`,
        `'${flag}'`, `"${flag}"`,   // string arrays: rejectBareStringFlags([...]) / field loops
        `--${flag}`,               // raw-argv readers (doctor --prompts-limit) + help text
      ];
      if (!forms.some((f) => haystack.includes(f))) unread.push(flag);
    }

    expect(unread, `allowlisted but no CLI command reads them — each one silences the `
      + `"ignored, it had no effect" warning for a flag that really is ignored`).toEqual([]);
  });

  it('warns (not silently accepts) on a flag no command reads', async () => {
    const { suggestUnknownFlags } = await import('../cli/common.mjs');
    // `out` is the concrete regression: natural to guess for `export`, read by nobody.
    const reported = suggestUnknownFlags({ out: 'backup.json' }).map((r) => r.flag);
    expect(reported).toContain('out');
  });

  it('still stays quiet on flags that ARE read', async () => {
    const { suggestUnknownFlags } = await import('../cli/common.mjs');
    expect(suggestUnknownFlags({ project: 'p', limit: 5, json: true, type: 'bugfix' })).toEqual([]);
  });
});
