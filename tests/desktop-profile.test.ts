// LC-12 and LC-14 (knowledge/lifecycle.md): storage for a removed origin is removed with it, temp
// leftovers are swept at start, and development runs never write into the installed app's profile.
// The audit found 62 MB of dead per-origin partitions and a leftover server.json backup in the real
// profile (raw/fabric-inbox.md §4, F3), and a debug-port file left by a launch on that profile (F8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const profile = require("../desktop/profile.cjs");
const policy = require("../desktop/policy.cjs");

const A = "https://mail-a.example.com";
const B = "https://mail-b.example.com";
const dirOf = (origin: string) => profile.partitionDirName(policy.partitionFor({ origin }));

test("a server's partition directory is named from its persistent partition, and nothing else qualifies", () => {
  assert.match(dirOf(A), /^fabric-[0-9a-f]{24}$/);
  assert.equal(profile.partitionDirName("persist:" + dirOf(A)), dirOf(A));
  for (const other of ["fabric-setup", "persist:fabric-setup", "persist:other-0123456789abcdef01234567", "persist:fabric-XYZ"]) {
    assert.equal(profile.partitionDirName(other), null, other);
  }
});

function userData() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-profile-"));
  const partitions = path.join(dir, "Partitions");
  for (const name of [dirOf(A), dirOf(B), dirOf("http://127.0.0.1:8787"), "GraphiteDawnCache", "not-ours"]) {
    mkdirSync(path.join(partitions, name, "Cache"), { recursive: true });
    writeFileSync(path.join(partitions, name, "Cookies"), "x");
  }
  for (const name of ["server.json", "server.json.tmp", "server.json.bak-onboarding-test", "pending-setup.json.tmp", "Local State", "Preferences"]) {
    writeFileSync(path.join(dir, name), "{}");
  }
  mkdirSync(path.join(dir, "server.json.d"));
  return dir;
}

test("the start-up sweep removes other servers' partitions and config leftovers, and keeps the current server", async () => {
  const dir = userData();
  const events: unknown[] = [];
  const removed = await profile.sweepProfile({ fs: fsPromises, userData: dir, keepPartition: policy.partitionFor({ origin: A }), log: (e: unknown) => events.push(e) });
  assert.deepEqual(readdirSync(path.join(dir, "Partitions")).sort(), [dirOf(A), "GraphiteDawnCache", "not-ours"].sort());
  assert.deepEqual(readdirSync(dir).sort(), ["Local State", "Partitions", "Preferences", "server.json", "server.json.d"]);
  assert.deepEqual(removed.partitions.sort(), [dirOf(B), dirOf("http://127.0.0.1:8787")].sort());
  assert.deepEqual(removed.files.sort(), ["pending-setup.json.tmp", "server.json.bak-onboarding-test", "server.json.tmp"]);
  assert.deepEqual(events, [{ event: "profile_sweep", outcome: "ok", partitions: 2, files: 3 }]);
});

test("with no server configured every server partition is an orphan; a profile without partitions is fine", async () => {
  const dir = userData();
  await profile.sweepProfile({ fs: fsPromises, userData: dir, keepPartition: null, log() {} });
  assert.deepEqual(readdirSync(path.join(dir, "Partitions")).sort(), ["GraphiteDawnCache", "not-ours"]);
  const empty = mkdtempSync(path.join(os.tmpdir(), "fabric-profile-"));
  assert.deepEqual(await profile.sweepProfile({ fs: fsPromises, userData: empty, keepPartition: null, log() {} }), { partitions: [], files: [] });
});

test("a failing sweep is logged and never stops the app from starting", async () => {
  const events: any[] = [];
  const broken = { readdir: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }, rm: async () => {} };
  const removed = await profile.sweepProfile({ fs: broken, userData: "/nowhere", keepPartition: null, log: (e: unknown) => events.push(e) });
  assert.deepEqual(removed, { partitions: [], files: [] });
  assert.equal(events[0].event, "profile_sweep");
  assert.equal(events[0].outcome, "failed");
  assert.equal(events[0].code, "EACCES");
});

test("retiring a server during a run clears its storage and keeps its directory for the sweep", async () => {
  const dir = userData();
  const ses = { clearStorageData: async () => {}, clearCache: async () => {} };
  const events: unknown[] = [];
  await profile.retirePartition({ fs: fsPromises, userData: dir, partition: policy.partitionFor({ origin: B }), session: ses, removeDirectory: false, log: (e: unknown) => events.push(e) });
  assert.equal(existsSync(path.join(dir, "Partitions", dirOf(B))), true);
  assert.deepEqual(events, [{ event: "partition_retired", outcome: "ok", directory: "kept until the next start" }]);
});

