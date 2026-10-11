'use strict';
// The agent console's view (B-70, SCN-078): choose the agent and its level, then xterm.js shows the
// PTY the main process runs (desktop/console.cjs). This page has no network and no Node; every
// effect goes through window.fabricConsole (console-preload.cjs).
const $ = (selector) => document.querySelector(selector);

let MESSAGES = {};
const t = (source, params) => {
  const text = Object.prototype.hasOwnProperty.call(MESSAGES, source) ? MESSAGES[source] : source;
  return params ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)) : text;
};
function applyLanguage(locale) {
  document.documentElement.lang = locale;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.textContent.replace(/\s+/g, ' ').trim();
    if (Object.prototype.hasOwnProperty.call(MESSAGES, key)) el.textContent = MESSAGES[key];
  }
}

let term = null;
let fit = null;
let running = false;

function ensureTerminal() {
  if (term) return term;
  term = new window.Terminal({ cursorBlink: true, scrollback: 5000, fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace', fontSize: 13,
    theme: { background: '#111111', foreground: '#e6e6e6' } });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#terminal'));
  term.onData((data) => { if (running) window.fabricConsole.write(data); });
  new ResizeObserver(() => { if (!$('#terminal').hidden) { fit.fit(); window.fabricConsole.resize(term.cols, term.rows); } }).observe($('#terminal'));
  return term;
}

function say(text) { $('#status').textContent = text; }

function show(state) {
  running = state.phase === 'running' || state.phase === 'starting';
  $('#stop').hidden = state.phase !== 'running';
  $('#choose').hidden = running || !state.runtimes?.length;
  $('#none').hidden = running || !!state.runtimes?.length;
  $('#terminal').hidden = !running && state.phase !== 'ended';
  if (state.phase === 'starting') say(t('Making a key for this session…'));
  else if (state.phase === 'running') say(t('{agent} is connected to Fabric Inbox.', { agent: state.runtimeName || state.runtime }));
  else if (state.phase === 'ended') say(state.keyRevoked === false
    ? t('The session ended; its key could not be revoked: revoke it in Settings → Agent access.')
    : state.reason === 'stopped' ? t('Stopped. The session\'s key was revoked.') : t('The agent exited (code {code}). The session\'s key was revoked.', { code: state.code ?? '?' }));
  else say('');
}

async function start(resume) {
  const problem = $('#problem');
  problem.hidden = true;
  const view = ensureTerminal();
  $('#terminal').hidden = false;
  fit.fit();
  view.clear();
  const out = await window.fabricConsole.start({ runtime: $('#runtime').value, level: $('#level').value, resume, cols: view.cols, rows: view.rows });
  if (!out.ok) {
    $('#terminal').hidden = true;
    problem.textContent = out.error === 'sign_in' ? t('Sign in to Fabric Inbox first: the mail window opens for it.')
      : out.error === 'spawn' ? t('The agent could not be started: {reason}', { reason: out.detail || '' })
      : out.error === 'key' ? t('No key could be made for the session: {reason}', { reason: out.detail || '' })
      : t('The console could not start.');
    problem.hidden = false;
  }
  view.focus();
}

$('#new').addEventListener('click', () => void start(false));
$('#continue').addEventListener('click', () => void start(true));
$('#stop').addEventListener('click', () => {
  if (window.confirm(t('Stop the agent? Its key is revoked.'))) void window.fabricConsole.stop();
});

window.fabricConsole.onData((data) => ensureTerminal().write(data));
window.fabricConsole.onState((state) => show(state));

window.fabricConsole.locale().then((l) => { MESSAGES = l.messages || {}; applyLanguage(l.locale || 'en'); }).catch(() => {}).finally(async () => {
  const state = await window.fabricConsole.state();
  const select = $('#runtime');
  select.replaceChildren(...(state.runtimes || []).map((r) => Object.assign(document.createElement('option'), { value: r.id, textContent: r.name })));
  if (state.lastRuntime) select.value = state.lastRuntime;
  $('#looked').textContent = t('Looked for: {names}', { names: 'claude, codex' });
  if (state.output) ensureTerminal().write(state.output);
  show(state);
});
