// lib/db-backup.mjs — point-in-time DB snapshot before irreversible maintenance.
//
// VACUUM INTO produces a consistent, compact copy of the database (WAL-safe —
// unlike copyFileSync, which would miss un-checkpointed WAL frames). Best-effort:
// a failure logs a WARN and returns null so it NEVER blocks the maintenance it
// guards (a backup that aborts a disk-full purge would be worse than no backup).
//
// MUST be called OUTSIDE any transaction — VACUUM cannot run inside one, which is
// why the maintenance entry points snapshot before opening their db.transaction().
import { readdirSync, unlinkSync } from 'fs';
import { dirname, basename, join } from 'path';
import { debugLog } from '../utils.mjs';

// Monotonic per-process suffix so two snapshots in the same millisecond (same pid)
// still get unique filenames (VACUUM INTO fails if the target already exists).
let _seq = 0;

/**
 * Snapshot `db` to `<db-path>.<tag>-<ts>.bak` via VACUUM INTO, then prune to the
 * newest `retain` snapshots. No-op (returns null) for :memory: DBs (tests) and on
 * any error (logged). Returns the snapshot path on success.
 * @returns {string|null}
 */
export function snapshotDb(db, { tag = 'pre-maintain', retain = 3 } = {}) {
  try {
    const dbPath = db && db.name;
    if (!dbPath || dbPath === ':memory:') return null; // in-memory — nothing to snapshot
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${_seq++}`;
    const out = `${dbPath}.${tag}-${stamp}.bak`;
    // Path is internal (db.name from our own config), but escape single quotes
    // defensively since VACUUM INTO takes a string literal, not a bound param.
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    pruneSnapshots(dbPath, tag, retain);
    return out;
  } catch (e) {
    try { debugLog('WARN', 'db-backup', `snapshot skipped (proceeding without): ${e.message}`); } catch { /* ignore */ }
    return null;
  }
}

// Keep the newest `retain` `<base>.<tag>-*.bak` files, unlink the rest. The ISO
// timestamp embedded in the name makes a lexical sort chronological.
function pruneSnapshots(dbPath, tag, retain) {
  try {
    const dir = dirname(dbPath);
    const prefix = `${basename(dbPath)}.${tag}-`;
    const names = readdirSync(dir)
      .filter(n => n.startsWith(prefix) && n.endsWith('.bak'))
      .sort()
      .reverse(); // newest first
    for (const n of names.slice(retain)) {
      try { unlinkSync(join(dir, n)); } catch { /* per-entry best-effort */ }
    }
  } catch { /* best-effort — dir may be unreadable */ }
}
