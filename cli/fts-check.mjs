// cli/fts-check.mjs — `claude-mem-lite fts-check <check|rebuild>`.
// Extracted from mem-cli.mjs (v2.41, god-module split).

import { checkFTSIntegrity, rebuildFTS } from '../schema.mjs';
import { parseArgs, out, fail } from './common.mjs';

export function cmdFtsCheck(db, args) {
  const { positional } = parseArgs(args);
  const action = positional[0];
  if (!action || !['check', 'rebuild'].includes(action)) {
    fail('[mem] Usage: mem fts-check <check|rebuild>');
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
