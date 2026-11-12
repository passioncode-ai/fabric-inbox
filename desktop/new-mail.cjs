'use strict';
// B-41 (operator, 2026-10-22: "да, но выключены по дефолту"): a system notification for new mail.
// Off until the person turns it on (the app menu's Notify About New Mail); the choice is the file
// `new-mail-notifications` in the profile ("on"). While on, the main process reads the inbox's unread
// mail of every server the app holds (B-233 part 2), each through its own signed-in session, every
// CHECK_EVERY_MS (one unref'd timer, also with no window), and shows one notification per new message, or
// one summary for many; a message opens on its own server. The first read of a server after turning it on,
// after a launch or after the server was added, only learns what is already there, so nothing old is
// announced. Pure: main.cjs passes the servers, the reader, the notifier and the clock; tests pass fakes.

const path = require('node:path');

const SWITCH_FILE = 'new-mail-notifications';
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;
/** More new messages than this at once make one summary instead of one notification each. */
const SINGLE_MAX = 3;
const PAGE_SIZE = 20;
const INBOX_PATH = `/api/inbox?folder=inbox&unread=1&limit=${PAGE_SIZE}`;
/** How many message keys are remembered as seen. */
const SEEN_MAX = 500;

/** The sender's name from `Name <address>`, else the address. */
function senderName(sender) {
  const s = String(sender || '').trim();
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(s);
  return (m && (m[1].trim() || m[2].trim())) || s || '';
}

/** The inbox link that opens one message (shared/mail/open-link.ts, kept in step by a test). */
function messageLink(accountId, providerMessageId) {
  const q = new URLSearchParams({ open: `${accountId}|${providerMessageId}` });
  return '/?' + q.toString().replace(/\+/g, '%20');
}

/**
 * deps: servers() → [{ origin, label }] (the servers the app holds; one without origin for a single-server caller),
 * read(origin, path) → the JSON body or null, open(origin, link), openAll() (the inbox with All chosen, when several
 * servers have new mail), focused() → the origin the person is looking at in the mail window, or null.
 */
