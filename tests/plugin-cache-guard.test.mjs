import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  scanPluginCacheHookPollution,
  clearPluginCacheHooks,
  hasInstallManagedHooks,
} from '../plugin-cache-guard.mjs';

function makeHome() {
  const dir = join(tmpdir(), `mem-cache-guard-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCacheHooks(home, version, hooksBody) {
  const dir = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', version, 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify(hooksBody, null, 2));
  return join(dir, 'hooks.json');
}

describe('plugin-cache-guard', () => {
  describe('scanPluginCacheHookPollution', () => {
    it('returns empty when cache base does not exist', () => {
      const home = makeHome();
      try {
        expect(scanPluginCacheHookPollution({ home })).toEqual([]);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('detects populated hooks.json across multiple versions', () => {
      const home = makeHome();
      try {
        writeCacheHooks(home, '2.28.0', { hooks: { SessionStart: [{ matcher: '*', hooks: [] }] } });
        writeCacheHooks(home, '2.30.0', { hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [] }] } });
        writeCacheHooks(home, '2.31.0', { hooks: {} });  // cleared — should not appear
        expect(scanPluginCacheHookPollution({ home })).toEqual(['2.28.0', '2.30.0']);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('ignores malformed hooks.json', () => {
      const home = makeHome();
      try {
        const dir = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '2.28.0', 'hooks');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'hooks.json'), 'not-json');
        expect(scanPluginCacheHookPollution({ home })).toEqual([]);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('clearPluginCacheHooks', () => {
    it('clears populated hooks.json and writes _note marker', () => {
      const home = makeHome();
      try {
        const path = writeCacheHooks(home, '2.28.0', {
          description: 'old',
          hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [] }] },
        });
        const cleared = clearPluginCacheHooks({ home, reason: 'test-reason' });
        expect(cleared).toEqual(['2.28.0']);
        const after = JSON.parse(readFileSync(path, 'utf8'));
        expect(after.hooks).toEqual({});
        expect(after._note).toContain('test-reason');
        expect(after._note).toContain('2.28.0');
        expect(after.description).toBe('old');
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('leaves already-cleared hooks.json untouched', () => {
      const home = makeHome();
      try {
        const path = writeCacheHooks(home, '2.28.0', { description: 'd', hooks: {} });
        const before = readFileSync(path, 'utf8');
        const cleared = clearPluginCacheHooks({ home });
        expect(cleared).toEqual([]);
        expect(readFileSync(path, 'utf8')).toBe(before);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  describe('hasInstallManagedHooks', () => {
    it('returns false when settings.json missing', () => {
      const home = makeHome();
      try {
        expect(hasInstallManagedHooks({ home })).toBe(false);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('returns true when settings.json hooks reference claude-mem-lite path', () => {
      const home = makeHome();
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
          hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${home}/.claude-mem-lite/hook.mjs" session-start` }] }] },
        }));
        expect(hasInstallManagedHooks({ home })).toBe(true);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });

    it('returns false when settings.json has unrelated hooks only', () => {
      const home = makeHome();
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
          hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /tmp/other-tool/hook.mjs' }] }] },
        }));
        expect(hasInstallManagedHooks({ home })).toBe(false);
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });
});
