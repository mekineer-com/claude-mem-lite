# MCP-Only User Settings Example

Sanitized mem-lite settings from the OpenAlma installation. These are fragments,
not replacements for entire client settings files. Replace
`/path/to/claude-mem-lite` with the checkout's absolute path; every client must
use the same data directory. No credentials or personal paths are included.

## Claude: `~/.claude/settings.json`

Disable the plugin's automatic capture and recall; keep auto-adoption disabled.

```json
{
  "enabledPlugins": {
    "claude-mem-lite@sdsrss": false
  },
  "env": {
    "CLAUDE_MEM_DIR": "/path/to/claude-mem-lite/.data",
    "MEM_NO_AUTO_ADOPT": "1"
  }
}
```

## Claude: `~/.claude.json`

Keep explicit memory tools through the independent user-scope MCP registration.
The native `claude mcp add` command in the README writes this entry.

```json
{
  "mcpServers": {
    "mem-lite": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/claude-mem-lite/scripts/launch.mjs"],
      "env": {
        "CLAUDE_MEM_DIR": "/path/to/claude-mem-lite/.data"
      }
    }
  }
}
```

## Codex: `~/.codex/config.toml`

This existing standalone registration is unchanged. Search telemetry records
search queries/results for retrieval analysis; it is not session capture.

```toml
[mcp_servers.mem-lite]
startup_timeout_sec = 20
command = "node"
args = ["/path/to/claude-mem-lite/scripts/launch.mjs"]
env = { "CLAUDE_MEM_DIR" = "/path/to/claude-mem-lite/.data", "CLAUDE_MEM_SEARCH_TELEMETRY" = "1" }
```

The private database and backups are not settings examples and remain outside Git.
