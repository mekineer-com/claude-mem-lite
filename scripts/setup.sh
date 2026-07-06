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
# shellcheck disable=SC2317  # kept for API symmetry with log_ok/log_info/log_warn
log_err()  { echo -e "${RED}✗${NC} $*" >&2; }

# 1. Migrate unhidden dir (~/claude-mem-lite/ → ~/.claude-mem-lite/)
if [[ -d "$OLD_UNHIDDEN_DIR" && ! -d "$DATA_DIR" ]]; then
  mv "$OLD_UNHIDDEN_DIR" "$DATA_DIR"
  log_ok "Migrated ~/claude-mem-lite/ → ~/.claude-mem-lite/"
fi

# 2. Ensure data directory exists (runtime created after migration check)
mkdir -p "$DATA_DIR"
log_ok "Data directory: $DATA_DIR"

# 3. Legacy ~/.claude-mem/ DB is schema-v16 (no memory_session_id) with no migration bridge to
#    the current schema — activating it FATALs on first launch ("no such column: memory_session_id")
#    and the "! -f claude-mem-lite.db" guard would re-copy it every time the user deletes the broken
#    DB (recovery loop). Mirror install.mjs migrateLegacyClaudeMemData: back it up (don't activate)
#    and let a fresh DB be created. Source ~/.claude-mem/ is left intact.
OLD_DIR="$HOME/.claude-mem"
if [[ -f "$OLD_DIR/claude-mem.db" && ! -f "$DATA_DIR/claude-mem-lite.db" && ! -f "$DATA_DIR/claude-mem.db" ]]; then
  BACKUP="$DATA_DIR/claude-mem-lite.db.legacy-backup-$(date +%s)"
  if cp "$OLD_DIR/claude-mem.db" "$BACKUP" 2>/dev/null; then
    log_info "Legacy ~/.claude-mem/ DB is schema-incompatible; backed up to $(basename "$BACKUP") (a fresh DB will be created). Old ~/.claude-mem/ preserved."
  else
    log_warn "Legacy DB backup failed — a fresh database will be created"
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
#
# Visibility contract: `npm install` failure here used to be a stderr-only log_warn,
# invisible to the Claude session unless the operator was watching the terminal.
# When it fails (no toolchain, blocked network, read-only FS) every hook silently
# degrades — pre-tool-recall, post-tool-use, session-start all import better-sqlite3
# and exit on the require() error. v2.79: write a JSON flag to runtime/.deps-broken
# and hook.mjs SessionStart surfaces it in the Claude context as a HIGH-VISIBILITY
# block; success branches remove the flag so a self-heal stays visible too.
DEPS_FLAG="$DATA_DIR/runtime/.deps-broken"
mkdir -p "$DATA_DIR/runtime" 2>/dev/null || true

mark_deps_broken() {
  local reason="$1"
  # Embed reason + repair command so hook.mjs renders a complete error without
  # having to re-derive them. Delegate JSON serialization to node so embedded
  # quotes / shell metachars in $ROOT or $reason can't produce an invalid file
  # (bash `printf '"..%s.."'` cannot escape arbitrary strings safely; v2.79.1 fix).
  # shellcheck disable=SC2016  # node script single-quoted on purpose; vars passed via env (MARK_*), not shell expansion
  MARK_REASON="$reason" MARK_ROOT="$ROOT" MARK_FLAG="$DEPS_FLAG" node -e '
    const fs = require("fs");
    const reason = process.env.MARK_REASON || "unknown";
    const root = process.env.MARK_ROOT || "";
    fs.writeFileSync(process.env.MARK_FLAG, JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      root,
      repair: `cd ${JSON.stringify(root)} && npm install --omit=dev`,
    }) + "\n");
  ' 2>/dev/null || true
}

mark_deps_ok() {
  rm -f "$DEPS_FLAG" 2>/dev/null || true
}

if [[ ! -d "$ROOT/node_modules/better-sqlite3" ]]; then
  # Fast path: symlink from data dir (instant, no network needed)
  if [[ -d "$DATA_DIR/node_modules/better-sqlite3" ]]; then
    if ln -sfn "$DATA_DIR/node_modules" "$ROOT/node_modules" 2>/dev/null; then
      log_ok "Dependencies linked from $DATA_DIR"
      mark_deps_ok
    fi
  fi
  # Slow path: npm install (first-time only, ~10-20s for native addon)
  if [[ ! -d "$ROOT/node_modules/better-sqlite3" ]]; then
    log_info "Installing dependencies (first-time setup)..."
    if (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund 2>&1) >&2; then
      log_ok "Dependencies installed"
      mark_deps_ok
    else
      log_warn "Dependency install failed — hooks may have limited functionality (flag: $DEPS_FLAG)"
      mark_deps_broken "npm install --omit=dev failed in plugin cache root"
    fi
  fi
else
  # Deps already present — make sure we don't keep stale broken flag around
  mark_deps_ok
fi

