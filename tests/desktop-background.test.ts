import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);

/**
 * knowledge/lifecycle.md "Background launch" (LC-07): with --background the lifecycle broker starts the app for an
 * agent with no window; the first activate (a Dock click, Cmd+Tab) shows the mail window. Without the flag, or with no
 * server yet, a window opens at launch as before.
 */
async function boot(userData: string, switches: string[], server = true) {
  const windows: any[] = [];
  const config = { origin: "https://mail.example.com", accessOrigin: "" };
  class FakeWindow extends EventEmitter {
    destroyed = false; options: any; webContents: any;
    constructor(options: any) {
      super(); this.options = options;
      const mainFrame = { url: config.origin + "/" };
      this.webContents = Object.assign(new EventEmitter(), { session: fakeSession, mainFrame, setWindowOpenHandler() {}, send() {}, getURL: () => mainFrame.url });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    hide() {} show() {} focus() {} setTitle() {} reload() {}
    loadURL() { return Promise.resolve(); } loadFile() { return Promise.resolve(); }
    close() { this.destroyed = true; this.emit("closed"); }
  }
  const fakeSession = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} });
  const fakeApp = Object.assign(new EventEmitter(), {
    isPackaged: true, commandLine: { hasSwitch: (name: string) => switches.includes(name) }, setName() {}, enableSandbox() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => userData, getVersion: () => "0.12.0",
    getPreferredSystemLanguages: () => ["en-US"],
  });
  const fakeElectron = {
    app: fakeApp, BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (x: any) => x, setApplicationMenu() {} },
    ipcMain: { handle() {}, on() {} }, shell: {}, dialog: {},
    session: { fromPartition: () => fakeSession }, powerMonitor: new EventEmitter(),
  };
  const logged: any[] = [];
  const code = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  runInNewContext(code, {
    require: (name: string) => name === "electron" ? fakeElectron
      : name === "node:fs/promises" ? { readFile: async (p: string) => (server && String(p).endsWith("server.json") ? JSON.stringify(config) : Promise.reject(Object.assign(new Error("none"), { code: "ENOENT" }))), readdir: async () => [], rm: async () => {}, mkdir: async () => {}, writeFile: async () => {}, chmod: async () => {}, rename: async () => {} }
      : name === "./log.cjs" ? { ...require("../desktop/log.cjs"), logEvent: (e: any) => logged.push(e), createLog: () => (e: any) => logged.push(e) }
      // B-243: the profile watcher (B-236) gets a stand-in, so no real watch holds the temporary profile that the
      // test then removes (on Windows that removal hung the platforms run).
      : name === "node:fs" ? { ...require("node:fs"), watch: () => Object.assign(new EventEmitter(), { close() {}, unref() {} }) }
      : name.startsWith("./") ? require("../desktop/" + name.slice(2)) : require(name),
    __dirname: "/fixture/desktop", process: { platform: "darwin", argv: [] }, URL, console: { log() {}, error() {}, warn() {} },
    setTimeout: () => 1, clearTimeout() {}, AbortSignal, globalThis: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const mail = () => windows.filter((w) => w.options.webPreferences?.preload?.endsWith("mail-preload.cjs") && !w.destroyed);
  return { app: fakeApp, windows, mail };
}

test("--background opens no window until the first activate; the mail window then opens once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-desktop-bg-"));
  try {
    const { app, windows, mail } = await boot(dir, ["background"]);
    assert.equal(windows.length, 0, "no window at a background launch");
    app.emit("activate");
    assert.equal(mail().length, 1, "the first activate shows the mail window");
    app.emit("activate");
    assert.equal(mail().length, 1, "a second activate brings the same window forward");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("without --background, or with no server yet, a window opens at launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-desktop-bg-"));
  try {
    assert.equal((await boot(dir, [])).mail().length, 1, "the mail window at a plain launch");
    const first = await boot(dir, ["background"], false);
    assert.ok(first.windows.length >= 1, "setup shows on a first run even in the background: nothing else could happen");
    assert.equal(first.mail().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
