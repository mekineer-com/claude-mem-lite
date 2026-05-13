// cli/fts-check.mjs — `claude-mem-lite fts-check <check|rebuild>`.
// Extracted from mem-cli.mjs (v2.41, god-module split).

import { checkFTSIntegrity, rebuildFTS } from '../schema.mjs';
import { parseArgs, out, fail } from './common.mjs';

export function cmdFtsCheck(db, args) {
  const { positional } = parseArgs(args);
  const action = positional[0];
  if (!action) {
    fail('[mem] Usage: claude-mem-lite fts-check <check|rebuild>');
    return;
  }
  if (!['check', 'rebuild'].includes(action)) {
    // Tell the user what was wrong rather than dumping the usage — they passed
    // something concrete, the error should name the invalid token.
    fail(`[mem] Invalid action "${action}". Use: check, rebuild`);
    return;
  }

  if (action === 'check') {
    const result = checkFTSIntegrity(db);
    if (result.healthy) {
      out('[mem] FTS5 indexes are healthy — all integrity checks passed.');
    } else {
      out(`[mem] FTS5 issues found:`);
      for (const d of result.details) out(`  ${d}`);
    }
    return;
  }

  if (action === 'rebuild') {
    const result = rebuildFTS(db);
    if (result.errors.length > 0) {
      out(`[mem] Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`);
    } else {
      out(`[mem] Successfully rebuilt: ${result.rebuilt.join(', ')}`);
    }
  }
}
