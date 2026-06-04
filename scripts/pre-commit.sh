#!/usr/bin/env bash
# Pre-commit hook: version sync + lint + test before commit
# Catches errors locally before they reach GitHub CI

set -e

# ── Version sync check ──────────────────────────────────────────────────────
# Ensures package.json, package-lock.json, plugin.json, marketplace.json, CLAUDE.md all match
echo "[pre-commit] Checking version sync..."
PKG_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json')).version)")
LOCK_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package-lock.json')).version)")
PLUGIN_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json')).version)")
MKT_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json')).plugins[0].version)")
CLAUDE_VER=$(grep -oP '(?<=\*\*Version\*\*: )\S+' CLAUDE.md)

MISMATCH=0
if [ "$PKG_VER" != "$LOCK_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs package-lock.json=$LOCK_VER"
  MISMATCH=1
fi
if [ "$PKG_VER" != "$PLUGIN_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs plugin.json=$PLUGIN_VER"
  MISMATCH=1
fi
if [ "$PKG_VER" != "$MKT_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs marketplace.json=$MKT_VER"
  MISMATCH=1
fi
if [ "$PKG_VER" != "$CLAUDE_VER" ]; then
  echo "[pre-commit] ❌ Version mismatch: package.json=$PKG_VER vs CLAUDE.md=$CLAUDE_VER"
  MISMATCH=1
fi
if [ "$MISMATCH" -eq 1 ]; then
  echo "[pre-commit] Fix: sync all 5 files to the same version, then re-commit."
  exit 1
fi
echo "[pre-commit] Versions synced: $PKG_VER"

# ── Lockfile @emnapi integrity check ────────────────────────────────────────
# A single-platform `npm install` prunes cross-platform @emnapi optional-native
# entries from package-lock.json, which breaks the CI runner's `npm ci`
# ("Missing: @emnapi/core@... from lock file"). This has recurred multiple times
# (mem P#6031 / #8644). Block any commit that REDUCES the @emnapi entry count vs
# the committed lock — that's the prune signature. Legit increases pass through.
if git diff --cached --name-only | grep -qx 'package-lock.json'; then
  STAGED_EMNAPI=$(git show :package-lock.json 2>/dev/null | grep -c '@emnapi' || true)
  HEAD_EMNAPI=$(git show HEAD:package-lock.json 2>/dev/null | grep -c '@emnapi' || true)
  if [ "${HEAD_EMNAPI:-0}" -gt 0 ] && [ "${STAGED_EMNAPI:-0}" -lt "${HEAD_EMNAPI:-0}" ]; then
    if [ "${DISABLE_EMNAPI_GUARD:-0}" = "1" ]; then
      echo "[pre-commit] ⚠ @emnapi entries dropped $HEAD_EMNAPI -> $STAGED_EMNAPI (DISABLE_EMNAPI_GUARD=1, allowing)"
    else
      echo "[pre-commit] ❌ package-lock.json @emnapi entries dropped: $HEAD_EMNAPI -> $STAGED_EMNAPI"
      echo "[pre-commit]    A single-platform 'npm install' pruned cross-platform optional native"
      echo "[pre-commit]    deps the CI runner's 'npm ci' needs (recurring — mem P#6031 / #8644)."
      echo "[pre-commit]    Fix: restore the committed lock + surgically patch only the changed dep"
      echo "[pre-commit]    (version+resolved+integrity), or regenerate preserving optionals."
      echo "[pre-commit]    Override (rare, intentional drop): DISABLE_EMNAPI_GUARD=1 git commit ..."
      exit 1
    fi
  fi
fi

# ── Lint ─────────────────────────────────────────────────────────────────────
echo "[pre-commit] Running eslint..."
npx eslint . || {
  echo "[pre-commit] ❌ Lint failed. Fix errors before committing."
  exit 1
}

echo "[pre-commit] Running tests..."
npx vitest run || {
  echo "[pre-commit] ❌ Tests failed. Fix errors before committing."
  exit 1
}

echo "[pre-commit] ✅ All checks passed."
