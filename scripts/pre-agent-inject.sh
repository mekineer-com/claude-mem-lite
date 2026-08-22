#!/usr/bin/env bash
# claude-mem-lite: Fast bash pre-filter for the PreToolUse:Agent|Task hook.
#
# Subagent dispatch-time injection is DEFAULT OFF (CLAUDE_MEM_SUBAGENT_INJECT=on|1),
# and pre-agent-inject.js's off path is already the cheapest thing a Node script can
# do — it reads one env var and returns. The cost that remained was Node itself:
# every Agent/Task dispatch paid a full interpreter start for a feature that was
# switched off. Measured on this machine, 20 dispatches each, flag unset: **22.6ms**
# through `node scripts/hook-launcher.mjs scripts/pre-agent-inject.js` vs **2.4ms**
# here. With the flag ON the prefilter costs 1.8ms on top of the 44.9ms the feature
# already spends (46.7ms) — the trade is a rounding error against a real saving.
#
# Measure with the flag EXPLICITLY unset (`env -u CLAUDE_MEM_SUBAGENT_INJECT …`). A
# maintainer shell that dogfoods the feature exports it, and the first pass at these
# numbers timed the ON path twice and called it the off-path cost.
#
# Audit 2026-08-22 P2-5 asked for "don't register the hook when the flag is off".
# A plugin manifest is static JSON — Claude Code reads hooks/hooks.json once and
# nothing in it can consult an env var — so conditional registration would mean
# deleting the entry and making opt-in require re-running the installer. This gets
# the same saving with the opt-in path intact, and mirrors scripts/post-tool-use.sh,
# the prefilter already doing this for PostToolUse.
#
# Fail-open, like every hook here: never exit non-zero, never block a dispatch.

# ON: hand off untouched. exec BEFORE reading anything — pre-agent-inject.js echoes
# the whole subagent prompt back via updatedInput, so stdin must reach it verbatim.
# hook-launcher.mjs sits next to this file in every install shape (plugin cache,
# managed copy, dev symlink), which is also how it locates its own install dir.
case "${CLAUDE_MEM_SUBAGENT_INJECT:-}" in
  on|1)
    _mem_dir=$(dirname "${BASH_SOURCE[0]}")
    exec node "${_mem_dir}/hook-launcher.mjs" scripts/pre-agent-inject.js
    ;;
esac

# OFF: drain stdin before exiting. The Node path did not read it either, so this is
# no worse than today and strictly safer — the host writes the event payload before
# waiting on us, and a >64KB prompt would otherwise leave that write against a pipe
# whose reader vanished. Builtin loop, no subprocess: `head -c` costs ~1ms more than
# the entire rest of this script.
while IFS= read -r _; do :; done
exit 0
