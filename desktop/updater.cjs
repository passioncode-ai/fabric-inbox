'use strict';
// Automatic updates of the Mac app (docs/desktop-data-and-updates.md). On by default: a released
// disk image checks the latest GitHub release's `update-mac.json`, downloads the signed,
// notarized `.zip` it names in the background, and Squirrel.Mac installs it the next time the app
// quits (or at once, when the person chooses Restart). Squirrel.Mac refuses an update that is not
// signed by the same Developer ID team as the running app, and the feed's sha256 and size are
// checked before anything is unpacked.
//
// Only an app the release workflow built carries a feed (desktop/updates.json, written by
// dist-mac.mjs in CI): source builds, forks without their own release, debug builds and the Mac
// App Store package (the store updates it) never check. An app run from outside /Applications
// (a disk image, Downloads under App Translocation) cannot replace itself, so it does not check
// and says so.
//
// Lifecycle (LC-08): no timer. A check runs at launch and when a window comes forward, at most
// every six hours; with no window open nothing is checked.
const path = require('node:path');

const CHECK_EVERY_MS = 6 * 3600 * 1000;
const FEED = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/latest\/download\/update-mac\.json$/;

/** The feed a release build carries, or null. */
function readFeed(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value.feed === 'string' && FEED.test(value.feed)) return value.feed;
  } catch { /* no feed: no updates */ }
  return null;
}

/**
 * The feed file for a release (`update-mac.json`, Squirrel.Mac's static `serverType: 'json'`
 * format): only the release itself, with the sha256 and size Squirrel.Mac checks before unpacking.
 */
function feedFor({ repository, version, zipName, sha256, size, notes = '', pubDate }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('A repository is owner/name.');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only a release version (X.Y.Z) is offered as an update.');
  if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isInteger(size) || size <= 0) throw new Error('The update needs its sha256 and size.');
  const url = `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(zipName)}`;
  return { currentRelease: version, releases: [{ version, updateTo: { version, name: version, notes, pub_date: pubDate, url, sha256, size } }] };
}

const feedURL = (repository) => `https://github.com/${repository}/releases/latest/download/update-mac.json`;

/**
 * The updater. `autoUpdater` is Electron's; every other dependency is passed in so tests drive it
 * with a fake. States: off | unavailable | idle | checking | downloading | ready | error.
 */
function createUpdater(deps) {
  const { autoUpdater, fs, userData, feed, now = Date.now, log = () => {}, onChange = () => {} } = deps;
  const settingsFile = path.join(userData, 'updates.json');
  let automatic = true;
  let state = 'off';
  let reason = '';
  let lastCheck = 0;
  let readyVersion = '';
  let lastError = '';
  let manual = null;      // resolves a person's "Check for Updates…" with what happened
  let wired = false;

  const set = (next) => { state = next; onChange(status()); };
  function status() { return { state, reason, automatic, readyVersion, error: lastError }; }

  async function loadSettings() {
    try {
      const value = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      if (value && value.automatic === false) automatic = false;
    } catch { /* first run: automatic */ }
  }
  async function saveSettings() {
    await fs.mkdir(userData, { recursive: true, mode: 0o700 });
    await fs.writeFile(`${settingsFile}.tmp`, JSON.stringify({ automatic }) + '\n', { mode: 0o600 });
    await fs.rename(`${settingsFile}.tmp`, settingsFile);
  }
  function settle(outcome) { if (manual) { const done = manual; manual = null; done(outcome); } }

  function wire() {
    if (wired) return;
    wired = true;
    autoUpdater.on('checking-for-update', () => set('checking'));
    autoUpdater.on('update-available', () => { log({ event: 'update', outcome: 'downloading' }); set('downloading'); settle({ outcome: 'downloading' }); });
    autoUpdater.on('update-not-available', () => { log({ event: 'update', outcome: 'current' }); set('idle'); settle({ outcome: 'current' }); });
    autoUpdater.on('update-downloaded', (_event, _notes, name) => {
      readyVersion = typeof name === 'string' ? name : '';
      log({ event: 'update', outcome: 'ready', version: readyVersion });
      set('ready');
      settle({ outcome: 'ready', version: readyVersion });
    });
    autoUpdater.on('error', (error) => {
      lastError = String(error && error.message || error).slice(0, 300);
      log({ event: 'update', outcome: 'failed', reason: lastError });
      set('error');
      settle({ outcome: 'failed', error: lastError });
    });
  }

  function check() {
    if (!['idle', 'error'].includes(state)) return false;
    lastCheck = now();
    try { autoUpdater.checkForUpdates(); return true; }
    catch (error) {
      lastError = String(error && error.message || error).slice(0, 300);
      log({ event: 'update', outcome: 'failed', reason: lastError });
      set('error');
      return false;
    }
  }

  return {
    status,

    /** At launch: decide whether this app can update itself, then check if automatic. */
    async start({ packaged, mas, inApplications }) {
      await loadSettings();
      if (!feed || !packaged || mas) { reason = !feed ? 'no_feed' : mas ? 'app_store' : 'development'; set('off'); return; }
      if (!inApplications) { reason = 'not_in_applications'; log({ event: 'update', outcome: 'unavailable', reason }); set('unavailable'); return; }
      try { autoUpdater.setFeedURL({ url: feed, serverType: 'json' }); }
      catch (error) { lastError = String(error && error.message || error).slice(0, 300); reason = 'feed_refused'; log({ event: 'update', outcome: 'unavailable', reason, error: lastError }); set('unavailable'); return; }
      wire();
      set('idle');
      if (automatic) check();
    },

    /** A window came forward: check again if six hours have passed and checks are automatic. */
    wake() {
      if (automatic && now() - lastCheck >= CHECK_EVERY_MS) return check();
      return false;
    },

    /** "Check for Updates…": checks now, whatever the switch says, and resolves with the outcome. */
    checkNow() {
      if (state === 'ready') return Promise.resolve({ outcome: 'ready', version: readyVersion });
      if (state === 'downloading' || state === 'checking') return Promise.resolve({ outcome: 'downloading' });
      if (!['idle', 'error'].includes(state)) return Promise.resolve({ outcome: 'unavailable', reason });
      return new Promise((resolve) => { manual = resolve; if (!check()) settle({ outcome: 'failed', error: lastError }); });
    },

    /** The switch. Off: no automatic checks (a manual check still works); on: checks at once. */
    async setAutomatic(on) {
      automatic = !!on;
      await saveSettings();
      onChange(status());
      if (automatic) check();
    },

    /** Restart into the downloaded version now (otherwise it is installed when the app quits). */
    restart() {
      if (state !== 'ready') return false;
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}

module.exports = { createUpdater, readFeed, feedFor, feedURL, CHECK_EVERY_MS };
