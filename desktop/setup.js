'use strict';
// First run and server settings (SCN-028). All effects go through the narrow
// fabricSetup bridge (preload.cjs); this page has no network access (CSP).
const $ = selector => document.querySelector(selector);
const steps = { welcome: $('#step-welcome'), cloudflare: $('#step-cloudflare'), review: $('#step-review'), manual: $('#step-manual') };
const notice = $('#notice');
let chosen = null;

function show(step) {
  for (const [name, el] of Object.entries(steps)) el.hidden = name !== step;
  const heading = steps[step].querySelector('h1');
  heading.focus();
}
function say(message) { notice.textContent = message; notice.hidden = !message; }
function fail(el, message) { el.textContent = message; el.hidden = !message; }
function text(tag, value, className) { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; }

function renderBundled(setups) {
  const holder = $('#bundled');
  holder.replaceChildren();
  for (const s of setups) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice primary-choice';
    button.append(text('strong', `Use ${s.name}`),
      text('span', `${s.domainCount} domains · ${s.mailboxCount} addresses · ${new URL(s.origin).host}`));
    button.addEventListener('click', () => review(s));
    holder.append(button);
  }
  holder.hidden = !setups.length;
}

function review(summary) {
  chosen = summary;
  fail($('#review-error'), '');
  $('#review-name').textContent = summary.name;
  $('#review-origin').textContent = summary.origin;
  $('#review-access').textContent = summary.accessOrigin
    ? `Cloudflare Access (${new URL(summary.accessOrigin).host}), a code by email`
    : 'Whatever the server asks for';
  $('#review-count').textContent = `${summary.domainCount} domains, ${summary.mailboxCount} addresses`;
  const list = $('#review-domains');
  list.replaceChildren(...summary.byDomain.map(d => {
    const li = document.createElement('li');
    li.append(text('strong', d.domain));
    const forwards = [...new Set(d.addresses.map(a => a.forwardTo).filter(Boolean))];
    li.append(text('span', `${d.addresses.map(a => a.address.split('@')[0]).join(', ')}${forwards.length ? ` → copy to ${forwards.join(', ')}` : ''}`));
    return li;
  }));
  const notServed = $('#review-not-served');
  notServed.hidden = !summary.notServed.length;
  $('#review-not-served-list').replaceChildren(...summary.notServed.map(n => {
    const li = document.createElement('li');
    li.append(text('strong', n.domain), text('span', n.reason));
    return li;
  }));
  show('review');
}

window.fabricSetup.state().then(state => {
  renderBundled(state.setups || []);
  $('#origin').value = state.config?.origin || '';
  $('#access').value = state.config?.accessOrigin || '';
  $('#retry').hidden = !state.config;
  if (state.notice) say(state.notice);
  // A saved server goes straight to its settings; a first run starts at the welcome;
  // Connect Cloudflare account… (menu) opens that step directly.
  if (state.start === 'cloudflare') void openCloudflare();
  else show(state.config ? 'manual' : 'welcome');
}).catch(() => say('Setup could not be loaded. Close the window and reopen Fabric Inbox.'));

$('#choose-manual').addEventListener('click', () => show('manual'));
$('#back-manual').addEventListener('click', () => show('welcome'));
$('#back-review').addEventListener('click', () => { chosen = null; show('welcome'); });
$('#choose-file').addEventListener('click', async () => {
  say('');
  try {
    const result = await window.fabricSetup.openFile();
    if (result.cancelled) return;
    if (!result.ok) { say(result.error); return; }
    review(result.summary);
  } catch { say('The file could not be read. Try again.'); }
});
$('#connect-setup').addEventListener('click', async () => {
  const button = $('#connect-setup');
  button.disabled = true; button.textContent = 'Connecting…';
  try {
    const result = await window.fabricSetup.connect(chosen.id);
    if (!result.ok) fail($('#review-error'), result.error);
    else say('Opening your server. Sign in there; the setup is applied right after.');
  } catch { fail($('#review-error'), 'The setup could not be saved. Try again.'); }
  finally { button.disabled = false; button.textContent = 'Connect and apply'; }
});

