'use strict';
// Verifies an update before anything can replace the app (LC-16 "Verification",
// docs/desktop-data-and-updates.md). Squirrel.Mac checks only that the new bundle satisfies the
// running app's designated requirement; everything else is checked here, in this order, and the
// first failure stops the update:
//
//   1. the feed names a release version strictly newer than this app;
//   2. the release's SHA256SUMS carries a valid signature by the pinned organization key;
//   3. the feed itself is listed in SHA256SUMS with its own digest, so its version, file name and
//      held-for-migration mark are all covered by that signature;
//   4. the zip the feed names is this product's file of that same release, its digest in the feed
//      equals SHA256SUMS, and the downloaded bytes have that digest and size;
//   5. the unpacked app is signed with a Developer ID of the pinned team, its version is the one
//      announced and its bundle identifier is this app's.
//
// Only then is Squirrel.Mac handed a local feed that points at the already-verified zip.
const path = require('node:path');
// Sentences a person may read in Check for Updates…: English, collected for translation (L10N-04).
const { msg } = require('./i18n.cjs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const pgp = require('./pgp-verify.cjs');

const TEAM = 'KJ35UYYL22';
/** A Developer ID application certificate of the pinned team, never "whoever signed this copy". */
const requirementFor = (team) => `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
const VERSION = /^\d+\.\d+\.\d+$/;

/** A failure with the LC-16 event code it is logged under and a short reason code. */
class UpdateError extends Error {
  constructor(code, reason, message) { super(message || reason); this.code = code; this.reason = reason; }
}
const fail = (code, reason, message) => { throw new UpdateError(code, reason, message); };

function compareVersions(a, b) {
  const parse = (v) => (VERSION.test(String(v)) ? String(v).split('.').map(Number) : null);
  const x = parse(a); const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * deps: { repository, appVersion, appName ('Fabric Inbox'), zipName(version), runningApp (the
 *   .app path), dir (a cache folder this updater owns), fetch, exec(file, args) → { stdout },
 *   fs (node:fs/promises), createWriteStream, key (armored), fingerprint, team, log }
 */
function createVerifier(deps) {
  const { repository, appVersion, appName, zipName, runningApp, dir, fetch, exec, fs, createWriteStream,
    key, fingerprint = pgp.RELEASE_KEY_FINGERPRINT, team = TEAM, log = () => {} } = deps;
  const releaseBase = (version) => `https://github.com/${repository}/releases/download/v${version}/`;

  async function bytes(url, code, reason) {
    let response;
    try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) }); }
    catch (error) { fail(code, reason, String(error && error.message || error)); }
    if (!response.ok) fail(code, reason, `HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Step 1: what the feed offers. Returns { outcome: 'current' | 'older' | 'newer', ... }. */
  function readFeed(feedBytes) {
    let feed;
    try { feed = JSON.parse(feedBytes.toString('utf8')); } catch { fail('check_failed', 'feed_invalid', msg('The update feed is not JSON.')); }
    const version = feed && feed.currentRelease;
    if (typeof version !== 'string' || !VERSION.test(version)) fail('check_failed', 'feed_invalid', msg('The update feed names no release version.'));
    const order = compareVersions(version, appVersion);
    if (order <= 0) return { outcome: order < 0 ? 'older' : 'current', version };
    const release = Array.isArray(feed.releases) ? feed.releases.find((r) => r && r.version === version) : null;
    const update = release && release.updateTo;
    if (!update || update.version !== version) fail('check_failed', 'feed_invalid', 'The update feed does not describe its own release.');
    const expected = `${releaseBase(version)}${encodeURIComponent(zipName(version))}`;
    if (update.url !== expected) fail('signature_failed', 'feed_foreign_file', msg('The update feed names a file that is not this release\'s.'));
    if (!/^[0-9a-f]{64}$/.test(update.sha256 || '') || !Number.isInteger(update.size) || update.size <= 0) {
      fail('check_failed', 'feed_invalid', 'The update feed has no sha256 or size for its file.');
    }
    const migration = update.migration || release.migration || null;
    return { outcome: 'newer', version, update, migration: migration ? { runbook: typeof migration.runbook === 'string' ? migration.runbook : '' } : null };
  }

  /** Steps 2–3: the signed sums of the announced release, and the feed listed in them. */
  async function signedSums(version, feedBytes, update) {
    const base = releaseBase(version);
    const [sums, signature] = await Promise.all([bytes(`${base}SHA256SUMS`, 'check_failed', 'sums_unreachable'), bytes(`${base}SHA256SUMS.asc`, 'check_failed', 'sums_unreachable')]);
    try { pgp.verifyDetached({ data: sums, signature: signature.toString('utf8'), key, fingerprint }); }
    catch (error) { fail('signature_failed', 'sums_signature', error.message); }
    let table;
    try { table = pgp.parseSums(sums.toString('utf8')); } catch (error) { fail('signature_failed', 'sums_invalid', error.message); }
    const feedDigest = crypto.createHash('sha256').update(feedBytes).digest('hex');
    if (table.get('update-mac.json') !== feedDigest) fail('signature_failed', 'feed_not_signed', msg('The update feed is not the one this release signed.'));
    if (table.get(zipName(version)) !== update.sha256) fail('signature_failed', 'zip_not_signed', msg('The update\'s digest is not the one this release signed.'));
  }

  /** Step 4: the zip, streamed to disk and hashed on the way. */
  async function download(version, update) {
    const folder = path.join(dir, version);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, zipName(version));
    log({ event: 'update_download', outcome: 'started', version });
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      const response = await fetch(update.url, { redirect: 'follow', signal: AbortSignal.timeout(60 * 60 * 1000) });
      if (!response.ok || !response.body) fail('download_failed', 'zip_unreachable', `HTTP ${response.status}`);
      const counter = new (require('node:stream').Transform)({
        transform(chunk, _enc, done) {
          size += chunk.length;
          if (size > update.size) { done(new UpdateError('signature_failed', 'zip_size', msg('The update is larger than its release says.'))); return; }
          hash.update(chunk); done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(file, { mode: 0o600 }));
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      fail('download_failed', 'zip_unreachable', String(error && error.message || error));
    }
    if (size !== update.size) fail('signature_failed', 'zip_size', msg('The update\'s size is not the one its release says.'));
    if (hash.digest('hex') !== update.sha256) fail('signature_failed', 'zip_sha256', msg('The update\'s bytes are not the ones its release signed.'));
    log({ event: 'update_download', outcome: 'done', version });
    return { folder, file };
  }

  async function plist(appPath, field) {
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', field, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]);
    return String(stdout).trim();
  }

  /** Step 5: the app inside, unpacked to a scratch folder that is removed again. */
  async function inspect(version, folder, file) {
    const unpacked = path.join(folder, 'unpacked');
    try { await exec('/usr/bin/ditto', ['-x', '-k', file, unpacked]); }
    catch (error) { fail('signature_failed', 'unpack', String(error && error.message || error)); }
    const app = path.join(unpacked, `${appName}.app`);
    try {
      try { await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', `--test-requirement=${requirementFor(team)}`, app]); }
      catch { fail('signature_failed', 'codesign', `The update is not signed by the organization's Developer ID (${team}).`); }
      let announced; let id; let ownId;
      try { [announced, id, ownId] = await Promise.all([plist(app, 'CFBundleShortVersionString'), plist(app, 'CFBundleIdentifier'), plist(runningApp, 'CFBundleIdentifier')]); }
      catch (error) { fail('signature_failed', 'bundle_unreadable', String(error && error.message || error)); }
      if (announced !== version) fail('signature_failed', 'version_mismatch', msg('The update\'s version is not the one its release announced.'));
      if (!id || id !== ownId) fail('signature_failed', 'bundle_id', msg('The update is another app.'));
    } finally {
      await fs.rm(unpacked, { recursive: true, force: true });
    }
  }

  /**
   * The whole check. Resolves { outcome: 'current' | 'older', version } when nothing is offered,
   * { outcome: 'skipped', version } when `shouldDownload(version)` says not now (a held or refused
 * version), or { outcome: 'verified', version, localFeed, migration } once the zip passed every step;
   * `onDownload(version, held)` is called when the download begins. Throws UpdateError otherwise.
   */
  async function verify(feedBytes, { onDownload = () => {}, shouldDownload = () => true } = {}) {
    const offer = readFeed(feedBytes);
    if (offer.outcome !== 'newer') return offer;
    if (!shouldDownload(offer.version)) return { outcome: 'skipped', version: offer.version };
    await signedSums(offer.version, feedBytes, offer.update);
    onDownload(offer.version, !!offer.migration);
    const { folder, file } = await download(offer.version, offer.update);
    await inspect(offer.version, folder, file);
    const localFeed = path.join(folder, 'feed.json');
    const { version, update } = offer;
    await fs.writeFile(localFeed, JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: {
      version, name: version, notes: typeof update.notes === 'string' ? update.notes : '', pub_date: update.pub_date, url: pathToFileURL(file).href,
    } }] }) + '\n', { mode: 0o600 });
    return { outcome: 'verified', version, localFeed: pathToFileURL(localFeed).href, migration: offer.migration };
  }

  /** Removes what a verification left (after Squirrel.Mac copied the zip, or after a failure). */
  async function clean() { await fs.rm(dir, { recursive: true, force: true }); }

  /**
   * The release gate's check before anything is signed (scripts/check-update-release.mjs
   * --before-signing): the feed names this release's own zip, the built zip has the feed's digest
   * and size, and the app inside is the pinned team's, of that version. The app never calls this:
   * an installed copy always requires the signed SHA256SUMS (`verify`).
   */
  async function checkBuilt(feedBytes, zipPath) {
    const offer = readFeed(feedBytes);
    if (offer.outcome !== 'newer') fail('check_failed', 'feed_invalid', `The feed announces ${offer.version}, not a newer release.`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const { createReadStream } = require('node:fs');
    for await (const chunk of createReadStream(zipPath)) { size += chunk.length; hash.update(chunk); }
    if (size !== offer.update.size) fail('signature_failed', 'zip_size', 'The built zip\'s size is not the one its feed says.');
    if (hash.digest('hex') !== offer.update.sha256) fail('signature_failed', 'zip_sha256', 'The built zip is not the one its feed names.');
    const folder = path.join(dir, offer.version);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    try { await inspect(offer.version, folder, zipPath); } finally { await clean(); }
    return { version: offer.version, held: !!offer.migration };
  }

  return { verify, clean, checkBuilt };
}

module.exports = { createVerifier, UpdateError, compareVersions, requirementFor, TEAM };
