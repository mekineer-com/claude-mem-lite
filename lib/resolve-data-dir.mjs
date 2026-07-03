// Single source of truth for resolving the CLAUDE_MEM_DIR data directory.
// Zero runtime deps (node:path + node:os only) so hot-path hook scripts can
// import it without pulling in better-sqlite3.
//
// The env var is a RELOCATION knob: unset → ~/.claude-mem-lite (the common,
// non-relocated case); set → an absolute path on a larger/faster volume.
// Anything else is a mistake we must reject LOUDLY rather than turn into a
// stray directory:
//   - The literal strings "undefined"/"null" arise when a caller interpolates
//     a JS nullish value into a shell env string (e.g. `CLAUDE_MEM_DIR='${x}'`
//     with x === undefined). They are truthy, so `env || default` accepts them
//     and better-sqlite3 then creates a relative `undefined/` dir at cwd.
//   - A relative path silently resolves against each process's cwd, scattering
//     state across directories.
// Falsy (unset/empty) is the only non-absolute value we treat as "use default".
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

/**
 * @param {string|undefined|null} raw  Typically process.env.CLAUDE_MEM_DIR.
 * @returns {string} An absolute data directory.
 * @throws if `raw` is a non-empty, non-absolute value (incl. "undefined"/"null").
 */
export function resolveDataDir(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return join(homedir(), '.claude-mem-lite');
  }
  if (typeof raw !== 'string' || raw === 'undefined' || raw === 'null' || !isAbsolute(raw)) {
    throw new Error(
      `CLAUDE_MEM_DIR must be an absolute path; got ${JSON.stringify(raw)}. ` +
      `Leave it unset to use ~/.claude-mem-lite.`
    );
  }
  return raw;
}
