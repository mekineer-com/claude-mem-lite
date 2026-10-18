# claude-mem-lite Fork

Read [CLAUDE.md](CLAUDE.md) for the shared repository rules, commands and
measurement constraints, regardless of agent family. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before changing the package. Do not duplicate
those instructions here or reorganize inherited upstream documentation.

OpenAlma uses curated MCP-only memory, not an automatic session diary. Save
non-obvious decisions, their reasons, hidden traps and short pointers to the
authoritative files. Routine progress belongs in task records. Forgetting routine
activity protects context and retrieval quality; zero data loss is not the goal.

Preserve ignored `.data/` and independent client MCP registrations during source
upgrades. README.md and [mcp-only-settings.example.md](mcp-only-settings.example.md)
contain the user-facing setup; disabling Claude's plugin does not disable Codex's
registration. Capture-skip settings are not equivalent to disabling capture.
