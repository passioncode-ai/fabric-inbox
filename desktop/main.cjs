'use strict';
const electron = require('electron');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, session, WebContentsView, Notification, Tray, nativeImage, clipboard } = electron;
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const policy = require('./policy.cjs');
const deployer = require('./cloudflare-deploy.cjs');
const profile = require('./profile.cjs');
const connector = require('./connect.cjs');
const { menuTemplate } = require('./menu.cjs');
const { contextMenuTemplate } = require('./context-menu.cjs');
const newMail = require('./new-mail.cjs');
const serverUpdates = require('./server-update.cjs');
const usage = require('./analytics.cjs');
const backup = require('./backup.cjs');
const updates = require('./updater.cjs');
const { createAutostart } = require('./autostart.cjs');
const i18n = require('./i18n.cjs');
const { t } = i18n;
const updateVerify = require('./update-verify.cjs');
const platformInstaller = require('./platform-installer.cjs');
const consoleCore = require('./console.cjs');
const { createLog } = require('./log.cjs');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const execFileAsync = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve({ stdout }))));
const fsSync = require('node:fs');
const { createWriteStream, existsSync, constants: fsConstants } = require('node:fs');
// The updater's file system is Node's own, not Electron's asar-aware one (B-86, update-verify.cjs).
const updateFs = updateVerify.updateFileSystem();

// A development run (`npm run desktop`) is its own app to macOS: its own name, so Chromium keeps its
// cookie key in its own Keychain item ("Fabric Inbox Development Safe Storage"). With the installed
// app's name, the first unsigned run created "Fabric Inbox Safe Storage" with an access list only it
// matched, and the signed release then asked for the login password (0.11.0 upgrade check, B-42).
app.setName(app.isPackaged ? 'Fabric Inbox' : 'Fabric Inbox Development');
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
let mailNotifier = null;
let serverUpdater = null;
/** Settles once the app's own updater is set up (its switch also governs the server's update, B-44). */
let updatesStarted = Promise.resolve();
/** Open at Login (the organization's lifecycle rule, 2026-10-16): the module and its last read state. */
let autostart = null;
let loginItem = null;
/** Windows and Linux: closing the window leaves the app running; the tray icon brings it back. */
let tray = null;
/** The ready version the "Restart to finish updating" notification was shown for, once per version. */
let notifiedReady = '';
// The app's log, ~/Library/Logs/<app name>/ (LC-12): codes and versions only.
let appLog = null;
function logEvent(line) {
  if (!appLog && typeof app.isReady === 'function' && app.isReady()) {
    try { appLog = createLog({ fs, dir: app.getPath('logs') }); } catch { appLog = null; }
  }
  if (appLog) void appLog(line); else console.error(JSON.stringify(line));
}

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
// A server a coding agent set up (scripts/onboard.mjs server, docs/agents/onboard.md; B-80) is
// offered first, like a bundled setup: the person only confirms it and signs in. It names no
// domains or addresses, so nothing is left for the server's Setup page to apply.
const agentSetupPath = () => path.join(app.getPath('appData'), 'PassionCode', 'fabric-inbox', 'setup.json');
async function loadAgentSetup() {
  try {
    const read = policy.readSetup(JSON.parse(await fs.readFile(agentSetupPath(), 'utf8')));
    if (read.ok) bundledSetups.unshift({ id: 'agent:onboard', byAgent: true, ...read, summary: { ...read.summary, byAgent: true } });
  } catch { /* none, or unreadable: nothing is offered */ }
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
      notice = t('The saved server setting could not be read. Enter it again.');
      return false;
    }
    const restored = await backup.readBackup({ fs, appData: app.getPath('appData'), validate: policy.validateConfig });
    if (!restored) return true;
    try { await writePrivate(configPath(), restored); } catch { /* used for this run even if it cannot be written */ }
    config = restored;
    logEvent({ event: 'settings_restored', from: 'PassionCode/backups/fabric-inbox.json' });
    return true;
  }
  const saved = await backup.readBackup({ fs, appData: app.getPath('appData'), validate: policy.validateConfig });
  if (!saved || saved.origin !== config.origin || saved.accessOrigin !== config.accessOrigin) await backup.saveBackup({ fs, appData: app.getPath('appData'), config, log: logEvent });
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
  if (mailNotifier) mailNotifier.reset();
  await backup.saveBackup({ fs, appData: app.getPath('appData'), config: next, log: logEvent });
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
      const answer = await dialog.showMessageBox({ type: 'question', title: t('Open in browser'),
        message: action === 'gmail' ? t('Connect Gmail in your browser?') : t('Open this website in your browser?'),
        detail: new URL(target).origin, buttons: [t('Cancel'), t('Open in browser')], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
    }
    await shell.openExternal(target);
  } catch { showSetup(t('The browser could not be opened. Try again from the Account menu.')); }
  finally { openingExternal = false; }
}
/** The server's Settings screen, and its Setup page that applies a setup chosen in this app. */
const SETTINGS_PAGE = '/settings';
const SETUP_PAGE = '/settings/app/setup';
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
    item.setSaveDialogOptions({ title: t('Save attachment'), defaultPath: path.basename(item.getFilename()) });
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
    showSetup(t('Fabric Inbox could not reach the server. Check your connection, then retry. Mail is not available offline in this version.'));
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
  // A right-click on a link or a button in a message offers to open it in the browser or copy it
  // (operator, 2026-10-21); the person chose it, so no second question. Messages' own frames included.
  win.webContents.on('context-menu', (_event, params) => {
    const items = contextMenuTemplate(params, { t,
      open: (url) => { shell.openExternal(url).catch(() => logEvent({ event: 'context_menu_open', outcome: 'failed' })); },
      copy: (text) => clipboard.writeText(text) });
    if (items.length && !win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: win });
  });
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
      // A console still running for the previous server revokes its key while that server's session
      // still holds its sign-in; retiring the partition first left the key live (bug hunt 2026-10-12).
      void (async () => {
        if (agentConsole && agentConsole.running() && consoleFor !== snapshot.origin) await agentConsole.stop({ wait: true, timeoutMs: 5000 });
        await retirePartition(retiring);
      })();
    }
    if (current.origin === snapshot.origin) void countActive();
    if (current.origin === snapshot.origin && serverUpdater) void serverUpdater.onSignedIn(snapshot.origin);
    if (!setupOpened && current.origin === snapshot.origin && current.pathname !== SETUP_PAGE && await readPendingSetup()) {
      setupOpened = true;
      void win.loadURL(new URL(`${SETUP_PAGE}?source=desktop`, snapshot.origin).href).catch(failure);
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
  // Node's fetch, not Chromium's: the counts need no cookies, and Chromium's network stack waits for
  // the cookie key from the Keychain, so a pending Keychain prompt held every count back (0.11.0).
  const send = globalThis.fetch;
  analytics = usage.createAnalytics({ fs, bundle, fetch: send, uuid: randomUUID, appData: app.getPath('appData'), userData: app.getPath('userData'),
    appVersion: app.getVersion(), platform: process.platform, osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
    locale: typeof app.getLocale === 'function' ? app.getLocale() : '', engineVersion: (process.versions && process.versions.electron) || '',
    log: logEvent });
  await analytics.start({ launch: launchedByLink ? 'link' : 'ordinary', serverConfigured: !!config });
  installMenu();
  if (!config) void countActive();
  // A window already in front when the start finished is asked now; otherwise the next one that comes forward.
  void askUsageCounts(BrowserWindow.getFocusedWindow());
}
async function startUpdates() {
  const target = platformInstaller.updateTarget({ platform: process.platform, arch: process.arch, execPath: process.execPath, env: process.env,
    installedOnMac: typeof app.isInApplicationsFolder === 'function' && app.isInApplicationsFolder(), exists: existsSync });
  // macOS: Squirrel.Mac installs. Windows and Linux: the verified installer or AppImage (PL-03).
  const autoUpdater = process.platform === 'darwin' ? electron.autoUpdater
    : platformInstaller.createPlatformInstaller({ platform: process.platform, app, spawn, fs: updateFs.promises, appImage: target.appImage, log: logEvent,
      stagingDir: path.join(app.getPath('cache'), app.getName(), 'pending-update') });
  if (typeof autoUpdater.clean === 'function') void autoUpdater.clean();
  let feed = null;
  try { feed = updates.readFeed(await fs.readFile(path.join(__dirname, 'updates.json'), 'utf8')); } catch { feed = null; }
  if (!feed || !autoUpdater) return;
  // The feed is read with Node's fetch, and a newer release is downloaded and verified by the app
  // itself (desktop/update-verify.cjs) before the installer step is handed the verified file (LC-16).
  const fetchFeed = async (url) => {
    const response = await globalThis.fetch(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`The update feed answered ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  };
  let verifier = null;
  try {
    const key = await fs.readFile(path.join(__dirname, 'release-key.asc'), 'utf8');
    const repository = new URL(feed).pathname.split('/').slice(1, 3).join('/');
    const exec = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve({ stdout }))));
    // Windows: a signed running copy accepts only a signed update; an unsigned interim one (PL-02)
    // trusts the GPG-signed SHA256SUMS alone. Read once per launch, and only for a copy that updates.
    let requireAuthenticode = false;
    if (process.platform === 'win32' && app.isPackaged && target.installed) {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        const out = await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${process.execPath.replace(/'/g, "''")}').Status`]);
        requireAuthenticode = String(out.stdout).trim() === 'Valid';
      } catch { requireAuthenticode = false; }
    }
    verifier = updateVerify.createVerifier({ repository, appVersion: app.getVersion(), appName: 'Fabric Inbox',
      zipName: target.fileName, runningApp: target.runningApp, platform: process.platform, arch: process.arch, requireAuthenticode,
      dir: path.join(app.getPath('cache'), app.getName(), 'updates'), fetch: globalThis.fetch, exec, fs: updateFs.promises, createWriteStream: updateFs.createWriteStream, key, log: logEvent });
  } catch (error) {
    logEvent({ event: 'update_check', outcome: 'check_failed', reason: 'no_release_key' });
  }
  // The timers hold no process open: quitting is never delayed by an update check.
  const setTimer = (fn, ms) => { const handle = setTimeout(fn, ms); if (handle.unref) handle.unref(); return handle; };
  // The update replaces the app in place: this user must be able to write it and its folder.
  const replaceable = async () => {
    if (!target.writable.length) return false;
    try { for (const where of target.writable) await fs.access(where, fsConstants.W_OK); return true; } catch { return false; }
  };
  // B-51: the staged update lives in ~/Library/Caches, which macOS purges when the disk runs short.
  const readPlist = async (file) => JSON.parse((await new Promise((resolve, reject) => execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file],
    { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))))));
  const staged = process.platform === 'darwin'
    ? () => updates.squirrelStaged({ fs, cacheDir: path.join(app.getPath('home'), 'Library', 'Caches'), bundleId: 'ai.passioncode.fabric-inbox', readPlist })
    : async () => true;
  // ShipIt waits under launchd for a bundle that is gone; Squirrel.Mac submits the job again with the next download.
  const forgetStaged = process.platform === 'darwin'
    ? () => new Promise((resolve) => execFile('/bin/launchctl', ['remove', 'ai.passioncode.fabric-inbox.ShipIt'], { timeout: 10000 }, () => resolve()))
    : async () => {};
  updater = updates.createUpdater({ autoUpdater, fs, userData: app.getPath('userData'), feed, appVersion: app.getVersion(), fetchFeed, verifier, replaceable, staged, forgetStaged,
    setTimer, clearTimer: clearTimeout, log: logEvent, onChange: () => { installMenu(); notifyReady(); } });
  await updater.start({ packaged: app.isPackaged, mas: !!process.mas, inApplications: target.installed, packageManager: target.packageManager });
  installMenu();
}
/**
 * A system notification, when the system supports them. The person may have notifications for the app
 * turned off; Electron cannot read that, so the same information is always in the menu too.
 */
