// claude-mem-lite episode buffer management
// Handles file-based episode storage with advisory locking and pending entry recovery

import { join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, openSync, closeSync, writeSync, renameSync, statSync, constants as fsConstants } from 'fs';
import { DB_DIR } from './schema.mjs';
import { inferProject } from './utils.mjs';

const RUNTIME_DIR = join(DB_DIR, 'runtime');

/**
 * Read episode file without locking (for signal handlers only).
 * @returns {object|null} Parsed episode or null on failure
 */
export function readEpisodeRaw() {
  try {
    return JSON.parse(readFileSync(join(RUNTIME_DIR, `ep-${inferProject()}.json`), 'utf8'));
  } catch { return null; }
}

/**
 * Get the path to the current project's episode buffer file.
 * @returns {string} Absolute path to the episode JSON file
 */
export function episodeFile() {
  return join(RUNTIME_DIR, `ep-${inferProject()}.json`);
}

/**
 * Get the path to the advisory lock file for episode operations.
 * @returns {string} Absolute path to the lock file
 */
export function lockFile() {
  return episodeFile() + '.lock';
}

/**
 * Acquire an advisory file lock for episode buffer operations.
 * Uses atomic O_CREAT|O_EXCL for lock creation with stale lock detection.
 * @param {number} [maxWaitMs=500] Maximum time to wait for the lock
 * @returns {boolean} true if lock acquired, false on timeout
 */
export function acquireLock(maxWaitMs = 500) {
  const lf = lockFile();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      let fd;
      try {
        fd = openSync(lf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
        writeSync(fd, payload);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      return true;
    } catch {
      // Lock exists — check if stale or orphaned
      try {
        const raw = readFileSync(lf, 'utf8');
        const info = JSON.parse(raw);
        const age = Date.now() - (info.ts || 0);
        let stale = age > 30000; // >30s = stale
        if (!stale && info.pid) {
          try { process.kill(info.pid, 0); } catch (killErr) {
            stale = killErr.code === 'ESRCH'; // Only stale if process truly gone
          }
        }
        if (stale) { try { unlinkSync(lf); } catch {} continue; }
      } catch {
        // Can't read lock — check mtime
        try {
          const st = statSync(lf);
          if (Date.now() - st.mtimeMs > 30000) { try { unlinkSync(lf); } catch {} continue; }
        } catch {}
      }
      // WARNING: Atomics.wait blocks the main thread. This is intentional and safe here
      // because hook.mjs runs as a short-lived subprocess (not the MCP server).
      // Do NOT use this pattern in server.mjs or any long-lived event-driven process.
      const wait = Math.ceil(Math.random() * 20);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  return false;
}

/**
 * Release the advisory file lock for episode buffer operations.
 */
export function releaseLock() {
  try { unlinkSync(lockFile()); } catch {}
}

/**
 * Read the current episode buffer from disk (requires lock).
 * @returns {object|null} Parsed episode or null if not found
 */
export function readEpisode() {
  try {
    return JSON.parse(readFileSync(episodeFile(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomically write episode buffer to disk using tmp+rename.
 * @param {object} episode The episode object to persist
 */
export function writeEpisode(episode) {
  const target = episodeFile();
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(episode));
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Create a new empty episode buffer.
 * @param {string} sessionId The current session ID
 * @param {string} project The current project name
 * @returns {object} A fresh episode object
 */
export function createEpisode(sessionId, project) {
  return {
    sessionId,
    project,
    startedAt: Date.now(),
    lastAt: Date.now(),
    files: [],
    entries: [],
    filesRead: [],
    fileHistoryShown: [],
  };
}

/**
 * Add file paths to an episode's file tracking set (deduped).
 * @param {object} episode The episode to update
 * @param {string[]} files Array of file paths to add
 */
export function addFileToEpisode(episode, files) {
  for (const f of files) {
    if (!episode.files.includes(f)) episode.files.push(f);
  }
}

/**
 * Write a pending entry to a recovery file when the episode lock cannot be acquired.
 * @param {object} entry The episode entry to persist
 * @param {string} sessionId The current session ID
 * @param {string} project The current project name
 */
export function writePendingEntry(entry, sessionId, project) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const pendingFile = join(RUNTIME_DIR, `pending-${ts}-${rand}.json`);
  const tmp = pendingFile + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify({ entry, sessionId, project, ts }));
    renameSync(tmp, pendingFile);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Merge pending recovery entries into the current episode buffer.
 * Reads and removes pending-*.json files from the runtime directory.
 * @param {object} episode The episode to merge entries into
 */
export function mergePendingEntries(episode) {
  const oneHourAgo = Date.now() - 3600000;
  const MAX_PENDING_MERGE = 50;
  let files;
  try {
    files = readdirSync(RUNTIME_DIR).filter(f => f.startsWith('pending-')).sort();
  } catch { return; }

  let merged = 0;
  for (const f of files) {
    if (merged >= MAX_PENDING_MERGE) break;
    const fp = join(RUNTIME_DIR, f);
    try {
      const raw = readFileSync(fp, 'utf8');
      const pending = JSON.parse(raw);
      if (pending.ts < oneHourAgo) { try { unlinkSync(fp); } catch {} continue; }
      // Only merge entries belonging to the same project
      if (pending.project && episode.project && pending.project !== episode.project) continue;
      unlinkSync(fp);
      if (pending.entry) {
        episode.entries.push(pending.entry);
        episode.lastAt = Math.max(episode.lastAt, pending.entry.ts || pending.ts);
        addFileToEpisode(episode, pending.entry.files || []);
        merged++;
      }
    } catch {
      // Corrupt pending file — remove
      try { unlinkSync(fp); } catch {}
    }
  }
}

/**
 * Check if an episode has significant content worth processing with LLM.
 * Significant = contains file edits or Bash errors.
 * @param {object} episode The episode to check
 * @returns {boolean} true if the episode has significant content
 */
export function episodeHasSignificantContent(episode) {
  return episode.entries.some(e =>
    ['Edit', 'Write', 'NotebookEdit'].includes(e.tool) ||
    (e.tool === 'Bash' && e.isError)
  );
}
