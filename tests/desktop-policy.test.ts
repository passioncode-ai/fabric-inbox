import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { serverOrigin, accessOrigin, validateConfig, navigation, gmailConnectURL, partitionFor, isSetupSender } = require('../desktop/policy.cjs');
const config = validateConfig({ origin: 'https://mail.example.com', accessOrigin: 'https://team.cloudflareaccess.com' });

test('settings reject credentials, paths and nonlocal cleartext', () => {
  for (const value of ['http://mail.example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://a:b@mail.example.invalid', 'https://mail.example.com/settings', 'https://mail.example.com?token=x', 'https://mail.example.com#x', 'https://mail.example.com\\@evil.example', 'https://mail.example.com\n.evil.example']) {
    assert.throws(() => serverOrigin(value), value);
  }
  assert.equal(serverOrigin('https://MAIL.example.com/'), config.origin);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(serverOrigin(`http://${host}:5173`), `http://${host}:5173`);
  assert.throws(() => serverOrigin('http://localhost.evil.example:5173'));
});

test('Access is an exact explicitly configured team origin', () => {
  assert.equal(accessOrigin(''), '');
  for (const value of ['https://cloudflareaccess.com', 'https://team.cloudflareaccess.com.evil.example', 'http://team.cloudflareaccess.com', 'https://team.cloudflareaccess.com:9443', 'https://nested.team.cloudflareaccess.com']) assert.throws(() => accessOrigin(value));
  assert.equal(navigation('https://team.cloudflareaccess.com/cdn-cgi/access/login', config), 'internal');
  assert.equal(navigation('https://other.cloudflareaccess.com/login', config), 'external');
  assert.equal(navigation('https://team.cloudflareaccess.com/login', { origin: config.origin, accessOrigin: '' }), 'external');
});

test('navigation isolates remote content and sends only safe websites outside', () => {
  assert.equal(navigation('https://mail.example.com/inbox', config), 'internal');
  for (const value of ['https://mail.example.com.evil.example', 'https://mail.example.com:9443', 'https://example.net']) assert.equal(navigation(value, config), 'external');
  for (const value of ['file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'mailto:person@example.com', 'https://user:pass@example.net', 'http://example.net', 'fabric://open']) assert.equal(navigation(value, config), 'deny');
});

test('Gmail starts at server route, never by forwarding supplied OAuth query', () => {
  assert.equal(navigation('https://mail.example.com/api/accounts/gmail/connect?redirect=evil', config), 'gmail');
  assert.equal(gmailConnectURL(config), 'https://mail.example.com/api/accounts/gmail/connect');
  assert.equal(navigation('https://evil.example/api/accounts/gmail/connect', config), 'external');
});

test('sessions are stable per server and separated across origins', () => {
  assert.equal(partitionFor(config), partitionFor({ ...config, accessOrigin: '' }));
  assert.notEqual(partitionFor(config), partitionFor({ origin: 'https://other.example' }));
  assert.match(partitionFor(config), /^persist:fabric-[a-f0-9]{24}$/);
});

test('setup IPC rejects remote pages, sibling windows and subframes', () => {
  const frame = { url: 'file:///app/setup.html' };
  const webContents = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: frame };
  assert.equal(isSetupSender(event, win, frame.url), true);
  assert.equal(isSetupSender({ ...event, sender: {} }, win, frame.url), false);
  assert.equal(isSetupSender({ ...event, senderFrame: { url: frame.url } }, win, frame.url), false);
  assert.equal(isSetupSender(event, win, 'https://mail.example.com'), false);
  assert.equal(isSetupSender(event, { ...win, isDestroyed: () => true }, frame.url), false);
  assert.equal(isSetupSender(event, null, frame.url), false);
});

test('a failed remote load cannot close recovery when Chromium finishes its error page', async () => {
  const { EventEmitter } = await import('node:events');
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const windows: any[] = [];
  const fakeSession = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} });
  class FakeWindow extends EventEmitter {
    destroyed = false;
    visible = true;
    webContents: any;
    options: any;
    constructor(options: any) {
      super(); this.options = options;
      this.webContents = Object.assign(new EventEmitter(), { session: fakeSession, setWindowOpenHandler() {} });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    hide() { this.visible = false; }
    show() { this.visible = true; }
    focus() {}
    setTitle() {}
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    close() { this.destroyed = true; this.emit('closed'); }
  }
  const fakeApp = Object.assign(new EventEmitter(), {
    isPackaged: true, commandLine: { hasSwitch: () => false },
    setName() {}, enableSandbox() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => '/fixture',
  });
  const fakeElectron = { app: fakeApp, BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (x: any) => x, setApplicationMenu() {} },
    ipcMain: { handle() {} }, shell: {}, dialog: {}, session: { fromPartition: () => fakeSession } };
  const code = await readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  runInNewContext(code, {
    require: (name: string) => name === 'electron' ? fakeElectron : name === 'node:fs/promises' ? { readFile: async () => JSON.stringify(config), readdir: async () => [] } : name === './policy.cjs' ? require('../desktop/policy.cjs') : name === './cloudflare-deploy.cjs' ? require('../desktop/cloudflare-deploy.cjs') : name === './profile.cjs' ? require('../desktop/profile.cjs') : name === './connect.cjs' ? require('../desktop/connect.cjs') : name.startsWith('./') ? require('../desktop/' + name.slice(2)) : require(name),
    __dirname: '/fixture/desktop', process: { platform: 'darwin' }, URL,
    setTimeout: () => 1, clearTimeout() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 1);
  const mail = windows[0];
  // The server page gets one narrow bridge and nothing else (desktop/mail-preload.cjs).
  assert.equal(mail.options.webPreferences.preload, '/fixture/desktop/mail-preload.cjs');
  const bridge = await readFile(new URL('../desktop/mail-preload.cjs', import.meta.url), 'utf8');
  assert.deepEqual([...bridge.matchAll(/ipcRenderer\.(\w+)\('([^']+)'/g)].map(m => m[1] + ' ' + m[2]),
    ['invoke fabric:pending-setup', 'invoke fabric:pending-setup-done']);
  assert.equal(mail.options.webPreferences.sandbox, true);
  assert.equal(mail.options.webPreferences.nodeIntegration, false);
  mail.webContents.emit('did-fail-load', {}, -102, 'connection refused', config.origin, true);
  assert.equal(windows.length, 2);
  const recovery = windows[1];
  assert.equal(mail.visible, false);
  mail.webContents.emit('did-finish-load');
  assert.equal(recovery.destroyed, false);
  assert.equal(recovery.visible, true);
  assert.equal(mail.visible, false);
});