function notify(title, body, onClick) {
  if (!Notification || !Notification.isSupported()) { logEvent({ event: 'notification', outcome: 'unsupported' }); return null; }
  const note = new Notification({ title, body, silent: false });
  if (onClick) note.on('click', onClick);
  note.show();
  return note;
}
/**
 * An update is downloaded, verified and ready: say so once per version, with "Restart to finish
 * updating" (LC-16, the organization's rule of 2026-10-16). Clicking it restarts, asking first when the
 * agent console runs; ignoring it installs the update when the app quits, as before.
 */
function notifyReady() {
  const now = updater ? updater.status() : null;
  if (!now || now.state !== 'ready' || !now.readyVersion || now.readyVersion === notifiedReady) return;
  notifiedReady = now.readyVersion;
  logEvent({ event: 'update_ready_notice', version: now.readyVersion });
  notify(t('Restart to finish updating'), t('Fabric Inbox {version} is ready. Click to restart now, or it is installed when you quit.', { version: now.readyVersion }),
    () => void restartToUpdate());
}
/**
 * B-41: new-mail notifications, off until the person turns them on in the app menu. The inbox is read
 * through the mail window's session (its sign-in cookie), so a signed-out or unreachable server reads
 * as nothing new; clicking a notification opens that message in the mail window.
 */