const form = $('#setup');
function setBusy(busy) { $('#connect').disabled = busy; $('#retry').disabled = busy; $('#connect').textContent = busy ? 'Connecting…' : 'Save and connect'; }
form.addEventListener('submit', async event => {
  event.preventDefault(); fail($('#error'), ''); setBusy(true);
  try {
    const result = await window.fabricSetup.save($('#origin').value, $('#access').value);
    if (!result.ok) { fail($('#error'), result.error); $('#origin').focus(); }
    else { say('Opening your server. Complete sign-in in the mail window.'); $('#retry').hidden = false; }
  } catch { fail($('#error'), 'The server setting could not be saved. Try again.'); }
  finally { setBusy(false); }
});
$('#retry').addEventListener('click', async () => {
  setBusy(true); fail($('#error'), '');
  try { await window.fabricSetup.retry(); say('Opening your saved server address…'); }
  catch { fail($('#error'), 'The connection could not be started. Try again.'); }
  finally { setBusy(false); }
});

// ── Create my server on Cloudflare (CF-5, SCN-030) ─────────────────────
// The token goes to the main process once (check); later calls name only the
// account. Nothing here reaches the network: the page has connect-src 'none'.
const cf = window.fabricSetup.cloudflare;
const CF_STEPS = [
  ['subdomain', 'Web address'], ['storage', 'Storage for your mail'], ['team', 'Sign-in page'], ['otp', 'Sign in with a code by email'],
  ['access', 'Only you can open it'], ['files', 'Upload the app'], ['server', 'Start the server'], ['address', 'Open it at its address'],
];
const MARK = { done: 'Done', already: 'Already so', skipped: 'Nothing to do', failed: 'Not done', running: 'Working…', waiting: 'Waiting' };
let cfAccounts = [];
function phase(name) {
  for (const p of ['token', 'details', 'progress']) $(`#cf-${p}-phase`).hidden = p !== name;
}
function cfField(id, show) { $(id).hidden = !show; }
function applyDetails(details) {
  $('#cf-existing').hidden = !details?.existing;
  cfField('#cf-subdomain-field', !details?.subdomain);
  cfField('#cf-team-field', !details?.team);
}
function renderSteps(state) {
  $('#cf-steps').replaceChildren(...CF_STEPS.map(([id, label]) => {
    const s = state[id] || { outcome: 'waiting', detail: '' };
    const li = document.createElement('li');
    li.className = 'is-' + s.outcome;
    li.append(text('span', MARK[s.outcome] || s.outcome, 'mark'));
    const body = document.createElement('span');
    body.append(text('strong', label + '. '), document.createTextNode(s.detail || ''));
    li.append(body);
    return li;
  }));
}
async function openCloudflare() {
  say('');
  try {
    const intro = await cf.intro();
    $('#cf-no-bundle').hidden = !!intro.bundle;
    $('#cf-check').disabled = !intro.bundle;
    $('#cf-permissions').replaceChildren(...intro.permissions.map(p => {
      const tr = document.createElement('tr');
      tr.append(text('td', p.scope), text('td', p.name), text('td', p.level));
      tr.title = p.for;
      return tr;
    }));
  } catch { say('This step could not be loaded. Close the window and reopen Fabric Inbox.'); return; }
  phase('token'); show('cloudflare'); $('#cf-token').focus();
}
$('#choose-cloudflare').addEventListener('click', () => void openCloudflare());
$('#back-cloudflare').addEventListener('click', () => show('welcome'));
$('#cf-open').addEventListener('click', async () => {
  const r = await cf.openTokenPage().catch(() => ({ ok: false, error: 'The browser could not be opened.' }));
  if (!r.ok) fail($('#cf-token-error'), r.error);
});
$('#cf-check').addEventListener('click', async () => {
  const button = $('#cf-check');
  fail($('#cf-token-error'), '');
  if (!$('#cf-token').value.trim()) { fail($('#cf-token-error'), 'Paste the token Cloudflare showed after creating it.'); $('#cf-token').focus(); return; }
  button.disabled = true; button.textContent = 'Checking…';
  try {
    const r = await cf.check($('#cf-token').value);
    if (!r.ok) { fail($('#cf-token-error'), r.error); return; }
    $('#cf-token').value = '';
    cfAccounts = r.accounts;
    const select = $('#cf-account');
    select.replaceChildren(...r.accounts.map(a => { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; return o; }));
    $('#cf-account-field').hidden = r.accounts.length < 2;
    applyDetails(r.details);
    if (!r.details) { const d = await cf.inspect(select.value); if (d.ok) applyDetails(d.details); else { fail($('#cf-token-error'), d.error); return; } }
    phase('details'); $('#cf-email').focus();
  } catch { fail($('#cf-token-error'), 'The token could not be checked. Try again.'); }
  finally { button.disabled = false; button.textContent = 'Continue'; }
});
$('#cf-account').addEventListener('change', async () => {
  fail($('#cf-details-error'), '');
  const d = await cf.inspect($('#cf-account').value).catch(() => ({ ok: false, error: 'The account could not be read. Try again.' }));
  if (d.ok) applyDetails(d.details); else fail($('#cf-details-error'), d.error);
});
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
for (const [input, preview] of [['#cf-subdomain', '#cf-subdomain-preview'], ['#cf-team', '#cf-team-preview']]) {
  $(input).addEventListener('input', () => { $(preview).textContent = $(input).value.trim().toLowerCase() || 'name'; });
}
$('#cf-back-token').addEventListener('click', () => { phase('token'); $('#cf-token').focus(); });
$('#cf-back-details').addEventListener('click', () => phase('details'));
let stepState = {};
let stopListening = null;
async function deploy() {
  fail($('#cf-details-error'), ''); fail($('#cf-progress-error'), '');
  const input = { accountId: $('#cf-account').value, email: $('#cf-email').value.trim(),
    subdomain: $('#cf-subdomain').value.trim().toLowerCase(), team: $('#cf-team').value.trim().toLowerCase() };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) { fail($('#cf-details-error'), 'Enter the email address you will sign in with.'); $('#cf-email').focus(); return; }
  if (!$('#cf-subdomain-field').hidden && !NAME.test(input.subdomain)) { fail($('#cf-details-error'), 'Choose a name for your web address: letters, digits and dashes.'); $('#cf-subdomain').focus(); return; }
  if (!$('#cf-team-field').hidden && !NAME.test(input.team)) { fail($('#cf-details-error'), 'Choose a name for your sign-in page: letters, digits and dashes.'); $('#cf-team').focus(); return; }
  stepState = {}; renderSteps(stepState);
  phase('progress'); $('#cf-progress-title').textContent = 'Creating your server…'; $('#cf-progress-title').focus();
  $('#cf-retry').hidden = true; $('#cf-back-details').hidden = true; $('#cf-done').hidden = true;
  stopListening?.();
  stopListening = cf.onStep(step => {
    stepState[step.id] = step;
    const next = CF_STEPS.find(([id]) => !stepState[id]);
    if (next && step.outcome !== 'failed') stepState[next[0]] = { outcome: 'running', detail: '' };
    renderSteps(stepState);
  });
  stepState[CF_STEPS[0][0]] = { outcome: 'running', detail: '' }; renderSteps(stepState);
  try {
    const r = await cf.deploy(input);
    if (r.ok) {
      $('#cf-progress-title').textContent = 'Your server is ready';
      $('#cf-done').hidden = false;
      say('Opening your server. Sign in there with the code Cloudflare emails you.');
    } else {
      $('#cf-progress-title').textContent = 'Your server is not ready yet';
      for (const [id] of CF_STEPS) if (stepState[id]?.outcome === 'running') delete stepState[id];
      renderSteps(stepState);
      fail($('#cf-progress-error'), r.error + ' Continue runs the remaining steps; what is done stays done.');
      $('#cf-retry').hidden = false; $('#cf-back-details').hidden = false;
    }
  } catch { fail($('#cf-progress-error'), 'The server could not be created. Continue to try again.'); $('#cf-retry').hidden = false; }
}
$('#cf-deploy').addEventListener('click', () => void deploy());
$('#cf-retry').addEventListener('click', () => void deploy());

const themeButton = $('#theme');
function setTheme(theme) { document.documentElement.dataset.theme = theme; themeButton.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'; try { localStorage.setItem('fabric-inbox:theme', theme); } catch {} }
try { setTheme(localStorage.getItem('fabric-inbox:theme') === 'dark' ? 'dark' : 'light'); } catch { setTheme('light'); }
themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
