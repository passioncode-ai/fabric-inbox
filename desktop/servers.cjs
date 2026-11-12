'use strict';
// B-158 M1 (decision D1 of docs/app-store/tasks/2026-10-27-organizations.md): the servers this app holds. A person's
// own server and every organization's server are each one server with its own sign-in (its partition) and its
// context (`personal` or `org:<id>`, read from GET /api/server once signed in). `server.json` names the one the
// window shows; `servers.json` remembers them all, so switching back keeps the sign-in and nothing is sent again.
// Pure: main.cjs reads and writes the file.

const MAX = 20;
const CONTEXT = /^(?:personal|org:[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const LABEL_MAX = 60;

/**
 * B-244 D-4: the name a person gave a server (`label`), trimmed, with no line breaks or control characters, at most
 * LABEL_MAX characters; null when none was given (the host stands in).
 */
function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? [...text].slice(0, LABEL_MAX).join('') : null;
}

/** The remembered servers from `servers.json`'s parsed value, each checked by `validate` (policy.validateConfig); a bad entry is left out. */
function readList(value, validate) {
  const list = Array.isArray(value?.servers) ? value.servers : [];
  const out = [];
  for (const entry of list) {
    try {
      const checked = validate({ origin: entry?.origin, accessOrigin: entry?.accessOrigin || '' });
      if (out.some((s) => s.origin === checked.origin)) continue;
      const label = cleanLabel(entry?.label);
      out.push({ ...checked, context: typeof entry?.context === 'string' && CONTEXT.test(entry.context) ? entry.context : null, ...(label ? { label } : {}) });
    } catch { /* an entry that is no server is dropped */ }
    if (out.length >= MAX) break;
  }
  return out;
}

/** The list with `server` in it: a known one keeps its place, its name and its context unless a new one is given. */
function remember(list, server, context) {
  const known = list.find((s) => s.origin === server.origin);
  const entry = { origin: server.origin, accessOrigin: server.accessOrigin || '',
    context: typeof context === 'string' && CONTEXT.test(context) ? context : known?.context ?? null,
    ...(known?.label ? { label: known.label } : {}) };
  if (known) return list.map((s) => (s.origin === server.origin ? entry : s));
  return [...list, entry].slice(-MAX);
}

function forget(list, origin) { return list.filter((s) => s.origin !== origin); }

/** B-244 D-4: the list with a held server renamed; an empty name gives it back its host. Unknown origins change nothing. */
function rename(list, origin, label) {
  const name = cleanLabel(label);
  return list.map((s) => {
    if (s.origin !== origin) return s;
    const { label: _old, ...rest } = s;
    return name ? { ...rest, label: name } : rest;
  });
}

/** What the menu and the inbox's tabs call a server: the name the person gave it, else its host and, for an organization's server, that it is one. */
function labelFor(server, t) {
  if (server.label) return server.label;
  const host = new URL(server.origin).host;
  return server.context && server.context !== 'personal' ? t('{host} (organization)', { host }) : host;
}

module.exports = { readList, remember, forget, rename, labelFor, cleanLabel, MAX, LABEL_MAX };
