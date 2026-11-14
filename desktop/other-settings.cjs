'use strict';
/**
 * S11 (B-276, SCN-099): Settings → Accounts, Addresses and Domains under All list every server the app holds. This reads
 * the other servers for the page's bridge (main.cjs `fabric:other-settings`): each through its own session (its own
 * sign-in), once when the list opens and again on Retry, never on a timer. Nothing is copied between servers; an item
 * of another server opens in that server's own Settings. One server that is signed out or does not answer never hides
 * the others: it gets a state of its own, as all-servers.cjs's readAll does for the inbox.
 *
 * Pure apart from what is passed in: `read(origin, path)` answers { status, body } (status 401 for a sign-in
 * redirect), as main.cjs's serverApi does; tests pass fakes.
 */

const KINDS = Object.freeze(['accounts', 'addresses', 'domains']);
const PATHS = Object.freeze({ accounts: '/api/accounts', addresses: '/api/project-addresses', domains: '/api/domains' });
/** How many items of one server the list keeps. */
const ITEMS_MAX = 500;

const text = (value) => (typeof value === 'string' ? value : '');

/** One server's items for a kind, keyed as its Settings section opens them; null for an answer that is not that list. */
function itemsOf(kind, body) {
  if (!body || typeof body !== 'object') return null;
  if (kind === 'accounts') {
    if (!Array.isArray(body.accounts)) return null;
    return body.accounts.filter((a) => a && typeof a.id === 'string' && a.id).map((a) => {
      const provider = a.provider === 'imap' || a.provider === 'outlook' ? a.provider : 'gmail';
      return { id: `${provider}:${a.id}`, title: text(a.email) || a.id, detail: text(a.providerName) };
    });
  }
  if (kind === 'addresses') {
    if (!Array.isArray(body.addresses)) return null;
    return body.addresses.filter((a) => a && typeof a.email === 'string' && a.email).map((a) => ({ id: a.email, title: a.email, detail: text(a.domain) }));
  }
  if (kind === 'domains') {
    if (!Array.isArray(body.domains)) return null;
    return body.domains.filter((d) => d && typeof d.domain === 'string' && d.domain).map((d) => ({ id: d.domain, title: d.domain, detail: '', served: !!d.served }));
  }
  return null;
}

/** One server's state from its answer: ok, signed_out (Access sent it to the sign-in page) or unreachable. */
function stateOf(kind, answer) {
  if (!answer) return 'unreachable';
  if (answer.status === 401 || answer.status === 403) return 'signed_out';
  if (answer.status !== 200 || !itemsOf(kind, answer.body)) return 'unreachable';
  return 'ok';
}

/**
 * Reads every server at once. servers: [{ origin, label }]; kind: accounts, addresses or domains.
 * Answers { kind, servers: [{ origin, label, state, items: [{ id, title, detail, served? }] }] }.
 */
async function readSettings({ servers, kind, read }) {
  if (!KINDS.includes(kind)) throw new Error('unknown settings kind');
  const answers = await Promise.all(servers.map(async (s) => {
    let answer;
    try { answer = await read(s.origin, PATHS[kind]); } catch { answer = null; }
    return { server: s, answer };
  }));
  return {
    kind,
    servers: answers.map(({ server, answer }) => {
      const state = stateOf(kind, answer);
      return { origin: server.origin, label: server.label, state, items: state === 'ok' ? itemsOf(kind, answer.body).slice(0, ITEMS_MAX) : [] };
    }),
  };
}

module.exports = { readSettings, itemsOf, stateOf, KINDS, PATHS, ITEMS_MAX };
