import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createAutostart } = require("../desktop/autostart.cjs");

function fakeApp(over: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  let settings: Record<string, unknown> = { openAtLogin: false, status: "not-registered" };
  return {
    calls,
    set status(value: string) { settings.status = value; },
    app: { isPackaged: true, isInApplicationsFolder: () => true,
      setLoginItemSettings: (s: Record<string, unknown>) => { calls.push(s); settings = { ...settings, openAtLogin: s.openAtLogin, status: s.openAtLogin ? "enabled" : "not-registered" }; },
      getLoginItemSettings: () => settings, ...over },
  };
}

test("the first launch of an installed copy turns Open at Login on once; later launches keep the person's choice", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "fi-auto-"));
  const lines: any[] = [];
  const f = fakeApp();
  const make = () => createAutostart({ app: f.app, fs, path, platform: "darwin", userData, log: (l: unknown) => lines.push(l) });
  const first = await make().start();
  assert.deepEqual([first.enabled, first.registered], [true, true]);
  assert.deepEqual(f.calls, [{ openAtLogin: true }]);
  await make().set(false);
  const again = await make().start();
  assert.equal(again.enabled, false, "turned off by the person: an update or a launch never turns it back on");
  assert.equal(again.registered, false);
  assert.deepEqual(f.calls, [{ openAtLogin: true }, { openAtLogin: false }]);
  assert.deepEqual(lines.map((l) => `${l.event}:${l.outcome}`), ["login_item:on", "login_item:off", "login_item:off"]);
});

test("a login item the system holds for approval is reported at every launch", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "fi-auto-"));
  const f = fakeApp();
  const auto = createAutostart({ app: f.app, fs, path, platform: "darwin", userData });
  await auto.start();
  f.status = "requires-approval";
  const now = await auto.start();
  assert.equal(now.needsApproval, true);
});

test("builds from source, the store package and a Mac copy outside Applications never register", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "fi-auto-"));
  for (const [over, extra, reason] of [[{ isPackaged: false }, {}, "development"], [{}, { mas: true }, "app_store"], [{ isInApplicationsFolder: () => false }, {}, "not_in_applications"]] as const) {
    const f = fakeApp(over);
    const out = await createAutostart({ app: f.app, fs, path, platform: "darwin", userData, ...extra }).start();
    assert.equal(out.reason, reason);
    assert.deepEqual(f.calls, [], reason);
  }
});

test("Linux: an autostart entry that starts the AppImage file, removed when the person turns it off", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fi-home-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "fi-auto-"));
  const f = fakeApp();
  const auto = createAutostart({ app: f.app, fs, path, platform: "linux", userData, homedir: home, env: { APPIMAGE: "/srv/My Apps/Fabric Inbox.AppImage" }, execPath: "/tmp/.mount_x/fabric-inbox" });
  const out = await auto.start();
  assert.equal(out.enabled, true);
  const entry = await readFile(path.join(home, ".config", "autostart", "fabric-inbox.desktop"), "utf8");
  assert.match(entry, /^Exec="\/srv\/My Apps\/Fabric Inbox\.AppImage"$/m, "the AppImage, quoted, not its mount point");
  assert.deepEqual(f.calls, [], "no Electron login item on Linux");
  await auto.set(false);
  await assert.rejects(access(path.join(home, ".config", "autostart", "fabric-inbox.desktop")));
});

test("the app keeps running when its last window closes, and the ready-update notice is shown once per version", async () => {
  const main = await readFile("desktop/main.cjs", "utf8");
  const closed = main.slice(main.indexOf("app.on('window-all-closed'"), main.indexOf("app.on('activate'"));
  assert.doesNotMatch(closed, /app\.quit\(\)/, "closing the window never quits");
  assert.match(main, /now\.readyVersion === notifiedReady\) return;\n  notifiedReady = now\.readyVersion;/);
  assert.match(main, /t\('Restart to finish updating'\)/);
  assert.match(main, /startTray\(\);\n  void startAutostart\(\)/, "tray and Open at Login at every launch");
});
