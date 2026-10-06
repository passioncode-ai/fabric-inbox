import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);

/**
 * SCN-076 in the Mac app: the mail window (and only it) reads and sets this Mac's language, the
 * menus follow at once, and the first-run window gets the words it needs (L10N-01).
 */
async function boot(userData: string) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const menus: any[] = [];
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
    isPackaged: true, commandLine: { hasSwitch: () => false }, setName() {}, enableSandbox() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => userData, getVersion: () => "0.12.0",
    getPreferredSystemLanguages: () => ["en-US"],
  });
  const fakeElectron = {
    app: fakeApp, BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (x: any) => x, setApplicationMenu: (m: any) => menus.push(m) },
    ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) }, shell: {}, dialog: {},
    session: { fromPartition: () => fakeSession }, powerMonitor: new EventEmitter(),
  };
  const code = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  runInNewContext(code, {
    require: (name: string) => name === "electron" ? fakeElectron
      : name === "node:fs/promises" ? { readFile: async (p: string) => (String(p).endsWith("server.json") ? JSON.stringify(config) : Promise.reject(Object.assign(new Error("none"), { code: "ENOENT" }))), readdir: async () => [], rm: async () => {}, mkdir: async () => {}, writeFile: async () => {}, chmod: async () => {}, rename: async () => {} }
      : name.startsWith("./") ? require("../desktop/" + name.slice(2)) : require(name),
    __dirname: "/fixture/desktop", process: { platform: "darwin", argv: [] }, URL, console: { log() {}, error() {}, warn() {} },
    setTimeout: () => 1, clearTimeout() {}, AbortSignal, globalThis: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { handlers, menus, windows };
}

test("only the mail window reads and sets the language; the menus follow at once (SCN-076)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-desktop-i18n-"));
  const i18n = require("../desktop/i18n.cjs");
  try {
    const { handlers, menus, windows } = await boot(dir);
    const mail = windows.find((w) => w.options.webPreferences.preload.endsWith("mail-preload.cjs"));
    assert.ok(mail, "the mail window opened");
    const trusted = { sender: mail.webContents, senderFrame: mail.webContents.mainFrame };
    const label = (menu: any) => menu[0].submenu.find((i: any) => i.accelerator === "CmdOrCtrl+,").label;
    assert.equal(label(menus.at(-1)), "Settings…", "an English system starts in English");
    assert.equal(handlers.get("fabric:locale")!(trusted), "system");
    // Another page, or a frame inside the mail window, may not change it.
    assert.throws(() => handlers.get("fabric:locale-set")!({ sender: {}, senderFrame: {} }, "ru"));
    assert.throws(() => handlers.get("fabric:locale-set")!({ sender: mail.webContents, senderFrame: { url: "https://mail.example.com/" } }, "ru"));
    assert.equal(existsSync(join(dir, "locale.json")), false);
    assert.equal(handlers.get("fabric:locale-set")!(trusted, "ru").ok, true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "locale.json"), "utf8")), { choice: "ru" });
    assert.equal(label(menus.at(-1)), "Настройки…", "the menu is rebuilt in Russian");
    assert.equal(menus.at(-1).find((m: any) => m.role === "windowMenu").label, "Окно");
    assert.equal(handlers.get("fabric:locale")!(trusted), "ru");
    // The first-run window asks for the words through its own, trusted channel only.
    assert.throws(() => handlers.get("fabric:setup-locale")!(trusted));
    handlers.get("fabric:locale-set")!(trusted, "system");
    assert.equal(label(menus.at(-1)), "Settings…");
  } finally {
    i18n._setForTests("en");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first-run window marks only plain text for translation, and every mark has its Russian", async () => {
  const html = readFileSync("desktop/setup.html", "utf8");
  const copy = JSON.parse(readFileSync("desktop/locales/ru.json", "utf8"));
  const marked = [...html.matchAll(/<(\w+)[^>]*\sdata-i18n[\s>][\s\S]*?<\/\1>/g)].map((m) => m[0]);
  assert.ok(marked.length > 40);
  for (const el of marked) {
    const inner = el.replace(/^<\w+[^>]*>/, "").replace(/<\/\w+>$/, "");
    assert.doesNotMatch(inner, /<(button|input|select|textarea|a)\b/, `a marked element holds a control: ${inner.slice(0, 60)}`);
    const key = inner.replace(/\s+/g, " ").trim();
    assert.ok(copy[key], `no Russian for ${key.slice(0, 60)}`);
  }
  assert.match(readFileSync("desktop/setup.js", "utf8"), /document\.documentElement\.lang = LOCALE/, "the window's lang follows the language");
});
