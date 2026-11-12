'use strict';
// B-236 (SCN-092; the organization service's request of 2026-11-11 for its onboarding): an agent on this Mac puts a
// server's address in the app by a `fabric-inbox://server` link, as the person does with Add Another Server. The
// person is asked first, as for a connect link: the name the link carries is chosen by whoever opened it, so the
// dialog shows the server's own host and Deny is the default. Nothing leaves this app: no key is made, and the
// person still signs in to the server as usual. Pure apart from `t`: main.cjs shows the dialog and saves the server.
const { t } = require('./i18n.cjs');

/** Reads a server link strictly; `validate` is policy.validateConfig. Anything unexpected is a refusal, never a guess. */
function parseServerLink(value, validate) {
  let url;
  try { url = new URL(String(value)); } catch { return { ok: false, error: t('This is not a Fabric Inbox server link.') }; }
  if (url.protocol !== 'fabric-inbox:' || url.hostname !== 'server' || url.username || url.password || url.hash)
    return { ok: false, error: t('This is not a Fabric Inbox server link.') };
  const q = url.searchParams;
  const from = (q.get('from') || '').trim();
  if (from.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(from)) return { ok: false, error: t('The name in the link cannot be shown.') };
  let server;
  try { server = validate({ origin: q.get('origin') || '', accessOrigin: q.get('access') || '' }); }
  catch { return { ok: false, error: t('The link names no server address this app can use.') }; }
  return { ok: true, value: { ...server, from } };
}

/** What the person is asked before a server is added. Deny is the default. */
function promptFor(request) {
  const host = new URL(request.origin).host;
  return {
    type: 'question',
    title: t('Add the server {host}?', { host }),
    message: t('Add the server {host}?', { host }),
    detail: [request.from ? t('The link calls itself “{from}”.', { from: request.from }) : t('A link on this Mac asks to add it.'),
      t('You sign in to it as usual; the servers you hold now stay as they are. Add it only if you expect this server.')].join('\n\n'),
    buttons: [t('Deny'), t('Add Server')], defaultId: 0, cancelId: 0,
  };
}

/**
 * What a link does: `refuse` (a bad link), `show` (a server already held: shown, nothing asked), or `ask` (a new one:
 * added only when the person allows). `held` is the list of origins the app holds.
 */
function planFor(parsed, held) {
  if (!parsed.ok) return { action: 'refuse', error: parsed.error };
  return held.includes(parsed.value.origin) ? { action: 'show', server: parsed.value } : { action: 'ask', server: parsed.value };
}

module.exports = { parseServerLink, promptFor, planFor };
