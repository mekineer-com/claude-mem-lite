// lib/atomic-write.mjs — crash-safe file writes with optional one-time backup.
//
// Why: several write paths mutate user-global config that, if torn or clobbered,
// breaks the user outside the plugin's control — most acutely ~/.claude.json
// (the WHOLE Claude Code config) in hook-update's post-update MCP dedup, and
// ~/.claude/settings.json in install. A plain writeFileSync can leave a
// half-written file on crash, and a fixed ".tmp" name races concurrent writers.
// This writes to a pid-unique temp then renames (atomic on POSIX), and can drop
// a one-time ".bak" so a logic bug in the caller's merge is recoverable.

import { writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomically write `data` to `filePath` (temp + rename). Optionally back up the
 * existing file once to `<filePath>.bak` before the first overwrite.
 * @param {string} filePath
 * @param {string} data
 * @param {object} [opts]
 * @param {boolean} [opts.backup=false]  Create <filePath>.bak if absent and the
 *   target exists, before writing. Only the first call creates it, so the backup
 *   preserves the last-known-good rather than being overwritten each run.
 */
export function atomicWriteFileSync(filePath, data, { backup = false } = {}) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (backup && existsSync(filePath) && !existsSync(filePath + '.bak')) {
    try { copyFileSync(filePath, filePath + '.bak'); } catch { /* best-effort backup */ }
  }

  // pid-unique temp: a fixed ".tmp" name lets two concurrent installs clobber
  // each other's temp mid-write. Same-dir temp keeps the rename atomic (no
  // cross-device move).
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}