test("SCN-028: a setup file is read for its server and counted; anything else is refused with a reason", async () => {
  const { readFileSync } = await import("node:fs");
  const policy = (await import("../desktop/policy.cjs")).default as any;
  const owner = JSON.parse(readFileSync("deployments/setup.example.json", "utf8"));
  const read = policy.readSetup(owner);
  assert.equal(read.ok, true);
  assert.equal(read.summary.origin, "https://fabric-inbox.your-subdomain.workers.dev");
  assert.equal(read.summary.accessOrigin, "https://your-team.cloudflareaccess.com");
  assert.equal(read.summary.domainCount, owner.domains.length);
  assert.equal(read.summary.mailboxCount, owner.mailboxes.length);
  assert.equal(read.summary.byDomain.reduce((n: number, d: any) => n + d.addresses.length, 0), owner.mailboxes.length);
  for (const [value, message] of [
    [null, /not a Fabric Inbox setup/],
    [{ ...owner, format: "other/1" }, /unknown format/],
    [{ ...owner, server: { origin: "http://inbox.example.com" } }, /server address cannot be used/],
    [{ ...owner, server: { origin: "https://ok.example.com", accessOrigin: "https://evil.example.com" } }, /server address cannot be used/],
    [{ ...owner, domains: ["not a domain"] }, /not a domain name/],
    [{ ...owner, mailboxes: [{ address: "nope" }] }, /not an email address/],
  ] as const) {
    const r = policy.readSetup(value);
    assert.equal(r.ok, false);
    assert.match(r.error, message);
  }
});

test("the pending-setup bridge answers only the configured server's main frame", async () => {
  const policy = (await import("../desktop/policy.cjs")).default as any;
  const mainFrame = { url: "https://inbox.example.com/setup" };
  const contents = { mainFrame };
  const win = { isDestroyed: () => false, webContents: contents };
  const config = { origin: "https://inbox.example.com" };
  assert.equal(policy.isMailSender({ sender: contents, senderFrame: mainFrame }, win, config), true);
  assert.equal(policy.isMailSender({ sender: contents, senderFrame: { url: "https://inbox.example.com/" } }, win, config), false, "a subframe");
  assert.equal(policy.isMailSender({ sender: contents, senderFrame: mainFrame }, win, { origin: "https://other.example.com" }), false);
  assert.equal(policy.isMailSender({ sender: {}, senderFrame: mainFrame }, win, config), false);
  const navigated = { url: "https://evil.example.com/" };
  assert.equal(policy.isMailSender({ sender: { mainFrame: navigated }, senderFrame: navigated }, { isDestroyed: () => false, webContents: { mainFrame: navigated } }, config), false);
});

test("the public app carries no personal setup: nothing under desktop/ names a deployment's domains", async () => {
  const { execFileSync } = await import("node:child_process");
  const tracked = execFileSync("git", ["ls-files", "desktop"], { encoding: "utf8" }).split("\n").filter(Boolean);
  assert.equal(tracked.some((f) => f.startsWith("desktop/setups/")), false);
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  // Deployments are local (git-ignored): on a clone with none, the tracked-files check above is the test.
  const local = existsSync("deployments") ? readdirSync("deployments").filter((d) => existsSync(`deployments/${d}/setup.json`)) : [];
  const domains = local.flatMap((d) => (JSON.parse(readFileSync(`deployments/${d}/setup.json`, "utf8")).domains ?? []) as string[]);
  for (const file of tracked.filter((f) => /\.(cjs|js|html|json|css)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    for (const d of domains) assert.equal(text.includes(d), false, `${file} mentions a deployment's domain`);
  }
});
