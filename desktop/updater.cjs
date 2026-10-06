'use strict';
// Automatic updates of the Mac app (docs/desktop-data-and-updates.md), one behaviour with every
// PassionCode.ai product (LC-16). On by default: a released copy reads the latest GitHub release's
// `update-mac.json`, and when it names a newer version the app downloads and verifies that release
// itself (desktop/update-verify.cjs: signed SHA256SUMS, digest, pinned Developer ID team, version)
// before Squirrel.Mac is handed the verified zip. Squirrel.Mac installs it when the person quits
// (or at once, on Restart to Install Update); a running session is never stopped for an update.
//
// Only an app the release workflow built carries a feed (desktop/updates.json, written by
// dist-mac.mjs in CI): source builds, forks without their own release, debug builds and the Mac
// App Store package (the store updates it) never check. An app run from outside /Applications
// (a disk image, Downloads under App Translocation) cannot replace itself, so it does not check
// and says so.
//
// The switch is the file `auto-update` in the app's data folder: absent means on, only the word
// `off` turns checks off. Cadence: the first check 90 s after start, then every 6 h while the app
// runs (window or not), and after a failed check one retry within the hour. The timers are the
// only ones this module owns, and they hold no process open (main.cjs unrefs them).
const path = require('node:path');

const { compareVersions } = require('./update-verify.cjs');

const FIRST_CHECK_MS = 90 * 1000;
const CHECK_EVERY_MS = 6 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const RESTART_TIMEOUT_MS = 60 * 1000;
const SWITCH_FILE = 'auto-update';
const INSTALL_FILE = 'update-install.json';
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
 * format): only the release itself, with the zip's sha256 and size the app checks before Squirrel.Mac
 * sees it. `migration` (a runbook URL) holds the release: it is downloaded and verified but not
 * installed until a person takes the step (LC-16 "Held releases").
 */
function feedFor({ repository, version, zipName, sha256, size, notes = '', pubDate, migration = null }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('A repository is owner/name.');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only a release version (X.Y.Z) is offered as an update.');
  if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isInteger(size) || size <= 0) throw new Error('The update needs its sha256 and size.');
  const url = `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(zipName)}`;
  const updateTo = { version, name: version, notes, pub_date: pubDate, url, sha256, size };
  if (migration !== null) {
    if (!/^https:\/\//.test(String(migration))) throw new Error('A held release names its runbook as an https URL.');
    updateTo.migration = { runbook: migration };
  }
  return { currentRelease: version, releases: [{ version, updateTo }] };
}

const feedURL = (repository) => `https://github.com/${repository}/releases/latest/download/update-mac.json`;

/**
 * The updater. `autoUpdater` is Electron's; every other dependency is passed in so tests drive it
 * with fakes. States: off | unavailable | idle | checking | downloading | ready | held | error.
 *
 * deps: { autoUpdater, fs, userData, feed, appVersion, fetchFeed(url) → Buffer, verifier
 *   ({ verify(feedBytes, { onDownload }), clean() }), now, setTimer(fn, ms) → handle,
 *   clearTimer(handle), log, onChange }
 */
