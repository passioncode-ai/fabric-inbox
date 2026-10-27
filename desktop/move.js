'use strict';
// B-158 M1 step 3d (SCN-094): moving an address from the server shown to another server the app holds.
// All effects go through the narrow fabricMove bridge (move-preload.cjs); this page has no network access (CSP).
const $ = (selector) => document.querySelector(selector);

let MESSAGES = {};
let LOCALE = 'en';
const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)) : text);
function t(source, params) { return fill(Object.prototype.hasOwnProperty.call(MESSAGES, source) ? MESSAGES[source] : source, params); }

/** The stages a person sees, in order (desktop/move.cjs STAGES, grouped). */
const STEPS = [
  { stages: ['copy', 'setup', 'labels', 'precheck'], label: () => t('Copying the mail, rules, agent and labels') },
  { stages: ['hold', 'settle', 'catchup', 'check'], label: () => t('Holding this server\'s copy') },
  { stages: ['route'], label: () => t('Sending the mail to the other server') },
  { stages: ['test'], label: () => t('Checking that a test message arrives') },
];

let view = { pending: null, from: null, addresses: null, targets: [] };

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
const button = (label, fn, cls) => el('button', { type: 'button', class: cls || 'secondary', text: label, on: { click: fn } });
function show(...nodes) { const root = $('#view'); root.replaceChildren(...nodes); const h = root.querySelector('h1'); if (h) { h.tabIndex = -1; h.focus(); } }
function notice(text) { const n = $('#notice'); n.textContent = text || ''; n.hidden = !text; }
const labelOf = (origin) => (view.targets.find((s) => s.origin === origin) || (view.from && view.from.origin === origin ? view.from : null) || { label: origin }).label;

async function act(fn) {
  notice('');
  try { render(await fn()); } catch { notice(t('Something went wrong. Try again.')); }
}

function pick() {
  if (!view.addresses) return show(el('h1', { text: t('Move an address') }), el('p', { class: 'lead', text: t('The addresses of this server could not be read. Check that you are signed in, then try again.') }),
    button(t('Try Again'), () => void load(), 'primary'));
  if (!view.addresses.length) return show(el('h1', { text: t('Move an address') }), el('p', { class: 'lead', text: t('This server has no Cloudflare addresses to move.') }));
  const address = el('select', { id: 'address', 'aria-label': t('Address') }, view.addresses.map((a) => el('option', { value: a, text: a })));
  const target = el('select', { id: 'target', 'aria-label': t('Move to') }, view.targets.map((s) => el('option', { value: s.origin, text: s.label })));
  show(el('h1', { text: t('Move an address') }),
    el('p', { class: 'lead', text: t('Its mail, files, folders, rules, agent with its knowledge and category labels go to the other server, and its mail arrives there from then on. Both servers must be in the same Cloudflare account. A Gmail, Outlook or IMAP account is not moved: connect it again on the other server.') }),
    el('label', { for: 'address', text: t('Address') }), address,
    el('label', { for: 'target', text: t('Move to') }), target,
    el('div', { class: 'actions' }, [button(t('Next'), () => void summary(address.value, target.value), 'primary')]));
}

async function summary(address, to) {
  notice('');
  const preview = await window.fabricMove.preview(address);
  if (!preview || preview.error) return notice(preview && preview.error ? preview.error : t('This address could not be read. Try again.'));
  show(el('h1', { text: t('Move {address} to {server}?', { address, server: labelOf(to) }) }),
    el('ul', {}, [
      el('li', { text: t('Messages: {emails}, attachments: {attachments}, with their folders', { emails: preview.counts.emails, attachments: preview.counts.attachments }) }),
      el('li', { text: t('Its rules, its agent with its knowledge, and its category labels') }),
      el('li', { text: t('From then on its mail arrives at {server}.', { server: labelOf(to) }) }),
      el('li', { text: t('This server keeps its copy and sends nothing from it, until you remove it here yourself.') }),
    ]),
    el('div', { class: 'actions' }, [button(t('Back'), () => pick()), button(t('Move'), () => void act(() => window.fabricMove.start(address, to)), 'primary')]));
}

function progress(state) {
  const at = STEPS.findIndex((s) => s.stages.includes(state.stage));
  const copied = (state.copied && state.copied.emails) || 0;
  const total = state.counts ? state.counts.emails : null;
  const items = STEPS.map((s, i) => el('li', { class: i < at ? 'done' : i === at ? 'current' : 'todo', 'aria-current': i === at ? 'step' : 'false', text: s.label() }));
  return [el('ol', { class: 'steps' }, items),
    total !== null && at === 0 ? el('p', { text: t('Messages copied: {copied} of {total}', { copied: Math.min(copied, total), total }) }) : null];
}

