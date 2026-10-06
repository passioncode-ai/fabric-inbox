'use strict';
// Connect a local hub to Fabric Inbox by the product's own consent (ADR-0115 §4 in
// passioncode-ai/fabric). A `fabric-inbox://connect` link asks; a person allows in this app; the
// app makes the key through the owner's own signed-in session — the route a person uses on Agent
// access — and hands it to a loopback callback, once. A key nobody received is revoked at once.
// Electron is passed in (session, dialog), so this file runs in tests without it. What the person
// reads is in the app's language (desktop/i18n.cjs); what the hub hears stays codes.
const { t } = require('./i18n.cjs');

const LEVELS = {
  read: () => t('Read — reads and searches mail and sees how everything is set up. Changes nothing.'),
  mail: () => t('Mail — also drafts, moves and marks mail and reports spam. Changes no settings.'),
  admin: () => t('Admin — everything the app does: mail, addresses and domains on Cloudflare, forwarding, spam lists, agents, categories, knowledge and rules. It can send.'),
};
const CLIENT_ID = /^[a-z][a-z0-9-]{1,62}$/;
const STATE = /^[A-Za-z0-9_-]{22,128}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Reads a connect link strictly; anything unexpected is a refusal, never a guess. */
function parseConnectLink(value) {
  let url;
  try { url = new URL(String(value)); } catch { return { ok: false, error: t('This is not a connect link.') }; }
  if (url.protocol !== 'fabric-inbox:' || url.hostname !== 'connect') return { ok: false, error: t('This is not a Fabric Inbox connect link.') };
  const q = url.searchParams;
  const client = (q.get('client') || '').trim();
  if (!client || client.length > 80 || /[\u0000-\u001f\u007f]/.test(client)) return { ok: false, error: t('The link does not say who is asking.') };
  const clientId = q.get('client_id') || '';
  if (!CLIENT_ID.test(clientId)) return { ok: false, error: t('The link names no valid client id.') };
  const level = q.get('level') || '';
  if (!Object.prototype.hasOwnProperty.call(LEVELS, level)) return { ok: false, error: t('The link asks for an unknown level.') };
  const askedSend = q.get('send') === 'send' ? 'send' : 'drafts';
  const send = level === 'read' ? 'drafts' : level === 'admin' ? 'send' : askedSend;
  const state = q.get('state') || '';
  if (!STATE.test(state)) return { ok: false, error: t('The link carries no valid request id.') };
  let callback;
  try { callback = new URL(q.get('callback') || ''); } catch { return { ok: false, error: t('The link has no callback on this Mac.') }; }
  // The key leaves this app only for this Mac: an http loopback address with an explicit port.
  if (callback.protocol !== 'http:' || !LOOPBACK.has(callback.hostname) || !callback.port || callback.username || callback.password || callback.hash)
    return { ok: false, error: t('The link asks to send the key somewhere other than this Mac.') };
  return { ok: true, value: { client, clientId, level, send, callback: callback.href, state } };
}

/** What the person is asked: who, what, where the key goes. Deny is the default. */
function promptFor(request, config) {
  const host = new URL(config.origin).host;
  const target = new URL(request.callback).host;
  return {
    title: t('Connect {client}?', { client: request.client }),
    message: t('{client} asks to work with your mail on {host}.', { client: request.client, host }),
    detail: `${LEVELS[request.level]()}\n\n${t('It gets its own key, which is sent only to this Mac ({target}). You can see and revoke it in Settings → Agent access.', { target })}`,
    buttons: [t('Deny'), t('Allow')], defaultId: 0, cancelId: 0,
  };
}

/** Makes a key with the owner's session (the Agent access route); a redirect or a page means sign in again. */
function mintWith(ses, origin) {
  return async (input) => {
    const response = await ses.fetch(new URL('/api/agent-keys', origin).href, {
      method: 'POST', redirect: 'manual', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if ((response.status >= 300 && response.status < 400) || response.status === 401 || !type.includes('json')) return { ok: false, signIn: true };
    const data = await response.json().catch(() => null);
    if (response.status === 201 && data && data.key && data.clientSecret) return { ok: true, data };
    return { ok: false, error: (data && typeof data.error === 'string' && data.error) || t('The server answered {status}.', { status: response.status }) };
  };
}

function revokeWith(ses, origin) {
  return async (id) => {
    const response = await ses.fetch(new URL(`/api/agent-keys/${encodeURIComponent(id)}`, origin).href, { method: 'DELETE', redirect: 'manual', credentials: 'include' });
    return response.status >= 200 && response.status < 300;
  };
}

/** Posts to the loopback callback; only a 2xx within the time limit counts as received. */
function deliverTo(callback, { fetch: doFetch = fetch, timeoutMs = 10000 } = {}) {
  return async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      return response.status >= 200 && response.status < 300;
    } catch { return false; }
    finally { clearTimeout(timer); }
  };
}

/**
 * The whole exchange. Returns { outcome: 'connected' | 'denied' | 'failed', reason? }.
 * The hub always hears the outcome; a secret is never logged.
 */
async function connect({ request, config, confirm, mint, revoke, deliver, signIn, log = () => {} }) {
  const say = (event, extra = {}) => log(JSON.stringify({ event: `connect.${event}`, client: request.clientId, level: request.level, ...extra }));
  if (!config) {
    await deliver({ state: request.state, outcome: 'failed', error: 'no_server' });
    say('refused', { reason: 'no_server' });
    return { outcome: 'failed', reason: 'no_server' };
  }
  if (!(await confirm(promptFor(request, config)))) {
    await deliver({ state: request.state, outcome: 'denied' });
    say('denied');
    return { outcome: 'denied' };
  }
  let minted;
  try { minted = await mint({ name: request.client, level: request.level, send: request.send, duration: '1y' }); }
  catch (error) { minted = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!minted.ok) {
    const reason = minted.signIn ? 'sign_in_required' : 'mint_failed';
    await deliver({ state: request.state, outcome: 'failed', error: reason });
    if (minted.signIn) await signIn();
    say('failed', { reason, detail: minted.error ? String(minted.error).slice(0, 200) : undefined });
    return { outcome: 'failed', reason, error: minted.error };
  }
  const { key, clientSecret, mcpUrl } = minted.data;
  const received = await deliver({ state: request.state, outcome: 'connected', server: config.origin, mcpUrl,
    key: { id: key.id, clientId: key.clientId, level: key.level, send: key.send, expiresAt: key.expiresAt ?? null }, clientSecret });
  if (!received) {
    const revoked = await revoke(key.id).catch(() => false);
    say('failed', { reason: 'callback_unreachable', keyId: key.id, revoked });
    return { outcome: 'failed', reason: 'callback_unreachable', revoked };
  }
  say('connected', { keyId: key.id });
  return { outcome: 'connected', keyId: key.id };
}

module.exports = { parseConnectLink, promptFor, mintWith, revokeWith, deliverTo, connect, SCHEME: 'fabric-inbox' };