# 7. MCP cleanup: one-shot purge of stale global MCP registrations.
#    - Pre-2.10: direct installs left a global "mem" MCP alongside plugin MCP.
#    - Pre-2.78: plugin and global registrations used the generic name "mem";
#      v2.78 renamed to "mem-lite" — any stale global "mem" must be purged so
#      Claude Code doesn't surface duplicate (old "mem" + new "mem-lite") tool
#      prefixes side-by-side.
#    Root .mcp.json in the installed plugin cache is required for Claude Code to
#    register plugin MCP; only stale global/marketplace copies are removed.
#    v2.79.1: marker file now actually gates entry (was touched but never read
#    pre-v2.79.1 — extra node spawn + JSON parse on every SessionStart for a
#    near-always no-op). Bump MCP_MIGRATION name to re-run cleanup in future
#    versions; same shape as the .deps-broken self-heal pattern.
MCP_MIGRATION="$DATA_DIR/runtime/.mcp-dedup-v2.78"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && ! -f "$MCP_MIGRATION" ]]; then
  # shellcheck disable=SC2016  # node script single-quoted on purpose; CLAUDE_JSON passed via env, not shell expansion
  CLAUDE_JSON="$HOME/.claude.json" node -e '
    const fs = require("fs");
    let changed = false;
    // Remove stale global MCP registrations (plugin .mcp.json handles it).
    // Both "mem" (legacy, pre-v2.78) and "mem-lite" (current) are purged from
    // user-global scope when running inside the plugin — the plugin manifest
    // is the single source of truth.
    try {
      const p = process.env.CLAUDE_JSON;
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const k of ["mem", "mem-lite"]) {
        if (d.mcpServers?.[k]) {
          delete d.mcpServers[k];
          process.stderr.write(`✓ Removed stale global MCP "${k}" (plugin handles it)\n`);
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
    } catch {}
    // NOTE: Do NOT touch marketplace .mcp.json — Claude Code copies it from
    // marketplace → plugin cache on updates. Clearing it causes the cache
    // .mcp.json to lose the MCP server definition, breaking plugin MCP.
    if (!changed) process.stderr.write("✓ MCP migration: already clean\n");
  ' || true
  touch "$MCP_MIGRATION"
fi

# 8. Prune old plugin cache versions (keep latest 3)
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  CACHE_DIR="$HOME/.claude/plugins/cache/sdsrss/claude-mem-lite"
  if [[ -d "$CACHE_DIR" ]]; then
    # List version dirs sorted by semver descending, skip top 3
    # Use glob + while-read for bash 3.2 (macOS) compatibility (no mapfile, no `ls | grep`)
    OLD_VERS=()
    shopt -s nullglob
    _all_dirs=("$CACHE_DIR"/[0-9]*)
    shopt -u nullglob
    while IFS= read -r ver; do
      [[ -n "$ver" ]] && OLD_VERS+=("$ver")
    done < <(for _d in "${_all_dirs[@]}"; do [[ -d "$_d" ]] && echo "${_d##*/}"; done | sort -t. -k1,1nr -k2,2nr -k3,3nr | tail -n +4)
    unset _all_dirs _d
    if [[ ${#OLD_VERS[@]} -gt 0 ]]; then
      for ver in "${OLD_VERS[@]}"; do
        rm -rf "${CACHE_DIR:?}/$ver" 2>/dev/null || true
      done
      log_ok "Plugin cache pruned: removed ${#OLD_VERS[@]} old version(s)"
    fi
  fi
fi

# 9. Residue detection (plugin mode only): warn once if legacy direct-install
#    hooks remain in ~/.claude/settings.json. A user who installed via global
#    `claude-mem-lite install` and later switched to the marketplace plugin
#    will run every hook twice (direct settings.json hooks AND plugin hooks)
#    until they run `claude-mem-lite uninstall` to clear the settings.json
#    entries. /plugin uninstall does not touch settings.json.
RESIDUE_MARKER="$DATA_DIR/runtime/.residue-warned-v2.55"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && ! -f "$RESIDUE_MARKER" ]]; then
  SETTINGS="$HOME/.claude/settings.json"
  if [[ -f "$SETTINGS" ]]; then
    SETTINGS_PATH="$SETTINGS" node -e '
      const fs = require("fs");
      try {
        const raw = fs.readFileSync(process.env.SETTINGS_PATH, "utf8");
        const data = JSON.parse(raw);
        const hooks = data.hooks || {};
        const events = Object.keys(hooks);
        const found = [];
        for (const ev of events) {
          const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
          for (const entry of list) {
            const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
            for (const h of inner) {
              const cmd = String(h?.command || "");
              if (cmd.includes(".claude-mem-lite/") || cmd.includes("claude-mem-lite/scripts") || cmd.includes("claude-mem-lite/hook.mjs")) {
                found.push(ev);
                break;
              }
            }
          }
        }
        if (found.length) {
          process.stderr.write("\n");
          process.stderr.write("\x1b[33m⚠\x1b[0m Legacy direct-install hooks detected in " + process.env.SETTINGS_PATH + "\n");
          process.stderr.write("  Events with stale entries: " + [...new Set(found)].join(", ") + "\n");
          process.stderr.write("  These will fire alongside plugin hooks (each tool call runs twice).\n");
          process.stderr.write("  Fix: run \x1b[1mclaude-mem-lite uninstall\x1b[0m to clear settings.json,\n");
          process.stderr.write("       then keep using the plugin install. (One-time warning.)\n\n");
          process.exit(2);
        }
      } catch {}
    ' || true
  fi
  # Mark the warning as shown regardless of result — silence is fine if no
  # residue, and the warning above is one-shot per data-dir.
  touch "$RESIDUE_MARKER"
fi

log_ok "claude-mem-lite ready"
exit 0
