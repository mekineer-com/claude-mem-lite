import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('plugin manifests', () => {
  it('declares plugin-mode MCP launcher in .mcp.json', () => {
    const manifest = readJson('.mcp.json');
    expect(manifest.mcpServers).toBeTruthy();
    expect(manifest.mcpServers.mem).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs'],
    });
  });

  it('declares plugin-mode session hooks in hooks/hooks.json', () => {
    const hooks = readJson('hooks/hooks.json');
    const sessionHooks = hooks.hooks?.SessionStart?.[0]?.hooks ?? [];
    expect(sessionHooks.map(h => h.command)).toContain('bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"');
    expect(sessionHooks.map(h => h.command)).toContain('node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" session-start');
  });
});

