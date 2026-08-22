// claude-mem-lite episode buffer management
// Handles file-based episode storage with advisory locking and pending entry recovery

import { join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, openSync, closeSync, writeSync, renameSync, statSync, constants as fsConstants } from 'fs';
import { inferProject, EDIT_TOOLS } from './utils.mjs';
import { RUNTIME_DIR } from './hook-shared.mjs';

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
  const tmp = target + `.tmp-${process.pid}`;
  const { _fileSet, ...serializable } = episode;
  // 0600 on the tmp file, not on `target`: mode applies at creation and rename
  // carries it over, so the buffer is never briefly world-readable. The buffer
  // holds captured file paths + scrubbed activity — owner-only like the DB.
  writeFileSync(tmp, JSON.stringify(serializable), { mode: 0o600 });
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
  };
}

/**
 * Split an episode's entries by originating CC session so each concurrent
 * session flushes as its own observation. Common path (single session, or all
 * untagged/legacy entries) returns [episode] BY REFERENCE — behavior identical
 * to pre-grouping. When >=2 sessions interleaved in one buffer, returns one
 * sub-episode per session with its own entries + recomputed file union;
 * filesRead (untagged bash reads-file) is inherited by every sub. Each sub
 * resets savedId so it receives its own from its immediate-save (savedId is
 * load-bearing: llm-episode upgrades the pre-saved obs by it).
 * @param {object} episode
 * @returns {object[]}
 */
export function planEpisodeFlush(episode) {
  const groups = new Map();
  for (const e of episode.entries) {
    const key = e.ccSession ?? '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  if (groups.size <= 1) return [episode];
  const subs = [];
  for (const [, entries] of groups) {
    subs.push({
      ...episode,
      entries,
      files: [...new Set(entries.flatMap(e => e.files || []))],
      filesRead: episode.filesRead,
      savedId: undefined,
    });
  }
  return subs;
}

/**
 * Add file paths to an episode's file tracking set (deduped).
 * @param {object} episode The episode to update
 * @param {string[]} files Array of file paths to add
 */
export function addFileToEpisode(episode, files) {
  if (!episode._fileSet) episode._fileSet = new Set(episode.files);
  for (const f of files) {
    if (!episode._fileSet.has(f)) {
      episode._fileSet.add(f);
      episode.files.push(f);
    }
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
    writeFileSync(tmp, JSON.stringify({ entry, sessionId, project, ts }), { mode: 0o600 });
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
      if (pending.entry) {
        unlinkSync(fp);
        episode.entries.push(pending.entry);
        episode.lastAt = Math.max(episode.lastAt, pending.entry.ts || pending.ts);
        addFileToEpisode(episode, pending.entry.files || []);
        merged++;
      } else {
        // No entry data — clean up the file without merging
        try { unlinkSync(fp); } catch {}
      }
    } catch {
      // Corrupt pending file — remove
      try { unlinkSync(fp); } catch {}
    }
  }
}

/** Rule 4's threshold — 8+ Read/Grep entries read as investigation. */
const RESEARCH_ENTRY_THRESHOLD = 8;

/**
 * The significance decision WITH its reasoning, for instrumentation.
 * `episodeHasSignificantContent` is the boolean face of this same body, so the meter
 * and the decision cannot drift (audit 2026-08-22 P2-14).
 *
 * `grepDecisive` answers the one question the "move Grep into the bash skip list"
 * decision is blocked on: would this episode still have been kept without its Grep
 * entries? It is true ONLY when rule 4 decided AND the non-Grep entries alone fall
 * short — an edit-driven episode that happens to contain Greps is not evidence that
 * Grep carries research episodes.
 *
 * @param {object} episode
 * @returns {{significant: boolean, rule: 1|2|3|4|null, readCount: number,
 *   grepCount: number, grepDecisive: boolean}}
 */
export function explainSignificance(episode) {
  const entries = episode?.entries || [];
  const grepCount = entries.filter(e => e.tool === 'Grep').length;
  const readCount = entries.filter(e => e.tool === 'Read' || e.tool === 'Grep').length;
  const base = { readCount, grepCount, grepDecisive: false };

  // 1. File edits → always significant (code changes matter)
  if (entries.some(e => EDIT_TOOLS.has(e.tool))) return { ...base, significant: true, rule: 1 };

  // 2. Test/build errors → significant (actionable failures)
  // Plain bash errors without edits are noise (e.g. typos, exploration errors)
  if (entries.some(e => e.tool === 'Bash' && e.isError && (e.bashSig?.isTest || e.bashSig?.isBuild))) {
    return { ...base, significant: true, rule: 2 };
  }

  // 3. Important files touched (config, schema, security, migration)
  // Checks episode.files (all touched files, including reads) — catches important-file investigation
  const allFiles = episode?.files || [];
  if (allFiles.some(f =>
    /\.(env|yml|yaml|toml|lock|sql|prisma|proto)$/.test(f) ||
    /(config|schema|migration|auth|security)/i.test(f)
  )) return { ...base, significant: true, rule: 3 };

  // 4. Research pattern: reading many files indicates investigation
  if (readCount >= RESEARCH_ENTRY_THRESHOLD) {
    return { ...base, significant: true, rule: 4, grepDecisive: readCount - grepCount < RESEARCH_ENTRY_THRESHOLD };
  }
  return { ...base, significant: false, rule: null };
}

/**
 * Check if an episode has significant content worth processing with LLM.
 * Significant = contains file edits, Bash errors, or a review/research pattern
 * (8+ Read/Grep entries indicate investigation worth recording).
 * @param {object} episode The episode to check
 * @returns {boolean} true if the episode has significant content
 */
export function episodeHasSignificantContent(episode) {
  return explainSignificance(episode).significant;
}
