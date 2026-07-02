#!/usr/bin/env node
// claude-mem-lite: PreToolUse:Agent|Task hook — subagent dispatch-time memory injection.
// Subagents are memory-blind (plugin hooks do NOT fire inside them — #8848); this hook
// injects ONE relevant project lesson into a dispatched subagent's prompt by mutating
// tool_input.prompt via hookSpecificOutput.updatedInput. Verified live 2026-07-03
// (Phase 0a: the mutation reaches the subagent's task-prompt position; Phase 0b: an
// appended, attributed, reference-only block is adopted, whereas a raw imperative
// prepend trips the subagent's own prompt-injection detector and is refused).
//
// DEFAULT OFF (CLAUDE_MEM_SUBAGENT_INJECT=on|1). The off path costs one env check and
// returns — no stdin read, no DB, no heavy imports (schema/better-sqlite3 are dynamic,
// loaded only on the enabled Agent path). Fail-open: never exits non-zero, never blocks
// a dispatch (a thrown hook would abort the user's subagent).

const ENABLED = process.env.CLAUDE_MEM_SUBAGENT_INJECT === 'on'
  || process.env.CLAUDE_MEM_SUBAGENT_INJECT === '1';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => { try { process.stdin.destroy(); } catch { /* */ } resolve(data); }, 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      // cap: agent prompts can be large. destroy() so the loop can drain and exit on
      // its own (see the no-forced-exit note at the bottom) rather than streaming to
      // the 1.5s timeout.
      if (data.length > 262144) { clearTimeout(timer); try { process.stdin.destroy(); } catch { /* */ } resolve(data.slice(0, 262144)); }
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
    process.stdin.resume();
  });
}

async function main() {
  if (!ENABLED) return;                             // default: cheapest possible no-op
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) return;  // recursion guard (background claude -p)

  const raw = await readStdin();
  let hook;
  try { hook = JSON.parse(raw); } catch { return; }
  if (!hook || typeof hook !== 'object') return;
  if (hook.tool_name !== 'Agent' && hook.tool_name !== 'Task') return;

  // Heavy deps loaded ONLY on the enabled Agent-dispatch path, so the default-off
  // hot path never pays the schema.mjs + better-sqlite3 native load on every dispatch.
  const { ensureDb } = await import('../schema.mjs');
  const { inferProject } = await import('../utils.mjs');
  const { buildSubagentInjection } = await import('../hook-memory.mjs');

  let db;
  try { db = ensureDb(); } catch { return; }
  try {
    const updatedInput = buildSubagentInjection(db, hook.tool_input, inferProject());
    if (updatedInput) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
      }));
    }
  } catch { /* never break a dispatch */ } finally {
    try { db.close(); } catch { /* */ }
  }
}

// No forced process.exit(0): every readStdin path ends/destroys stdin and db.close()
// runs in main's finally, so the event loop drains and the process exits 0 on its own —
// which FLUSHES stdout. The emitted updatedInput echoes the whole prompt back, so the
// payload can exceed the ~64KB pipe buffer; a forced process.exit() would drop that
// pending async write and truncate the JSON (the gotcha every sibling hook avoids).
// Swallow any rejection so the exit code can never go non-zero.
main().catch(() => {});