function startNewMail() {
  const read = async (pathname) => {
    if (!config) return null;
    try {
      const response = await session.fromPartition(policy.partitionFor(config)).fetch(new URL(pathname, config.origin).href,
        { redirect: 'manual', credentials: 'include', headers: { Accept: 'application/json' } });
      if (response.status !== 200 || !(response.headers.get('content-type') || '').toLowerCase().includes('json')) return null;
      return await response.json();
    } catch { return null; }
  };
  const open = (link) => {
    if (!config) return;
    if (mailWindow && !mailWindow.isDestroyed()) {
      mailWindow.show(); mailWindow.focus();
      void mailWindow.loadURL(new URL(link, config.origin).href).catch(() => {});
      return;
    }
    openAfterSignIn = link;
    loadMail();
  };
  mailNotifier = newMail.createNewMailNotifier({ fs, userData: app.getPath('userData'), read, open, t, log: logEvent,
    notify: (title, body, onClick) => notify(title, body, onClick),
    focused: () => !!(mailWindow && !mailWindow.isDestroyed() && mailWindow.isFocused()) });
  void mailNotifier.start().then(installMenu);
}
/**
 * B-44: the server is updated through itself, without a new Cloudflare token: after the person signs
 * in, an older server gets the server this app carries (automatic when updates are; else the menu).
 */
