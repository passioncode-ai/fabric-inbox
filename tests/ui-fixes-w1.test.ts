// The mail window's fixes of 2026-11-18, wave 1 (docs/ux/plans/2026-11-18-ui-fixes/README.md): U1 (B-290) the console
// closes from its own bar, U2 (B-291) All stays All and a switch stops no console, U3 (B-292) "All inboxes" is every
// server's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { consoleStopsOnSwitch, linkWithAll, readServerTab } from "../app/lib/other-servers";

const require = createRequire(import.meta.url);
const main = readFileSync("desktop/main.cjs", "utf8");

// ── U1 ─────────────────────────────────────────────────────────────────────────────────────────────
test("U1: the console's bar always carries a close button, and it hides the console through its own channel", () => {
  const html = readFileSync("desktop/console.html", "utf8");
  const bar = html.slice(html.indexOf('<header class="bar">'), html.indexOf("</header>"));
  assert.match(bar, /<button type="button" id="close" class="close" aria-label="Close the console"/);
  assert.doesNotMatch(bar.match(/<button[^>]*id="close"[^>]*>/)![0], /\bhidden\b/, "never hidden, in every phase");
  const preload = readFileSync("desktop/console-preload.cjs", "utf8");
  assert.match(preload, /hide: \(\) => ipcRenderer\.invoke\('fabric:console-hide'\)/);
  assert.match(main, /handle\('fabric:console-hide', \(event\) => \{ fromConsole\(event\); hideConsole\(\); return true; \}\)/, "answered only to the console's own page");
  assert.match(main, /function hideConsole\(\) \{\s*if \(consoleDocked\) toggleDock\(\);\s*if \(consoleWindow && !consoleWindow\.isDestroyed\(\)\) consoleWindow\.close\(\);/);
  assert.doesNotMatch(main.slice(main.indexOf("function hideConsole()"), main.indexOf("async function ensureConsole()")), /\.stop\(/, "closing never stops a session");
});

test("U1: Escape closes the console only when no session runs; the close button says when a session keeps running", () => {
  const view = readFileSync("desktop/console-view.js", "utf8");
  assert.match(view, /if \(event\.key !== 'Escape' \|\| running \|\| event\.defaultPrevented \|\| event\.isComposing\) return;/);
  assert.match(view, /const closeLabel = running \? t\('Hide the console; the session keeps running'\) : t\('Close the console'\);/);
  assert.match(view, /\$\('#close'\)\.addEventListener\('click', \(\) => void window\.fabricConsole\.hide\(\)\);/);
});

test("U1: the docked panel is laid out again after full screen, maximize, restore and a finished resize", () => {
  assert.match(main, /const dockRelayoutEvents = \['resized', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'\];/);
  assert.match(main, /for \(const name of dockRelayoutEvents\) win\.on\(name, \(\) => \{ layoutPages\(\); setTimeout\(layoutPages, 50\); \}\);/);
});

// ── U2 ─────────────────────────────────────────────────────────────────────────────────────────────
test("U2: a message opened from All carries servers=all, its own parameters kept", () => {
  assert.equal(linkWithAll("/?open=acc%7Cmsg"), "/?open=acc%7Cmsg&servers=all");
  assert.equal(linkWithAll("/"), "/?servers=all");
  assert.equal(linkWithAll("/?servers=own&open=a"), "/?servers=all&open=a", "replaces an earlier choice, never doubles it");
  assert.equal(linkWithAll("/?open=a%20b"), "/?open=a%20b&servers=all", "a space stays %20, as the app's message links write it");
  const list = readFileSync("app/components/inbox/TriagedList.tsx", "utf8");
  assert.match(list, /onClick=\{\(\) => showServer\(row\.origin, linkWithAll\(row\.link\)\)\}/);
});

test("U2: the bridge's choice is read strictly; a build that keeps the console says so, an older one does not", () => {
  assert.equal(readServerTab("all"), "all");
  assert.equal(readServerTab("own"), "own");
  for (const v of [null, undefined, "ALL", 1, {}]) assert.equal(readServerTab(v), null);
  const g = globalThis as unknown as { window?: unknown };
  const before = g.window;
  try {
    g.window = { fabricDesktop: {} };
    assert.equal(consoleStopsOnSwitch(), true, "older desktop build: the switch still stops the console");
    g.window = { fabricDesktop: { consoleKeepsOnSwitch: () => true } };
    assert.equal(consoleStopsOnSwitch(), false);
  } finally { g.window = before; }
});

test("U2: a switch of server never stops the console; Forget Server, a retired partition of its own server and quitting still do", () => {
  const switching = main.slice(main.indexOf("async function switchServer(origin)"), main.indexOf("async function forgetServer(origin)"));
  assert.doesNotMatch(switching, /agentConsole\.stop/);
  const forgetting = main.slice(main.indexOf("async function forgetServer(origin)"), main.indexOf("async function saveConfig(next)"));
  assert.match(forgetting, /if \(consoleFor === origin && agentConsole && agentConsole\.running\(\)\) await agentConsole\.stop/);
  assert.match(main, /consoleFor && policy\.partitionFor\(\{ origin: consoleFor \}\) === retiring\) await agentConsole\.stop/, "only the retired server's console");
  assert.match(main, /The agent console is still running\./, "quitting with a running console still asks first");
});

test("U2: the switch's choice is the window's: kept by the app, told to the other pages, only to held pages", () => {
  const preload = readFileSync("desktop/mail-preload.cjs", "utf8");
  assert.match(preload, /setServerTab: \(tab\) => ipcRenderer\.invoke\('fabric:server-tab-set', tab === 'all' \? 'all' : 'own'\)/);
  assert.match(preload, /consoleKeepsOnSwitch: \(\) => true/);
  assert.match(main, /ipcMain\.handle\('fabric:server-tab', \(event\) => \{ from\(event\); return serverTab; \}\);/);
  assert.match(main, /ipcMain\.handle\('fabric:server-tab-set', \(event, tab\) => setServerTab\(tab, from\(event\)\)\);/);
  assert.match(main, /mailViews\.originOf\(view\.webContents\) !== chooser\) view\.webContents\.send\('fabric:server-tab', next\)/);
  const tabs = readFileSync("app/components/inbox/ServerTabs.tsx", "utf8");
  assert.match(tabs, /else \{ onChoose\(false\); showServer\(choice\); \}/, "another server's segment shows its own list");
});

test("U2: the console's bar names its server, and a panel a switch hid comes back with its server", () => {
  const view = readFileSync("desktop/console-view.js", "utf8");
  assert.match(view, /t\('\{agent\} is connected to \{server\}\.'/);
  assert.match(main, /consoleSend\('fabric:console-phase', \{ \.\.\.state, server: consoleServerLabel\(\)/);
  assert.match(main, /if \(consoleDocked && consoleFor && consoleFor !== origin\) \{ toggleDock\(\); consoleHiddenBySwitch = true; \}/);
  assert.match(main, /else if \(!consoleDocked && consoleHiddenBySwitch && consoleFor === origin\)/);
});

// ── U3 ─────────────────────────────────────────────────────────────────────────────────────────────
const menuCtx = (servers: unknown) => ({ t: (s: string) => s, update: {}, automatic: {}, usage: {}, openSettings() {}, showServer() {}, showCloudflare() {}, connectGmail() {}, retry() {}, console: null, servers });
const accountMenu = (menu: { label: string; submenu: { label?: string; accelerator?: string; type?: string }[] }[]) => menu.find((m) => m.label === "Account")!.submenu;

test("U3: with two or more servers, Account opens every server's inboxes first (⇧⌘0, never ⌘0, which is Actual Size)", () => {
  const { menuTemplate } = require("../desktop/menu.cjs");
  const servers = (all: unknown) => ({ items: [{ label: "A", checked: true, click() {} }, { label: "B", checked: false, click() {} }], add() {}, move: null, forget: [], rename: [], all });
  const first = accountMenu(menuTemplate("darwin", menuCtx(servers(() => {}))))[0];
  assert.equal(first.label, "All Servers' Inboxes");
  assert.equal(first.accelerator, "CmdOrCtrl+Shift+0");
  assert.ok(!accountMenu(menuTemplate("darwin", menuCtx(servers(null)))).some((i) => i.label === "All Servers' Inboxes"), "absent with one server");
  assert.match(main, /all: servers\.length > 1 && config \? \(\) => void showAllMail\(\) : null,/);
  assert.match(main, /click: \(\) => \{ setServerTab\('own'\); void switchServer\(s\.origin\); \}/, "a server chosen here shows its own list");
});

test("U3: the sidebar's All inboxes chooses All when the app holds several servers, and counts every server", () => {
  const inbox = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(inbox, /onClick=\{\(\) => \{ scope\(\{ account: "", domain: "", category: "", provider: "" \}\); if \(everyServer\) chooseServerTab\(true\); \}\}/);
  assert.match(inbox, /const allInboxesActive = unscoped && \(!everyServer \|\| mergeAll\);/);
  assert.match(inbox, /switchCounts\(heldServers, otherInbox\.data\?\.servers \?\? \[\], totalUnread\(shownAccounts\) \?\? 0\)\.all/);
  assert.match(inbox, /folder !== "inbox" && everyServer && mergeAll && shownServerLabel \? ` · \$\{shownServerLabel\}` : ""/, "another folder names its server");
});
