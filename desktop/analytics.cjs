'use strict';
// Anonymous usage counts (passioncode-ai/fabric-inbox#27, docs/ANALYTICS.md): installs, days of
// use and how many accounts, mailboxes, agents and agent keys a server has — never a name, an
// address, a domain, a path, a message or a token. Events go to the organization's self-hosted
// Aptabase in batches of at most 25 (the ingestion contract of ssheleg/sshlg-analytics); its
// address comes with the App Key, so the source names no host.
//
// Only an app that carries an App Key sends anything: the release workflow writes
// desktop/analytics.json into the disk image's app; source builds, forks, tests and the store
// package carry none. The shared installation file (`<appData>/PassionCode/installation.json`)
// is the one Switchboard and Fabric read: one id per machine, and one switch for every app.
//
// Lifecycle (LC-08): no timer. A flush happens when something is tracked or the window comes
// forward; a refused send waits 60 s, then 10 min, before the next trigger may retry it.
const path = require('node:path');

const SDK = 'fabric-inbox-analytics@1';
const KEY = /^A-SH-\d{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 25;
const MAX_QUEUE = 200;
const MAX_AGE_MS = 23 * 3600 * 1000;      // the server refuses events older than a day
const SESSION_IDLE_MS = 3600 * 1000;      // a new session after an hour without an event
const RETRY_MS = [60 * 1000, 600 * 1000];
const SEND_TIMEOUT_MS = 10 * 1000;
/** What a server's counts may hold; anything else is dropped before it is sent. */
const COUNT_KEYS = ['gmail', 'cloudflare', 'agents', 'agent_keys'];

const installationFile = (appData) => path.join(appData, 'PassionCode', 'installation.json');
const stateFile = (userData) => path.join(userData, 'analytics-state.json');
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** An https origin with nothing after it, or null. */
function analyticsOrigin(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.href === `${url.origin}/` && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

/** The App Key and host bundled with a release build, or null (desktop/analytics.json, written by the builder). */
function readBundledKey(text) {
  try {
    const value = JSON.parse(text);
    const host = value && analyticsOrigin(value.host);
    if (host && typeof value.appKey === 'string' && KEY.test(value.appKey)) return { appKey: value.appKey, host, debug: value.debug === true };
  } catch { /* no key: nothing is sent */ }
  return null;
}

/** Reads the shared installation file. A file that does not parse is never repaired: analytics stays off. */
async function readInstallation(fs, file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { return { state: error && error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' && UUID.test(value.id)) return { state: 'ok', value };
  } catch { /* falls through */ }
  return { state: 'unreadable' };
}

/**
 * Reads the shared file, or creates it once: written to a temporary name and hard-linked into
 * place, which fails when another PassionCode app created it at the same moment — that one is
 * read instead. `created` says this app made it (no PassionCode app had run here before).
 */
async function ensureInstallation({ fs, file, uuid, now }) {
  const read = await readInstallation(fs, file);
  if (read.state !== 'missing') return { ...read, created: false };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = { version: 1, id: uuid(), analytics: true, created_at: Math.floor(now() / 1000) };
  const temp = `${file}.${uuid()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try {
    await fs.link(temp, file);
    return { state: 'ok', value, created: true };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    return { ...(await readInstallation(fs, file)), created: false };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** Rewrites the shared switch, keeping every field another app added. False when the file is not ours to touch. */
async function writeSwitch({ fs, file, enabled }) {
  const read = await readInstallation(fs, file);
  if (read.state !== 'ok') return false;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...read.value, analytics: enabled }, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
  return true;
}

function cleanCounts(counts) {
  const out = {};
  if (!counts || typeof counts !== 'object') return out;
  for (const key of COUNT_KEYS) {
    const n = counts[key];
    if (Number.isInteger(n) && n >= 0 && n < 1e6) out[key] = n;
  }
  return out;
}

/**
 * The analytics client. Every dependency is passed in, so tests drive it with a fake clock, file
 * system and server; main.cjs passes Electron's.
 */
function createAnalytics(deps) {
  const { fs, appData, userData, fetch: send, now = Date.now, uuid, random = Math.random, log = () => {},
    appVersion = '', osVersion = '', locale = '', engineVersion = '' } = deps;
  const bundle = deps.bundle || null;
  const host = bundle ? bundle.host : '';
  const shared = installationFile(appData);
  // sshlg-growth counts installs by props.iid and keeps only production or sandbox events
  // (operator decision 2026-10-05): a debug key or a pre-release version is sandbox.
  const environment = bundle && !bundle.debug && !String(appVersion).includes('-') ? 'production' : 'sandbox';
  let installId = null;      // set only while analytics is on
  let queue = [];
  let session = { id: '', at: 0 };
  let retryAt = 0;
  let failures = 0;
  let flushing = null;
  let state = { installed: false, activeDay: '', counts: null, version: '' };

  async function loadState() {
    try {
      const value = JSON.parse(await fs.readFile(stateFile(userData), 'utf8'));
      if (value && typeof value === 'object') state = { installed: value.installed === true, activeDay: typeof value.activeDay === 'string' ? value.activeDay : '', counts: value.counts && typeof value.counts === 'object' ? cleanCounts(value.counts) : null, version: typeof value.version === 'string' ? value.version.slice(0, 50) : '' };
    } catch { /* first run, or an unreadable state: start fresh */ }
  }
  async function saveState() {
    try {
      await fs.mkdir(userData, { recursive: true, mode: 0o700 });
      const target = stateFile(userData);
      await fs.writeFile(`${target}.tmp`, JSON.stringify(state) + '\n', { mode: 0o600 });
      await fs.rename(`${target}.tmp`, target);
    } catch (error) { log({ event: 'analytics_state', outcome: 'not_saved', code: error && error.code || 'error' }); }
  }
  function sessionId(at) {
    if (!session.id || at - session.at > SESSION_IDLE_MS) {
      const digits = String(Math.floor(random() * 1e8)).padStart(8, '0');
      session.id = `${Math.floor(at / 1000)}${digits}`;
    }
    session.at = at;
    return session.id;
  }
  function track(eventName, props = {}) {
    if (!installId) return false;
    const at = now();
    queue.push({
      at,
      body: {
        timestamp: new Date(at).toISOString(), sessionId: sessionId(at), eventName,
        systemProps: { isDebug: !!bundle.debug, locale: String(locale).slice(0, 10), osName: 'macOS', osVersion: String(osVersion).slice(0, 100),
          appVersion: String(appVersion).slice(0, 50), appBuildNumber: '', sdkVersion: SDK, engineName: 'Electron', engineVersion: String(engineVersion).slice(0, 30) },
        props: { ...props, install_id: installId, iid: installId, environment },
      },
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    return true;
  }
  async function sendBatch(batch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await send(`${host}/api/v0/events`, { method: 'POST', signal: controller.signal,
        headers: { 'App-Key': bundle.appKey, 'Content-Type': 'application/json' }, body: JSON.stringify(batch.map(e => e.body)) });
      if (response.status >= 200 && response.status < 300) return 'sent';
      return response.status === 429 || response.status >= 500 ? 'deferred' : 'dropped';
    } catch { return 'deferred'; }
    finally { clearTimeout(timer); }
  }
  async function flushNow() {
    while (installId && queue.length) {
      if (retryAt && now() < retryAt) return;
      const cutoff = now() - MAX_AGE_MS;
      queue = queue.filter(e => e.at >= cutoff);
      if (!queue.length) return;
      const batch = queue.slice(0, BATCH);
      const outcome = await sendBatch(batch);
      log({ event: 'analytics_flush', outcome, events: batch.length });
      if (outcome === 'deferred') {
        retryAt = now() + RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
        failures += 1;
        return;
      }
      retryAt = 0; failures = 0;
      const sent = new Set(batch);
      queue = queue.filter(e => !sent.has(e));
    }
  }
  /** Sends what is waiting; one send at a time, never throws. */
  function flush() {
    if (!flushing) flushing = flushNow().catch(() => {}).finally(() => { flushing = null; });
    return flushing;
  }

  return {
    /** Whether this build can send at all, and whether it does now. */
    status: () => ({ available: !!bundle, enabled: !!installId }),

    /** At launch: the install once per app, then the start. */
    async start({ launch = 'ordinary', serverConfigured = false } = {}) {
      if (!bundle || typeof send !== 'function') return;
      let installation;
      try { installation = await ensureInstallation({ fs, file: shared, uuid, now }); }
      catch (error) { log({ event: 'analytics_off', reason: 'installation_not_written', code: error && error.code || 'error' }); return; }
      if (installation.state !== 'ok') { log({ event: 'analytics_off', reason: 'installation_unreadable' }); return; }
      await loadState();
      if (installation.value.analytics === false) return;
      installId = installation.value.id;
      if (!state.installed && track('app_installed', { first_passioncode_app: installation.created, server_configured: !!serverConfigured })) {
        state.installed = true;
        await saveState();
      }
      // An update shows as the version this app last started as (automatic updates, docs/desktop-data-and-updates.md).
      if (state.version && state.version !== appVersion) track('app_updated', { from: state.version });
      if (state.version !== appVersion) { state.version = String(appVersion).slice(0, 50); await saveState(); }
      track('app_started', { launch: launch === 'link' ? 'link' : 'ordinary' });
      await flush();
    },

    /** Whether today's active event is still due; a caller fetches counts only then. */
    activeDue: () => !!installId && state.activeDay !== utcDay(now()),

    /**
     * Once a UTC day: `app_active` with the server's counts (when they could be read), and the
     * accounts added or removed since the last counts. The first counts are a baseline.
     */
    async active(counts) {
      if (!installId) return;
      const clean = counts ? cleanCounts(counts) : null;
      const day = utcDay(now());
      if (state.activeDay !== day) {
        track('app_active', { server: !!counts, ...(clean || {}) });
        state.activeDay = day;
      }
      if (clean) {
        const before = state.counts;
        if (before) {
          for (const provider of ['gmail', 'cloudflare']) {
            if (!(provider in clean) || !(provider in before)) continue;
            const change = clean[provider] - before[provider];
            if (change > 0) track('account_added', { provider, added: change, accounts: clean[provider] });
            if (change < 0) track('account_removed', { provider, removed: -change, accounts: clean[provider] });
          }
        }
        state.counts = { ...(before || {}), ...clean };
      }
      await saveState();
      await flush();
    },

    /** A named moment: a server connected, a hub connected. Props are counts and kinds only. */
    async event(name, props) {
      if (track(name, props)) await flush();
    },

    /** The window came forward: a retry is due if its wait is over. */
    wake: () => flush(),

    /**
     * The shared switch, for every PassionCode app on this Mac. Off drops what is waiting; on
     * starts from the counts seen next, so nothing done while off is reported later.
     */
    async setEnabled(enabled) {
      if (!bundle) return false;
      if (enabled) {
        const installation = await ensureInstallation({ fs, file: shared, uuid, now }).catch(() => null);
        if (!installation || installation.state !== 'ok') return false;
        if (installation.value.analytics === false && !(await writeSwitch({ fs, file: shared, enabled: true }))) return false;
        await loadState();
        state.counts = null;
        installId = installation.value.id;
        await saveState();
        return true;
      }
      queue = [];
      installId = null;
      return writeSwitch({ fs, file: shared, enabled: false }).catch(() => false);
    },
  };
}

/**
 * Reads how many Gmail accounts, Cloudflare mailboxes, agents and agent keys the signed-in server
 * has, with the mail window's own session, once a day. Only lengths leave this function. Null
 * when the person is not signed in or the server answers nothing usable.
 */
function countsWith(ses, origin) {
  const read = async (pathname) => {
    try {
      const response = await ses.fetch(new URL(pathname, origin).href, { redirect: 'manual', credentials: 'include', headers: { Accept: 'application/json' } });
      if (response.status !== 200 || !(response.headers.get('content-type') || '').toLowerCase().includes('json')) return null;
      return await response.json();
    } catch { return null; }
  };
  return async () => {
    const [accounts, mailboxes, agents, keys] = await Promise.all(['/api/accounts', '/api/v1/mailboxes', '/api/agents', '/api/agent-keys'].map(read));
    const counts = {};
    if (accounts && Array.isArray(accounts.accounts)) counts.gmail = accounts.accounts.length;
    if (Array.isArray(mailboxes)) counts.cloudflare = mailboxes.length;
    if (agents && Array.isArray(agents.agents)) counts.agents = agents.agents.length;
    if (keys && Array.isArray(keys.keys)) counts.agent_keys = keys.keys.length;
    return Object.keys(counts).length ? counts : null;
  };
}

module.exports = { createAnalytics, countsWith, readBundledKey, analyticsOrigin, readInstallation, ensureInstallation, writeSwitch, installationFile, stateFile, SDK, BATCH, KEY };