function createUpdater(deps) {
  const { autoUpdater, fs, userData, feed, appVersion, fetchFeed, verifier, now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), log = () => {}, onChange = () => {} } = deps;
  const switchFile = path.join(userData, SWITCH_FILE);
  const installFile = path.join(userData, INSTALL_FILE);
  let automatic = true;
  let state = 'off';
  let reason = '';
  let readyVersion = '';
  let heldVersion = '';
  let runbook = '';
  let lastError = '';
  let lastCheck = 0;
  let retried = false;     // one retry within the hour after a failed check, then back to 6 h
  let timer = null;
  let manual = null;       // resolves a person's "Check for Updates…" with what happened
  let staging = '';        // the version handed to Squirrel.Mac, until it answers
  let wired = false;
  let installing = false;  // Restart to Install Update was chosen: the quit is Squirrel.Mac's

  const set = (next) => { state = next; onChange(status()); };
  function status() { return { state, reason, automatic, readyVersion, heldVersion, runbook, error: lastError, lastCheck, installing }; }
  function settle(outcome) { if (manual) { const done = manual; manual = null; done(outcome); } }

  /** The switch: absent = on, only `off` = off. A legacy `updates.json` choice is carried over once. */
  async function loadSwitch() {
    try {
      automatic = (await fs.readFile(switchFile, 'utf8')).trim() !== 'off';
      return;
    } catch { /* absent: on, unless the person turned it off before the file existed */ }
    const legacy = path.join(userData, 'updates.json');
    try {
      const value = JSON.parse(await fs.readFile(legacy, 'utf8'));
      if (value && value.automatic === false) { await writeSwitch(false); automatic = false; }
      await fs.rm(legacy, { force: true });
    } catch { /* no legacy choice */ }
  }
  async function writeSwitch(on) {
    await fs.mkdir(userData, { recursive: true, mode: 0o700 });
    if (on) { await fs.rm(switchFile, { force: true }); return; }
    await fs.writeFile(`${switchFile}.tmp`, 'off\n', { mode: 0o600 });
    await fs.rename(`${switchFile}.tmp`, switchFile);
  }

  /** What the previous run left: an install that started, and whether this launch is its result. */
  async function reconcileInstall() {
    let pending;
    try { pending = JSON.parse(await fs.readFile(installFile, 'utf8')); } catch { return; }
    await fs.rm(installFile, { force: true });
    if (!pending || typeof pending.version !== 'string') return;
    const installed = compareVersions(appVersion, pending.version) >= 0;
    log({ event: 'update_install', outcome: installed ? 'installed' : 'failed', version: pending.version, running: appVersion });
  }
  async function recordInstall(version) {
    try { await fs.writeFile(installFile, JSON.stringify({ version, from: appVersion, at: new Date(now()).toISOString() }) + '\n', { mode: 0o600 }); }
    catch { /* the next launch then cannot tell; nothing else depends on it */ }
  }

  function schedule(ms) {
    if (timer) clearTimer(timer);
    timer = null;
    if (!automatic || ['off', 'unavailable', 'ready'].includes(state)) return;
    timer = setTimer(() => { timer = null; if (automatic) void check(); }, ms);
  }

  function failed(code, why, message) {
    lastError = String(message || why || code).slice(0, 300);
    reason = why || code;
    log({ event: 'update_check', outcome: code, reason: reason, version: staging || undefined });
    staging = '';
    set('error');
    settle({ outcome: 'failed', code, reason, error: lastError });
    if (!retried) { retried = true; schedule(RETRY_MS); } else { retried = false; schedule(CHECK_EVERY_MS); }
  }

  function wire() {
    if (wired) return;
    wired = true;
    autoUpdater.on('update-downloaded', (_event, _notes, name) => {
      readyVersion = staging || (typeof name === 'string' ? name : '');
      staging = '';
      log({ event: 'update_check', outcome: 'ready', version: readyVersion });
      set('ready');
      settle({ outcome: 'ready', version: readyVersion });
      schedule(0);
      void verifier.clean().catch(() => {});
    });
    autoUpdater.on('update-not-available', () => {
      // Squirrel.Mac was handed a verified newer release and refused it: an install failure.
      if (state === 'downloading') failed('install_failed', 'squirrel_declined', 'Squirrel.Mac did not accept the verified update.');
    });
    autoUpdater.on('error', (error) => {
      const message = String(error && error.message || error);
      if (state === 'downloading') { void verifier.clean().catch(() => {}); failed('install_failed', 'squirrel', message); }
      else if (state === 'ready') log({ event: 'update_install', outcome: 'failed', reason: 'squirrel' });
      else failed('check_failed', 'squirrel', message);
    });
  }

  /** One check: read the feed, verify a newer release, then hand it to Squirrel.Mac. */
  async function check() {
    if (!['idle', 'error', 'held'].includes(state)) return null;
    lastCheck = now();
    set('checking');
    let feedBytes;
    try { feedBytes = await fetchFeed(feed); }
    catch (error) { failed('check_failed', 'feed_unreachable', error && error.message); return null; }
    let out;
    try {
      // A held release is downloaded and verified too, but a person's check waits for its verdict.
      out = await verifier.verify(feedBytes, { onDownload: (version, held) => { staging = version; set('downloading'); if (!held) settle({ outcome: 'downloading', version }); } });
    } catch (error) {
      void verifier.clean().catch(() => {});
      failed(error && error.code || 'check_failed', error && error.reason, error && error.message);
      return null;
    }
    retried = false;
    if (out.outcome !== 'verified') {
      log({ event: 'update_check', outcome: 'current', latest: out.version, running: appVersion, ...(out.outcome === 'older' ? { refused: 'older' } : {}) });
      staging = '';
      set('idle');
      settle({ outcome: 'current' });
      schedule(CHECK_EVERY_MS);
      return null;
    }
    if (out.migration) {
      heldVersion = out.version; runbook = out.migration.runbook;
      log({ event: 'update_check', outcome: 'needs_migration', version: out.version });
      staging = '';
      void verifier.clean().catch(() => {});
      set('held');
      settle({ outcome: 'held', version: out.version, runbook });
      schedule(CHECK_EVERY_MS);
      return null;
    }
    try {
      autoUpdater.setFeedURL({ url: out.localFeed, serverType: 'json' });
      autoUpdater.checkForUpdates();
    } catch (error) {
      void verifier.clean().catch(() => {});
      failed('install_failed', 'squirrel', error && error.message);
    }
    return null;
  }

  return {
    status,

    /** At launch: decide whether this copy can update itself, then schedule the first check. */
    async start({ packaged, mas, inApplications }) {
      await loadSwitch();
      await reconcileInstall();
      if (!feed || !packaged || mas) { reason = !feed ? 'no_feed' : mas ? 'app_store' : 'development'; set('off'); return; }
      if (!inApplications) { reason = 'not_in_applications'; log({ event: 'update_check', outcome: 'check_failed', reason }); set('unavailable'); return; }
      if (typeof fetchFeed !== 'function' || !verifier || !/^\d+\.\d+\.\d+$/.test(String(appVersion))) {
        reason = 'no_version_check'; set('unavailable'); return;
      }
      wire();
      set('idle');
      schedule(FIRST_CHECK_MS);
    },

    /** "Check for Updates…": checks now, whatever the switch says, and resolves with the outcome. */
    checkNow() {
      if (state === 'ready') return Promise.resolve({ outcome: 'ready', version: readyVersion });
      if (state === 'downloading' || state === 'checking') return Promise.resolve({ outcome: 'downloading' });
      if (!['idle', 'error', 'held'].includes(state)) return Promise.resolve({ outcome: 'unavailable', reason });
      return new Promise((resolve) => { manual = resolve; void check(); });
    },

    /** The switch. Off: no checks, downloads or installs start; on: a check runs at once. */
    async setAutomatic(on) {
      automatic = !!on;
      await writeSwitch(automatic);
      log({ event: 'auto_update', outcome: automatic ? 'on' : 'off' });
      onChange(status());
      if (automatic) await check(); else schedule(0);
    },

    /** Restart into the downloaded version now (otherwise it is installed when the app quits). */
    restart() {
      if (state !== 'ready') { log({ event: 'update_restart', outcome: 'refused', state }); return false; }
      if (installing) return true;
      installing = true;
      log({ event: 'update_restart', outcome: 'requested', version: readyVersion });
      void recordInstall(readyVersion).then(() => {
        log({ event: 'update_install', outcome: 'started', version: readyVersion });
        autoUpdater.quitAndInstall();
        setTimer(() => log({ event: 'update_install', outcome: 'timeout', version: readyVersion }), RESTART_TIMEOUT_MS);
      });
      return true;
    },

    /** The app is quitting: a ready update is installed now by Squirrel.Mac's ShipIt. */
    async quitting() {
      if (state !== 'ready' || installing) return;
      log({ event: 'update_install', outcome: 'started', version: readyVersion });
      await recordInstall(readyVersion);
    },

    /** Stops the timers (tests; the app's own exit needs nothing). */
    stop() { if (timer) clearTimer(timer); timer = null; },
  };
}

module.exports = { createUpdater, readFeed, feedFor, feedURL, compareVersions, FIRST_CHECK_MS, CHECK_EVERY_MS, RETRY_MS, SWITCH_FILE };
