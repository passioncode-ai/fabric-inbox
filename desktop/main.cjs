'use strict';
const electron = require('electron');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, session } = electron;
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const policy = require('./policy.cjs');
const deployer = require('./cloudflare-deploy.cjs');
const profile = require('./profile.cjs');
const connector = require('./connect.cjs');
const usage = require('./analytics.cjs');
const backup = require('./backup.cjs');
const updates = require('./updater.cjs');
const { randomUUID } = require('node:crypto');

app.setName('Fabric Inbox');
// A development run (`npm run desktop`, an unpackaged Electron) keeps its own profile, so it never
// writes into the installed app's settings, cookies or single-instance lock (LC-14). A walk or a
// release check names its own throwaway folder with --user-data-dir, which always wins.
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Fabric Inbox Development'));
}
app.enableSandbox();
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
// fabric-inbox://connect links (ADR-0115 §4): a local hub asks to connect, a person allows here.
if (typeof app.setAsDefaultProtocolClient === "function") app.setAsDefaultProtocolClient(connector.SCHEME);
const pendingLinks = [];
let appReady = false;
let connecting = false;
app.on('open-url', (event, url) => { event.preventDefault(); if (!appReady) launchedByLink = true; queueLink(url); });
const setupURL = pathToFileURL(path.join(__dirname, 'setup.html')).href;
let config = null;
let setupWindow = null;
let mailWindow = null;
let notice = '';
// Which step the setup window opens on: '' (welcome or server settings) or 'cloudflare'.
let setupStart = '';
let openingExternal = false;
let quitting = false;
// The partition of the last mail window this run opened, and the previous server's partition,
// retired only once the new server has answered (a mistyped address never costs the old one's
// drafts and sign-in).
let mailPartition = null;
let retireAfterLoad = null;
const configPath = () => path.join(app.getPath('userData'), 'server.json');
const pendingSetupPath = () => path.join(app.getPath('userData'), 'pending-setup.json');
// Setups shipped with the app (desktop/setups/*.json) and one opened from a file.
let bundledSetups = [];
let openedSetup = null;
// Creating a server (CF-5): the token lives in this process's memory for one
// setup and is never written to disk or a log; the server keeps it as a secret.
const serverBundleDir = path.join(__dirname, 'server-bundle');
/** The bundled server is the one built with this app (same version). */
const bundleMatchesApp = (manifest) => !!manifest && manifest.version === app.getVersion();
let cloudflareToken = null;
let deploying = false;
// Opened once after the first sign-in on a server the app just created.
let openAfterSignIn = '';
// Anonymous usage counts (docs/ANALYTICS.md): off unless this build carries an App Key.
let analytics = null;
let launchedByLink = false;
// Automatic updates (docs/desktop-data-and-updates.md): off unless this build carries a feed.
let updater = null;