function startServerUpdates() {
  const ses = () => (config ? session.fromPartition(policy.partitionFor(config)) : null);
  const read = async (pathname) => {
    const s = ses();
    if (!s) return null;
    try {
      const response = await s.fetch(new URL(pathname, config.origin).href, { redirect: 'manual', credentials: 'include', headers: { Accept: 'application/json' } });
      if (response.status !== 200 || !(response.headers.get('content-type') || '').toLowerCase().includes('json')) return null;
      return await response.json();
    } catch { return null; }
  };
  const post = async (pathname, form) => {
    const s = ses();
    if (!s) return null;
    // Chromium's fetch takes bytes, not a FormData: encode it here with its boundary.
    const encoded = new Response(form);
    const response = await s.fetch(new URL(pathname, config.origin).href, { method: 'POST', redirect: 'manual', credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': encoded.headers.get('content-type') }, body: Buffer.from(await encoded.arrayBuffer()) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  serverUpdater = serverUpdates.createServerUpdater({ appVersion: () => app.getVersion(), bundleDir: serverBundleDir, readBundle: deployer.readBundle,
    readFile: (file) => fs.readFile(file), read, post, t, log: logEvent, automatic: async () => { await updatesStarted; return !!(updater && updater.status().automatic); },
    notify: (title, body) => notify(title, body), onChange: () => installMenu() });
}
/**
 * Every launch: Open at Login is turned on once for an installed copy and read again; a login item the
 * system holds for approval is told to the person with where to allow it (no silent degradation).
 */
async function startAutostart() {
  autostart = createAutostart({ app, fs, path, platform: process.platform, userData: app.getPath('userData'), env: process.env,
    homedir: require('node:os').homedir(), mas: !!process.mas, execPath: process.execPath, log: logEvent });
  loginItem = await autostart.start();
  installMenu();
  if (loginItem.needsApproval) notify(t('Fabric Inbox cannot open at login yet'),
    t('Allow it in System Settings → General → Login Items, so new mail is ready when you start your Mac.'),
    () => void shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension').catch(() => {}));
}
async function toggleLogin(item) {
  if (!autostart) return;
  try { loginItem = await autostart.set(item.checked); }
  catch (error) { logEvent({ event: 'login_item', outcome: 'failed', reason: String(error && error.code || 'error') }); }
  installMenu();
}
/** Windows and Linux: the tray icon that keeps a closed app reachable (macOS has its Dock icon). */
function startTray() {
  if (process.platform === 'darwin' || tray || !Tray) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Fabric Inbox');
    const open = () => { const win = setupWindow || mailWindow; if (win && !win.isDestroyed()) { win.show(); win.focus(); } else if (config) loadMail(); else showSetup(); };
    tray.setContextMenu(Menu.buildFromTemplate([{ label: t('Open Fabric Inbox'), click: open }, { type: 'separator' }, { label: t('Quit Fabric Inbox'), click: () => app.quit() }]));
    tray.on('click', open);
  } catch (error) {
    tray = null;
    logEvent({ event: 'tray', outcome: 'failed', reason: String(error && error.message || error).slice(0, 120) });
  }
}
/** The download page a copy that cannot update itself is sent to (also named in the notices below). */
const DOWNLOAD_PAGE = 'https://passioncode.ai/inbox';
/**
 * Several checks in a row failed (B-86: 0.12.0 failed every check for days and only logged it).
 * The menu says so, and this notice offers the download; a later good check clears it.
 */
async function showUpdatesStuck(now) {
  const answer = await dialog.showMessageBox({ type: 'warning', title: t('Updates'),
    message: t('Fabric Inbox has not been able to update itself.'),
    detail: t('The last {count} update checks failed: {error}. Download the latest version and install it over this one; your server, sign-in and settings stay as they are.',
      { count: now.failures, error: now.error ? t.text(String(now.error).replace(/\.$/, '')) : t('Unknown error') }),
    buttons: [t('Download Latest Version'), t('Try Again'), t('Later')], defaultId: 0, cancelId: 2 });
  if (answer.response === 0) { try { await shell.openExternal(DOWNLOAD_PAGE); } catch { /* the notice named the page */ } }
  else if (answer.response === 1) void checkForUpdates();
}
async function checkForUpdates() {
  if (!updater) {
    await dialog.showMessageBox({ type: 'info', title: t('Updates'), message: t('This copy of Fabric Inbox does not update itself.'),
      detail: process.platform === 'darwin'
        ? t('Only the released app from GitHub or passioncode.ai checks for updates. Builds from source and the Mac App Store version are updated another way.')
        : t('Only the released app from GitHub or passioncode.ai checks for updates. Builds from source are updated another way.'), buttons: [t('OK')] });
    return;
  }
  const out = await updater.checkNow();
  const reason = updater.status().reason;
  const mac = process.platform === 'darwin';
  const messages = {
    current: [t('You have the latest version.'), t('Fabric Inbox {version} is the newest release.', { version: app.getVersion() })],
    downloading: [t('A new version is downloading.'), mac
      ? t('It will be installed when you quit Fabric Inbox, or you can restart once it is ready (Fabric Inbox menu).')
      : t('It will be installed when you quit Fabric Inbox, or you can restart once it is ready (Help menu).')],
    unavailable: [t('Updates are not available for this copy.'), reason === 'package_manager'
      ? t('This copy was installed from a .deb package and does not update itself. Download the new package from passioncode.ai/inbox, or use the AppImage, which updates itself.')
      : reason === 'not_in_applications'
        ? (mac ? t('Move Fabric Inbox to the Applications folder, open it from there, and it will update itself.')
          : t('Install Fabric Inbox with its installer from passioncode.ai/inbox, and that copy will update itself.'))
        : reason === 'not_replaceable'
          ? (mac ? t('This Mac account cannot replace the app in Applications (it was installed by another account, or the folder is read-only). Install the new version from passioncode.ai/inbox, or update it from the account that installed it.')
            : t('This account cannot replace the installed app (its folder is read-only). Install the new version from passioncode.ai/inbox.'))
          : t('This copy cannot update itself.')],
    failed: out.code === 'signature_failed'
      ? [t('The update did not pass verification and was not installed.'),
        t('{error} Fabric Inbox keeps running this version and checks again later; you can also download the latest version from passioncode.ai/inbox.',
          { error: out.error ? t.text(out.error) : t('It is not the release the organization signed.') })]
      : [t('The update check did not finish.'), t('{error}. It will try again later; you can also download the latest version from passioncode.ai/inbox.',
          { error: out.error ? t.text(String(out.error).replace(/\.$/, '')) : t('Unknown error') })],
    held: [t('A new version needs a step before it is installed.'),
      t('Fabric Inbox {version} is downloaded and verified, but it is not installed until the step in its release notes is done: {runbook}.',
        { version: out.version || '', runbook: out.runbook || t('see the release notes') })],
  };
  if (out.outcome === 'ready') {
    const answer = await dialog.showMessageBox({ type: 'info', title: t('Updates'), message: t('Fabric Inbox {version} is ready to install.', { version: out.version || '' }),
      detail: t('It will be installed when you quit Fabric Inbox. Restart now to use it at once.'), buttons: [t('Later'), t('Restart Now')], defaultId: 1, cancelId: 0 });
    if (answer.response === 1) void restartToUpdate();
    return;
  }
  const [message, detail] = messages[out.outcome] || messages.failed;
  await dialog.showMessageBox({ type: out.outcome === 'failed' ? 'warning' : 'info', title: t('Updates'), message, detail, buttons: [t('OK')] });
}
async function toggleAnalytics(item) {
  if (!analytics) return;
  const ok = await analytics.setEnabled(!!item.checked);
  if (!ok && item.checked) {
    await dialog.showMessageBox({ type: 'warning', title: t('Usage counts'), message: t('Usage counts could not be turned on.'),
      detail: t('The shared PassionCode settings file on this Mac could not be read, so nothing is sent.'), buttons: [t('OK')] });
  }
  installMenu();
  if (analytics.status().enabled) void countActive();
}
const usageCountsText = () => t('When this is on, Fabric Inbox tells PassionCode.ai that it was installed and opened, once a day that it was used, and how many Gmail accounts, Cloudflare mailboxes, agents and agent keys your server has. It never sends names, email addresses, domains, messages, keys or anything from your mail. The setting is shared by every PassionCode app on this Mac.');
function aboutUsageCounts() {
  void dialog.showMessageBox({ type: 'info', title: t('Usage counts'), message: t('Anonymous usage counts'), detail: usageCountsText(), buttons: [t('OK')] });
}
/**
 * A7-012 (issue #45): until the person has answered once, nothing is counted or sent. The first time a
 * window comes forward this asks, with the switch on and Continue; Not now asks again at the next launch,
 * and the menu's Share Usage Counts is the other way to answer. Asked at most once a launch.
 */
let usageAsked = false;
async function askUsageCounts(win) {
  if (usageAsked || !analytics || !analytics.status().pending || !win || win.isDestroyed()) return;
  // Review 2026-10-21: a hub's Allow/Deny comes first; the question waits until it is answered.
  if (connecting || pendingLinks.length) return;
  usageAsked = true;
  const before = analytics.status().sentBefore;
  const { response, checkboxChecked } = await dialog.showMessageBox(win, { type: 'question', title: t('Usage counts'),
    message: t('Share anonymous usage counts?'),
    detail: `${usageCountsText()}\n\n${before ? t('This copy sent counts before it asked you; from now on it sends nothing until you answer.') : t('Nothing has been sent yet.')}`,
    checkboxLabel: t('Share usage counts'), checkboxChecked: true, buttons: [t('Continue'), t('Not now')], defaultId: 0, cancelId: 1 });
  if (response !== 0) { logEvent({ event: 'analytics_question', answer: 'later' }); return; }
  logEvent({ event: 'analytics_question', answer: checkboxChecked ? 'on' : 'off' });
  const ok = await analytics.setEnabled(!!checkboxChecked);
  if (!ok && checkboxChecked) {
    await dialog.showMessageBox(win, { type: 'warning', title: t('Usage counts'), message: t('Usage counts could not be turned on.'),
      detail: t('The shared PassionCode settings file on this Mac could not be read, so nothing is sent.'), buttons: [t('OK')] });
  }
  installMenu();
  if (analytics.status().enabled) void countActive();
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
  if (analytics) void askUsageCounts(BrowserWindow.getFocusedWindow());
}
const attend = connector.attendWith(app);
/** The window a connect prompt is attached to: the open one, else the mail (or setup) window opened for it. */
function promptWindow() {
  const live = (win) => (win && !win.isDestroyed() ? win : null);
  if (live(mailWindow) || live(setupWindow)) return live(mailWindow) || live(setupWindow);
  loadMail();
  return live(mailWindow) || live(setupWindow);
}
// ── The agent console (B-70, SCN-078; desktop/console.cjs) ─────────────────────────────────────
// The person's own coding agent in a PTY beside the mail, connected to this server's MCP with a key
// made for the session. Not in the Mac App Store package: its sandbox cannot run another CLI.
const consoleURL = pathToFileURL(path.join(__dirname, 'console.html')).href;
let consoleWindow = null;
// Docked: the console as a panel on the mail window's right (Fabric Dashboards ADR-0017), when the
// mail page says it makes room for it (fabric:console-dock-ready); otherwise a window of its own.
let consoleView = null;
let consoleDocked = false;
let dockReady = false;
const DOCK_WIDTH = 520;
let agentConsole = null;
let consoleFor = null;
let loginPathValue;
let lastRuntime = null;
const consoleAvailable = () => !process.mas;
/** The login shell's PATH (an app started from the Dock has a short one), read once, 5 s at most. */
function loginPath() {
  if (loginPathValue !== undefined) return Promise.resolve(loginPathValue);
  if (process.platform === 'win32') { loginPathValue = process.env.Path || process.env.PATH || ''; return Promise.resolve(loginPathValue); }
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => execFile(shell, ['-ilc', 'printf "%s" "$PATH"'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
    loginPathValue = error ? (process.env.PATH || '') : String(stdout).trim().split('\n').pop();
    resolve(loginPathValue);
  }));
}
function consoleRuntimes(found) {
  const exists = (file) => { try { fsSync.accessSync(file, fsConstants.X_OK); return fsSync.statSync(file).isFile(); } catch { return false; } };
  return consoleCore.findRuntimes({ platform: process.platform, env: process.env, loginPath: found, exists });
}
/** node-pty from the app (or the repository in a development run); macOS's spawn-helper made executable. */
function loadPty() {
  const pty = require('node-pty');
  if (process.platform === 'darwin') {
    const helper = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `darwin-${process.arch}`, 'spawn-helper').replace('app.asar', 'app.asar.unpacked');
    try { fsSync.accessSync(helper, fsConstants.X_OK); } catch { try { fsSync.chmodSync(helper, 0o755); } catch { /* reported when spawning */ } }
  }
  return pty;
}
function consoleSend(channel, value) {
  if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.webContents.send(channel, value);
  if (consoleView && !consoleView.webContents.isDestroyed()) consoleView.webContents.send(channel, value);
}
function layoutDock() {
  if (!consoleDocked || !consoleView || !mailWindow || mailWindow.isDestroyed()) return;
  const { width, height } = mailWindow.getContentBounds();
  const panel = Math.min(DOCK_WIDTH, Math.max(320, Math.floor(width / 2)));
  consoleView.setBounds({ x: width - panel, y: 0, width: panel, height });
  mailWindow.webContents.send('fabric:console-dock', panel);
}
/** Shows or hides the docked panel; the session in it keeps running while hidden. */
function toggleDock() {
  if (!mailWindow || mailWindow.isDestroyed()) return;
  if (consoleDocked) {
    mailWindow.contentView.removeChildView(consoleView);
    consoleDocked = false;
    mailWindow.webContents.send('fabric:console-dock', 0);
    return;
  }
  if (!consoleView || consoleView.webContents.isDestroyed()) {
    consoleView = new WebContentsView({ webPreferences: securePreferences({ preload: path.join(__dirname, 'console-preload.cjs'), partition: 'fabric-console' }) });
    rejectPermissions(consoleView.webContents.session);
    consoleView.webContents.on('will-navigate', (event) => event.preventDefault());
    consoleView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    consoleView.webContents.loadFile(path.join(__dirname, 'console.html'));
    if (!mailWindow.__consoleLayout) {
      mailWindow.__consoleLayout = true;
      mailWindow.on('resize', layoutDock);
      mailWindow.on('closed', () => { consoleView = null; consoleDocked = false; dockReady = false; });
      mailWindow.webContents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) dockReady = false; });
    }
  }
  mailWindow.contentView.addChildView(consoleView);
  consoleDocked = true;
  layoutDock();
  consoleView.webContents.focus();
}
async function ensureConsole() {
  if (!config || !consoleAvailable()) return null;
  if (agentConsole && consoleFor === config.origin) return agentConsole;
  if (agentConsole && agentConsole.running()) return agentConsole;
  const ses = session.fromPartition(policy.partitionFor(config));
  consoleFor = config.origin;
  agentConsole = consoleCore.createConsole({
    pty: { spawn: (...args) => loadPty().spawn(...args) }, fs, dir: path.join(app.getPath('userData'), 'consoles'),
    mint: connector.mintWith(ses, config.origin), revoke: connector.revokeWith(ses, config.origin),
    origin: config.origin, mcpUrl: new URL('/mcp', config.origin).href, cwd: app.getPath('home'), loginPath: await loginPath(),
    log: logEvent,
    onData: (data) => consoleSend('fabric:console-data', data),
    onState: (state) => { consoleSend('fabric:console-phase', { ...state, runtimes: consoleRuntimes(loginPathValue) }); installMenu(); },
  });
  return agentConsole;
}
/** Opens the console window, beside the mail window on its right when there is room. */
function openConsole() {
  if (!consoleAvailable()) return;
  if (!config) { showSetup(t('Set up your server first; the console works with it.')); return; }
  if (dockReady && mailWindow && !mailWindow.isDestroyed() && !(consoleWindow && !consoleWindow.isDestroyed())) { toggleDock(); return; }
  if (consoleWindow && !consoleWindow.isDestroyed()) { consoleWindow.show(); consoleWindow.focus(); return; }
  const anchor = mailWindow && !mailWindow.isDestroyed() ? mailWindow.getBounds() : null;
  consoleWindow = new BrowserWindow({ title: t('Agent console — Fabric Inbox'), width: 720, height: anchor ? anchor.height : 640, minWidth: 420, minHeight: 320,
    ...(anchor ? { x: anchor.x + anchor.width + 8, y: anchor.y } : {}), backgroundColor: '#111111',
    webPreferences: securePreferences({ preload: path.join(__dirname, 'console-preload.cjs'), partition: 'fabric-console' }) });
  rejectPermissions(consoleWindow.webContents.session);
  consoleWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  consoleWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  consoleWindow.on('closed', () => { consoleWindow = null; });
  consoleWindow.loadFile(path.join(__dirname, 'console.html'));
}

