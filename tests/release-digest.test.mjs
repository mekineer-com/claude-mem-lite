// Tests for lib/release-digest.mjs — the shared release-signing core used by
// scripts/sign-release.mjs (CI, signs) and hook-update.mjs (client, verifies).
//
// Security properties asserted:
//   1. A valid Ed25519 signature over the manifest bytes verifies true.
//   2. A tampered manifest byte stream fails signature verification.
//   3. A wrong/foreign public key fails verification.
//   4. File-hash verification flags any extracted file whose bytes differ from
//      the signed manifest, and any manifest-listed file missing on disk.
//   5. A clean round-trip (build → serialize → sign → verify files + sig) passes.

import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sha256Hex,
  sha256File,
  buildReleaseManifest,
  serializeManifest,
  verifyReleaseFiles,
  verifyManifestSignature,
} from '../lib/release-digest.mjs';

const dirs = [];
function makeReleaseTree() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-reldigest-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\n// cli\n');
  writeFileSync(join(dir, 'server.mjs'), '// server\n');
  writeFileSync(join(dir, 'lib', 'x.mjs'), '// x\n');
  return dir;
}
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('lib/release-digest', () => {
  const FILES = ['cli.mjs', 'server.mjs', 'lib/x.mjs'];

  it('sha256Hex / sha256File agree and are stable', () => {
    const dir = makeReleaseTree();
    expect(sha256File(join(dir, 'cli.mjs'))).toBe(sha256Hex('#!/usr/bin/env node\n// cli\n'));
  });

  it('buildReleaseManifest lists only existing files with their sha256, sorted', () => {
    const dir = makeReleaseTree();
    const m = buildReleaseManifest(dir, [...FILES, 'does-not-exist.mjs'], '3.7.1');
    expect(m.name).toBe('claude-mem-lite');
    expect(m.version).toBe('3.7.1');
    expect(m.algo).toBe('sha256');
    expect(Object.keys(m.files)).toEqual(['cli.mjs', 'lib/x.mjs', 'server.mjs']); // sorted, missing dropped
    expect(m.files['cli.mjs']).toBe(sha256File(join(dir, 'cli.mjs')));
  });

  it('clean round-trip: build → serialize → sign → verify (files + signature)', () => {
    const dir = makeReleaseTree();
    const { privateKey, publicKeyPem } = keypair();
    const manifest = buildReleaseManifest(dir, FILES, '3.7.1');
    const bytes = serializeManifest(manifest);
    const sigB64 = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');

    expect(verifyManifestSignature(bytes, sigB64, publicKeyPem)).toBe(true);
    expect(verifyReleaseFiles(dir, JSON.parse(bytes))).toEqual({ ok: true, mismatches: [], missing: [] });
  });

  it('rejects a tampered manifest byte stream (signature no longer matches)', () => {
    const dir = makeReleaseTree();
    const { privateKey, publicKeyPem } = keypair();
    const bytes = serializeManifest(buildReleaseManifest(dir, FILES, '3.7.1'));
    const sigB64 = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');
    const tampered = bytes.replace('3.7.1', '9.9.9');
    expect(verifyManifestSignature(tampered, sigB64, publicKeyPem)).toBe(false);
  });

  it('rejects a foreign public key', () => {
    const dir = makeReleaseTree();
    const { privateKey } = keypair();
    const { publicKeyPem: otherPub } = keypair();
    const bytes = serializeManifest(buildReleaseManifest(dir, FILES, '3.7.1'));
    const sigB64 = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');
    expect(verifyManifestSignature(bytes, sigB64, otherPub)).toBe(false);
  });

  it('verifyManifestSignature returns false on empty key/sig instead of throwing', () => {
    expect(verifyManifestSignature('x', 'y', '')).toBe(false);
    expect(verifyManifestSignature('x', '', 'PEM')).toBe(false);
  });

  it('verifyReleaseFiles flags a content mismatch', () => {
    const dir = makeReleaseTree();
    const manifest = buildReleaseManifest(dir, FILES, '3.7.1');
    writeFileSync(join(dir, 'server.mjs'), '// TAMPERED\n');
    const r = verifyReleaseFiles(dir, manifest);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain('server.mjs');
  });

  it('verifyReleaseFiles flags a manifest-listed file missing on disk', () => {
    const dir = makeReleaseTree();
    const manifest = buildReleaseManifest(dir, FILES, '3.7.1');
    rmSync(join(dir, 'lib', 'x.mjs'), { force: true });
    const r = verifyReleaseFiles(dir, manifest);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('lib/x.mjs');
  });
});
