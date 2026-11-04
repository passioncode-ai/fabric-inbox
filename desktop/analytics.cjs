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
/** B-203: the server's error classes (workers/lib/error-counts.ts) and the shape of a code; at most this many events a day. */
const ERROR_CLASSES = new Set(['http', 'alarm', 'incoming', 'agent', 'send', 'sync']);
const ERROR_CODE = /^[a-z][a-z0-9_]{0,47}$/;
const ERROR_EVENTS_MAX = 30;

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
 * B-203: yesterday's error counts as the server answered them (`/api/server-errors`), as one `server_error` event's
 * properties each: a known class, a code of the fixed shape, a whole count, the day; the largest first, at most
 * ERROR_EVENTS_MAX. Anything else is dropped.
 */
function cleanErrors(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day) || !raw.counts || typeof raw.counts !== 'object') return [];
  const out = [];
  for (const [key, count] of Object.entries(raw.counts)) {
    const dot = key.indexOf('.');
    const cls = key.slice(0, dot), code = key.slice(dot + 1);
    if (dot < 1 || !ERROR_CLASSES.has(cls) || !ERROR_CODE.test(code) || !Number.isInteger(count) || count < 1 || count >= 1e6) continue;
    out.push({ class: cls, code, count, day: raw.day });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, ERROR_EVENTS_MAX);
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
  // `disclosedAt`: when the person was shown what is sent (the first-run notice, or an answer before B-200);
  // `declined`: true once they turned the details off, false once on, null for an answer kept before B-198.
  let state = { installed: false, activeDay: '', counts: null, version: '', disclosedAt: '', declined: null };
  // B-200: the first-run notice is still to be shown; the launch's options, for an install counted when turned on.
  let noticeDue = false;
  let launchOptions = {};
  /** B-200: each error is counted once per launch (by where and code). */
  const errorsSeen = new Set();
  // B-198: the baseline tier runs whenever this build can send; its day of use is kept in memory only.
  let baseline = false;
  let baselineDay = '';
  let baselineStarted = false;

  async function loadState() {
    try {
      const value = JSON.parse(await fs.readFile(stateFile(userData), 'utf8'));
      if (value && typeof value === 'object') state = { installed: value.installed === true, activeDay: typeof value.activeDay === 'string' ? value.activeDay : '', counts: value.counts && typeof value.counts === 'object' ? cleanCounts(value.counts) : null, version: typeof value.version === 'string' ? value.version.slice(0, 50) : '',
        disclosedAt: typeof value.disclosedAt === 'string' ? value.disclosedAt.slice(0, 40) : '', declined: typeof value.declined === 'boolean' ? value.declined : null };
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

  /** The person's choice of this product's switch (B-200: per product), kept with when they were first shown it. */
  async function choose(declined) {
    if (!state.disclosedAt) state.disclosedAt = new Date(now()).toISOString();
    state.declined = declined;
    await saveState();
  }

  return {
    /**
     * Whether this build can send at all, whether it sends the details now, whether the first-run notice is still
     * to be shown, and whether the baseline runs.
     */
    status: () => ({ available: !!bundle, enabled: !!installId, pending: noticeDue, sentBefore: state.installed === true, baseline }),

    /**
     * At launch (B-200, operator 2026-11-04: usage and error data on by default, for installs already out too, off per
     * product in its settings). The details start at once with the shared id unless this product's switch is off; the
     * person is shown a notice the first time a window comes forward. An explicit no kept from before stays a no: an
     * answer before B-198 is read from the shared switch it wrote; with the switch off nothing is sent, the baseline
     * included. The shared switch no longer turns this product off. Without a readable shared file the baseline
     * with no id still runs (B-198).
     */
    async start(options = {}) {
      if (!bundle || typeof send !== 'function') return;
      launchOptions = { ...options };
      await loadState();
      let installation = await readInstallation(fs, shared);
      if (state.declined === null && state.disclosedAt && installation.state === 'ok' && installation.value.analytics === false) {
        state.declined = true;
        await saveState();
      }
      noticeDue = !state.disclosedAt;
      if (noticeDue) log({ event: 'analytics_notice', reason: 'not_shown' });
      // Off is off (B-200, the analytics contract's reading of 2026-11-04): nothing at all, the baseline included.
      if (state.declined === true) return;
      if (installation.state === 'missing') {
        try { installation = await ensureInstallation({ fs, file: shared, uuid, now }); }
        catch (error) { log({ event: 'analytics_off', reason: 'installation_not_written', code: error && error.code || 'error' }); }
      }
      if (installation.state !== 'ok') {
        log({ event: 'analytics_off', reason: 'installation_unreadable' });
        await beginBaseline(options);
        return;
      }
      await begin({ ...installation, created: installation.created === true }, options);
    },

    /** B-200: the first-run notice was shown; the switch stays as it is. */
    async noticeShown() {
      noticeDue = false;
      if (!state.disclosedAt) { state.disclosedAt = new Date(now()).toISOString(); await saveState(); }
    },

    /**
     * B-200: an error the app noticed (a crash of the main process, a renderer or a helper): where and a code only,
     * never a message or a path; once per launch for each, and only with the details on.
     */
    async error(where, code) {
      const key = `${String(where).slice(0, 20)}:${String(code).slice(0, 60)}`;
      if (errorsSeen.has(key)) return;
      errorsSeen.add(key);
      if (track('app_error', { where: String(where).slice(0, 20), code: String(code).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) })) await flush();
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
        // B-203: the server's errors of yesterday, one event per class and code (growth reads string properties).
        for (const props of cleanErrors(counts && counts.errors)) track('server_error', props);
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
     * This product's switch (B-200: per product; the shared file keeps only the shared id). On counts the install
     * once and starts from the counts seen next, so nothing done while off is reported later; off drops everything
     * still waiting and sends nothing more, the baseline included.
     */
    async setEnabled(enabled) {
      if (!bundle) return false;
      noticeDue = false;
      if (enabled) {
        const installation = await ensureInstallation({ fs, file: shared, uuid, now }).catch(() => null);
        if (!installation || installation.state !== 'ok') return false;
        await loadState();
        await choose(false);
        if (installId) return true;
        state.counts = null;
        await begin(installation, launchOptions);
        return true;
      }
      queue = [];
      installId = null;
      baseline = false;
      await choose(true);
      return true;
    },
  };
}

/**
 * Reads how many Gmail accounts, Cloudflare mailboxes, agents and agent keys the signed-in server
 * has, with the mail window's own session, once a day, and yesterday's error counts (B-203: classes, codes and
 * numbers, which cleanErrors checks again). Only lengths and those counts leave this function. Null when the person
 * is not signed in or the server answers nothing usable.
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
    const [accounts, mailboxes, agents, keys, errors] = await Promise.all(['/api/accounts', '/api/v1/mailboxes', '/api/agents', '/api/agent-keys', '/api/server-errors'].map(read));
    const counts = {};
    if (accounts && Array.isArray(accounts.accounts)) counts.gmail = accounts.accounts.length;
    if (Array.isArray(mailboxes)) counts.cloudflare = mailboxes.length;
    if (agents && Array.isArray(agents.agents)) counts.agents = agents.agents.length;
    if (keys && Array.isArray(keys.keys)) counts.agent_keys = keys.keys.length;
    // B-203: the server's own error counts of yesterday (a server older than 0.90.0 answers 404: none).
    if (errors && typeof errors === 'object' && typeof errors.day === 'string' && errors.counts && typeof errors.counts === 'object') counts.errors = { day: errors.day, counts: errors.counts };
    return Object.keys(counts).length ? counts : null;
  };
}

module.exports = { createAnalytics, countsWith, cleanErrors, readBundledKey, analyticsOrigin, readInstallation, ensureInstallation, writeSwitch, installationFile, stateFile, SDK, BATCH, KEY };
