// One-shot v2.70.0 upgrade banner.
// Split out of hook.mjs because hook.mjs has module-level side effects
// (notably `if (!event) process.exit(0)` at top level) that abort vitest
// workers if imported directly from a test. See test
// tests/hook-upgrade-banner.test.mjs.

import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * One-shot stderr banner on first SessionStart after v2.70.0 upgrade.
 * Notifies users that the `### Deferred Work` block now reads from the
 * deferred_work table (not high-importance observations as in v2.69.x).
 * Idempotent via a marker file in `runtimeDir`; subsequent calls in the
 * same project are silent.
 *
 * @param {object} args
 * @param {string} args.project Project name (used in banner + marker filename).
 * @param {string} args.runtimeDir RUNTIME_DIR (test override; production passes hook-shared.RUNTIME_DIR).
 * @param {boolean} [args.hasPriorData=true] Whether the project has pre-existing
 *   observations. A fresh install never had the v2.69.x deferred-block semantics,
 *   so the migration notice (and its "pin to 2.69.x" advice, nonsensical 40+
 *   versions on) is wrong noise — suppress it but still write the marker so it
 *   stays suppressed once the new user starts saving memories. Defaults to true
 *   for backward-compatibility with callers that don't probe.
 */
export function emitV270UpgradeBanner({ project, runtimeDir, hasPriorData = true }) {
  const marker = join(runtimeDir, `.deferred-block-migrated-${project}`);
  if (existsSync(marker)) return;
  // The banner only matters to someone who had high-importance observations
  // under the old deferred-block semantics. No prior data → nothing migrated →
  // suppress (but mark, so a brand-new user never sees it later either).
  if (hasPriorData) {
    process.stderr.write(
      `[mem] v2.70.0 upgrade notice (project "${project}"): Deferred Work block now ` +
      `backed by deferred_work table. To keep an obs visible there, run ` +
      `\`claude-mem-lite defer add "<title>" --priority 3\`. ` +
      `Pin to 2.69.x to revert.\n`
    );
  }
  try { writeFileSync(marker, String(Date.now())); } catch { /* best-effort marker */ }
}