test("retiring a server clears its session storage and cache, then removes its directory", async () => {
  const dir = userData();
  const calls: string[] = [];
  const ses = { clearStorageData: async () => { calls.push("storage"); }, clearCache: async () => { calls.push("cache"); } };
  const events: unknown[] = [];
  await profile.retirePartition({ fs: fsPromises, userData: dir, partition: policy.partitionFor({ origin: B }), session: ses, log: (e: unknown) => events.push(e) });
  assert.deepEqual(calls, ["storage", "cache"]);
  assert.equal(existsSync(path.join(dir, "Partitions", dirOf(B))), false);
  assert.equal(existsSync(path.join(dir, "Partitions", dirOf(A))), true);
  assert.deepEqual(events, [{ event: "partition_retired", outcome: "ok" }]);
  // Clearing can fail (the session is gone); the directory still goes and the failure is logged.
  const failing = { clearStorageData: async () => { throw new Error("gone"); }, clearCache: async () => {} };
  const more: any[] = [];
  await profile.retirePartition({ fs: fsPromises, userData: dir, partition: policy.partitionFor({ origin: A }), session: failing, log: (e: unknown) => more.push(e) });
  assert.equal(existsSync(path.join(dir, "Partitions", dirOf(A))), false);
  assert.deepEqual(more, [{ event: "partition_retired", outcome: "storage_not_cleared", reason: "gone" }]);
  // Only this app's per-server partitions are ever retired.
  await assert.rejects(profile.retirePartition({ fs: fsPromises, userData: dir, partition: "persist:../../x", session: ses, log() {} }), /not a server partition/);
});

// ---- desktop/main.cjs wiring, driven through the same fake Electron the policy tests use ----

