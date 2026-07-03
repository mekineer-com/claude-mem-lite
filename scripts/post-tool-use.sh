#!/usr/bin/env bash
# claude-mem-lite: Fast bash pre-filter for PostToolUse hook
# Skips known low-value tools in ~5ms instead of launching Node (~80-150ms)
# SYNC: Skip list must match skip-tools.mjs (source of truth)
# Consistency enforced by tests/skip-tools.test.mjs

# Prevent recursive hooks
[[ -n "$CLAUDE_MEM_HOOK_RUNNING" ]] && exit 0

# Read stdin (tool hook JSON)
input=$(head -c 262144)

# Extract tool_name via bash regex — no subprocess
if [[ "$input" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  tool="${BASH_REMATCH[1]}"
else
  exit 0
fi

# Read tool: track file path for episode context, then exit (no Node needed)
if [[ "$tool" == "Read" ]]; then
  if [[ "$input" =~ \"file_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    file_path="${BASH_REMATCH[1]}"
    _dir="${CLAUDE_PROJECT_DIR:-$PWD}"
    # Strip trailing slashes so ${_dir##*/} / ${_dir%/*} match Node's path.basename /
    # path.dirname in inferProject(). Without this, CLAUDE_PROJECT_DIR="/org/proj/"
    # gave bash "proj--" (empty base) while JS gave "org--proj" — a name mismatch that
    # made flushEpisode read a DIFFERENT reads-<project>.txt, silently dropping this
    # session's Read context AND orphaning the bash-named file (nothing ever collects it).
    while [[ "$_dir" == */ && ${#_dir} -gt 1 ]]; do _dir="${_dir%/}"; done
    _base="${_dir##*/}"
    _parent="${_dir%/*}"; _parent="${_parent##*/}"
    if [[ -n "$_parent" && "$_parent" != "." && "$_parent" != "/" ]]; then
      project="${_parent}--${_base}"
    else
      project="${_base}"
    fi
    # Sanitize + truncate to 100 to match utils.mjs inferProject() EXACTLY
    # (raw.replace(/[^a-zA-Z0-9_.-]/g,'-').slice(0,100)). A >100-char parent--base
    # otherwise diverges from the JS side (same reads-file mismatch as above).
    project="${project//[^a-zA-Z0-9_.-]/-}"
    project="${project:0:100}"
    project="${project:-unknown}"
    # Honor CLAUDE_MEM_DIR relocation (mirrors schema.mjs DB_DIR → hook-shared RUNTIME_DIR).
    # hook.mjs flushEpisode reads reads-<project>.txt from CLAUDE_MEM_DIR/runtime; if this
    # bash fast-path wrote to $HOME unconditionally, a relocated install would drop all
    # Read context from episodes AND grow an uncollected reads file in $HOME forever.
    runtime_dir="${CLAUDE_MEM_DIR:-$HOME/.claude-mem-lite}/runtime"
    mkdir -p "$runtime_dir" 2>/dev/null
    # Use printf to avoid shell interpretation of special characters in file paths
    printf '%s\n' "$file_path" >> "${runtime_dir}/reads-${project}.txt"
  fi
  exit 0
fi

# SYNC: Must match SKIP_TOOLS and SKIP_PREFIXES in skip-tools.mjs
case "$tool" in
  # Exact matches (SKIP_TOOLS set — Read handled above)
  Glob|TodoRead|TodoWrite|TaskList|TaskGet|TaskCreate|TaskUpdate|\
  AskUserQuestion|EnterPlanMode|ExitPlanMode|\
  mcp__claude-in-chrome__screenshot|mcp__claude-in-chrome__read_page|\
  mcp__claude-in-chrome__tabs_context_mcp|mcp__claude-in-chrome__computer|\
  mcp__claude-in-chrome__find|mcp__claude-in-chrome__navigate)
    exit 0
    ;;
  # Prefix filters
  mem_*|mcp__mem__*|mcp__mem-lite__*|mcp__plugin_claude-mem-lite*|mcp__sequential*|mcp__plugin_context7*)
    exit 0
    ;;
esac

# Tool not skipped — hand off to Node for full processing.
# Routed through hook-launcher.mjs (self-heal on ERR_MODULE_NOT_FOUND).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
printf '%s' "$input" | node "${SCRIPT_DIR}/scripts/hook-launcher.mjs" hook.mjs post-tool-use
