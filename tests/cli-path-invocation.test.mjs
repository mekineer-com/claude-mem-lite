// Regression lock for the v3.1.1 path-resolution fix (code review 2026-06-20,
// findings #1/#2/#3/#13). The bundled CLI must be advertised by an absolute,
// import.meta.url-resolved path that exists on EVERY install shape — NOT the
// pre-v3.1.1 `~/.claude-mem-lite/cli.mjs`, which is absent on a plugin-only
// install (setup.sh provisions the data dir but never materializes source).
//
// Two correct strategies, asserted separately:
//   • JS-emitted/runtime-resolved surfaces  → absolute CLI_INVOKE (this file)
//   • plugin MANIFEST files (commands/*.md)  → literal ${CLAUDE_PLUGIN_ROOT}

import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { CLI_PATH, CLI_INVOKE } from '../cli-path.mjs';
import { tools } from '../tool-schemas.mjs';
import { buildServerInstructions } from '../search-scoring.mjs';
import { getDetailDoc } from '../adopt-content.mjs';

const ROOT = dirname(fileURLToPath(new URL('../cli-path.mjs', import.meta.url)));
const BROKEN = '~/.claude-mem-lite/cli.mjs';

describe('cli-path single source of truth', () => {
  test('CLI_PATH resolves to the real bundled cli.mjs on this install shape', () => {
    expect(CLI_PATH.endsWith('cli.mjs')).toBe(true);
    expect(CLI_PATH.startsWith('/')).toBe(true);      // absolute, never a tilde
    expect(CLI_PATH).not.toContain('~');
    expect(existsSync(CLI_PATH)).toBe(true);          // the whole point: it exists
    expect(CLI_INVOKE).toBe(`node ${CLI_PATH}`);
  });
});

describe('LLM-visible CLI hints advertise the resolvable path, not the tilde path', () => {
  test('tool-schemas per-tool "Equivalent CLI" hints', () => {
    const withHint = tools.filter((t) => /Equivalent CLI: node /.test(t.description || ''));
    expect(withHint.length).toBeGreaterThan(10);      // ~18 tools carry a CLI hint
    for (const t of tools) {
      expect(t.description || '').not.toContain(BROKEN);
    }
    expect(tools.some((t) => (t.description || '').includes(CLI_PATH))).toBe(true);
  });

  test('MCP server instructions (highest-authority Claude-facing surface)', () => {
    for (const instr of [buildServerInstructions(false), buildServerInstructions(true)]) {
      expect(instr).not.toContain(BROKEN);
      expect(instr).toContain(CLI_PATH);
      // the copyable examples must NOT be the bare `claude-mem-lite <cmd>` form
      expect(instr).not.toMatch(/\n {2}claude-mem-lite (search|recall|recent|get|timeline) /);
    }
  });

  test('adopt detail doc (persisted verbatim into the user MEMORY.md)', () => {
    const doc = getDetailDoc();
    expect(doc).not.toContain(BROKEN);
    expect(doc).toContain(CLI_PATH);
  });
});

describe('runtime recovery hints resolve `repair` by absolute path', () => {
  // #3: hook-launcher + native-binding-hint advised bare `claude-mem-lite repair`,
  // which is not on PATH for a plugin-only install. They must now emit an
  // absolute `node <cli.mjs> repair`.
  test('no bare `claude-mem-lite repair` survives in the recovery hints', () => {
    for (const rel of ['scripts/hook-launcher.mjs', 'lib/native-binding-hint.mjs']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still emits bare 'claude-mem-lite repair'`).not.toContain('claude-mem-lite repair');
      expect(src).toContain('cli.mjs') ;
    }
  });
});

describe('source + manifest guards', () => {
  test('no JS-emitted surface still hardcodes the tilde path', () => {
    for (const rel of ['tool-schemas.mjs', 'adopt-content.mjs', 'search-scoring.mjs',
                       'lib/native-binding-hint.mjs', 'scripts/hook-launcher.mjs']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still contains the broken tilde path`).not.toContain(BROKEN);
    }
  });

  test('slash-command manifests use ${CLAUDE_PLUGIN_ROOT}, not the tilde path', () => {
    for (const rel of ['commands/adopt.md', 'commands/unadopt.md', 'commands/mem.md',
                       'commands/bug.md', 'commands/lesson.md']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still contains the broken tilde path`).not.toContain(BROKEN);
      expect(src).toContain('${CLAUDE_PLUGIN_ROOT}/cli.mjs');
    }
  });

  test('cli-path.mjs is registered for shipping (SOURCE_FILES + package.json files)', () => {
    const srcFiles = readFileSync(join(ROOT, 'source-files.mjs'), 'utf8');
    expect(srcFiles).toContain("'cli-path.mjs'");
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('cli-path.mjs');
  });
});
