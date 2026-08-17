// Dev-drift check: in dev-mode installs (symlinked to project repo), every
// managed source file in INSTALL_DIR should be a symlink. A regular file
// means an earlier install copied it (e.g. install.mjs before it was added
// to SOURCE_FILES) or someone ran `cp` manually — edits won't propagate
// from the repo, testing vs runtime will silently diverge.
//
// Returns: { devMode, drift, details } — devMode=false when no symlinks
// detected (prod copy install), drift=true when in dev-mode AND at least
// one SOURCE_FILES entry is a plain file.

import { existsSync, lstatSync } from 'fs';
import { join } from 'path';

// Files something EXECUTES by path (the CLI, the MCP server, a hook entry) as opposed to
// files that are only ever `import`ed. The distinction decides whether an absent file
// matters in a symlink install: Node resolves an ESM specifier against the importing
// module's REALPATH, so a symlinked entry point resolves `../lib/x.mjs` inside the REPO and
// never looks at the install dir. An absent import-only module is therefore unreachable
// dead weight there — while an absent ENTRY POINT is fatal in every shape, because the
// command names that path directly.
//
// Scope note (pre-tag review): this classifies only what the CALLER passes in, and
// install.mjs passes SOURCE_FILES, which holds zero `scripts/` entries — hook scripts are
// installed from the separate HOOK_SCRIPT_FILES manifest. An earlier draft mapped those
// into this set; it could never match a single path, so it is gone rather than left as
// inert code implying coverage it does not have. Extending doctor to check the hook-script
// manifest is real work with its own fixture, and is tracked as deferred rather than
// implied here.
const ENTRY_POINTS = new Set([
  'cli.mjs', 'mem-cli.mjs', 'server.mjs', 'hook.mjs', 'install.mjs',
]);

export function checkDevDrift(installDir, sourceFiles) {
  if (!existsSync(installDir)) {
    return { devMode: false, drift: false, symlinkCount: 0, plainCount: 0, plainFiles: [], missingCount: 0, details: [] };
  }
  const symlinkFiles = [];
  const plainFiles = [];
  const missing = [];
  for (const rel of sourceFiles) {
    const p = join(installDir, rel);
    if (!existsSync(p)) { missing.push(rel); continue; }
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) symlinkFiles.push(rel);
      else plainFiles.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  // devMode detection: if ≥1 symlink exists among source files, consider
  // this a dev install. (Prod install is all plain files → drift=false
  // because there's nothing to drift from.)
  const devMode = symlinkFiles.length > 0;
  const drift = devMode && plainFiles.length > 0;
  const missingEntry = missing.filter((rel) => ENTRY_POINTS.has(rel));
  const missingModules = missing.filter((rel) => !ENTRY_POINTS.has(rel));
  return {
    devMode,
    drift,
    symlinkCount: symlinkFiles.length,
    plainCount: plainFiles.length,
    plainFiles,
    missingCount: missing.length,
    missingFiles: missing.slice(0, 5),
    // Split so the caller can grade by consequence rather than by count: an entry point is
    // fatal in every install shape, an import-only module only in a copy install.
    missingEntryCount: missingEntry.length,
    missingEntryFiles: missingEntry.slice(0, 5),
    missingModuleCount: missingModules.length,
    missingModuleFiles: missingModules.slice(0, 5),
    details: plainFiles.slice(0, 5),
  };
}
