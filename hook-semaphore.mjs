// claude-mem-lite LLM concurrency semaphore
// Limits concurrent claude -p calls to prevent resource contention

import { join } from 'path';
import { readFileSync, unlinkSync, readdirSync, openSync, closeSync, writeSync, constants as fsConstants } from 'fs';
import { RUNTIME_DIR } from './hook-shared.mjs';
import { BG_LLM_TIMEOUT_MS } from './haiku-client.mjs';

export const LLM_SEM_MAX = 2;

// D#134 MEDIUM-2 — both budgets are DERIVED from the longest a slot can
// legitimately be held, not hand-set. They used to be the literals 30000 and
// 60000, sized for the ~15-20s LLM calls of the time; v3.66.0 raised the
// background call budget to 45s and neither literal followed, leaving two
// silent failures:
//
//   • wait budget < hold: with both slots busy the third worker gave up after
//     30s while a holder was still legitimately working, and its caller fell
//     through to degraded storage — the observation is SAVED but never
//     enriched. Nothing errors; the row just quietly lacks aliases/lesson.
//   • stale threshold barely above hold: a 45s holder had 15s of margin, so a
//     slow SIGTERM, GC pause, or loaded machine let a PEER delete the live
//     holder's file. That drops it out of `active`, and the peer then sees
//     room that does not exist — more than LLM_SEM_MAX concurrent calls.
//
// Wait one full hold plus a wait-cycle of slack: the worst honest case is
// arriving just as a 45s call started.
export const LLM_SEM_TIMEOUT = BG_LLM_TIMEOUT_MS + 15000; // 60s max wait
// Reaping is the PID-REUSE backstop, not the liveness test (that is
// process.kill(pid, 0) below). At 2x the hold plus slack it cannot fire on a
// working holder, which is why the ts written at acquire never needs
// refreshing — a heartbeat would buy nothing this margin doesn't.
export const LLM_SEM_STALE_MS = BG_LLM_TIMEOUT_MS * 2 + 30000; // 120s

export const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Acquire a file-based semaphore slot for LLM calls.
 * Uses acquire-then-verify: atomically creates a slot file, then checks total count.
 * @returns {Promise<boolean>} true if slot acquired, false on timeout
 */
export async function acquireLLMSlot() {
  const deadline = Date.now() + LLM_SEM_TIMEOUT;
  const slotFile = join(RUNTIME_DIR, `llm-sem-${process.pid}`);

  while (Date.now() < deadline) {
    // Acquire-then-verify: atomically create our slot first, then check total count
    let created;
    try {
      let fd;
      try {
        fd = openSync(slotFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
        writeSync(fd, payload);
        created = true;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    } catch {
      // Our own pid-named slot file already exists: a leftover from a prior acquire
      // that never released (crash between acquire and releaseLLMSlot, or PID reuse).
      // We are inside acquire and therefore do NOT currently hold a slot, so it is
      // always stale — remove it and retry. The await is essential: a bare `continue`
      // here re-hits the same EEXIST every iteration, a synchronous tight loop that
      // pins a core until the 30s deadline (the age-based cleanup below is unreachable
      // on this path — it only runs after a successful create).
      try { unlinkSync(slotFile); } catch {}
      await sleepMs(50 + Math.random() * 100);
      continue;
    }

    if (!created) { await sleepMs(200 + Math.random() * 800); continue; }

    // Count all active semaphore files (including ours) and clean stale ones
    let active = 0;
    try {
      for (const f of readdirSync(RUNTIME_DIR)) {
        if (!f.startsWith('llm-sem-')) continue;
        const fp = join(RUNTIME_DIR, f);
        try {
          const raw = readFileSync(fp, 'utf8');
          const info = JSON.parse(raw);
          const age = Date.now() - (info.ts || 0);
          // Liveness FIRST, age second. The pre-D#134 order reaped on age alone,
          // which evicted holders that were alive and mid-call (see the budget
          // note at the top of this file). A dead holder is reaped at any age;
          // a live one only once its age is implausible as a real hold, which is
          // the pid-reuse case the age check exists for.
          if (info.pid) {
            let alive;
            try { process.kill(info.pid, 0); alive = true; } catch (killErr) {
              // EPERM = process exists but belongs to another user → alive.
              alive = killErr.code !== 'ESRCH';
            }
            if (!alive) { try { unlinkSync(fp); } catch {} continue; }
          }
          if (age > LLM_SEM_STALE_MS) {
            try { unlinkSync(fp); } catch {}
            continue;
          }
          active++;
        } catch {
          // Corrupt/unreadable semaphore file — treat as stale and remove
          try { unlinkSync(fp); } catch {}
        }
      }
    } catch {}

    if (active <= LLM_SEM_MAX) return true; // Slot acquired

    // Too many concurrent — release our slot and back off
    try { unlinkSync(slotFile); } catch {}
    await sleepMs(200 + Math.random() * 800);
  }
  return false; // Timed out
}

/**
 * Release the file-based semaphore slot for the current process.
 */
export function releaseLLMSlot() {
  try { unlinkSync(join(RUNTIME_DIR, `llm-sem-${process.pid}`)); } catch {}
}
