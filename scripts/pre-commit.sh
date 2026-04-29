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
