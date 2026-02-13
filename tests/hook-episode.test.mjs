// Tests for hook-episode.mjs — episode buffer management, locking, pending entries
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs';

// We need to mock the runtime dir and inferProject before importing the module.
// hook-episode.mjs uses DB_DIR from schema.mjs and inferProject from utils.mjs.
// We'll test the pure logic functions by importing them directly and setting up
// a temp runtime directory.

import {
  readEpisodeRaw,
  episodeFile,
  lockFile,
  acquireLock,
  releaseLock,
  readEpisode,
  writeEpisode,
  createEpisode,
  addFileToEpisode,
  writePendingEntry,
  mergePendingEntries,
  episodeHasSignificantContent,
} from '../hook-episode.mjs';
import { DB_DIR } from '../schema.mjs';

const RUNTIME_DIR = join(DB_DIR, 'runtime');

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanupEpisodeFiles() {
  const epFile = episodeFile();
  const lf = lockFile();
  for (const f of [epFile, epFile + '.tmp', lf]) {
    try { unlinkSync(f); } catch {}
  }
  // Clean pending files
  try {
    for (const f of readdirSync(RUNTIME_DIR)) {
      if (f.startsWith('pending-')) {
        try { unlinkSync(join(RUNTIME_DIR, f)); } catch {}
      }
    }
  } catch {}
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('hook-episode.mjs', () => {
  beforeEach(() => {
    try { mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}
    cleanupEpisodeFiles();
  });

  afterEach(() => {
    releaseLock();
    cleanupEpisodeFiles();
  });

  // ─── createEpisode ──────────────────────────────────────────────────────

  describe('createEpisode', () => {
    it('creates episode with correct structure', () => {
      const ep = createEpisode('sess-1', 'my-project');
      expect(ep.sessionId).toBe('sess-1');
      expect(ep.project).toBe('my-project');
      expect(ep.entries).toEqual([]);
      expect(ep.files).toEqual([]);
      expect(ep.filesRead).toEqual([]);
      expect(ep.fileHistoryShown).toEqual([]);
      expect(ep.startedAt).toBeGreaterThan(0);
      expect(ep.lastAt).toBeGreaterThan(0);
    });
  });

  // ─── addFileToEpisode ───────────────────────────────────────────────────

  describe('addFileToEpisode', () => {
    it('adds unique files to episode', () => {
      const ep = createEpisode('s', 'p');
      addFileToEpisode(ep, ['a.js', 'b.js']);
      expect(ep.files).toEqual(['a.js', 'b.js']);
    });

    it('deduplicates files', () => {
      const ep = createEpisode('s', 'p');
      addFileToEpisode(ep, ['a.js', 'b.js']);
      addFileToEpisode(ep, ['b.js', 'c.js']);
      expect(ep.files).toEqual(['a.js', 'b.js', 'c.js']);
    });

    it('handles empty array', () => {
      const ep = createEpisode('s', 'p');
      addFileToEpisode(ep, []);
      expect(ep.files).toEqual([]);
    });
  });

  // ─── episodeHasSignificantContent ───────────────────────────────────────

  describe('episodeHasSignificantContent', () => {
    it('returns true for episodes with Edit entries', () => {
      const ep = createEpisode('s', 'p');
      ep.entries.push({ tool: 'Edit', desc: 'edit file', isError: false });
      expect(episodeHasSignificantContent(ep)).toBe(true);
    });

    it('returns true for episodes with Write entries', () => {
      const ep = createEpisode('s', 'p');
      ep.entries.push({ tool: 'Write', desc: 'write file', isError: false });
      expect(episodeHasSignificantContent(ep)).toBe(true);
    });

    it('returns true for episodes with NotebookEdit entries', () => {
      const ep = createEpisode('s', 'p');
      ep.entries.push({ tool: 'NotebookEdit', desc: 'edit notebook', isError: false });
      expect(episodeHasSignificantContent(ep)).toBe(true);
    });

    it('returns true for episodes with Bash error entries', () => {
      const ep = createEpisode('s', 'p');
      ep.entries.push({ tool: 'Bash', desc: 'npm test', isError: true });
      expect(episodeHasSignificantContent(ep)).toBe(true);
    });

    it('returns false for episodes with only non-significant entries', () => {
      const ep = createEpisode('s', 'p');
      ep.entries.push({ tool: 'Bash', desc: 'git status', isError: false });
      ep.entries.push({ tool: 'Grep', desc: 'search', isError: false });
      expect(episodeHasSignificantContent(ep)).toBe(false);
    });

    it('returns false for empty episodes', () => {
      const ep = createEpisode('s', 'p');
      expect(episodeHasSignificantContent(ep)).toBe(false);
    });
  });

  // ─── acquireLock / releaseLock ──────────────────────────────────────────

  describe('acquireLock / releaseLock', () => {
    it('acquires lock and creates lock file', () => {
      const got = acquireLock();
      expect(got).toBe(true);
      expect(existsSync(lockFile())).toBe(true);
    });

    it('lock file contains pid and timestamp', () => {
      acquireLock();
      const info = JSON.parse(readFileSync(lockFile(), 'utf8'));
      expect(info.pid).toBe(process.pid);
      expect(info.ts).toBeGreaterThan(0);
    });

    it('releaseLock removes lock file', () => {
      acquireLock();
      releaseLock();
      expect(existsSync(lockFile())).toBe(false);
    });

    it('fails to acquire when lock is held by current process', () => {
      acquireLock();
      // Second acquire should timeout quickly since same PID holds it
      // The lock check sees our PID is alive so it waits
      const got = acquireLock(100);
      // Should be false since we already hold it
      expect(got).toBe(false);
    });

    it('recovers stale lock (old timestamp)', () => {
      // Write a stale lock file with old timestamp
      writeFileSync(lockFile(), JSON.stringify({ pid: 999999, ts: Date.now() - 60000 }));
      const got = acquireLock(1000);
      expect(got).toBe(true);
    });

    it('recovers lock from dead process', () => {
      // Write a lock file with non-existent PID
      writeFileSync(lockFile(), JSON.stringify({ pid: 2147483647, ts: Date.now() }));
      const got = acquireLock(2000);
      expect(got).toBe(true);
    });
  });

  // ─── writeEpisode / readEpisode ─────────────────────────────────────────

  describe('writeEpisode / readEpisode', () => {
    it('round-trips episode through write and read', () => {
      const ep = createEpisode('sess-1', 'proj');
      ep.entries.push({ tool: 'Edit', desc: 'test', files: ['a.js'], ts: Date.now() });
      writeEpisode(ep);
      const loaded = readEpisode();
      expect(loaded.sessionId).toBe('sess-1');
      expect(loaded.project).toBe('proj');
      expect(loaded.entries.length).toBe(1);
      expect(loaded.entries[0].tool).toBe('Edit');
    });

    it('readEpisode returns null when no file exists', () => {
      const loaded = readEpisode();
      expect(loaded).toBeNull();
    });

    it('readEpisodeRaw returns null when no file exists', () => {
      const loaded = readEpisodeRaw();
      expect(loaded).toBeNull();
    });

    it('writeEpisode is atomic (no leftover tmp on success)', () => {
      const ep = createEpisode('s', 'p');
      writeEpisode(ep);
      expect(existsSync(episodeFile())).toBe(true);
      expect(existsSync(episodeFile() + '.tmp')).toBe(false);
    });
  });

  // ─── writePendingEntry / mergePendingEntries ────────────────────────────

  describe('writePendingEntry / mergePendingEntries', () => {
    it('writes pending entry as JSON file', () => {
      const entry = { tool: 'Bash', desc: 'npm test', files: [], ts: Date.now(), isError: true };
      writePendingEntry(entry, 'sess-1', 'proj');

      const files = readdirSync(RUNTIME_DIR).filter(f => f.startsWith('pending-'));
      expect(files.length).toBe(1);

      const content = JSON.parse(readFileSync(join(RUNTIME_DIR, files[0]), 'utf8'));
      expect(content.entry.tool).toBe('Bash');
      expect(content.sessionId).toBe('sess-1');
      expect(content.project).toBe('proj');
    });

    it('merges pending entries into episode', () => {
      const entry1 = { tool: 'Edit', desc: 'edit a.js', files: ['a.js'], ts: Date.now() };
      const entry2 = { tool: 'Bash', desc: 'npm run build', files: [], ts: Date.now() + 100 };
      writePendingEntry(entry1, 'sess-1', 'proj');
      writePendingEntry(entry2, 'sess-1', 'proj');

      const ep = createEpisode('sess-1', 'proj');
      mergePendingEntries(ep);

      expect(ep.entries.length).toBe(2);
      // Pending files should be cleaned up
      const remaining = readdirSync(RUNTIME_DIR).filter(f => f.startsWith('pending-'));
      expect(remaining.length).toBe(0);
    });

    it('skips pending entries from different projects', () => {
      const entry = { tool: 'Edit', desc: 'edit', files: [], ts: Date.now() };
      writePendingEntry(entry, 'sess-1', 'other-project');

      const ep = createEpisode('sess-1', 'proj');
      mergePendingEntries(ep);

      expect(ep.entries.length).toBe(0);
      // File should still exist (not consumed)
      const remaining = readdirSync(RUNTIME_DIR).filter(f => f.startsWith('pending-'));
      expect(remaining.length).toBe(1);
    });

    it('skips expired pending entries (>1 hour)', () => {
      // Write a pending file with old timestamp
      const ts = Date.now() - 2 * 3600000; // 2 hours ago
      const entry = { tool: 'Edit', desc: 'old edit', files: [], ts };
      const pendingFile = join(RUNTIME_DIR, `pending-${ts}-test.json`);
      writeFileSync(pendingFile, JSON.stringify({ entry, sessionId: 's', project: 'proj', ts }));

      const ep = createEpisode('s', 'proj');
      mergePendingEntries(ep);

      expect(ep.entries.length).toBe(0);
      // Expired file should be deleted
      expect(existsSync(pendingFile)).toBe(false);
    });

    it('respects MAX_PENDING_MERGE limit', () => {
      // Write 55 pending entries
      for (let i = 0; i < 55; i++) {
        const entry = { tool: 'Bash', desc: `cmd ${i}`, files: [], ts: Date.now() + i };
        writePendingEntry(entry, 'sess-1', 'proj');
      }

      const ep = createEpisode('sess-1', 'proj');
      mergePendingEntries(ep);

      expect(ep.entries.length).toBe(50); // MAX_PENDING_MERGE = 50
    });

    it('updates episode lastAt and files from pending entries', () => {
      const futureTs = Date.now() + 10000;
      const entry = { tool: 'Edit', desc: 'edit', files: ['new-file.js'], ts: futureTs };
      writePendingEntry(entry, 'sess-1', 'proj');

      const ep = createEpisode('sess-1', 'proj');
      mergePendingEntries(ep);

      expect(ep.lastAt).toBeGreaterThanOrEqual(futureTs);
      expect(ep.files).toContain('new-file.js');
    });
  });
});