const ERRORS = {
  counts: () => t('The copy does not have every message yet. Nothing changed on this server; Try Again copies what is missing.'),
  still_busy: () => t('This server is still sending or receiving mail for this address. Wait longer, or put everything back.'),
  not_arrived: () => t('The test message has not arrived at the other server. Wait longer, or put the mail back here.'),
  test_failed: () => t('The test message could not be sent. Put the mail back here, or try again.'),
  signed_out: () => t('You are signed out of one of the servers. Sign in there, then try again.'),
  too_large: () => t('One attachment is larger than a move carries. Try again, or put everything back.'),
  cannot_route: () => t('The other server cannot take this address\'s mail: it is in another Cloudflare account, or its Cloudflare connection is missing. Nothing changed on this server.'),
};

function render(state) {
  if (!state) return pick();
  const head = (text) => el('h1', { text });
  if (state.stage === 'done') {
    return show(head(t('Mail for {address} now arrives at {server}', { address: state.address, server: labelOf(state.to) })),
      el('p', { class: 'lead', text: t('Every message is there, and a test message arrived. This server keeps its copy and sends nothing from it.') }),
      state.refusedRules.length ? el('p', { text: t('Rules not copied, as that server does not allow their tools: {n}', { n: state.refusedRules.length }) }) : null,
      state.skippedLabels ? el('p', { text: t('Category labels not copied, as that server has no matching category: {n}', { n: state.skippedLabels }) }) : null,
      el('div', { class: 'actions' }, [
        state.agentId ? button(t('Answer With Its Agent There'), () => void window.fabricMove.chooseAgent().then((ok) => notice(ok ? t('Its agent answers there now.') : t('The agent could not be chosen. Choose it in that server\'s Settings.')))) : null,
        button(t('Show That Server'), () => void window.fabricMove.showTarget()),
        button(t('Done'), () => void window.fabricMove.dismiss().then(() => window.close()), 'primary')]));
  }
  if (state.stage === 'back') {
    return show(head(t('Mail for {address} arrives here again', { address: state.address })),
      el('p', { class: 'lead', text: t('The mail goes to this server as before, and it sends again. The copy on the other server stays there.') }),
      el('div', { class: 'actions' }, [button(t('Done'), () => void window.fabricMove.dismiss().then(() => window.close()), 'primary')]));
  }
  const nodes = [head(t('Moving {address}', { address: state.address })), ...progress(state)];
  if (state.error) {
    const text = (ERRORS[state.error.code] || (() => t('This step stopped: {detail}', { detail: state.error.detail })))();
    nodes.push(el('p', { class: 'error', role: 'alert', text }));
    const actions = [];
    if (state.error.code === 'not_arrived' || state.error.code === 'still_busy') actions.push(button(t('Wait Longer'), () => void act(() => window.fabricMove.waitLonger()), 'primary'));
    else actions.push(button(t('Try Again'), () => void act(() => window.fabricMove.continue()), 'primary'));
    if (state.held || state.routed) actions.push(button(t('Put It Back'), () => void act(() => window.fabricMove.putBack())));
    // Cancel: nothing on this server changed yet; the copy on the other server stays there.
    else actions.push(button(t('Cancel'), () => void window.fabricMove.dismiss().then(load)));
    nodes.push(el('div', { class: 'actions' }, actions));
  } else nodes.push(el('p', { class: 'muted', text: t('You can close this window; the move goes on while the app is open, and continues from here when you open it again.') }));
  show(...nodes);
}

async function load() {
  view = (await window.fabricMove.state()) || view;
  if (view.pending && view.pending.stage !== null) {
    render(view.pending);
    if (!view.pending.error && view.pending.stage !== 'done' && view.pending.stage !== 'back') void act(() => window.fabricMove.continue());
  } else pick();
}

window.fabricMove.onProgress((state) => { view.pending = state; render(state); });
window.fabricMove.locale()
  .then((lang) => { if (lang && lang.locale === 'ru' && lang.messages && typeof lang.messages === 'object') { LOCALE = 'ru'; MESSAGES = lang.messages; document.documentElement.lang = LOCALE; } })
  .catch(() => {})
  .then(load);