async function handleConnectLink(url) {
  const parsed = connector.parseConnectLink(url);
  const parent = mailWindow && !mailWindow.isDestroyed() ? mailWindow : (setupWindow && !setupWindow.isDestroyed() ? setupWindow : null);
  const box = (options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  if (!parsed.ok) {
    console.warn(JSON.stringify({ event: 'connect.refused', reason: 'bad_link' }));
    await box({ type: 'warning', title: t('Connect'), message: t('This connect link cannot be used.'), detail: t.text(parsed.error), buttons: [t('OK')] });
    return;
  }
  const request = parsed.value;
  const ses = config ? session.fromPartition(policy.partitionFor(config)) : null;
  const out = await connector.connect({
    request, config,
    // The prompt is a sheet on a window brought forward (the Dock bounces until it is answered),
    // and it closes itself when the requester stops listening (`signal`, desktop/connect.cjs). A
    // window is opened when none is: on macOS a box with no parent cannot be closed that way.
    confirm: async (prompt, { signal } = {}) => {
      const owner = promptWindow();
      const stop = attend(owner);
      try { return owner ? await dialog.showMessageBox(owner, { type: 'question', ...prompt, signal }) : await dialog.showMessageBox({ type: 'question', ...prompt, signal }); }
      finally { stop(); }
    },
    identify: connector.listenerWith(execFileAsync),
    mint: ses ? connector.mintWith(ses, config.origin) : async () => ({ ok: false, error: t('No server') }),
    revoke: ses ? connector.revokeWith(ses, config.origin) : async () => false,
    deliver: connector.deliverTo(request.callback),
    signIn: async () => { loadMail(); },
    log: (line) => { try { logEvent(JSON.parse(line)); } catch { logEvent({ event: 'connect', outcome: 'unparsed' }); } },
  });
  // A requester that stopped waiting gets no notice: nothing was made, the hub already gave up, and
  // a notice nobody reads would hold the next link's prompt back.
  if (out.reason === 'no_listener' || out.reason === 'not_answered') return;
  if (out.outcome === 'connected') {
    track('hub_connected', {});
    await box({ type: 'info', title: t('Connected'), message: t('{client} is connected to Fabric Inbox.', { client: request.client }), detail: t('You can see and revoke its key in Settings → Agent access.'), buttons: [t('OK')] });
  } else if (out.outcome === 'failed') {
    const detail = out.reason === 'no_server' ? t('Set up your Fabric Inbox server first, then connect again.')
      : out.reason === 'sign_in_required' ? t('Sign in to Fabric Inbox in the window that opened, then connect again from {client}.', { client: request.client })
      : out.reason === 'callback_unreachable' ? (out.revoked ? t('{client} did not receive the key, so it was revoked again.', { client: request.client }) : t('{client} did not receive the key, so it was made but could not be revoked: revoke it in Settings → Agent access.', { client: request.client }))
      : out.reason === 'listener_changed' ? (out.revoked ? t('The key was made but could not reach {client}, and was revoked again.', { client: request.client }) : t('The key was made but could not reach {client}, and it could not be revoked: revoke it in Settings → Agent access.', { client: request.client }))
      : t('The key could not be made: {error}', { error: out.error ? t.text(out.error) : t('unknown error') });
    if (out.reason === 'no_server') showSetup(t('Set up your server, then connect again.'));
    await box({ type: 'warning', title: t('Not connected'), message: t('{client} is not connected.', { client: request.client }), detail, buttons: [t('OK')] });
  }
}
function installIPC() {
  const fromConsole = (event) => {
    const docked = consoleView && !consoleView.webContents.isDestroyed() && event.sender === consoleView.webContents
      && event.senderFrame === consoleView.webContents.mainFrame && event.senderFrame.url === consoleURL;
    if (!docked && !policy.isSetupSender(event, consoleWindow, consoleURL)) throw new Error('Untrusted console request');
  };
  ipcMain.handle('fabric:console-locale', (event) => { fromConsole(event); return i18n.forWindow(); });
  ipcMain.handle('fabric:console-available', (event) => { if (!policy.isMailSender(event, mailWindow, config)) throw new Error('Untrusted request'); return consoleAvailable(); });
  ipcMain.handle('fabric:console-open', (event) => { if (!policy.isMailSender(event, mailWindow, config)) throw new Error('Untrusted request'); openConsole(); return true; });
  // The mail page makes room for a docked console (it shifts by --fi-console-width); an older page does not, and gets a window.
  ipcMain.handle('fabric:console-dock-ready', (event) => { if (!policy.isMailSender(event, mailWindow, config)) throw new Error('Untrusted request'); dockReady = consoleAvailable(); if (consoleDocked) layoutDock(); return dockReady; });
  ipcMain.handle('fabric:console-state', async (event) => {
    fromConsole(event);
    const c = await ensureConsole();
    const runtimes = consoleRuntimes(await loginPath());
    return { ...(c ? c.state() : { phase: 'idle' }), runtimes, lastRuntime, output: c ? c.output() : '' };
  });
  ipcMain.handle('fabric:console-start', async (event, input) => {
    fromConsole(event);
    const c = await ensureConsole();
    if (!c) return { ok: false, error: 'no_server' };
    const runtime = consoleRuntimes(await loginPath()).find((r) => r.id === String(input?.runtime));
    if (!runtime) return { ok: false, error: 'runtime' };
    lastRuntime = runtime.id;
    const out = await c.start({ runtime, level: String(input?.level || 'admin'), resume: !!input?.resume, cols: Number(input?.cols) || 100, rows: Number(input?.rows) || 30 });
    if (!out.ok && out.error === 'sign_in') loadMail();
    return out;
  });
  ipcMain.handle('fabric:console-stop', async (event) => { fromConsole(event); if (agentConsole) await agentConsole.stop(); return true; });
  ipcMain.on('fabric:console-write', (event, data) => { try { fromConsole(event); } catch { return; } if (agentConsole) agentConsole.write(String(data)); });
  ipcMain.on('fabric:console-resize', (event, cols, rows) => { try { fromConsole(event); } catch { return; } if (agentConsole) agentConsole.resize(Number(cols), Number(rows)); });
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
    const picked = await dialog.showOpenDialog(setupWindow, { title: t('Open a Fabric Inbox setup'), properties: ['openFile'], filters: [{ name: t('Fabric Inbox setup'), extensions: ['json'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    try {
      const stat = await fs.stat(picked.filePaths[0]);
      if (stat.size > 1024 * 1024) return { ok: false, error: t('This file is too large to be a setup.') };
      const read = policy.readSetup(JSON.parse(await fs.readFile(picked.filePaths[0], 'utf8')));
      if (!read.ok) return { ...read, error: t.text(read.error) };
      openedSetup = { id: 'file:' + path.basename(picked.filePaths[0]), ...read };
      return { ok: true, summary: { id: openedSetup.id, ...read.summary } };
    } catch { return { ok: false, error: t('This file is not a Fabric Inbox setup (not readable JSON).') }; }
  });
  ipcMain.handle('fabric:setup-connect', async (event, id) => {
    trusted(event);
    const chosen = setupById(id);
    if (!chosen) return { ok: false, error: t('Choose the setup again.') };
    try {
      if (!chosen.byAgent) await writePrivate(pendingSetupPath(), chosen.setup);
      await saveConfig({ origin: chosen.summary.origin, accessOrigin: chosen.summary.accessOrigin });
      track('server_connected', { method: 'setup_file' });
      loadMail();
      return { ok: true };
    } catch { return { ok: false, error: t('The setup could not be saved on this Mac. Try again.') }; }
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
    } catch (error) { return { ok: false, error: error instanceof Error && !error.code ? t.text(error.message) : t('The server setting could not be saved. Try again.') }; }
  });
  ipcMain.handle('fabric:setup-retry', event => { trusted(event); loadMail(); return { ok: true }; });
  // The interface language (L10N-01): the first-run window reads it; the mail window reads this
  // Mac's choice and sets it from Settings → App → Language, and the menus follow at once.
  ipcMain.handle('fabric:setup-locale', event => { trusted(event); return i18n.forWindow(); });
  ipcMain.handle('fabric:locale', event => {
    if (!policy.isMailSender(event, mailWindow, config)) throw new Error('Untrusted request');
    return i18n.choice();
  });
  ipcMain.handle('fabric:locale-set', (event, value) => {
    if (!policy.isMailSender(event, mailWindow, config)) throw new Error('Untrusted request');
    const kept = i18n.setChoice(value, { userData: app.getPath('userData') });
    installMenu();
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.reload();
    return { ok: kept };
  });

  const problem = error => (error instanceof deployer.DeployError ? t.text(error.message) : t('Something went wrong on this Mac. Try again.'));
  ipcMain.handle('fabric:cf-intro', async event => {
    trusted(event);
    let bundle = null;
    try { const m = await deployer.readBundle(serverBundleDir); bundle = bundleMatchesApp(m) ? { version: m.version } : null; } catch { bundle = null; }
    return { permissions: deployer.PERMISSIONS, bundle };
  });
  ipcMain.handle('fabric:cf-open-token-page', async event => {
    trusted(event);
    try { await shell.openExternal(deployer.TOKEN_PAGE); return { ok: true }; }
    catch { return { ok: false, error: t('The browser could not be opened. Go to {page} yourself.', { page: deployer.TOKEN_PAGE }) }; }
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
    if (!cloudflareToken) return { ok: false, error: t('Enter the token again.') };
    if (!/^[0-9a-f]{32}$/.test(String(accountId))) return { ok: false, error: t('Choose an account.') };
    try { return { ok: true, details: await deployer.inspect({ token: cloudflareToken, accountId }) }; }
    catch (error) { return { ok: false, error: problem(error) }; }
  });
  ipcMain.handle('fabric:cf-deploy', async (event, input) => {
    trusted(event);
    if (!cloudflareToken) return { ok: false, error: t('Enter the token again.') };
    if (deploying) return { ok: false, error: t('Your server is already being created.') };
    const accountId = String(input?.accountId || '');
    if (!/^[0-9a-f]{32}$/.test(accountId)) return { ok: false, error: t('Choose an account.') };
    // Only the server built with this app is ever uploaded: a stale bundle left from an older
    // build would put old code over newer data (deploy audit, 2026-09-29).
    try {
      const m = await deployer.readBundle(serverBundleDir);
      if (!bundleMatchesApp(m)) return { ok: false, error: t('This app carries server {server} but is {app}; rebuild it (npm run desktop:server-bundle) and try again.', { server: m.version, app: app.getVersion() }) };
    } catch { return { ok: false, error: t('This app does not carry a server to upload. Rebuild it (npm run desktop:server-bundle) and try again.') }; }
    deploying = true;
    const started = Date.now();
    try {
      const result = await deployer.deploy({ token: cloudflareToken, accountId, email: input.email, subdomain: input.subdomain, team: input.team,
        bundleDir: serverBundleDir, onStep: step => { if (!event.sender.isDestroyed()) event.sender.send('fabric:cf-step', { ...step, label: t.text(step.label), detail: t.text(step.detail) }); } });
      logEvent({ event: 'server_deploy', outcome: 'ok', ms: Date.now() - started, steps: result.steps.map(s => `${s.id}:${s.outcome}`) });
      cloudflareToken = null;
      await saveConfig(policy.validateConfig({ origin: result.origin, accessOrigin: result.accessOrigin }));
      track('server_connected', { method: 'created' });
      openAfterSignIn = policy.afterDeployPage(input);
      loadMail();
      return { ok: true, origin: result.origin };
    } catch (error) {
      logEvent({ event: 'server_deploy', outcome: 'failed', ms: Date.now() - started, steps: (error.steps || []).map(s => `${s.id}:${s.outcome}`) });
      return { ok: false, error: problem(error) };
    } finally { deploying = false; }
  });
}
/**
 * Settings… (⌘,) opens the server's Settings screen in the mail window (SCR-02); with no server
 * yet, the local server-address window is the only setting there is. Server address… always opens
 * that window.
 */
function openSettings() {
  if (!config) { showSetup(); return; }
  if (mailWindow && !mailWindow.isDestroyed()) {
    mailWindow.show(); mailWindow.focus();
    void mailWindow.loadURL(new URL(SETTINGS_PAGE, config.origin).href).catch(() => {});
    return;
  }
  openAfterSignIn = SETTINGS_PAGE;
  loadMail();
}
function installMenu() {
  const state = updater ? updater.status() : null;
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, {
    t,
    update: {
      label: state && state.state === 'ready' ? t('Restart to Install Update') : state && state.state === 'downloading' ? t('Downloading Update…')
        : state && state.stuck ? t('Updates Are Not Installing…') : t('Check for Updates…'),
      enabled: !(state && state.state === 'downloading'),
      click: () => {
        const now = updater ? updater.status() : null;
        if (now && now.state === 'ready') void restartToUpdate();
        else if (now && now.stuck) void showUpdatesStuck(now);
        else void checkForUpdates();
      },
    },
    automatic: { checked: !!(state && state.automatic), enabled: !!updater && !['off', 'unavailable'].includes(state.state), click: (item) => { if (updater) void updater.setAutomatic(item.checked); } },
    usage: { checked: !!(analytics && analytics.status().enabled), enabled: !!analytics, click: (item) => void toggleAnalytics(item), about: aboutUsageCounts },
    login: { checked: !!(loginItem && loginItem.enabled), enabled: !!(loginItem && loginItem.supported), click: (item) => void toggleLogin(item) },
    serverUpdate: serverUpdater ? serverUpdater.menuItem(() => void serverUpdater.update({ manual: true })) : null,
    newMail: { checked: !!(mailNotifier && mailNotifier.enabled()), enabled: !!mailNotifier, click: (item) => { if (mailNotifier) void mailNotifier.setEnabled(item.checked).then(installMenu); } },
    openSettings, showServer: () => showSetup(), showCloudflare: () => showSetup('', 'cloudflare'),
    connectGmail: () => { if (config) void openExternal(policy.gmailConnectURL(config), true); else showSetup(t('Set the server address before connecting Gmail.')); },
    retry: loadMail,
    console: consoleAvailable() ? openConsole : null,
  })));
}
/**
 * A running agent console is asked about before the app quits or restarts for an update (Fabric
 * Dashboards ADR-0017); true when it may go. Stopping waits for its key to be revoked (bug hunt
 * 2026-10-12: the app used to exit first, leaving a 30-day key live).
 */
