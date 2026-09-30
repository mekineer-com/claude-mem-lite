// `restore --dry-run` must not report work it did not do.
//
// The summary line was shared verbatim between the real and preview runs:
//
//   [mem] Restore (dry-run): 10 restored, 0 duplicate(s) skipped, 0 malformed/failed …
//
// Past-tense "restored" for a run that wrote nothing, on the one command whose entire job is
// to let a user check a backup BEFORE trusting it. Worse, the count can exceed the real
// outcome: the preview applies the durable exact-dup guard (project+title+created_at) but not
// saveObservation's Jaccard near-duplicate collapse, which only exists on the writing path.
// Measured on a backup holding two same-titled weekly summaries: previewed 10, restored 9.
//
// That collapse was the defect, not the preview (E2E round 2026-09-29): a backup's rows all
// coexisted in the source store, so restore has nothing to deduplicate but rows the target
// already holds (the exact project+title+created_at guard). With the near-duplicate window —
// which restore ran with a PAST `now` and so no upper bound — 25 distinct `--force`d rows
// restored into an empty store as 1, and an old backup row was dropped for resembling a
// newer live row. Restore now saves with `force`, so the preview is the outcome.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
let dir, backup, env;

function cli(args, dataDir) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...env, CLAUDE_MEM_DIR: dataDir },
    encoding: 'utf8',
  });
}

/** Two rows sharing a title but not a timestamp — past the exact-dup guard, into Jaccard. */
function makeBackup() {
  const now = Date.now();
  const rows = [
    {
      project: 'p--proj',
      type: 'change',
      title: 'Weekly summary: 7 change observations',
      narrative: 'Weekly summary covering seven routine build-config changes in this project.',
      importance: 1,
      created_at_epoch: now - 5 * 86400000,
      created_at: new Date(now - 5 * 86400000).toISOString(),
    },
    {
      project: 'p--proj',
      type: 'change',
      title: 'Weekly summary: 7 change observations',
      narrative: 'Weekly summary covering seven routine build-config changes in this project.',
      importance: 1,
      created_at_epoch: now - 5 * 86400000 + 60000,
      created_at: new Date(now - 5 * 86400000 + 60000).toISOString(),
    },
    {
      project: 'p--proj',
      type: 'bugfix',
      title: 'Retry budget was shared across shards',
      narrative: 'One hot shard starved the rest because the retry budget was a single global counter.',
      lesson_learned: 'give each shard its own retry budget',
      importance: 3,
      created_at_epoch: now - 9 * 86400000,
      created_at: new Date(now - 9 * 86400000).toISOString(),
    },
  ];
  writeFileSync(backup, JSON.stringify(rows));
  return rows.length;
}

describe('restore --dry-run — reports a preview, not an outcome', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restore-dry-'));
    backup = join(dir, 'backup.json');
    env = {
      ...process.env,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_PROJECT_DIR: '/x/proj',
      PWD: '/x/proj',
    };
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  });

  it('uses conditional wording and writes nothing', () => {
    makeBackup();
    const target = join(dir, 'data-dry');
    const out = cli(['restore', backup, '--dry-run'], target);
    expect(out).toMatch(/would be restored/);
    expect(out).not.toMatch(/\d+ restored,/); // the past-tense shape
    // …and the claim is true: nothing landed.
    expect(cli(['recent', '5'], target)).toMatch(/No recent observations/);
  });

  it('previews exactly what the real run restores — every distinct row comes back', () => {
    const total = makeBackup();
    const dryOut = cli(['restore', backup, '--dry-run'], join(dir, 'data-a'));
    const realOut = cli(['restore', backup], join(dir, 'data-b'));
    const n = (s, re) => Number((s.match(re) || [])[1]);
    // Premise: two rows share a title and body, so the near-duplicate window would bite.
    expect(total).toBe(3);
    expect(n(dryOut, /: (\d+) would be restored/)).toBe(total);
    expect(n(realOut, /: (\d+) restored/)).toBe(total);
    expect(dryOut).not.toMatch(/near-duplicate/);
    // Re-running the same restore is still a no-op: the exact guard is what dedups a backup.
    const again = cli(['restore', backup], join(dir, 'data-b'));
    expect(n(again, /: (\d+) restored/)).toBe(0);
    expect(n(again, /, (\d+) duplicate\(s\) skipped/)).toBe(total);
  });
});
