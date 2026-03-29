#!/usr/bin/env node
const CLI_COMMANDS = new Set(['search', 'recent', 'recall', 'get', 'timeline', 'save', 'stats', 'context', 'browse', 'delete', 'update', 'export', 'compress', 'maintain', 'fts-check', 'registry', 'import', 'enrich', 'help']);
const INSTALL_COMMANDS = new Set(['install', 'uninstall', 'status', 'doctor', 'cleanup', 'cleanup-hooks', 'self-update', 'release']);

const cmd = process.argv[2];

if (cmd === '--version' || cmd === '-v') {
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
  process.stdout.write(`claude-mem-lite v${pkg.version}\n`);
} else if (cmd === '--help' || cmd === '-h') {
  const { run } = await import('./mem-cli.mjs');
  await run(['help']);
} else if (CLI_COMMANDS.has(cmd)) {
  const { run } = await import('./mem-cli.mjs');
  await run(process.argv.slice(2));
} else if (!cmd) {
  // No command: show CLI help if installed, install help if not
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const dbPath = join(process.env.HOME || '', '.claude-mem-lite', 'claude-mem-lite.db');
  if (existsSync(dbPath)) {
    const { run } = await import('./mem-cli.mjs');
    await run(['help']);
  } else {
    const { main } = await import('./install.mjs');
    await main([]);
  }
} else if (INSTALL_COMMANDS.has(cmd)) {
  const { main } = await import('./install.mjs');
  await main(process.argv.slice(2));
} else {
  process.stderr.write(`[mem] Unknown command: "${cmd}"\n`);
  // Suggest closest command by edit distance
  const allCmds = [...CLI_COMMANDS, ...INSTALL_COMMANDS];
  let best = null, bestDist = Infinity;
  for (const c of allCmds) {
    const a = cmd.toLowerCase(), b = c;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) continue;
    const d = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] !== b[j-1] ? 1 : 0));
    if (d[m][n] < bestDist) { bestDist = d[m][n]; best = c; }
  }
  if (best && bestDist <= 2) {
    process.stderr.write(`[mem] Did you mean: ${best}?\n`);
  } else {
    process.stderr.write('[mem] Run "claude-mem-lite help" for CLI commands or "claude-mem-lite install" for setup\n');
  }
  process.exitCode = 1;
}