function createNewMailNotifier(deps) {
  const { fs, userData, notify, t, now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), log = () => {} } = deps;
  // The single-server shape (read(path), open(link), focused() → boolean) is one server with no origin.
  const servers = deps.servers || (() => [{ origin: '', label: '' }]);
  const read = deps.servers ? deps.read : (_origin, pathname) => deps.read(pathname);
  const open = deps.servers ? deps.open : (_origin, link) => deps.open(link);
  const openAll = deps.openAll || (() => {});
  const focusedOn = deps.servers ? (deps.focused || (() => null)) : () => ((deps.focused || (() => false))() ? '' : null);
  const file = path.join(userData, SWITCH_FILE);
  let enabled = false;
  let timer = null;
  // What was seen, per server: each message's keys (its Message-ID, and its row), the last SEEN_MAX of them. A
  // timestamp watermark missed account mail that synced after a newer Cloudflare message (N-5) and announced a copy
  // twice when its merged row changed id (N-6). `floor`: older than the first page's oldest is old mail.
  let known = new Map();
  let generation = 0;
  let lastOutcome = '';

  const say = (outcome, extra = {}) => { if (outcome !== lastOutcome) log({ event: 'new_mail_check', outcome, ...extra }); lastOutcome = outcome; };
  function schedule(ms) {
    if (timer) clearTimer(timer);
    timer = enabled ? setTimer(() => { timer = null; void check().finally(() => schedule(CHECK_EVERY_MS)); }, ms) : null;
    if (timer && timer.unref) timer.unref();
  }
  // The same email in two inboxes shares its Message-ID (the feed merges them under one row, `alsoIn`).
  const keysOf = (m) => [`row:${m.accountId}|${m.providerMessageId}`, ...(m.rfcMessageId ? [`rfc:${m.rfcMessageId}`] : [])];
  function remember(state, keys) {
    for (const k of keys) { state.seen.delete(k); state.seen.add(k); }
    while (state.seen.size > SEEN_MAX) state.seen.delete(state.seen.values().next().value);
  }

  /** One server's new unread messages since its last read; null when it could not be read. */
  async function checkServer(server, mine) {
    let page;
    try { page = await read(server.origin, INBOX_PATH); } catch { page = null; }
    // N-7: switched off while this read was out: its answer is stale.
    if (!enabled || mine !== generation) return [];
    if (!page || !Array.isArray(page.messages)) return null;
    const messages = page.messages.filter((m) => m && !m.read && typeof m.providerMessageId === 'string' && typeof m.accountId === 'string')
      .map((m) => ({ ...m, at: Number(m.timestamp) || Date.parse(m.date) || 0, origin: server.origin, server: server.label }));
    let state = known.get(server.origin);
    if (!state) {
      state = { seen: new Set(), floor: messages.length >= PAGE_SIZE ? messages.reduce((n, m) => Math.min(n, m.at), Infinity) : 0 };
      for (const m of messages) remember(state, keysOf(m));
      known.set(server.origin, state);
      return [];
    }
    const fresh = messages.filter((m) => m.at >= state.floor && !keysOf(m).some((k) => state.seen.has(k)));
    for (const m of messages) remember(state, keysOf(m));
    return fresh;
  }

  /** One read of every server: new unread messages since the last one, announced unless the person is looking at that server's inbox. */
  async function check() {
    if (!enabled) return [];
    const mine = generation;
    const list = servers();
    // A server the app no longer holds is forgotten, so holding it again starts from what is there then.
    for (const origin of [...known.keys()]) if (!list.some((s) => s.origin === origin)) known.delete(origin);
    const firstRead = list.every((s) => !known.has(s.origin));
    const answers = await Promise.all(list.map((s) => checkServer(s, mine)));
    if (!enabled || mine !== generation) return [];
    if (answers.every((a) => a === null)) { say('unreadable'); return []; }
    if (firstRead) { say('baseline'); return []; }
    const fresh = answers.flatMap((a) => a || []).sort((a, b) => a.at - b.at);
    if (!fresh.length) { say('none'); return []; }
    say('new', { count: fresh.length, servers: new Set(fresh.map((m) => m.origin)).size });
    // The person is looking at one server's inbox: it shows that server's mail already; the others are announced.
    const looking = focusedOn();
    const told = fresh.filter((m) => looking === null || m.origin !== looking);
    const several = list.length > 1;
    if (told.length && told.length <= SINGLE_MAX) {
      for (const m of told) notify(senderName(m.sender) || t('New mail'), [m.subject || t('(No subject)'), several ? m.server : ''].filter(Boolean).join('\n'),
        () => open(m.origin, messageLink(m.accountId, m.providerMessageId)));
    } else if (told.length) {
      const names = [...new Set(told.map((m) => senderName(m.sender)).filter(Boolean))].slice(0, 3).join(', ');
      const origins = [...new Set(told.map((m) => m.origin))];
      notify(t('New messages: {n}', { n: told.length }), names, () => (origins.length === 1 ? open(origins[0], '/') : openAll()));
    }
    return fresh;
  }

  return {
    /** At launch: reads the switch; starts reading the inbox only when it is on. */
    async start() {
      try { enabled = (await fs.readFile(file, 'utf8')).trim() === 'on'; } catch { enabled = false; }
      log({ event: 'new_mail_notifications', outcome: enabled ? 'on' : 'off' });
      known = new Map(); generation++;
      schedule(FIRST_CHECK_MS);
    },
    enabled: () => enabled,
    /** The menu switch. Turning it on learns what is there first, so nothing already waiting is announced. */
    async setEnabled(on) {
      try {
        await fs.mkdir(userData, { recursive: true, mode: 0o700 });
        await fs.writeFile(file, on ? 'on\n' : 'off\n', { mode: 0o600 });
      } catch (error) { log({ event: 'new_mail_notifications', outcome: 'not_saved', code: (error && error.code) || 'error' }); return false; }
      enabled = !!on;
      known = new Map(); generation++;
      lastOutcome = '';
      log({ event: 'new_mail_notifications', outcome: enabled ? 'on' : 'off' });
      if (enabled) { await check(); schedule(CHECK_EVERY_MS); } else schedule(0);
      return true;
    },
    /** Forgets what was seen (every server is read again from what is there). Switching servers no longer needs it: each is kept apart. */
    reset() { known = new Map(); generation++; },
    check,
  };
}

module.exports = { createNewMailNotifier, senderName, messageLink, SWITCH_FILE, FIRST_CHECK_MS, CHECK_EVERY_MS, SINGLE_MAX, INBOX_PATH };
