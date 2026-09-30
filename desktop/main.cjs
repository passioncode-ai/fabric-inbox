'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const policy = require('./policy.cjs');
const deployer = require('./cloudflare-deploy.cjs');

app.setName('Fabric Inbox');
app.enableSandbox();
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
const setupURL = pathToFileURL(path.join(__dirname, 'setup.html')).href;
let config = null;
let setupWindow = null;
let mailWindow = null;
let notice = '';
// Which step the setup window opens on: '' (welcome or server settings) or 'cloudflare'.
let setupStart = '';
let openingExternal = false;
let quitting = false;
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
async function readConfig() {
  try { config = policy.validateConfig(JSON.parse(await fs.readFile(configPath(), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') notice = 'The saved server setting could not be read. Enter it again.'; }
}
async function saveConfig(next) {
  await writePrivate(configPath(), next);
  config = next;
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
  const ses = session.fromPartition(policy.partitionFor(snapshot));
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
      await saveConfig(next); loadMail(); return { ok: true };
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
    { label: 'Fabric Inbox', submenu: [{ role: 'about' }, { type: 'separator' },
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (mailWindow && !mailWindow.isDestroyed()) { mailWindow.show(); mailWindow.focus(); }
  else if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
  else loadMail();
});
app.on('second-instance', () => {
  const win = setupWindow || mailWindow;
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
if (ownsInstance) app.whenReady().then(async () => { installIPC(); installMenu(); await loadBundledSetups(); await readConfig(); config ? loadMail() : showSetup(notice); });
