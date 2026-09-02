// One parse of a Claude Code transcript, shared by everything that scans it.
//
// Audit 2026-08-22 P2-8. handleStop asked the same .jsonl the same question eight
// different ways — tail assistant text, citations, citations again with mainOnly,
// injected-by-surface, cite-back signals, main-thread text, cite-recall, bugfix shape —
// and every one of them did its own readFileSync + split('\n') + JSON.parse per line.
// Measured on a real 5.7MB transcript: ~25ms per pass, so the repeated work is roughly
// 175ms of a 5s Stop budget, and it scales linearly with a session that runs long.
// Parsing is nearly all of it; iterating an already-parsed array of 2908 entries is
// 0.1ms.
//
// This is a memo, not a rewrite: each scanner keeps its own per-entry logic exactly as
// it was, and only stops re-reading and re-parsing the file to get at it.
import { readFileSync, existsSync, statSync } from 'fs';

// Retention cap. Parsed entries cost ~3.45× the file size in heap (measured, same
// transcript: 5.7MB → 19.5MB). Holding that across a whole Stop is fine for the sessions
// people actually have; holding it for a 50MB transcript is not, and a hook that gets
// OOM-killed loses the session's work outright. Above the cap each caller parses on its
// own exactly as before, so the worst case is today's behaviour rather than a new one.
export const TRANSCRIPT_CACHE_MAX_BYTES = 24 * 1024 * 1024;

let cacheKey = '';
let cacheEntries = null;

/**
 * Parsed transcript records, in file order, unparsable lines dropped.
 *
 * The cache key carries size and mtime: a transcript is append-only and Claude Code is
 * still writing to it while the Stop hook runs, so a later caller in the same process
 * must see the same fresh data it would have read for itself.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {object[]} entries (empty array when the path is missing or unreadable)
 */
export function readTranscriptEntries(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  let st;
  try { st = statSync(transcriptPath); } catch { return []; }
  const key = `${transcriptPath} ${st.size} ${st.mtimeMs}`;
  if (key === cacheKey && cacheEntries) return cacheEntries;

  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a partially written tail line */ }
  }
  if (st.size <= TRANSCRIPT_CACHE_MAX_BYTES) {
    cacheKey = key;
    cacheEntries = entries;
  } else {
    // Drop whatever was held: an oversized transcript should not keep an older, smaller
    // one alive in memory for the rest of the process either.
    cacheKey = '';
    cacheEntries = null;
  }
  return entries;
}

/** Test seam: forget the memo so a fixture rewritten within one mtime tick is re-read. */
export function _resetTranscriptCache() {
  cacheKey = '';
  cacheEntries = null;
}