async function loadBundledSetups() {
  const dir = path.join(__dirname, 'setups');
  let names = [];
  try { names = (await fs.readdir(dir)).filter(n => n.endsWith('.json')).sort(); } catch { return; }
  for (const name of names) {
    try {
      const read = policy.readSetup(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
      if (read.ok) bundledSetups.push({ id: 'bundled:' + name, ...read });
    } catch { /* a broken bundled file is skipped, never fatal */ }
  }
}
function setupById(id) {
  if (openedSetup && id === openedSetup.id) return openedSetup;
  return bundledSetups.find(s => s.id === id) || null;
}
async function writePrivate(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(`${target}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.chmod(`${target}.tmp`, 0o600);
  await fs.rename(`${target}.tmp`, target);
}
async function readPendingSetup() {
  try { return JSON.parse(await fs.readFile(pendingSetupPath(), 'utf8')); } catch { return null; }
}

function securePreferences(extra = {}) {
  return { nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, ...extra };
}
function rejectPermissions(ses) {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}
/**
 * Reads server.json; false when it exists but cannot be used. A missing one is restored from the
 * copy in the shared PassionCode folder (desktop/backup.cjs), so removing the app's profile does
 * not forget the server; an existing one refreshes that copy when it differs.
 */
async function readConfig() {
  try { config = policy.validateConfig(JSON.parse(await fs.readFile(configPath(), 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      notice = 'The saved server setting could not be read. Enter it again.';
      return false;
    }
    const restored = await backup.readBackup({ fs, appData: app.getPath('appData'), validate: policy.validateConfig });
    if (!restored) return true;
    try { await writePrivate(configPath(), restored); } catch { /* used for this run even if it cannot be written */ }
    config = restored;
    console.log(JSON.stringify({ event: 'settings_restored', from: 'PassionCode/backups/fabric-inbox.json' }));
    return true;
  }
  const saved = await backup.readBackup({ fs, appData: app.getPath('appData'), validate: policy.validateConfig });
  if (!saved || saved.origin !== config.origin || saved.accessOrigin !== config.accessOrigin) await backup.saveBackup({ fs, appData: app.getPath('appData'), config, log: (l) => console.error(JSON.stringify(l)) });
  return true;
}
/**
 * Clears a server's partition once no window uses it and the new server has answered (LC-12,
 * desktop/profile.cjs). Its directory stays until the next start's sweep: deleting it under the
 * live session would break that server if the person switched back during this run.
 */
async function retirePartition(partition) {
  if (!partition || partition === mailPartition) return;
  await profile.retirePartition({ fs, userData: app.getPath('userData'), partition, session: session.fromPartition(partition), removeDirectory: false });
}
async function saveConfig(next) {
  await writePrivate(configPath(), next);
  config = next;
  await backup.saveBackup({ fs, appData: app.getPath('appData'), config: next, log: (l) => console.error(JSON.stringify(l)) });
}
function showSetup(message = '', start = '') {
  notice = message;
  setupStart = start;
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.reload(); setupWindow.show(); setupWindow.focus(); return;
  }
  setupWindow = new BrowserWindow({ title: 'Fabric Inbox', width: 620, height: 650, minWidth: 460, minHeight: 560,
    backgroundColor: '#f7f7f8', webPreferences: securePreferences({ preload: path.join(__dirname, 'preload.cjs'), partition: 'fabric-setup' }) });
  rejectPermissions(setupWindow.webContents.session);
  setupWindow.webContents.on('will-navigate', event => event.preventDefault());
  setupWindow.webContents.on('will-redirect', event => event.preventDefault());
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  setupWindow.on('closed', () => { setupWindow = null; });
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
}
async function openExternal(url, force = false) {
  if (!config || openingExternal) return;
  const action = policy.navigation(url, config);
  if (!['external', 'gmail'].includes(action)) return;
  openingExternal = true;
  try {
    const target = action === 'gmail' ? policy.gmailConnectURL(config) : url;
    if (!force) {
      const answer = await dialog.showMessageBox({ type: 'question', title: 'Open in browser',
        message: action === 'gmail' ? 'Connect Gmail in your browser?' : 'Open this website in your browser?',
        detail: new URL(target).origin, buttons: ['Cancel', 'Open in browser'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
    }
    await shell.openExternal(target);
  } catch { showSetup('The browser could not be opened. Try again from the Account menu.'); }
  finally { openingExternal = false; }
}
function loadMail() {
  if (!config) { showSetup(); return; }
  if (mailWindow && !mailWindow.isDestroyed()) { mailWindow.destroy(); }
  const snapshot = { ...config };
  const partition = policy.partitionFor(snapshot);
  const previousPartition = mailPartition;
  mailPartition = partition;
  // The old server's window is destroyed above; its storage goes once this server has answered
  // (F3: never left behind). Coming back to it before then cancels that.
  if (previousPartition && previousPartition !== partition) retireAfterLoad = previousPartition;
  if (retireAfterLoad === partition) retireAfterLoad = null;
  const ses = session.fromPartition(partition);
  rejectPermissions(ses);
  // A download remains an explicit user choice; never auto-save attachment files.
  ses.removeAllListeners('will-download');
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save attachment', defaultPath: path.basename(item.getFilename()) });
  });
  const win = new BrowserWindow({ title: 'Fabric Inbox', width: 1360, height: 900, minWidth: 760, minHeight: 560,
    show: true, webPreferences: securePreferences({ session: ses, preload: path.join(__dirname, 'mail-preload.cjs') }) });
  let setupOpened = false;
  mailWindow = win;
  let loadTimer;
  let loadFailed = false;
  const failure = () => {
    clearTimeout(loadTimer);
    if (quitting || win.isDestroyed() || mailWindow !== win || loadFailed) return;
    loadFailed = true;
    win.hide();
    showSetup('Fabric Inbox could not reach the server. Check your connection, then retry. Mail is not available offline in this version.');
  };
  const navigate = (event, url) => {
    if (policy.navigation(url, snapshot) === 'internal') return;
    event.preventDefault(); void openExternal(url);
  };
  win.webContents.on('will-navigate', navigate);
  win.webContents.on('will-redirect', navigate);
  win.webContents.on('will-frame-navigate', event => {
    // Main-frame navigation is handled above. Message subframes cannot leave app content.
    if (event.isMainFrame) return;
    if (['about:blank', 'about:srcdoc'].includes(event.url)) return;
    if (policy.navigation(event.url, snapshot) !== 'internal') event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const action = policy.navigation(url, snapshot);
    if (action === 'internal') void win.loadURL(url).catch(failure);
    else void openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('page-title-updated', event => event.preventDefault());
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) failure();
  });
  win.webContents.on('render-process-gone', failure);
  win.webContents.on('did-finish-load', async () => {
    clearTimeout(loadTimer);
    if (win.isDestroyed() || mailWindow !== win || loadFailed) return;
    win.show(); win.setTitle('Fabric Inbox');
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
    // A chosen setup is applied by the server's Setup page once the person is
    // signed in there (the page loads only behind Access).
    let current;
    try { current = new URL(win.webContents.getURL()); } catch { return; }
    // The new server (or its sign-in page) answered: the previous server's storage can go.
    if (retireAfterLoad && (current.origin === snapshot.origin || (snapshot.accessOrigin && current.origin === snapshot.accessOrigin))) {
      const retiring = retireAfterLoad;
      retireAfterLoad = null;
      void retirePartition(retiring);
    }
    if (current.origin === snapshot.origin) void countActive();
    if (!setupOpened && current.origin === snapshot.origin && current.pathname !== '/setup' && await readPendingSetup()) {
      setupOpened = true;
      void win.loadURL(new URL('/setup?source=desktop', snapshot.origin).href).catch(failure);
    } else if (openAfterSignIn && current.origin === snapshot.origin) {
      const next = openAfterSignIn;
      openAfterSignIn = '';
      if (current.pathname !== next) void win.loadURL(new URL(next, snapshot.origin).href).catch(failure);
    }
  });
  win.on('closed', () => { clearTimeout(loadTimer); if (mailWindow === win) mailWindow = null; });
  loadTimer = setTimeout(failure, 30000);
  void win.loadURL(snapshot.origin).catch(failure);
}
/** Once a UTC day: the active event, with the server's counts when its window is signed in. */
async function countActive() {
  if (!analytics || !analytics.activeDue()) return;
  const signedIn = config && mailWindow && !mailWindow.isDestroyed();
  const counts = signedIn ? await usage.countsWith(session.fromPartition(policy.partitionFor(config)), config.origin)() : null;
  await analytics.active(counts);
}
function track(name, props) { if (analytics) void analytics.event(name, props); }
async function startAnalytics() {
  if (!app.isPackaged) return;
  let bundle = null;
  try { bundle = usage.readBundledKey(await fs.readFile(path.join(__dirname, 'analytics.json'), 'utf8')); } catch { bundle = null; }
  if (!bundle) return;
  const send = electron.net && typeof electron.net.fetch === 'function' ? (url, init) => electron.net.fetch(url, init) : globalThis.fetch;
  analytics = usage.createAnalytics({ fs, bundle, fetch: send, uuid: randomUUID, appData: app.getPath('appData'), userData: app.getPath('userData'),
    appVersion: app.getVersion(), osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
    locale: typeof app.getLocale === 'function' ? app.getLocale() : '', engineVersion: (process.versions && process.versions.electron) || '',
    log: (line) => console.log(JSON.stringify(line)) });
  await analytics.start({ launch: launchedByLink ? 'link' : 'ordinary', serverConfigured: !!config });
  installMenu();
  if (!config) void countActive();
}
async function startUpdates() {
  const autoUpdater = electron.autoUpdater;
  let feed = null;
  try { feed = updates.readFeed(await fs.readFile(path.join(__dirname, 'updates.json'), 'utf8')); } catch { feed = null; }
  if (!feed || !autoUpdater) return;
  updater = updates.createUpdater({ autoUpdater, fs, userData: app.getPath('userData'), feed,
    log: (line) => console.log(JSON.stringify(line)), onChange: () => installMenu() });
  await updater.start({ packaged: app.isPackaged, mas: !!process.mas,
    inApplications: typeof app.isInApplicationsFolder === 'function' && app.isInApplicationsFolder() });
  installMenu();
}
async function checkForUpdates() {
  if (!updater) {
    await dialog.showMessageBox({ type: 'info', title: 'Updates', message: 'This copy of Fabric Inbox does not update itself.',
      detail: 'Only the released app from GitHub or passioncode.ai checks for updates. Builds from source and the Mac App Store version are updated another way.', buttons: ['OK'] });
    return;
  }
  const out = await updater.checkNow();
  const messages = {
    current: ['You have the latest version.', `Fabric Inbox ${app.getVersion()} is the newest release.`],
    downloading: ['A new version is downloading.', 'It will be installed when you quit Fabric Inbox, or you can restart once it is ready (Fabric Inbox menu).'],
    unavailable: ['Updates are not available for this copy.', updater.status().reason === 'not_in_applications'
      ? 'Move Fabric Inbox to the Applications folder, open it from there, and it will update itself.' : 'This copy cannot update itself.'],
    failed: ['The update check did not finish.', `${out.error || 'Unknown error'}. It will try again later; you can also download the latest version from passioncode.ai/inbox.`],
  };
  if (out.outcome === 'ready') {
    const answer = await dialog.showMessageBox({ type: 'info', title: 'Updates', message: `Fabric Inbox ${out.version || ''} is ready to install.`.replace('  ', ' '),
      detail: 'It will be installed when you quit Fabric Inbox. Restart now to use it at once.', buttons: ['Later', 'Restart Now'], defaultId: 1, cancelId: 0 });
    if (answer.response === 1) updater.restart();
    return;
  }
  const [message, detail] = messages[out.outcome] || messages.failed;
  await dialog.showMessageBox({ type: out.outcome === 'failed' ? 'warning' : 'info', title: 'Updates', message, detail, buttons: ['OK'] });
}
async function toggleAnalytics(item) {
  if (!analytics) return;
  const ok = await analytics.setEnabled(!!item.checked);
  if (!ok && item.checked) {
    await dialog.showMessageBox({ type: 'warning', title: 'Usage counts', message: 'Usage counts could not be turned on.',
      detail: 'The shared PassionCode settings file on this Mac could not be read, so nothing is sent.', buttons: ['OK'] });
  }
  installMenu();
  if (analytics.status().enabled) void countActive();
}
function aboutUsageCounts() {
  void dialog.showMessageBox({ type: 'info', title: 'Usage counts', message: 'Anonymous usage counts',
    detail: 'When this is on, Fabric Inbox tells PassionCode.ai that it was installed and opened, once a day that it was used, and how many Gmail accounts, Cloudflare mailboxes, agents and agent keys your server has. It never sends names, email addresses, domains, messages, keys or anything from your mail. The setting is shared by every PassionCode app on this Mac.',
    buttons: ['OK'] });
}
function queueLink(url) {
  if (typeof url !== 'string' || !url.startsWith(`${connector.SCHEME}:`)) return;
  pendingLinks.push(url);
  if (appReady) void drainLinks();
}
async function drainLinks() {
  if (connecting) return;
  connecting = true;
  try { while (pendingLinks.length) await handleConnectLink(pendingLinks.shift()); }
  finally { connecting = false; }
}
async function handleConnectLink(url) {
  const parsed = connector.parseConnectLink(url);
  const parent = mailWindow && !mailWindow.isDestroyed() ? mailWindow : (setupWindow && !setupWindow.isDestroyed() ? setupWindow : null);
  const box = (options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  if (!parsed.ok) {
    console.warn(JSON.stringify({ event: 'connect.refused', reason: 'bad_link' }));
    await box({ type: 'warning', title: 'Connect', message: 'This connect link cannot be used.', detail: parsed.error, buttons: ['OK'] });
    return;
  }
  const request = parsed.value;
  const ses = config ? session.fromPartition(policy.partitionFor(config)) : null;
  const out = await connector.connect({
    request, config,
    confirm: async (prompt) => (await box({ type: 'question', ...prompt })).response === 1,
    mint: ses ? connector.mintWith(ses, config.origin) : async () => ({ ok: false, error: 'No server' }),
    revoke: ses ? connector.revokeWith(ses, config.origin) : async () => false,
    deliver: connector.deliverTo(request.callback),
    signIn: async () => { loadMail(); },
    log: (line) => console.log(line),
  });
  if (out.outcome === 'connected') {
    track('hub_connected', {});
    await box({ type: 'info', title: 'Connected', message: `${request.client} is connected to Fabric Inbox.`, detail: 'You can see and revoke its key in Settings → Agent access.', buttons: ['OK'] });
  } else if (out.outcome === 'failed') {
    const detail = out.reason === 'no_server' ? 'Set up your Fabric Inbox server first, then connect again.'
      : out.reason === 'sign_in_required' ? `Sign in to Fabric Inbox in the window that opened, then connect again from ${request.client}.`
      : out.reason === 'callback_unreachable' ? `${request.client} did not receive the key, so it was ${out.revoked ? 'revoked again' : 'made but could not be revoked: revoke it in Settings → Agent access'}.`
      : `The key could not be made: ${out.error || 'unknown error'}`;
    if (out.reason === 'no_server') showSetup('Set up your server, then connect again.');
    await box({ type: 'warning', title: 'Not connected', message: `${request.client} is not connected.`, detail, buttons: ['OK'] });
  }
}
function installIPC() {
  function trusted(event) {
    if (!policy.isSetupSender(event, setupWindow, setupURL)) throw new Error('Untrusted setup request');
  }
  ipcMain.handle('fabric:setup-state', event => {
    trusted(event);
    const start = setupStart; setupStart = '';
    return { config, notice, start, setups: bundledSetups.map(s => ({ id: s.id, ...s.summary })) };
  });
  ipcMain.handle('fabric:setup-open-file', async event => {
    trusted(event);
    const picked = await dialog.showOpenDialog(setupWindow, { title: 'Open a Fabric Inbox setup', properties: ['openFile'], filters: [{ name: 'Fabric Inbox setup', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    try {
      const stat = await fs.stat(picked.filePaths[0]);
      if (stat.size > 1024 * 1024) return { ok: false, error: 'This file is too large to be a setup.' };
      const read = policy.readSetup(JSON.parse(await fs.readFile(picked.filePaths[0], 'utf8')));
      if (!read.ok) return read;
      openedSetup = { id: 'file:' + path.basename(picked.filePaths[0]), ...read };
      return { ok: true, summary: { id: openedSetup.id, ...read.summary } };
    } catch { return { ok: false, error: 'This file is not a Fabric Inbox setup (not readable JSON).' }; }
  });
  ipcMain.handle('fabric:setup-connect', async (event, id) => {
    trusted(event);
    const chosen = setupById(id);
    if (!chosen) return { ok: false, error: 'Choose the setup again.' };
    try {
      await writePrivate(pendingSetupPath(), chosen.setup);
      await saveConfig({ origin: chosen.summary.origin, accessOrigin: chosen.summary.accessOrigin });
      track('server_connected', { method: 'setup_file' });
      loadMail();
      return { ok: true };
    } catch { return { ok: false, error: 'The setup could not be saved on this Mac. Try again.' }; }
  });
  // The server's Setup page (trusted origin only) reads the chosen setup once.
  ipcMain.handle('fabric:pending-setup', async event => {
    if (!policy.isMailSender(event, mailWindow, config)) throw new Error('Untrusted request');
    return readPendingSetup();
  });
  ipcMain.handle('fabric:pending-setup-done', async event => {
    if (!policy.isMailSender(event, mailWindow, config)) throw new Error('Untrusted request');
    await fs.rm(pendingSetupPath(), { force: true });
    return { ok: true };
  });
  ipcMain.handle('fabric:setup-save', async (event, value) => {
    trusted(event);
    try {
      const next = policy.validateConfig(value);
      await saveConfig(next); track('server_connected', { method: 'entered' }); loadMail(); return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error && !error.code ? error.message : 'The server setting could not be saved. Try again.' }; }
  });
  ipcMain.handle('fabric:setup-retry', event => { trusted(event); loadMail(); return { ok: true }; });

  const problem = error => (error instanceof deployer.DeployError ? error.message : 'Something went wrong on this Mac. Try again.');
  ipcMain.handle('fabric:cf-intro', async event => {
    trusted(event);
    let bundle = null;
    try { const m = await deployer.readBundle(serverBundleDir); bundle = bundleMatchesApp(m) ? { version: m.version } : null; } catch { bundle = null; }
    return { permissions: deployer.PERMISSIONS, bundle };
  });
  ipcMain.handle('fabric:cf-open-token-page', async event => {
    trusted(event);
    try { await shell.openExternal(deployer.TOKEN_PAGE); return { ok: true }; }
    catch { return { ok: false, error: `The browser could not be opened. Go to ${deployer.TOKEN_PAGE} yourself.` }; }
  });
  ipcMain.handle('fabric:cf-check', async (event, token) => {
    trusted(event);
    try {
      const accounts = await deployer.accounts(token);
      cloudflareToken = String(token).trim();
      const details = accounts.length === 1 ? await deployer.inspect({ token: cloudflareToken, accountId: accounts[0].id }) : null;
      return { ok: true, accounts, details };
    } catch (error) { cloudflareToken = null; return { ok: false, error: problem(error) }; }
  });
  ipcMain.handle('fabric:cf-inspect', async (event, accountId) => {
    trusted(event);
    if (!cloudflareToken) return { ok: false, error: 'Enter the token again.' };
    if (!/^[0-9a-f]{32}$/.test(String(accountId))) return { ok: false, error: 'Choose an account.' };
    try { return { ok: true, details: await deployer.inspect({ token: cloudflareToken, accountId }) }; }
    catch (error) { return { ok: false, error: problem(error) }; }
  });
  ipcMain.handle('fabric:cf-deploy', async (event, input) => {
    trusted(event);
    if (!cloudflareToken) return { ok: false, error: 'Enter the token again.' };
    if (deploying) return { ok: false, error: 'Your server is already being created.' };
    const accountId = String(input?.accountId || '');
    if (!/^[0-9a-f]{32}$/.test(accountId)) return { ok: false, error: 'Choose an account.' };
    // Only the server built with this app is ever uploaded: a stale bundle left from an older
    // build would put old code over newer data (deploy audit, 2026-09-29).
    try {
      const m = await deployer.readBundle(serverBundleDir);
      if (!bundleMatchesApp(m)) return { ok: false, error: `This app carries server ${m.version} but is ${app.getVersion()}; rebuild it (npm run desktop:server-bundle) and try again.` };
    } catch { return { ok: false, error: 'This app does not carry a server to upload. Rebuild it (npm run desktop:server-bundle) and try again.' }; }
    deploying = true;
    const started = Date.now();
    try {
      const result = await deployer.deploy({ token: cloudflareToken, accountId, email: input.email, subdomain: input.subdomain, team: input.team,
        bundleDir: serverBundleDir, onStep: step => { if (!event.sender.isDestroyed()) event.sender.send('fabric:cf-step', step); } });
      console.log(JSON.stringify({ event: 'server_deploy', outcome: 'ok', ms: Date.now() - started, steps: result.steps.map(s => `${s.id}:${s.outcome}`) }));
      cloudflareToken = null;
      await saveConfig(policy.validateConfig({ origin: result.origin, accessOrigin: result.accessOrigin }));
      track('server_connected', { method: 'created' });
      openAfterSignIn = '/projects';
      loadMail();
      return { ok: true, origin: result.origin };
    } catch (error) {
      console.error(JSON.stringify({ event: 'server_deploy', outcome: 'failed', ms: Date.now() - started, steps: (error.steps || []).map(s => `${s.id}:${s.outcome}`) }));
      return { ok: false, error: problem(error) };
    } finally { deploying = false; }
  });
}
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Fabric Inbox', submenu: [{ role: 'about' },
      { label: updater && updater.status().state === 'ready' ? 'Restart to Install Update' : 'Check for Updates…',
        click: () => { if (updater && updater.status().state === 'ready') updater.restart(); else void checkForUpdates(); } },
      { label: 'Install Updates Automatically', type: 'checkbox', checked: !!(updater && updater.status().automatic), enabled: !!updater && !['off', 'unavailable'].includes(updater.status().state),
        click: (item) => { if (updater) void updater.setAutomatic(item.checked); } },
      { type: 'separator' },
      { label: 'Share Anonymous Usage Counts', type: 'checkbox', checked: !!(analytics && analytics.status().enabled), enabled: !!analytics, click: (item) => void toggleAnalytics(item) },
      { label: 'About Usage Counts…', click: aboutUsageCounts },
      { type: 'separator' },
      { label: 'Server settings…', accelerator: 'CmdOrCtrl+,', click: () => showSetup() },
      { label: 'Connect Cloudflare account…', click: () => showSetup('', 'cloudflare') },
      { label: 'Setup…', click: () => { if (config && mailWindow && !mailWindow.isDestroyed()) void mailWindow.loadURL(new URL('/setup', config.origin).href); else showSetup(); } },
      { type: 'separator' }, { role: 'services' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'Account', submenu: [{ label: 'Connect Gmail in browser…', click: () => {
      if (config) void openExternal(policy.gmailConnectURL(config), true); else showSetup('Set the server address before connecting Gmail.');
    } }] },
    { label: 'View', submenu: [{ label: 'Retry connection', accelerator: 'CmdOrCtrl+R', click: loadMail },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}
app.on('before-quit', () => { quitting = true; });
// The window coming forward is the only retry trigger and the daily check: no timer runs (LC-08).
app.on('browser-window-focus', () => {
  if (analytics) { void analytics.wake(); void countActive(); }
  if (updater) updater.wake();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (mailWindow && !mailWindow.isDestroyed()) { mailWindow.show(); mailWindow.focus(); }
  else if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
  else loadMail();
});
app.on('second-instance', (_event, argv) => {
  for (const arg of argv || []) queueLink(arg);
  const win = setupWindow || mailWindow;
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
if (ownsInstance) app.whenReady().then(async () => {
  installIPC(); installMenu(); await loadBundledSetups();
  // Orphan partitions and settings leftovers go before any window opens (LC-12). An unreadable
  // server.json is kept and nothing is swept: the person is about to enter that server again.
  // With no server known at all, no partition is an orphan yet: it may be the server the person is
  // about to enter again, with their drafts in it.
  if (await readConfig()) await profile.sweepProfile({ fs, userData: app.getPath('userData'), keepPartition: config ? policy.partitionFor(config) : null, keepPartitions: !config });
  config ? loadMail() : showSetup(notice);
  appReady = true;
  void startAnalytics().catch(() => {});
  void startUpdates().catch((error) => console.error(JSON.stringify({ event: 'update', outcome: 'not_started', reason: String(error && error.message || error).slice(0, 200) })));
  for (const arg of process.argv || []) queueLink(arg);
  void drainLinks();
});
