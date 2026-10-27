'use strict';
// B-158 M1 (decision D1 of docs/app-store/tasks/2026-10-27-organizations.md): the servers this app holds. A person's
// own server and every organization's server are each one server with its own sign-in (its partition) and its
// context (`personal` or `org:<id>`, read from GET /api/server once signed in). `server.json` names the one the
// window shows; `servers.json` remembers them all, so switching back keeps the sign-in and nothing is sent again.
// Pure: main.cjs reads and writes the file.

const MAX = 20;
const CONTEXT = /^(?:personal|org:[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

/** The remembered servers from `servers.json`'s parsed value, each checked by `validate` (policy.validateConfig); a bad entry is left out. */
function readList(value, validate) {
  const list = Array.isArray(value?.servers) ? value.servers : [];
  const out = [];
  for (const entry of list) {
    try {
      const checked = validate({ origin: entry?.origin, accessOrigin: entry?.accessOrigin || '' });
      if (out.some((s) => s.origin === checked.origin)) continue;
      out.push({ ...checked, context: typeof entry?.context === 'string' && CONTEXT.test(entry.context) ? entry.context : null });
    } catch { /* an entry that is no server is dropped */ }
    if (out.length >= MAX) break;
  }
  return out;
}

/** The list with `server` in it: a known one keeps its place and its context unless a new one is given. */
function remember(list, server, context) {
  const known = list.find((s) => s.origin === server.origin);
  const entry = { origin: server.origin, accessOrigin: server.accessOrigin || '',
    context: typeof context === 'string' && CONTEXT.test(context) ? context : known?.context ?? null };
  if (known) return list.map((s) => (s.origin === server.origin ? entry : s));
  return [...list, entry].slice(-MAX);
}

function forget(list, origin) { return list.filter((s) => s.origin !== origin); }

/** What the menu calls a server: its host, and for an organization's server that it is one. */
function labelFor(server, t) {
  const host = new URL(server.origin).host;
  return server.context && server.context !== 'personal' ? t('{host} (organization)', { host }) : host;
}

module.exports = { readList, remember, forget, labelFor, MAX };
