import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Imported from lib/upgrade-banner.mjs (split out of hook.mjs to avoid
// module-level `process.exit(0)` aborting the vitest worker on import).
import { emitV270UpgradeBanner } from '../lib/upgrade-banner.mjs';

describe('v2.70.0 first-run upgrade banner', () => {
  it('emits stderr banner once and creates marker, no-op on subsequent calls', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'mem-banner-'));
    try {
      const project = 'test-banner-proj';
      const marker = join(runtimeDir, `.deferred-block-migrated-${project}`);
      expect(existsSync(marker)).toBe(false);

      // Capture stderr writes
      const writes = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (msg) => { writes.push(String(msg)); return true; };
      try {
        emitV270UpgradeBanner({ project, runtimeDir });
        emitV270UpgradeBanner({ project, runtimeDir }); // second call must be silent
      } finally {
        process.stderr.write = orig;
      }
      expect(writes.length).toBe(1);
      expect(writes[0]).toMatch(/Deferred Work block now backed by deferred_work table/);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
