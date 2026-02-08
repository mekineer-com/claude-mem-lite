#!/usr/bin/env bash
# claude-mem-lite: Fast bash pre-filter for PostToolUse hook
# Skips known low-value tools in ~5ms instead of launching Node (~80-150ms)
# SYNC: Skip list must match hook.mjs SKIP_TOOLS + prefix filters

# Prevent recursive hooks
[[ -n "$CLAUDE_MEM_HOOK_RUNNING" ]] && exit 0

# Read stdin (tool hook JSON)
input=$(cat)

# Extract tool_name via bash regex — no subprocess
if [[ "$input" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  tool="${BASH_REMATCH[1]}"
else
  exit 0
fi

# SYNC: Must match SKIP_TOOLS set and prefix filters in hook.mjs
case "$tool" in
  # Exact matches (SKIP_TOOLS set)
  Read|Glob|TodoRead|TodoWrite|TaskList|TaskGet|TaskCreate|TaskUpdate|\
  AskUserQuestion|EnterPlanMode|ExitPlanMode|\
  mcp__claude-in-chrome__screenshot|mcp__claude-in-chrome__read_page|\
  mcp__claude-in-chrome__tabs_context_mcp|mcp__claude-in-chrome__computer|\
  mcp__claude-in-chrome__find|mcp__claude-in-chrome__navigate)
    exit 0
    ;;
  # Prefix filters
  mem_*|mcp__mem__*|mcp__sequential*|mcp__plugin_context7*)
    exit 0
    ;;
esac

# Tool not skipped — hand off to Node for full processing
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s' "$input" | node "${SCRIPT_DIR}/hook.mjs" post-tool-use
