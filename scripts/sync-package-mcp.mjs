import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function syncPackageMcp(root = process.cwd()) {
  const src = resolve(root, 'claude-plugin/.mcp.json');
  const dest = resolve(root, '.mcp.json');
  if (!existsSync(src)) throw new Error(`Missing source MCP manifest: ${src}`);
  writeFileSync(dest, readFileSync(src, 'utf8'));
}

export function cleanupPackageMcp(root = process.cwd()) {
  const dest = resolve(root, '.mcp.json');
  if (existsSync(dest)) rmSync(dest, { force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] ?? 'write';
  if (command === 'write') syncPackageMcp();
  else if (command === 'cleanup') cleanupPackageMcp();
  else throw new Error(`Unknown command: ${command}`);
}