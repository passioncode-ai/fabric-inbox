// The Mac App Store leg of the CI release (.github/workflows/release.yml, docs/release.md →
// "Mac App Store"). Run by the workflow, never by hand for a release:
//
//   node scripts/app-store-connect.mjs build-number <tag>       the CFBundleVersion a release tag gets
//   node scripts/app-store-connect.mjs check-record [--warn-only] is there an App Store Connect app record?
//   node scripts/app-store-connect.mjs upload <pkg>             upload a store-signed .pkg (CI only)
//
// The API key comes from the environment (ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8_B64: the
// `release` environment's secrets) and never from an argument. For the upload, altool reads the
// key from ~/.appstoreconnect/private_keys/AuthKey_<id>.p8, so the file is written (0600) for the
// one call and removed after it, also when the upload fails. No value is printed.
//
// The app record cannot be created through the App Store Connect API; a person creates it once
// in App Store Connect. Until then the upload stops before altool with a message that says so.
import { spawnSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_ID = 'ai.passioncode.fabric-inbox';
const API = 'https://api.appstoreconnect.apple.com';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireThat(condition, message) { if (!condition) throw new Error(message); }

/**
 * The CFBundleVersion a release tag gets. App Store Connect refuses a build number it has seen,
 * and a Mac build number must grow, so it is derived from the tag and only grows:
 * vM.m.p → (M·100+m).p.99, and vM.m.p-rc.N → (M·100+m).p.N. An rc sorts below its release
 * and every release below the next version's rc. Re-running a tag gives the same number, which
 * Apple refuses as a second upload: a published release is never rebuilt; a fix is a new tag.
 */
export function buildNumberForTag(tag, version) {
  const name = String(tag).replace(/^refs\/tags\//, '');
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(name);
  requireThat(m, `${name} is not a release tag (vX.Y.Z or vX.Y.Z-rc.N).`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  requireThat(`${major}.${minor}.${patch}` === version, `The tag ${name} does not match the version ${version} that desktop/package.json carries.`);
  requireThat(m[4] === undefined || (Number(m[4]) >= 1 && Number(m[4]) <= 98), 'A store build needs an rc number from 1 to 98.');
  requireThat(minor <= 99 && patch <= 99, 'A store build number holds minor and patch up to 99.');
  requireThat(major <= 99, 'A store build number holds a major up to 99.');
  requireThat(major * 100 + minor > 0, 'Version 0.0.x has no store build number (its first part would be 0).');
  return `${major * 100 + minor}.${patch}.${m[4] === undefined ? 99 : Number(m[4])}`;
}

/** The App Store Connect API key from the environment, checked by shape. Values never enter a message. */
export function readCredentials(env) {
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_API_KEY_P8_B64']) {
    requireThat(typeof env[name] === 'string' && env[name].trim() !== '', `${name} is empty; is the release environment's secret set?`);
  }
  const keyId = env.ASC_KEY_ID.trim();
  const issuer = env.ASC_ISSUER_ID.trim();
  requireThat(/^[A-Z0-9]{10}$/.test(keyId), 'ASC_KEY_ID is not a key id (ten capital letters and digits).');
  requireThat(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuer), 'ASC_ISSUER_ID is not an issuer id (a UUID).');
  return { keyId, issuer, p8: env.ASC_API_KEY_P8_B64.trim() };
}

/** An ES256 token for the App Store Connect API, valid for ten minutes (Apple allows twenty). */
export function ascToken({ keyId, issuer, p8 }, now = Math.floor(Date.now() / 1000)) {
  let key;
  try { key = createPrivateKey({ key: Buffer.from(p8, 'base64'), format: 'pem' }); } catch { key = null; }
  requireThat(key && key.asymmetricKeyType === 'ec', 'ASC_API_KEY_P8_B64 is not a .p8 private key (base64 of the AuthKey file).');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  // JWS wants the raw 64-byte r||s signature, not Node's default DER.
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** The app whose bundle id is exactly ours in a GET /v1/apps answer, or null. */
export function findAppRecord(json, bundleId) {
  requireThat(json && Array.isArray(json.data), 'App Store Connect answered with no data.');
  const app = json.data.find((a) => a?.attributes?.bundleId === bundleId);
  return app ? { id: app.id, name: app.attributes.name, bundleId } : null;
}

/**
 * GET /v1/apps?filter[bundleId]=… with the token. A refused key (401/403) or another client error
 * fails at once; a network failure, 429 or 5xx is tried three times before it is reported.
 */
export async function lookupAppRecord({ token, bundleId, fetchImpl = fetch, attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = `${API}/v1/apps?${new URLSearchParams({ 'filter[bundleId]': bundleId, 'fields[apps]': 'bundleId,name' })}`;
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (error) { last = `network: ${error.message}`; }
    if (response) {
      if (response.ok) return findAppRecord(await response.json(), bundleId);
      let title = '';
      try { title = (await response.json())?.errors?.[0]?.title ?? ''; } catch { title = ''; }
      if (response.status === 401 || response.status === 403) throw new Error(`App Store Connect refused the API key (${response.status}: ${title || 'no detail'}). Check ASC_KEY_ID, ASC_ISSUER_ID and ASC_API_KEY_P8_B64 in the release environment.`);
      if (response.status !== 429 && response.status < 500) throw new Error(`App Store Connect answered ${response.status}: ${title || 'no detail'}.`);
      last = `HTTP ${response.status}`;
    }
    if (attempt < attempts) await sleep(2000 * attempt);
  }
  throw new Error(`App Store Connect could not be reached after ${attempts} attempts (last: ${last}).`);
}

/** altool's arguments for a macOS package upload. The key is found by its id; it is never an argument. */
export function altoolUploadArgs(pkg, keyId, issuer) {
  requireThat(pkg.endsWith('.pkg'), 'The Mac App Store takes a .pkg made by desktop/mas-package.mjs.');
  return ['altool', '--upload-app', '-f', pkg, '-t', 'macos', '--apiKey', keyId, '--apiIssuer', issuer, '--output-format', 'json'];
}

/** Where altool looks for the key (one of its documented places). */
export function keyFilePath(home, keyId) {
  return path.join(home, '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`);
}

export function missingRecordMessage(bundleId) {
  return `No App Store Connect app record for ${bundleId}, and the API cannot create one. A person with the `
    + `Account Holder, Admin or App Manager role creates it once: App Store Connect → Apps → + → New App, platform macOS, `
    + `bundle id ${bundleId}. Then run the release again (docs/release.md → Mac App Store). Nothing was uploaded.`;
}

/**
 * Uploads a store-signed package: the app record must exist, the key file is written for the call
 * and removed after it (with the directories made for it), and a non-zero altool is a failure.
 */
export async function uploadPackage({ pkg, credentials, home = os.homedir(), findRecord, runAltool }) {
  requireThat(existsSync(pkg), `No package at ${pkg}.`);
  const args = altoolUploadArgs(pkg, credentials.keyId, credentials.issuer);
  const app = await findRecord(credentials);
  requireThat(app, missingRecordMessage(BUNDLE_ID));
  const keyFile = keyFilePath(home, credentials.keyId);
  requireThat(!existsSync(keyFile), `${path.dirname(keyFile)} already holds AuthKey_${credentials.keyId}.p8; it is not this job's to replace or remove.`);
  const made = [];
  for (const dir of [path.join(home, '.appstoreconnect'), path.dirname(keyFile)]) {
    if (!existsSync(dir)) { mkdirSync(dir, { mode: 0o700 }); made.unshift(dir); }
  }
  try {
    writeFileSync(keyFile, Buffer.from(credentials.p8, 'base64'), { mode: 0o600, flag: 'wx' });
    const result = await runAltool(args);
    requireThat(result.status === 0, `altool exited ${result.status}: ${String(result.output).trim().slice(-4000)}`);
    return { app, output: result.output };
  } finally {
    rmSync(keyFile, { force: true });
    for (const dir of made) { try { rmdirSync(dir); } catch { /* not empty: something else lives there now */ } }
  }
}

function runXcrun(args) {
  const r = spawnSync('xcrun', args, { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, timeout: 60 * 60 * 1000 });
  if (r.error) throw r.error;
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function recordFor(credentials) {
  return lookupAppRecord({ token: ascToken(credentials), bundleId: BUNDLE_ID });
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'build-number') {
    requireThat(rest.length === 1, 'Give the tag: build-number <tag>.');
    const version = JSON.parse(readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8')).version;
    console.log(buildNumberForTag(rest[0], version));
    return;
  }
  if (command === 'check-record') {
    const warnOnly = rest.includes('--warn-only');
    requireThat(rest.every((a) => a === '--warn-only'), 'check-record takes only --warn-only.');
    try {
      const app = await recordFor(readCredentials(process.env));
      requireThat(app, missingRecordMessage(BUNDLE_ID));
      console.log(`::notice::App Store Connect app record ${app.id} (${app.name}) holds ${BUNDLE_ID}.`);
    } catch (error) {
      if (!warnOnly) throw error;
      console.log(`::warning::${error.message.replace(' Nothing was uploaded.', '')} (A rehearsal uploads nothing, so it goes on.)`);
    }
    return;
  }
  if (command === 'upload') {
    requireThat(rest.length === 1, 'Give the package: upload <pkg>.');
    requireThat(process.env.GITHUB_ACTIONS === 'true', 'The store upload runs only in the release workflow; a package built anywhere else is a debug build and is never uploaded.');
    const credentials = readCredentials(process.env);
    const { app, output } = await uploadPackage({ pkg: path.resolve(rest[0]), credentials, findRecord: recordFor, runAltool: runXcrun });
    console.log(String(output).trim());
    console.log(`::notice::Uploaded to App Store Connect app ${app.id} (${BUNDLE_ID}); Apple processes it before it appears under TestFlight.`);
    return;
  }
  throw new Error('Use build-number <tag>, check-record [--warn-only] or upload <pkg>.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
