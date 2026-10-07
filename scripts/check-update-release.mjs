#!/usr/bin/env node
// The release gate's update check (LC-16, docs/release.md): runs the app's own verification
// (desktop/update-verify.cjs) on a signed release set — the files release-publish signed, or a
// published release downloaded with `gh release download` — so a feed that names a file of another
// release, a digest the signature does not cover, or a zip whose app is not the pinned team's or
// not the announced version fails the release instead of every installed copy.
//
//   node scripts/check-update-release.mjs --dir <folder with update-mac.json, SHA256SUMS, SHA256SUMS.asc, the -mac.zip> --version 0.12.0
//   node scripts/check-update-release.mjs --before-signing --dir release --version 0.12.0
//
// --before-signing runs in the release workflow before `publish`, on the built files (no
// SHA256SUMS exists yet): everything but the signature, so a bad feed or zip stops the release
// before it is published. The full check runs again on the signed set after `publish`.
//
// Runs on macOS (ditto, codesign, plutil). Exits 0 only when the update would be installed.
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createVerifier } = require('../desktop/update-verify.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = 'ai.passioncode.fabric-inbox';

const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve({ stdout }))));

/** Serves the release's files from `dir` at the addresses the app would fetch them from. */
export function localFetch(dir, repository, version) {
  const base = `https://github.com/${repository}/releases/download/v${version}/`;
  return async (url) => {
    const name = url.startsWith(base) ? decodeURIComponent(url.slice(base.length)) : '';
    const file = path.join(dir, name);
    if (!name || name.includes('/') || !existsSync(file)) return new Response(`not in the release set: ${url}`, { status: 404 });
    return new Response(readFileSync(file));
  };
}

/** A stand-in for the installed app: only its bundle identifier is read. */
function stubApp(scratch, bundleId) {
  const app = path.join(scratch, 'Installed.app');
  mkdirSync(path.join(app, 'Contents'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>
`);
  return app;
}

/** The app's verification of this release set, as a copy one version older would run it. */
export async function checkRelease({ dir, version, repository = 'passioncode-ai/fabric-inbox', exec = run, key, fingerprint, bundleId = BUNDLE_ID, beforeSigning = false }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('--version is a release version like 1.2.3.');
  const feed = readFileSync(path.join(dir, 'update-mac.json'));
  let announced = '';
  try { announced = JSON.parse(feed.toString('utf8')).currentRelease; } catch { /* the verifier names it */ }
  if (announced && announced !== version) throw new Error(`The feed announces ${announced}, not ${version}.`);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'fabric-update-check-'));
  try {
    const verifier = createVerifier({
      repository, appVersion: '0.0.0', appName: 'Fabric Inbox', zipName: (v) => `Fabric-Inbox-${v}-mac.zip`,
      runningApp: stubApp(scratch, bundleId), dir: path.join(scratch, 'updates'), fetch: localFetch(dir, repository, version),
      exec, fs, createWriteStream, key: key ?? readFileSync(path.join(root, 'desktop', 'release-key.asc'), 'utf8'), ...(fingerprint ? { fingerprint } : {}),
    });
    if (beforeSigning) return await verifier.checkBuilt(feed, path.join(dir, `Fabric-Inbox-${version}-mac.zip`));
    const out = await verifier.verify(feed);
    if (out.outcome !== 'verified' || out.version !== version) throw new Error(`The feed announces ${out.version}, not ${version}.`);
    return { version: out.version, held: !!out.migration };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const beforeSigning = process.argv.includes('--before-signing');
    const out = await checkRelease({ dir: path.resolve(arg('dir') || '.'), version: arg('version') || '', repository: arg('repository') || undefined, beforeSigning });
    console.log(beforeSigning
      ? `update ${out.version}: the built feed names its own zip, the zip has its digest and size, and the app inside is the pinned team's, of this version${out.held ? '; held for a migration' : ''}`
      : `update ${out.version}: verified as an installed copy would (signed SHA256SUMS, feed, zip digest and size, Developer ID team, version)${out.held ? '; held for a migration' : ''}`);
  } catch (error) {
    console.error(`update check failed: ${error.code ? `${error.code}/${error.reason}: ` : ''}${error.message}`);
    process.exit(1);
  }
}
