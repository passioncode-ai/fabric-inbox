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
const { menuTemplate } = require('./menu.cjs');
const usage = require('./analytics.cjs');
const backup = require('./backup.cjs');
const updates = require('./updater.cjs');
const i18n = require('./i18n.cjs');
const { t } = i18n;
const updateVerify = require('./update-verify.cjs');
const platformInstaller = require('./platform-installer.cjs');
const { createLog } = require('./log.cjs');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const execFileAsync = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve({ stdout }))));
const { createWriteStream, existsSync, constants: fsConstants } = require('node:fs');

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
    appVersion: app.getVersion(), osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
    locale: typeof app.getLocale === 'function' ? app.getLocale() : '', engineVersion: (process.versions && process.versions.electron) || '',
    log: logEvent });
  await analytics.start({ launch: launchedByLink ? 'link' : 'ordinary', serverConfigured: !!config });
  installMenu();
  if (!config) void countActive();
}
async function startUpdates() {
  const target = platformInstaller.updateTarget({ platform: process.platform, arch: process.arch, execPath: process.execPath, env: process.env,
    installedOnMac: typeof app.isInApplicationsFolder === 'function' && app.isInApplicationsFolder(), exists: existsSync });
  // macOS: Squirrel.Mac installs. Windows and Linux: the verified installer or AppImage (PL-03).
  const autoUpdater = process.platform === 'darwin' ? electron.autoUpdater
    : platformInstaller.createPlatformInstaller({ platform: process.platform, app, spawn, fs, appImage: target.appImage, log: logEvent,
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
      dir: path.join(app.getPath('cache'), app.getName(), 'updates'), fetch: globalThis.fetch, exec, fs, createWriteStream, key, log: logEvent });
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
  updater = updates.createUpdater({ autoUpdater, fs, userData: app.getPath('userData'), feed, appVersion: app.getVersion(), fetchFeed, verifier, replaceable,
    setTimer, clearTimer: clearTimeout, log: logEvent, onChange: () => installMenu() });
  await updater.start({ packaged: app.isPackaged, mas: !!process.mas, inApplications: target.installed, packageManager: target.packageManager });
  installMenu();
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
    if (answer.response === 1) updater.restart();
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
function aboutUsageCounts() {
  void dialog.showMessageBox({ type: 'info', title: t('Usage counts'), message: t('Anonymous usage counts'),
    detail: t('When this is on, Fabric Inbox tells PassionCode.ai that it was installed and opened, once a day that it was used, and how many Gmail accounts, Cloudflare mailboxes, agents and agent keys your server has. It never sends names, email addresses, domains, messages, keys or anything from your mail. The setting is shared by every PassionCode app on this Mac.'),
    buttons: [t('OK')] });
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
const attend = connector.attendWith(app);
/** The window a connect prompt is attached to: the open one, else the mail (or setup) window opened for it. */
function promptWindow() {
  const live = (win) => (win && !win.isDestroyed() ? win : null);
  if (live(mailWindow) || live(setupWindow)) return live(mailWindow) || live(setupWindow);
  loadMail();
  return live(mailWindow) || live(setupWindow);
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
      label: state && state.state === 'ready' ? t('Restart to Install Update') : state && state.state === 'downloading' ? t('Downloading Update…') : t('Check for Updates…'),
      enabled: !(state && state.state === 'downloading'),
      click: () => { if (updater && updater.status().state === 'ready') updater.restart(); else void checkForUpdates(); },
    },
    automatic: { checked: !!(state && state.automatic), enabled: !!updater && !['off', 'unavailable'].includes(state.state), click: (item) => { if (updater) void updater.setAutomatic(item.checked); } },
    usage: { checked: !!(analytics && analytics.status().enabled), enabled: !!analytics, click: (item) => void toggleAnalytics(item), about: aboutUsageCounts },
    openSettings, showServer: () => showSetup(), showCloudflare: () => showSetup('', 'cloudflare'),
    connectGmail: () => { if (config) void openExternal(policy.gmailConnectURL(config), true); else showSetup(t('Set the server address before connecting Gmail.')); },
    retry: loadMail,
  })));
}
app.on('before-quit', () => { quitting = true; });
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
app.on('browser-window-focus', () => {
  if (analytics) { void analytics.wake(); void countActive(); }
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
  i18n.init({ app, userData: app.getPath('userData') });
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
  config ? loadMail() : showSetup(notice);
  appReady = true;
  void startAnalytics().catch(() => {});
  void startUpdates().catch(() => logEvent({ event: 'update_check', outcome: 'check_failed', reason: 'not_started' }));
  for (const arg of process.argv || []) queueLink(arg);
  void drainLinks();
});
