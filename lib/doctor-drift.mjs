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
  return {
    devMode,
    drift,
    symlinkCount: symlinkFiles.length,
    plainCount: plainFiles.length,
    plainFiles,
    missingCount: missing.length,
    details: plainFiles.slice(0, 5),
  };
}
