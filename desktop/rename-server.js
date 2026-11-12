'use strict';
// B-244 D-4 (SCN-099): naming a server the app holds. The name lives in this Mac's servers.json and is shown in the
// Account menu and on the inbox's tabs; the server itself is not changed. All effects go through fabricRename
// (rename-server-preload.cjs); this page has no network access (CSP).
const $ = (selector) => document.querySelector(selector);

let MESSAGES = {};
const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)) : text);
function t(source, params) { return fill(Object.prototype.hasOwnProperty.call(MESSAGES, source) ? MESSAGES[source] : source, params); }

function notice(text) { const n = $('#notice'); n.textContent = text || ''; n.hidden = !text; }

async function start() {
  try {
    const locale = await window.fabricRename.locale();
    if (locale && locale.messages) MESSAGES = locale.messages;
    if (locale && locale.locale) document.documentElement.lang = locale.locale;
  } catch { /* English */ }
  const state = await window.fabricRename.state().catch(() => null);
  if (!state) { notice(t('Something went wrong. Try again.')); return; }
  $('#title').textContent = t('Rename {server}', { server: state.host });
  $('#name-label').textContent = t('Name');
  $('#hint').textContent = t('Shown in the Account menu and on the inbox tabs on this Mac. Leave it empty to show the address {server}.', { server: state.host });
  $('#cancel').textContent = t('Cancel');
  $('#save').textContent = t('Save');
  const input = $('#name');
  input.value = state.label || '';
  input.maxLength = state.max || 60;
  input.placeholder = state.host;
  $('#cancel').addEventListener('click', () => void window.fabricRename.close());
  $('#form').addEventListener('submit', async (event) => {
    event.preventDefault();
    notice('');
    $('#save').disabled = true;
    try {
      if (await window.fabricRename.save(input.value)) await window.fabricRename.close();
      else notice(t('Something went wrong. Try again.'));
    } catch { notice(t('Something went wrong. Try again.')); } finally { $('#save').disabled = false; }
  });
  input.focus();
  input.select();
}
void start();
