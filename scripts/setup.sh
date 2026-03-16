#!/usr/bin/env bash
#
# claude-mem-lite SessionStart pre-hook
# Data directory setup, migrations, and dependency resolution
#

set -euo pipefail

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(dirname "$SCRIPT_DIR")"
else
  ROOT="$CLAUDE_PLUGIN_ROOT"
fi

DATA_DIR="$HOME/.claude-mem-lite"
OLD_UNHIDDEN_DIR="$HOME/claude-mem-lite"

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

# 1. Migrate unhidden dir (~/claude-mem-lite/ → ~/.claude-mem-lite/)
if [[ -d "$OLD_UNHIDDEN_DIR" && ! -d "$DATA_DIR" ]]; then
  mv "$OLD_UNHIDDEN_DIR" "$DATA_DIR"
  log_ok "Migrated ~/claude-mem-lite/ → ~/.claude-mem-lite/"
fi

# 2. Ensure data directory exists (runtime created after migration check)
mkdir -p "$DATA_DIR"
log_ok "Data directory: $DATA_DIR"

# 3. Migrate from old ~/.claude-mem/ if needed
OLD_DIR="$HOME/.claude-mem"
if [[ -f "$OLD_DIR/claude-mem.db" && ! -f "$DATA_DIR/claude-mem-lite.db" && ! -f "$DATA_DIR/claude-mem.db" ]]; then
  log_info "Migrating data from ~/.claude-mem/ → ~/.claude-mem-lite/..."
  if cp "$OLD_DIR/claude-mem.db" "$DATA_DIR/claude-mem-lite.db" 2>/dev/null; then
    # Main DB copied successfully, WAL/SHM are optional
    cp "$OLD_DIR/claude-mem.db-wal" "$DATA_DIR/claude-mem-lite.db-wal" 2>/dev/null || true
    cp "$OLD_DIR/claude-mem.db-shm" "$DATA_DIR/claude-mem-lite.db-shm" 2>/dev/null || true
    if [[ -d "$OLD_DIR/runtime" && ! -d "$DATA_DIR/runtime" ]]; then
      cp -r "$OLD_DIR/runtime" "$DATA_DIR/runtime" 2>/dev/null || true
    fi
    log_ok "Data migrated (old ~/.claude-mem/ preserved)"
  else
    log_warn "Migration failed — using fresh database"
  fi
fi

# 4. Rename claude-mem.db → claude-mem-lite.db in same directory
if [[ -f "$DATA_DIR/claude-mem.db" && ! -f "$DATA_DIR/claude-mem-lite.db" ]]; then
  mv "$DATA_DIR/claude-mem.db" "$DATA_DIR/claude-mem-lite.db"
  mv "$DATA_DIR/claude-mem.db-wal" "$DATA_DIR/claude-mem-lite.db-wal" 2>/dev/null || true
  mv "$DATA_DIR/claude-mem.db-shm" "$DATA_DIR/claude-mem-lite.db-shm" 2>/dev/null || true
  log_ok "Database renamed: claude-mem.db → claude-mem-lite.db"
fi

# 5. Ensure runtime directory exists (after migration to not mask migration check)
mkdir -p "$DATA_DIR/runtime"

# 6. Ensure native dependencies available for hooks (ESM import needs node_modules in resolution chain)
#    Plugin cache doesn't include node_modules — symlink from data dir or npm install on first run
if [[ ! -d "$ROOT/node_modules/better-sqlite3" ]]; then
  # Fast path: symlink from data dir (instant, no network needed)
  if [[ -d "$DATA_DIR/node_modules/better-sqlite3" ]]; then
    ln -sfn "$DATA_DIR/node_modules" "$ROOT/node_modules" 2>/dev/null && \
      log_ok "Dependencies linked from $DATA_DIR" || true
  fi
  # Slow path: npm install (first-time only, ~10-20s for native addon)
  if [[ ! -d "$ROOT/node_modules/better-sqlite3" ]]; then
    log_info "Installing dependencies (first-time setup)..."
    if (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund 2>&1) >&2; then
      log_ok "Dependencies installed"
    else
      log_warn "Dependency install failed — hooks may have limited functionality"
    fi
  fi
fi

# 7. MCP cleanup: idempotently clean stale registrations from pre-2.10 direct installs.
#    This runs on every plugin SessionStart because old global mem entries may still
#    exist even after an earlier migration marker was written.
#    Before 2.10: old direct installs left a global mem MCP alongside plugin MCP.
#    - Global mcpServers.mem in ~/.claude.json (from old install.mjs)
#    - Possibly stale marketplace root .mcp.json (from old git clone)
#    Root .mcp.json in the installed plugin cache is required for Claude Code to
#    register plugin MCP; only stale global/marketplace copies should be removed.
MCP_MIGRATION="$DATA_DIR/runtime/.mcp-dedup-v2.10.4"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  CLAUDE_JSON="$HOME/.claude.json" ROOT="$ROOT" node -e '
    const fs = require("fs");
    let changed = false;
    // 1. Remove stale global MCP registration
    try {
      const p = process.env.CLAUDE_JSON;
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      if (d.mcpServers?.mem) {
        delete d.mcpServers.mem;
        fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
        process.stderr.write("✓ Removed stale global MCP \"mem\" (plugin handles it)\n");
        changed = true;
      }
    } catch {}
    // 2. Remove stale marketplace root .mcp.json
    try {
      const root = process.env.ROOT;
      if (root.includes("/plugins/cache/")) {
        const key = root.split("/plugins/cache/")[1].split("/")[0];
        const mktMcp = require("path").join(require("os").homedir(), ".claude/plugins/marketplaces", key, ".mcp.json");
        if (fs.existsSync(mktMcp)) {
          const m = JSON.parse(fs.readFileSync(mktMcp, "utf8"));
          if (m.mcpServers?.mem) {
            delete m.mcpServers.mem;
            fs.writeFileSync(mktMcp, JSON.stringify(m, null, 2) + "\n");
            process.stderr.write("✓ Cleared stale marketplace root .mcp.json\n");
            changed = true;
          }
        }
      }
    } catch {}
    if (!changed) process.stderr.write("✓ MCP migration: already clean\n");
  ' 2>&2 || true
  touch "$MCP_MIGRATION"
fi

log_ok "claude-mem-lite ready"
exit 0
