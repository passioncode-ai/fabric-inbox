import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { menuTemplate } = require("../desktop/menu.cjs");

const ctx = {
  t: (s: string) => s,
  update: { label: "Check for Updates…", enabled: true, click: () => {} },
  automatic: { checked: true, enabled: true, click: () => {} },
  usage: { checked: false, enabled: true, click: () => {}, about: () => {} },
  openSettings: () => {}, showServer: () => {}, showCloudflare: () => {}, connectGmail: () => {}, retry: () => {},
};
const roles = (items: any[]): string[] => items.flatMap((i) => [i.role, ...(i.submenu ? roles(i.submenu) : [])]).filter(Boolean);
const labels = (items: any[]) => items.map((i) => i.label ?? i.role);
const MAC_ONLY = ["services", "hide", "hideOthers", "unhide", "front", "startSpeaking", "stopSpeaking", "windowMenu", "pasteAndMatchStyle"];

test("macOS keeps its app menu: About, updates, Settings, Services, Hide, Quit", () => {
  const menu = menuTemplate("darwin", ctx);
  assert.deepEqual(labels(menu), ["Fabric Inbox", "[menu] Edit", "Account", "[menu] View", "Window"]);
  for (const role of ["about", "services", "hide", "quit", "front"]) assert.ok(roles(menu).includes(role), role);
});

for (const platform of ["win32", "linux"]) test(`${platform}: File, Edit, Account, View, Window, Help — and no macOS-only roles`, () => {
  const menu = menuTemplate(platform, ctx);
  assert.deepEqual(labels(menu), ["[menu] File", "[menu] Edit", "Account", "[menu] View", "Window", "[menu] Help"]);
  for (const role of MAC_ONLY) assert.ok(!roles(menu).includes(role), `${role} is macOS-only`);
  const file = menu[0].submenu.map((i: any) => i.label ?? i.type);
  assert.deepEqual(file, ["Settings…", "Server address…", "Connect Cloudflare account…", "separator", "Quit Fabric Inbox"]);
  const help = menu[5].submenu.map((i: any) => i.label ?? i.type);
  assert.deepEqual(help, ["Check for Updates…", "Install Updates Automatically", "separator", "Share Anonymous Usage Counts", "About Usage Counts…", "separator", "About Fabric Inbox"]);
  assert.ok(menu[0].submenu.find((i: any) => i.role === "quit").accelerator === "Ctrl+Q");
});

test("PL-05: Linux without a Secret Service (basic_text) is refused; other platforms and real stores are not", () => {
  const { keyStoreRefusal } = require("../desktop/policy.cjs");
  assert.equal(keyStoreRefusal("linux", "basic_text"), "basic_text");
  assert.equal(keyStoreRefusal("linux", "unknown"), "unknown");
  assert.equal(keyStoreRefusal("linux", null), "unknown");
  for (const ok of ["gnome_libsecret", "kwallet5", "kwallet6"]) assert.equal(keyStoreRefusal("linux", ok), null, ok);
  assert.equal(keyStoreRefusal("win32", null), null);
  assert.equal(keyStoreRefusal("darwin", null), null);
});
