'use strict';
// Anonymous usage counts (passioncode-ai/fabric-inbox#27, docs/ANALYTICS.md): installs, days of
// use and how many accounts, mailboxes, agents and agent keys a server has — never a name, an
// address, a domain, a path, a message or a token. Two tiers (B-198; the analytics server's client
// contract, "Two tiers", operator decision 2026-11-03): the baseline (starts, days of use, connects)
// needs no consent, carries no id and writes nothing on the Mac; the person's yes adds the shared
// installation id, the install and update events and the server's counts. Events go to the organization's self-hosted
// Aptabase in batches of at most 25 (the ingestion contract of the analytics server); its
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
/** Events of the baseline tier: no id, no state on the Mac, sent with or without the person's yes. */
const BASELINE = new Set(['app_started', 'app_active', 'server_connected', 'hub_connected']);
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
/** Aptabase's operating system names (review 2026-10-21: Windows and Linux were reported as macOS). */
const OS_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function createAnalytics(deps) {
  const { fs, appData, userData, fetch: send, now = Date.now, uuid, random = Math.random, log = () => {},
    appVersion = '', osVersion = '', locale = '', engineVersion = '', platform = 'darwin' } = deps;
  const osName = OS_NAMES[platform] || String(platform).slice(0, 20);
  const bundle = deps.bundle || null;
  const host = bundle ? bundle.host : '';
  const shared = installationFile(appData);
  // a growth agent counts installs by props.iid and keeps only production or sandbox events
  // (operator decision 2026-10-05): a debug key or a pre-release version is sandbox. Aptabase's build mode follows it:
  // isDebug is true exactly when the environment is not production (the analytics server client contract, "Build modes").
  const environment = bundle && !bundle.debug && !String(appVersion).includes('-') ? 'production' : 'sandbox';
  let installId = null;      // set only while analytics is on
  let queue = [];
  let session = { id: '', at: 0 };
  let retryAt = 0;
  let failures = 0;
  let flushing = null;
  let state = { installed: false, activeDay: '', counts: null, version: '', disclosedAt: '', declined: false };
  // A7-012 (issue #45, Fabric ADR-0127): a start before the person answered the switch waits here.
  let deferred = null;
  // B-198: the baseline tier runs whenever this build can send; its day of use is kept in memory only.
  let baseline = false;
  let baselineDay = '';
  let baselineStarted = false;

  async function loadState() {
    try {
      const value = JSON.parse(await fs.readFile(stateFile(userData), 'utf8'));
      if (value && typeof value === 'object') state = { installed: value.installed === true, activeDay: typeof value.activeDay === 'string' ? value.activeDay : '', counts: value.counts && typeof value.counts === 'object' ? cleanCounts(value.counts) : null, version: typeof value.version === 'string' ? value.version.slice(0, 50) : '',
        disclosedAt: typeof value.disclosedAt === 'string' ? value.disclosedAt.slice(0, 40) : '', declined: value.declined === true };
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
  /** An identity event needs the person's yes; a baseline event goes without an id when there is none. */
  function track(eventName, props = {}) {
    if (!installId && !(baseline && BASELINE.has(eventName))) return false;
    const at = now();
    queue.push({
      at,
      body: {
        timestamp: new Date(at).toISOString(), sessionId: sessionId(at), eventName,
        systemProps: { isDebug: environment !== 'production', locale: String(locale).slice(0, 10), osName, osVersion: String(osVersion).slice(0, 100),
          appVersion: String(appVersion).slice(0, 50), appBuildNumber: '', sdkVersion: SDK, engineName: 'Electron', engineVersion: String(engineVersion).slice(0, 30) },
        props: installId ? { ...props, install_id: installId, iid: installId, environment } : { ...props, environment },
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
    while ((installId || baseline) && queue.length) {
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

  /** The identity tier's start, once the switch is on and answered: the install once per app, then the start. */
  async function begin(installation, { launch = 'ordinary', serverConfigured = false, created } = {}) {
      installId = installation.value.id;
      // A start that waited for the answer keeps whether this app made the shared file at launch (review 2026-10-21).
      const first = typeof created === 'boolean' ? created : installation.created;
      if (!state.installed && track('app_installed', { first_passioncode_app: first, server_configured: !!serverConfigured })) {
        state.installed = true;
        await saveState();
      }
      // An update shows as the version this app last started as (automatic updates, docs/desktop-data-and-updates.md).
      if (state.version && state.version !== appVersion) track('app_updated', { from: state.version });
      if (state.version !== appVersion) { state.version = String(appVersion).slice(0, 50); await saveState(); }
      // A launch whose start already went out without an id is not counted twice (B-198).
      if (!baselineStarted) track('app_started', { launch: launch === 'link' ? 'link' : 'ordinary' });
      baselineStarted = true;
      await flush();
  }
  /** The baseline tier's start: no id, nothing read or written beyond the shared switch's answer. */
  async function beginBaseline({ launch = 'ordinary' } = {}) {
    baseline = true;
    if (!baselineStarted && track('app_started', { launch: launch === 'link' ? 'link' : 'ordinary' })) baselineStarted = true;
    await flush();
  }

  /**
   * The person's answer, from the first-run question or the menu switch: kept once per app (A7-012),
   * with whether it was a no, since a no may leave no shared file to say so (B-198).
   */
  async function disclose(declined) {
    if (state.disclosedAt && state.declined === declined) return;
    if (!state.disclosedAt) state.disclosedAt = new Date(now()).toISOString();
    state.declined = declined;
    await saveState();
  }

  return {
    /**
     * Whether this build can send at all, whether it does now, whether it still waits for the person's
     * first answer (nothing is sent until then), and whether this install sent counts before it asked.
     */
    status: () => ({ available: !!bundle, enabled: !!installId, pending: !!deferred, sentBefore: state.installed === true, baseline }),

    /**
     * At launch. The baseline tier starts at once, with no id and nothing written (B-198). The identity
     * tier waits until the person has answered the switch once (the first-run question or the menu):
     * no id, no `app_installed` and no shared file is made before that answer (A7-012).
     */
    async start(options = {}) {
      if (!bundle || typeof send !== 'function') return;
      await loadState();
      const installation = await readInstallation(fs, shared);
      if (installation.state === 'unreadable') log({ event: 'analytics_off', reason: 'installation_unreadable' });
      const off = installation.state === 'ok' && installation.value.analytics === false;
      if (!state.disclosedAt && installation.state !== 'unreadable' && !off) {
        deferred = { ...options };
        log({ event: 'analytics_pending', reason: 'not_answered' });
      }
      if (installation.state === 'ok' && !off && state.disclosedAt) {
        await begin({ ...installation, created: false }, options);
        return;
      }
      if (state.disclosedAt && !state.declined && installation.state === 'missing') {
        // Answered yes here, but the shared file is gone (another app's reset): made again, as before B-198.
        let made;
        try { made = await ensureInstallation({ fs, file: shared, uuid, now }); }
        catch (error) { log({ event: 'analytics_off', reason: 'installation_not_written', code: error && error.code || 'error' }); made = null; }
        if (made && made.state === 'ok') { await begin(made, options); return; }
      }
      await beginBaseline(options);
    },

    /** Whether today's active event is still due; a caller fetches counts only then. */
    activeDue: () => installId ? state.activeDay !== utcDay(now()) : baseline && baselineDay !== utcDay(now()),
    /** Whether the server's counts are wanted: the identity tier only (B-198). */
    countsWanted: () => !!installId,

    /**
     * Once a UTC day: `app_active` with the server's counts (when they could be read), and the
     * accounts added or removed since the last counts. The first counts are a baseline.
     */
    async active(counts) {
      if (!installId) {
        // B-198: the baseline's day of use, kept in memory only and without the server's counts.
        const day = utcDay(now());
        if (baseline && baselineDay !== day && track('app_active', { server: !!counts })) { baselineDay = day; await flush(); }
        return;
      }
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
      const waiting = deferred;
      deferred = null;
      if (enabled) {
        const installation = await ensureInstallation({ fs, file: shared, uuid, now }).catch(() => null);
        if (!installation || installation.state !== 'ok') { deferred = waiting; return false; }
        if (installation.value.analytics === false && !(await writeSwitch({ fs, file: shared, enabled: true }))) { deferred = waiting; return false; }
        await loadState();
        await disclose(false);
        // The start that waited for this answer happens now, so the install is counted after it, not before.
        if (waiting) { await begin(installation, waiting); return true; }
        state.counts = null;
        installId = installation.value.id;
        await saveState();
        return true;
      }
      // Off drops what waits with the id; the baseline goes on without one (B-198).
      queue = queue.filter(e => !e.body.props.iid);
      installId = null;
      baseline = true;
      await disclose(true);
      // A no before any PassionCode app made the shared id: there is nothing to switch off, and none is made (B-198).
      if ((await readInstallation(fs, shared)).state === 'missing') return true;
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
