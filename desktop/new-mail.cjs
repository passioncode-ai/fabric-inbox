'use strict';
// B-41 (operator, 2026-10-22: "да, но выключены по дефолту"): a system notification for new mail.
// Off until the person turns it on (the app menu's Notify About New Mail); the choice is the file
// `new-mail-notifications` in the profile ("on"). While on, the main process reads the inbox's unread
// mail through the mail window's session every CHECK_EVERY_MS (one unref'd timer, also with no window)
// and shows one notification per new message, or one summary for many. The first read after turning
// it on, or after a launch, only learns what is already there, so nothing old is announced. Pure:
// main.cjs passes the reader, the notifier and the clock; tests pass fakes.

const path = require('node:path');

const SWITCH_FILE = 'new-mail-notifications';
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;
/** More new messages than this at once make one summary instead of one notification each. */
const SINGLE_MAX = 3;
const INBOX_PATH = '/api/inbox?folder=inbox&unread=1&limit=20';

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

function createNewMailNotifier(deps) {
  const { fs, userData, read, notify, open, t, focused = () => false, now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), log = () => {} } = deps;
  const file = path.join(userData, SWITCH_FILE);
  let enabled = false;
  let timer = null;
  let baseline = null;          // { at, ids }: the newest message seen and the ids at that time
  let lastOutcome = '';

  const say = (outcome, extra = {}) => { if (outcome !== lastOutcome) log({ event: 'new_mail_check', outcome, ...extra }); lastOutcome = outcome; };
  function schedule(ms) {
    if (timer) clearTimer(timer);
    timer = enabled ? setTimer(() => { timer = null; void check().finally(() => schedule(CHECK_EVERY_MS)); }, ms) : null;
    if (timer && timer.unref) timer.unref();
  }

  /** One read: new unread messages since the last one, announced unless the person is looking at the app. */
  async function check() {
    if (!enabled) return [];
    let page;
    try { page = await read(INBOX_PATH); } catch { page = null; }
    if (!page || !Array.isArray(page.messages)) { say('unreadable'); return []; }
    const messages = page.messages.filter((m) => m && !m.read && typeof m.providerMessageId === 'string' && typeof m.accountId === 'string')
      .map((m) => ({ ...m, at: Number(m.timestamp) || Date.parse(m.date) || 0 }));
    const newest = messages.reduce((n, m) => Math.max(n, m.at), 0);
    if (!baseline) {
      baseline = { at: newest, ids: new Set(messages.filter((m) => m.at === newest).map((m) => m.id)) };
      say('baseline');
      return [];
    }
    const fresh = messages.filter((m) => m.at > baseline.at || (m.at === baseline.at && !baseline.ids.has(m.id)))
      .sort((a, b) => a.at - b.at);
    if (newest >= baseline.at) {
      const ids = new Set(newest === baseline.at ? baseline.ids : []);
      for (const m of messages) if (m.at === newest) ids.add(m.id);
      baseline = { at: newest, ids };
    }
    if (!fresh.length) { say('none'); return []; }
    say('new', { count: fresh.length });
    if (focused()) return fresh;   // the person is looking at the inbox: it shows them already
    if (fresh.length <= SINGLE_MAX) {
      for (const m of fresh) notify(senderName(m.sender) || t('New mail'), m.subject || t('(No subject)'), () => open(messageLink(m.accountId, m.providerMessageId)));
    } else {
      const names = [...new Set(fresh.map((m) => senderName(m.sender)).filter(Boolean))].slice(0, 3).join(', ');
      notify(t('New messages: {n}', { n: fresh.length }), names, () => open('/'));
    }
    return fresh;
  }

  return {
    /** At launch: reads the switch; starts reading the inbox only when it is on. */
    async start() {
      try { enabled = (await fs.readFile(file, 'utf8')).trim() === 'on'; } catch { enabled = false; }
      log({ event: 'new_mail_notifications', outcome: enabled ? 'on' : 'off' });
      baseline = null;
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
      baseline = null;
      lastOutcome = '';
      log({ event: 'new_mail_notifications', outcome: enabled ? 'on' : 'off' });
      if (enabled) { await check(); schedule(CHECK_EVERY_MS); } else schedule(0);
      return true;
    },
    /** The server changed: what was seen on the old one says nothing about the new one. */
    reset() { baseline = null; },
    check,
  };
}

module.exports = { createNewMailNotifier, senderName, messageLink, SWITCH_FILE, FIRST_CHECK_MS, CHECK_EVERY_MS, SINGLE_MAX, INBOX_PATH };
