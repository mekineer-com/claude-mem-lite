// Which user-scope MCP registrations are this plugin's own. A leaf (no imports), shared by
// install.mjs (install / uninstall) and hook-update.mjs (the post-update migration), so the
// two cannot disagree; scripts/setup.sh carries the pattern inline
// (tests/mcp-legacy-name-ownership.test.mjs pins the parity).
//
// `mem` is the pre-v2.78 name of our server — and a generic one: the MCP reference memory
// server is commonly registered under it. Every remover used to drop a user-scope `mem` without
// looking at what it ran, so a user's own `mem` server vanished. A registration under that name
// is ours only when it runs our server; `mem-lite` always is.

export const OUR_MCP_SERVER_RE = /claude-mem-lite[\w.-]*[\\/]+(?:scripts[\\/]+launch|server)\.mjs/;

/**
 * @param {string} name registration name
 * @param {unknown} entry its `{command, args}` entry
 * @returns {boolean}
 */
export function isOurMcpRegistration(name, entry) {
  if (name === 'mem-lite') return true;
  if (!entry || typeof entry !== 'object') return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return OUR_MCP_SERVER_RE.test([entry.command, ...args].join(' '));
}
