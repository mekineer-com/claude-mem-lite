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
    _base="${_dir##*/}"
    _parent="${_dir%/*}"; _parent="${_parent##*/}"
    if [[ -n "$_parent" && "$_parent" != "." && "$_parent" != "/" ]]; then
      project="${_parent}--${_base}"
    else
      project="${_base}"
    fi
    # Sanitize project name to match utils.mjs inferProject()
    project="${project//[^a-zA-Z0-9_.-]/-}"
    project="${project:-unknown}"
    runtime_dir="$HOME/.claude-mem-lite/runtime"
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

# Tool not skipped — hand off to Node for full processing
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
printf '%s' "$input" | node "${SCRIPT_DIR}/hook.mjs" post-tool-use
