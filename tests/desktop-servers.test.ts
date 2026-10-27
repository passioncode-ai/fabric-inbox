// B-158 M1 (D1 of docs/app-store/tasks/2026-10-27-organizations.md): the Mac app holds several servers, a person's own
// and each organization's, each with its own sign-in and context; one click shows another (SCN-092, SCN-093).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const servers = require("../desktop/servers.cjs");
const policy = require("../desktop/policy.cjs");
const profile = require("../desktop/profile.cjs");
const { menuTemplate } = require("../desktop/menu.cjs");

const MINE = { origin: "https://fabric-inbox.someone.workers.dev", accessOrigin: "https://someone.cloudflareaccess.com" };
const ACME = { origin: "https://acme-inbox.someone.workers.dev", accessOrigin: "https://someone.cloudflareaccess.com" };
const t = (s: string, v: Record<string, string> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

test("the remembered list keeps valid servers once each, with a context only when it is one", () => {
  const list = servers.readList({ servers: [
    { ...MINE, context: "personal" }, { ...MINE, context: "org:x" }, { origin: "http://plain.example" }, "nonsense",
    { ...ACME, context: "Org:acme" }, null] }, policy.validateConfig);
  assert.deepEqual(list, [{ ...MINE, context: "personal" }, { ...ACME, context: null }]);
  assert.deepEqual(servers.readList(null, policy.validateConfig), []);
  const many = { servers: Array.from({ length: 30 }, (_, i) => ({ origin: `https://s${i}.example.com` })) };
  assert.equal(servers.readList(many, policy.validateConfig).length, servers.MAX);
});

test("remembering adds a new server at the end, keeps a known one's place and context, and forgetting takes it out", () => {
  let list = servers.remember([], MINE, "personal");
  list = servers.remember(list, ACME);
  assert.deepEqual(list.map((s: any) => [s.origin, s.context]), [[MINE.origin, "personal"], [ACME.origin, null]]);
  list = servers.remember(list, MINE);
  assert.equal(list[0].context, "personal", "a later save without a context keeps the one learned");
  list = servers.remember(list, ACME, "org:org_ABC23");
  assert.equal(list[1].context, "org:org_ABC23");
  assert.deepEqual(servers.forget(list, MINE.origin).map((s: any) => s.origin), [ACME.origin]);
  assert.equal(servers.labelFor(list[0], t), "fabric-inbox.someone.workers.dev");
  assert.equal(servers.labelFor(list[1], t), "acme-inbox.someone.workers.dev (organization)");
});

test("the Account menu lists the servers, the one shown ticked, with Add Another Server and Forget Server", () => {
  const clicked: string[] = [];
  const ctx = { t, update: { label: "u", enabled: true, click() {} }, automatic: { checked: true, enabled: true, click() {} },
    usage: { checked: false, enabled: true, click() {}, about() {} }, openSettings() {}, showServer() {}, showCloudflare() {}, connectGmail() {}, retry() {},
    servers: { items: [{ label: "mine", checked: true, click: () => clicked.push("mine") }, { label: "acme (organization)", checked: false, click: () => clicked.push("acme") }],
      add: () => clicked.push("add"), forget: [{ label: "acme (organization)", click: () => clicked.push("forget acme") }] } };
  for (const platform of ["darwin", "linux"]) {
    const account = menuTemplate(platform, ctx).find((m: any) => m.label === "Account").submenu;
    assert.deepEqual(account.map((i: any) => i.label ?? i.type), ["mine", "acme (organization)", "Add Another Server…", "Forget Server", "separator", "Connect Gmail in browser…"]);
    assert.deepEqual(account.slice(0, 2).map((i: any) => [i.type, i.checked]), [["radio", true], ["radio", false]]);
    account[1].click(); account[2].click(); account[3].submenu[0].click();
  }
  assert.deepEqual(clicked.slice(0, 3), ["acme", "add", "forget acme"]);
  // With one server there is nothing to forget, and with no list (an old caller) the menu is as before.
  const one = menuTemplate("darwin", { ...ctx, servers: { ...ctx.servers, forget: [] } }).find((m: any) => m.label === "Account").submenu;
  assert.ok(!one.some((i: any) => i.label === "Forget Server"));
  const none = menuTemplate("darwin", { ...ctx, servers: null }).find((m: any) => m.label === "Account").submenu;
  assert.deepEqual(none.map((i: any) => i.label), ["Connect Gmail in browser…"]);
  // SCN-094: with two servers held, an address can move from the one shown to another; with one, no such item.
  const withMove = menuTemplate("darwin", { ...ctx, servers: { ...ctx.servers, move: () => clicked.push("move") } }).find((m: any) => m.label === "Account").submenu;
  const move = withMove.find((i: any) => i.label === "Move an Address to Another Server…");
  assert.ok(move && withMove.indexOf(move) === 3, "after Add Another Server, before Forget Server");
  move.click();
  assert.equal(clicked.at(-1), "move");
  assert.ok(!one.some((i: any) => i.label === "Move an Address to Another Server…"));
});

test("the start-up sweep keeps every remembered server's sign-in and removes the rest", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-servers-"));
  const dirOf = (origin: string) => profile.partitionDirName(policy.partitionFor({ origin }));
  const gone = "https://typo.example.com";
  for (const o of [MINE.origin, ACME.origin, gone]) { mkdirSync(path.join(dir, "Partitions", dirOf(o)), { recursive: true }); writeFileSync(path.join(dir, "Partitions", dirOf(o), "Cookies"), "x"); }
  writeFileSync(path.join(dir, "servers.json.tmp"), "{}");
  const removed = await profile.sweepProfile({ fs: fsPromises, userData: dir, keepPartition: policy.partitionFor(MINE), keepAlso: [policy.partitionFor(ACME)], log() {} });
  assert.deepEqual(removed, { partitions: [dirOf(gone)], files: ["servers.json.tmp"] });
  assert.deepEqual(readdirSync(path.join(dir, "Partitions")).sort(), [dirOf(MINE.origin), dirOf(ACME.origin)].sort());
});

test("main keeps a remembered server's storage on a switch, learns its context after sign-in, and sweeps around the list", () => {
  const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  assert.match(main, /!partitionsOf\(servers\)\.includes\(previousPartition\)\) retireAfterLoad = previousPartition/);
  assert.match(main, /if \(current\.origin === snapshot\.origin\) void learnContext\(snapshot\);/);
  assert.match(main, /keepAlso: partitionsOf\(servers\)/);
  assert.ok(main.indexOf("await readServers();") < main.indexOf("keepAlso: partitionsOf(servers)"), "the list is read before the sweep");
  assert.match(main, /await saveServers\(serverList\.remember\(servers, next\)\);/, "every server saved is remembered");
  const forget = main.slice(main.indexOf("async function forgetServer"), main.indexOf("async function saveConfig"));
  assert.match(forget, /config\.origin === origin\)\) return;/, "the server shown is never forgotten");
  assert.match(forget, /retirePartition\(partition\)/);
});
