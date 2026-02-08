#!/usr/bin/env bash
#
# claude-mem-lite Setup Hook
# Installs native dependencies (better-sqlite3) on first run
#

set -euo pipefail

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(dirname "$SCRIPT_DIR")"
else
  ROOT="$CLAUDE_PLUGIN_ROOT"
fi

DATA_DIR="$HOME/claude-mem-lite"

# Colors
if [[ -t 2 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN='' YELLOW='' BLUE='' RED='' NC=''
fi

log_ok()   { echo -e "${GREEN}✓${NC} $*" >&2; }
log_info() { echo -e "${BLUE}ℹ${NC} $*" >&2; }
log_warn() { echo -e "${YELLOW}⚠${NC} $*" >&2; }
log_err()  { echo -e "${RED}✗${NC} $*" >&2; }

# 1. Install npm dependencies if needed
if [[ ! -d "$ROOT/node_modules/better-sqlite3" ]]; then
  log_info "Installing dependencies..."
  if npm install --production --prefix "$ROOT" 2>&1; then
    log_ok "Dependencies installed"
  else
    log_err "npm install failed"
    exit 1
  fi
else
  log_ok "Dependencies up to date"
fi

# 2. Ensure data directory exists
mkdir -p "$DATA_DIR/runtime"
log_ok "Data directory: $DATA_DIR"

# 3. Migrate from old ~/.claude-mem/ if needed
OLD_DIR="$HOME/.claude-mem"
if [[ -f "$OLD_DIR/claude-mem.db" && ! -f "$DATA_DIR/claude-mem.db" ]]; then
  log_info "Migrating data from ~/.claude-mem/ → ~/claude-mem-lite/..."
  cp "$OLD_DIR/claude-mem.db" "$DATA_DIR/claude-mem.db" 2>/dev/null || true
  cp "$OLD_DIR/claude-mem.db-wal" "$DATA_DIR/claude-mem.db-wal" 2>/dev/null || true
  cp "$OLD_DIR/claude-mem.db-shm" "$DATA_DIR/claude-mem.db-shm" 2>/dev/null || true
  if [[ -d "$OLD_DIR/runtime" && ! -d "$DATA_DIR/runtime" ]]; then
    cp -r "$OLD_DIR/runtime" "$DATA_DIR/runtime" 2>/dev/null || true
  fi
  log_ok "Data migrated (old ~/.claude-mem/ preserved)"
fi

log_ok "claude-mem-lite ready"
exit 0