type Harness = Awaited<ReturnType<typeof boot>>;
async function boot({ config, packaged = true, switches = [] as string[], files = {} as Record<string, string[]>, readError = "", backupJson = "" }:
  { config?: { origin: string; accessOrigin: string }; packaged?: boolean; switches?: string[]; files?: Record<string, string[]>; readError?: string; backupJson?: string }) {
  const log: string[] = [];
  const windows: any[] = [];
  const sessions = new Map<string, any>();
  const handlers = new Map<string, Function>();
  let menu: any[] = [];
  const sessionFor = (partition: string) => {
    if (!sessions.has(partition)) {
      sessions.set(partition, Object.assign(new EventEmitter(), {
        partition, cleared: [] as string[],
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        async clearStorageData() { log.push(`clear-storage ${partition}`); },
        async clearCache() { log.push(`clear-cache ${partition}`); },
      }));
    }
    return sessions.get(partition);
  };
  class FakeWindow extends EventEmitter {
    destroyed = false;
    options: any;
    webContents: any;
    constructor(options: any) {
      super(); this.options = options;
      const partition = options.webPreferences.session?.partition ?? options.webPreferences.partition;
      const frame = { url: "" };
      this.webContents = Object.assign(new EventEmitter(), { session: sessionFor(partition), mainFrame: frame, setWindowOpenHandler() {}, getURL: () => frame.url });
      log.push(`window ${partition}`);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; log.push(`destroy ${this.webContents.session.partition}`); this.emit("closed"); }
    hide() {} show() {} focus() {} setTitle() {} reload() {} isMinimized() { return false; }
    loadURL(url: string) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    loadFile(file: string) { this.webContents.mainFrame.url = "file://" + file; return Promise.resolve(); }
    close() { this.destroy(); }
  }
  const paths: Record<string, string> = { userData: "/fixture/Fabric Inbox", appData: "/fixture" };
  const fakeApp = Object.assign(new EventEmitter(), {
    isPackaged: packaged,
    commandLine: { hasSwitch: (name: string) => switches.includes(name) },
    setName() {}, enableSandbox() {},
    requestSingleInstanceLock: () => { log.push(`lock ${paths.userData}`); return true; },
    whenReady: () => Promise.resolve(), getPath: (name: string) => paths[name], getVersion: () => "0.0.0",
    setPath: (name: string, value: string) => { log.push(`set-path ${name} ${value}`); paths[name] = value; },
  });
  const fakeFs = {
    readFile: async (file: string) => {
      if (file.endsWith("server.json")) {
        if (readError) return readError;
        if (!config) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return JSON.stringify(config);
      }
      if (file.endsWith("PassionCode/backups/fabric-inbox.json") && backupJson) return backupJson;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readdir: async (dir: string) => {
      const names = files[dir];
      if (!names) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return names.map((name) => ({ name, isDirectory: () => !name.includes(".json"), isFile: () => name.includes(".json") }));
    },
    rm: async (target: string) => { log.push(`rm ${target}`); },
    mkdir: async () => {}, writeFile: async (file: string) => { log.push(`write ${file}`); }, chmod: async () => {}, rename: async (from: string, to: string) => { log.push(`rename ${to}`); },
  };
  const fakeElectron = {
    app: fakeApp, BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (x: any) => { menu = x; return x; }, setApplicationMenu() {} },
    ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) }, shell: {}, dialog: {},
    session: { fromPartition: sessionFor },
  };
  const code = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  runInNewContext(code, {
    require: (name: string) => name === "electron" ? fakeElectron : name === "node:fs/promises" ? fakeFs
      : name.startsWith("./") ? require("../desktop/" + name.slice(2)) : require(name),
    __dirname: "/fixture/desktop", process: { platform: "darwin" }, URL, console: { log() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const openSettings = () => menu[0].submenu.find((item: any) => item.label === "Server settings…").click();
  const setupSender = () => {
    const setup = windows.filter((w) => w.options.webPreferences.partition === "fabric-setup").pop();
    return { sender: setup.webContents, senderFrame: setup.webContents.mainFrame };
  };
  const mailWindows = () => windows.filter((w) => w.options.webPreferences.session);
  return { log, windows, mailWindows, sessions, handlers, settle, openSettings, setupSender, menu: () => menu };
}

const P = "/fixture/Fabric Inbox/Partitions";

test("at start the orphan partitions and leftovers go before the current server's window opens", async () => {
  const h: Harness = await boot({
    config: { origin: A, accessOrigin: "" },
    files: { [P]: [dirOf(A), dirOf(B), "GraphiteDawnCache"], "/fixture/Fabric Inbox": ["server.json", "server.json.bak-onboarding-test", "Partitions"] },
  });
  await h.settle();
  const rmB = h.log.indexOf(`rm ${P}/${dirOf(B)}`);
  const windowA = h.log.indexOf(`window ${policy.partitionFor({ origin: A })}`);
  assert.ok(rmB >= 0, h.log.join("\n"));
  assert.ok(h.log.includes("rm /fixture/Fabric Inbox/server.json.bak-onboarding-test"));
  assert.ok(windowA > rmB, "the sweep finishes before the mail window is created");
  assert.ok(!h.log.includes(`rm ${P}/${dirOf(A)}`), "the current server's partition is kept");
  assert.ok(!h.log.some((l) => l.includes("GraphiteDawnCache")));
});

test("an unreadable server setting is not a reason to delete the session the person is about to re-enter", async () => {
  const h = await boot({ readError: "{not json", files: { [P]: [dirOf(A)] } });
  await h.settle();
  assert.ok(!h.log.some((l) => l.startsWith("rm ")), h.log.join("\n"));
});

test("changing the server retires the old server's storage once the new one answers, and keeps its directory for the next start", async () => {
  const h = await boot({ config: { origin: A, accessOrigin: "" }, files: { [P]: [dirOf(A)] } });
  await h.settle();
  h.menu()[3].submenu.find((i: any) => i.label === "Retry connection").click();
  await h.settle();
  assert.ok(!h.log.some((l) => l.startsWith("clear-") || l.startsWith(`rm ${P}`)), "same server: nothing is cleared");
  h.openSettings();
  const answer = await h.handlers.get("fabric:setup-save")!(h.setupSender(), { origin: B, accessOrigin: "" });
  assert.equal(answer.ok, true);
  await h.settle();
  const oldPartition = policy.partitionFor({ origin: A });
  assert.ok(h.log.includes(`destroy ${oldPartition}`));
  assert.ok(!h.log.some((l) => l.startsWith("clear-")), "nothing is cleared before the new server answers");
  h.mailWindows().pop().webContents.emit("did-finish-load");
  await h.settle();
  assert.ok(h.log.includes(`clear-storage ${oldPartition}`) && h.log.includes(`clear-cache ${oldPartition}`), h.log.join("\n"));
  assert.ok(!h.log.includes(`rm ${P}/${dirOf(A)}`), "the directory stays under its live session until the next start's sweep");
  assert.ok(!h.log.some((l) => l.includes(`clear-storage ${policy.partitionFor({ origin: B })}`)), "the new server keeps its session");
});

test("a mistyped server address costs the old server nothing: its drafts and sign-in survive the failed load", async () => {
  const h = await boot({ config: { origin: A, accessOrigin: "" }, files: { [P]: [dirOf(A)] } });
  await h.settle();
  h.openSettings();
  await h.handlers.get("fabric:setup-save")!(h.setupSender(), { origin: B, accessOrigin: "" });
  await h.settle();
  h.mailWindows().pop().webContents.emit("did-fail-load", {}, -105, "name not resolved", B, true);
  await h.settle();
  h.openSettings();
  await h.handlers.get("fabric:setup-save")!(h.setupSender(), { origin: A, accessOrigin: "" });
  await h.settle();
  h.mailWindows().pop().webContents.emit("did-finish-load");
  await h.settle();
  assert.ok(!h.log.includes(`clear-storage ${policy.partitionFor({ origin: A })}`), h.log.join("\n"));
  assert.ok(!h.log.some((l) => l.startsWith(`rm ${P}`)), h.log.join("\n"));
});

test("a development run uses its own profile; the installed app and an explicit --user-data-dir are left alone", async () => {
  const dev = await boot({ packaged: false });
  assert.equal(dev.log[0], "set-path userData /fixture/Fabric Inbox Development");
  assert.equal(dev.log[1], "lock /fixture/Fabric Inbox Development", "the single-instance lock is the development profile's");
  const installed = await boot({ packaged: true });
  assert.ok(!installed.log.some((l) => l.startsWith("set-path")));
  const harness = await boot({ packaged: false, switches: ["user-data-dir"] });
  assert.ok(!harness.log.some((l) => l.startsWith("set-path")));
});

test("usage counts: a build without an App Key shows the switch unavailable and starts nothing (docs/ANALYTICS.md)", async () => {
  const h = await boot({ config: { origin: A, accessOrigin: "" }, files: { [P]: [dirOf(A)] } });
  await h.settle();
  const items = h.menu()[0].submenu;
  const share = items.find((i: any) => i.label === "Share Anonymous Usage Counts");
  assert.equal(share.type, "checkbox");
  assert.equal(share.enabled, false);
  assert.equal(share.checked, false);
  assert.ok(items.some((i: any) => i.label === "About Usage Counts…"));
  assert.ok(!h.log.some((l) => l.includes("installation.json")), "the shared installation file is not touched");
  // Updates: this build carries no feed, so it never checks; the menu says so instead of hiding it.
  assert.ok(items.some((i: any) => i.label === "Check for Updates…"));
  const automatic = items.find((i: any) => i.label === "Install Updates Automatically");
  assert.equal(automatic.type, "checkbox");
  assert.equal(automatic.enabled, false);
});

test("a profile removed by an uninstaller gets its server back from the shared PassionCode copy", async () => {
  const backupJson = JSON.stringify({ version: 1, server: { origin: A, accessOrigin: "" } });
  const h = await boot({ backupJson, files: { [P]: [dirOf(A)] } });
  await h.settle();
  assert.ok(h.log.includes(`window ${policy.partitionFor({ origin: A })}`), "the mail window opens for the saved server");
  assert.ok(h.log.some((l) => l === "rename /fixture/Fabric Inbox/server.json"), "server.json is written back");
  assert.ok(!h.log.includes(`rm ${P}/${dirOf(A)}`), "its sign-in and drafts are kept");
});

test("with no server known at all, no partition is swept: it may be the one about to be entered again", async () => {
  const h = await boot({ files: { [P]: [dirOf(A), dirOf(B)], "/fixture/Fabric Inbox": ["server.json.tmp", "Partitions"] } });
  await h.settle();
  assert.ok(!h.log.some((l) => l.startsWith(`rm ${P}`)), h.log.join("\n"));
  assert.ok(h.log.includes("rm /fixture/Fabric Inbox/server.json.tmp"), "leftovers still go");
});

test("saving a server keeps its copy in the shared PassionCode folder", async () => {
  const h = await boot({ config: { origin: A, accessOrigin: "" }, files: { [P]: [dirOf(A)] } });
  await h.settle();
  assert.ok(h.log.includes("rename /fixture/PassionCode/backups/fabric-inbox.json"), "an existing server gets its copy at start");
  h.openSettings();
  await h.handlers.get("fabric:setup-save")!(h.setupSender(), { origin: B, accessOrigin: "" });
  await h.settle();
  assert.equal(h.log.filter((l) => l === "rename /fixture/PassionCode/backups/fabric-inbox.json").length, 2);
});
