#!/usr/bin/env node
// scripts/sign-release.mjs — CI release signer (P1 supply-chain hardening).
//
// Builds release-manifest.json (sha256 of every SOURCE_FILES entry at this
// checkout) and signs the exact serialized bytes with an Ed25519 private key,
// producing release-manifest.json.sig (base64). publish.yml uploads both as
// GitHub Release assets; hook-update.mjs verifies them against the embedded
// public key before installing an auto-update. Shared core: lib/release-digest.mjs.
//
// Reads the PRIVATE key from env RELEASE_SIGNING_KEY (PKCS8 PEM — a GitHub
// Actions secret). If the secret is absent it EXITS 0 WITHOUT writing assets, so
// the release pipeline keeps working before the key is provisioned (the client
// side is opportunistic and installs unsigned releases unchanged).
//
// Dev/CI-only: NOT listed in package.json "files", so it never ships in the
// tarball. Run by the `publish` job in .github/workflows/publish.yml.

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_FILES } from '../source-files.mjs';
import { buildReleaseManifest, serializeManifest } from '../lib/release-digest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => process.stdout.write(`[sign-release] ${m}\n`);

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const keyPem = process.env.RELEASE_SIGNING_KEY;
if (!keyPem || !keyPem.trim()) {
  log('RELEASE_SIGNING_KEY not set — skipping signing.');
  log('Release ships unsigned; clients install it opportunistically (no verification).');
  process.exit(0);
}

let privateKey;
try {
  privateKey = createPrivateKey(keyPem);
} catch (e) {
  process.stderr.write(`[sign-release] FAIL: RELEASE_SIGNING_KEY is not a valid PEM private key: ${e.message}\n`);
  process.exit(1);
}

const manifest = buildReleaseManifest(ROOT, SOURCE_FILES, version);
const bytes = serializeManifest(manifest);
writeFileSync(join(ROOT, 'release-manifest.json'), bytes);

const sig = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');
writeFileSync(join(ROOT, 'release-manifest.json.sig'), sig + '\n');

log(`signed ${Object.keys(manifest.files).length} files for v${version}`);
log('wrote release-manifest.json + release-manifest.json.sig');