async function consoleMayEnd() {
  if (!agentConsole || !agentConsole.running()) return true;
  const answer = dialog.showMessageBoxSync(consoleWindow && !consoleWindow.isDestroyed() ? consoleWindow : undefined, {
    type: 'question', buttons: [t('Cancel'), t('Quit and stop the agent')], defaultId: 0, cancelId: 0,
    message: t('The agent console is still running.'), detail: t('Quitting stops the agent and revokes its key.') });
  if (answer === 0) return false;
  await agentConsole.stop({ wait: true, timeoutMs: 5000 });
  return true;
}
/**
 * Restart to install a ready update, from the update-ready dialog or the menu (B-104): a running
 * console is asked about and its key revoked first, since an AppImage restart exits without
 * before-quit.
 */
async function restartToUpdate() {
  if (!(await consoleMayEnd())) return;
  updater.restart();
}
let endingConsole = false;
app.on('before-quit', (event) => {
  if (!quitting && agentConsole && agentConsole.running()) {
    event.preventDefault();
    if (endingConsole) return;
    endingConsole = true;
    void consoleMayEnd().then((go) => { endingConsole = false; if (go) { quitting = true; app.quit(); } });
    return;
  }
  quitting = true;
});
// A ready update is installed as the app exits (Squirrel.Mac's ShipIt on macOS, the verified installer on
// Windows; a Linux AppImage is already in place); the next launch logs the result.
let installNoted = false;
app.on('will-quit', (event) => {
  if (installNoted || !updater || updater.status().state !== 'ready' || updater.status().installing) return;
  event.preventDefault();
  installNoted = true;
  void updater.quitting().finally(() => app.quit());
});
// The window coming forward retries usage counts (LC-08); updates run on their own timer (LC-16).
app.on('browser-window-focus', (_event, win) => {
  if (analytics) { void analytics.wake(); void countActive(); void askUsageCounts(win); }
});
// Closing the last window leaves the app running (the organization's lifecycle rule, 2026-10-16): the
// Dock icon on macOS, the tray icon on Windows and Linux bring it back; it ends only by Quit or a signal.
// Without a tray (the desktop offers none) opening the app again brings a window back (second-instance).
app.on('window-all-closed', () => { /* keep running */ });
app.on('activate', () => {
  if (mailWindow && !mailWindow.isDestroyed()) { mailWindow.show(); mailWindow.focus(); }
  else if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
  else loadMail();
});
app.on('second-instance', (_event, argv) => {
  for (const arg of argv || []) queueLink(arg);
  const win = setupWindow || mailWindow;
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  // No window left (Windows and Linux, after the console prompt kept the app running): opening the
  // app again brings one back instead of doing nothing (bug hunt 2026-10-12).
  else if (config) loadMail(); else showSetup();
});
if (ownsInstance) app.whenReady().then(async () => {
  i18n.init({ app, userData: app.getPath('userData') });
  // B-99: an AppImage's AppRun adds --no-sandbox where user namespaces are off (Ubuntu 24.04's default);
  // the .deb keeps the sandbox through its SUID chrome-sandbox. Said in the log, never silent.
  if (process.platform === 'linux' && app.commandLine.hasSwitch('no-sandbox')) logEvent({ event: 'sandbox_off', appImage: !!process.env.APPIMAGE });
  // ...and on screen once per launch, until the person asks not to be told again (B-99: warn, not refuse).
  const dismissedFile = path.join(app.getPath('userData'), policy.SANDBOX_WARNING_FILE);
  if (policy.sandboxWarning(process.platform, app.commandLine.hasSwitch('no-sandbox'), fsSync.existsSync(dismissedFile))) {
    const answer = await dialog.showMessageBox({ type: 'warning', title: 'Fabric Inbox', message: t('Fabric Inbox is running without its sandbox'),
      detail: t('This system does not let the AppImage use Chromium\'s sandbox, which keeps a harmful message from reaching the rest of your computer. The .deb package keeps the sandbox: install it to read mail with that protection.'),
      buttons: [t('Continue'), t('How to keep the sandbox')], defaultId: 1, cancelId: 0,
      checkboxLabel: t('Do not warn me again on this computer'), checkboxChecked: false });
    logEvent({ event: 'sandbox_warning', answer: answer.response === 1 ? 'help' : 'continue', dismissed: !!answer.checkboxChecked });
    if (answer.checkboxChecked) { try { fsSync.writeFileSync(dismissedFile, 'off\n', { mode: 0o600 }); } catch { /* asked again next launch */ } }
    if (answer.response === 1) void electron.shell.openExternal(policy.SANDBOX_HELP_URL);
  }
  // PL-05: no Secret Service on Linux means no protected sign-in; say so and stop (never plain text).
  const refusal = policy.keyStoreRefusal(process.platform, process.platform === 'linux' && electron.safeStorage && typeof electron.safeStorage.getSelectedStorageBackend === 'function'
    ? electron.safeStorage.getSelectedStorageBackend() : null);
  if (refusal) {
    logEvent({ event: 'key_store_refused', backend: refusal });
    dialog.showMessageBoxSync({ type: 'error', title: 'Fabric Inbox', message: t('Fabric Inbox needs a system key store'),
      detail: t('It keeps your sign-in encrypted with the Secret Service (GNOME Keyring or KWallet), and none was found. Install or unlock one, then open Fabric Inbox again. On a desktop other than GNOME or KDE, start it with --password-store=gnome-libsecret.'),
      buttons: [t('Quit Fabric Inbox')] });
    app.exit(1);
    return;
  }
  installIPC(); installMenu(); await loadBundledSetups(); await loadAgentSetup();
  // The Mac woke from sleep: the open mail window reads new mail now instead of at its next poll
  // (P1-4). An event, not a timer: nothing runs here while the Mac sleeps or no window is open.
  if (electron.powerMonitor) electron.powerMonitor.on('resume', () => {
    if (mailWindow && !mailWindow.isDestroyed()) mailWindow.webContents.send('fabric:resumed');
  });
  // Orphan partitions and settings leftovers go before any window opens (LC-12). An unreadable
  // server.json is kept and nothing is swept: the person is about to enter that server again.
  // With no server known at all, no partition is an orphan yet: it may be the server the person is
  // about to enter again, with their drafts in it.
  if (await readConfig()) await profile.sweepProfile({ fs, userData: app.getPath('userData'), keepPartition: config ? policy.partitionFor(config) : null, keepPartitions: !config,
    debugging: app.commandLine.hasSwitch('remote-debugging-port'), log: logEvent });
  startServerUpdates();
  config ? loadMail() : showSetup(notice);
  appReady = true;
  void startAnalytics().catch(() => {});
  updatesStarted = startUpdates().catch(() => logEvent({ event: 'update_check', outcome: 'check_failed', reason: 'not_started' }));
  startTray();
  startNewMail();
  void startAutostart().catch(() => logEvent({ event: 'login_item', outcome: 'failed', reason: 'not_started' }));
  for (const arg of process.argv || []) queueLink(arg);
  void drainLinks();
});
