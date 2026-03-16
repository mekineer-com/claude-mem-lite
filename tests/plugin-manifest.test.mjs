import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('plugin manifests', () => {
  it('declares plugin-mode MCP launcher in claude-plugin/.mcp.json', () => {
    const manifest = readJson('claude-plugin/.mcp.json');
    expect(manifest.mcpServers).toBeTruthy();
    expect(manifest.mcpServers.mem).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs'],
    });
  });

  it('keeps MCP manifest under claude-plugin/ and not at repo root or .claude-plugin/', () => {
    expect(existsSync('claude-plugin/.mcp.json')).toBe(true);
    expect(existsSync('.claude-plugin/.mcp.json')).toBe(false);
    expect(existsSync('.mcp.json')).toBe(false);

    const pkg = readJson('package.json');
    expect(pkg.files).toContain('claude-plugin/.mcp.json');
    expect(pkg.files).not.toContain('.claude-plugin/.mcp.json');
    expect(pkg.files).not.toContain('.mcp.json');
  });

  it('keeps package, plugin, and marketplace versions in sync for releases', () => {
    const pkg = readJson('package.json');
    const plugin = readJson('.claude-plugin/plugin.json');
    const marketplace = readJson('.claude-plugin/marketplace.json');

    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.plugins?.[0]?.version).toBe(pkg.version);
  });

  it('declares plugin-mode session hooks in hooks/hooks.json', () => {
    const hooks = readJson('hooks/hooks.json');
    const sessionHooks = hooks.hooks?.SessionStart?.[0]?.hooks ?? [];
    expect(sessionHooks.map(h => h.command)).toContain('bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"');
    expect(sessionHooks.map(h => h.command)).toContain('node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" session-start');
  });
});

