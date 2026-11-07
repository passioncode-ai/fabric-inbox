'use strict';
// B-233 (SCN-099): the mail of every server the app holds, in one list. All effects go through the
// fabricAll bridge (all-servers-preload.cjs); this page has no network access (CSP).
const $ = (selector) => document.querySelector(selector);

let MESSAGES = {};
const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)) : text);
function t(source, params) { return fill(Object.prototype.hasOwnProperty.call(MESSAGES, source) ? MESSAGES[source] : source, params); }

let data = { servers: [], messages: [] };
let loading = false;

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'text') node.textContent = value;
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    else node.setAttribute(key, value);
  }
  for (const child of children || []) if (child) node.append(child);
  return node;
}
function notice(text) { const n = $('#notice'); n.textContent = text || ''; n.hidden = !text; }

/** `Name <address>` shows the name; a bare address shows itself. */
function who(sender) {
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(String(sender || '').trim());
  return (m && (m[1].trim() || m[2].trim())) || String(sender || '');
}
function when(at) {
  if (!at) return '';
  const d = new Date(at), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(document.documentElement.lang, { day: 'numeric', month: 'short' });
}

function renderServers() {
  const pick = $('#server');
  const current = pick.value;
  pick.replaceChildren(el('option', { value: '', text: t('All servers') }), ...data.servers.map((s) => el('option', { value: s.origin, text: s.label })));
  pick.value = data.servers.some((s) => s.origin === current) ? current : '';
  $('#servers').replaceChildren(...data.servers.map((s) => {
    if (s.state === 'signed_out') return el('li', { class: 'problem' }, [el('span', { text: t('Sign in to {server}', { server: s.label }) }),
      el('button', { type: 'button', class: 'secondary', text: t('Sign In'), on: { click: () => void window.fabricAll.signIn(s.origin) } })]);
    if (s.state === 'unreachable') return el('li', { class: 'problem' }, [el('span', { text: t('{server}: not reachable now', { server: s.label }) }),
      el('button', { type: 'button', class: 'secondary', text: t('Retry'), on: { click: () => void load() } })]);
    return el('li', { text: s.unread ? t('{server}: {n} unread', { server: s.label, n: s.unread }) : t('{server}: nothing unread', { server: s.label }) });
  }));
}

function renderList() {
  const origin = $('#server').value, unreadOnly = $('#unread').checked;
  const rows = data.messages.filter((m) => (!origin || m.origin === origin) && (!unreadOnly || !m.read));
  const list = $('#list');
  if (!rows.length) { list.replaceChildren(el('li', { class: 'empty', text: loading ? t('Reading your servers…') : t('No mail here') })); return; }
  list.replaceChildren(...rows.map((m) => el('li', { class: m.read ? '' : 'unread' }, [
    el('button', { type: 'button', class: 'row', 'aria-label': t('{sender}: {subject}, on {server}', { sender: who(m.sender), subject: m.subject || t('(No subject)'), server: m.server }),
      on: { click: () => void window.fabricAll.open(m.origin, m.link) } }, [
      el('span', { class: 'who', text: who(m.sender) }),
      el('span', { class: 'text' }, [el('span', { class: 'subject', text: m.subject || t('(No subject)') }), el('span', { class: 'snippet', text: m.snippet })]),
      el('span', { class: 'meta' }, [el('span', { class: 'server', text: m.server }), el('span', { text: when(m.at) })]),
    ]),
  ])));
}

async function load() {
  loading = true; notice(''); renderList();
  try { data = (await window.fabricAll.read()) || { servers: [], messages: [] }; }
  catch { notice(t('Something went wrong. Try again.')); }
  loading = false;
  renderServers(); renderList();
}

function labels() {
  document.title = t('All Servers');
  $('#title').textContent = t('Mail on all your servers');
  $('#server-label').textContent = t('Server');
  $('#unread-label').textContent = t('Unread only');
  $('#refresh').textContent = t('Refresh');
}

$('#server').addEventListener('change', renderList);
$('#unread').addEventListener('change', renderList);
$('#refresh').addEventListener('click', () => void load());
window.addEventListener('focus', () => { if (!loading) void load(); });
window.fabricAll.locale()
  .then((lang) => { if (lang && lang.locale === 'ru' && lang.messages && typeof lang.messages === 'object') { MESSAGES = lang.messages; document.documentElement.lang = 'ru'; } })
  .catch(() => {})
  .then(() => { labels(); return load(); });
