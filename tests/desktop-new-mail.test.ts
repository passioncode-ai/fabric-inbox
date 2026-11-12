import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error a CommonJS module of the desktop app
import * as newMail from "../desktop/new-mail.cjs";
// @ts-expect-error a CommonJS module of the desktop app
import { menuTemplate } from "../desktop/menu.cjs";
import { messageLink } from "../shared/mail/open-link";

// B-41 (operator, 2026-10-22): new-mail notifications, off by default.
const msg = (id: string, at: number, over: Record<string, unknown> = {}) => ({
  id: JSON.stringify(["cloudflare:me@x.invalid", id]), accountId: "cloudflare:me@x.invalid", providerMessageId: id,
  sender: `Ann ${id} <ann@y.invalid>`, subject: `Subject ${id}`, timestamp: at, date: new Date(at).toISOString(), read: false, ...over,
});

function harness(initial: unknown[] = [], { on = false, focused = false } = {}) {
  const userData = mkdtempSync(path.join(os.tmpdir(), "fabric-new-mail-"));
  if (on) writeFileSync(path.join(userData, "new-mail-notifications"), "on\n");
  let page: { messages: unknown[] } | null = { messages: initial };
  const shown: { title: string; body: string; click: () => void }[] = [];
  const opened: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const lines: any[] = [];
  const n = newMail.createNewMailNotifier({
    fs: fsPromises, userData, read: async () => page, t: (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_: string, k: string) => String(p?.[k])),
    notify: (title: string, body: string, click: () => void) => shown.push({ title, body, click }), open: (link: string) => opened.push(link),
    focused: () => focused, setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t: any) => { if (t) t.live = false; }, log: (l: unknown) => lines.push(l),
  });
  return { n, userData, shown, opened, timers, lines, setPage: (p: typeof page) => { page = p; } };
}

test("off by default: no switch file, no timer, nothing read or shown", async () => {
  const h = harness([msg("a", 1)]);
  await h.n.start();
  assert.equal(h.n.enabled(), false);
  assert.equal(h.timers.filter((t) => t.live).length, 0);
  assert.deepEqual(await h.n.check(), []);
  assert.equal(h.shown.length, 0);
});

test("turned on: what is already there is not announced; each new message is, and its click opens it", async () => {
  const h = harness([msg("a", 1000)]);
  await h.n.start();
  assert.equal(await h.n.setEnabled(true), true);
  assert.equal(readFileSync(path.join(h.userData, "new-mail-notifications"), "utf8"), "on\n");
  assert.equal(h.shown.length, 0, "the mail already waiting is the baseline");
  assert.deepEqual(h.timers.filter((t) => t.live).map((t) => t.ms), [newMail.CHECK_EVERY_MS]);
  h.setPage({ messages: [msg("b", 2000), msg("a", 1000)] });
  await h.n.check();
  assert.deepEqual(h.shown.map((s) => [s.title, s.body]), [["Ann b", "Subject b"]]);
  h.shown[0]!.click();
  assert.deepEqual(h.opened, [messageLink("cloudflare:me@x.invalid", "b")]);
  assert.equal(newMail.messageLink("cloudflare:me@x.invalid", "b"), messageLink("cloudflare:me@x.invalid", "b"), "the same link as the server's");
  await h.n.check();
  assert.equal(h.shown.length, 1, "never twice");
});

test("many at once make one summary; a read message, a focused window or an unreadable server announce nothing", async () => {
  const h = harness([], { on: true });
  await h.n.start();
  await h.n.check();
  h.setPage({ messages: [1, 2, 3, 4].map((i) => msg("m" + i, 5000 + i)) });
  await h.n.check();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0]!.title, "New messages: 4");
  h.shown[0]!.click();
  assert.deepEqual(h.opened, ["/"]);
  h.setPage({ messages: [msg("r", 9000, { read: true })] });
  await h.n.check();
  assert.equal(h.shown.length, 1);
  h.setPage(null);
  assert.deepEqual(await h.n.check(), []);
  assert.ok(h.lines.some((l) => l.outcome === "unreadable"));
  const f = harness([], { on: true, focused: true });
  await f.n.start();
  await f.n.check();
  f.setPage({ messages: [msg("z", 1)] });
  assert.equal((await f.n.check()).length, 1, "seen as new");
  assert.equal(f.shown.length, 0, "but the inbox in front shows it already");
});

test("turning it off stops the timer and keeps the choice", async () => {
  const h = harness([], { on: true });
  await h.n.start();
  assert.equal(h.n.enabled(), true);
  await h.n.setEnabled(false);
  assert.equal(readFileSync(path.join(h.userData, "new-mail-notifications"), "utf8"), "off\n");
  assert.equal(h.timers.filter((t) => t.live).length, 0);
});

test("the menu offers the switch on every platform, and the app starts the notifier", () => {
  const t = (s: string) => s;
  const ctx = { t, update: { label: "u", enabled: true, click() {} }, automatic: { checked: false, enabled: true, click() {} },
    usage: { checked: false, enabled: true, click() {}, about() {} }, login: { checked: true, enabled: true, click() {} },
    newMail: { checked: false, enabled: true, click() {} }, openSettings() {}, showServer() {}, showCloudflare() {}, connectGmail() {}, retry() {}, console: null };
  for (const platform of ["darwin", "win32", "linux"]) {
    const labels = JSON.stringify(menuTemplate(platform, ctx));
    assert.match(labels, /Notify About New Mail/, platform);
  }
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /startTray\(\);\n  startNewMail\(\);/);
  assert.doesNotMatch(main, /mailNotifier\.reset\(\);/, "B-233: each server is kept apart, so switching servers forgets nothing");
  assert.match(main, /servers: \(\) => servers\.map/, "B-233: every server the app holds is read");
});

test("N-5: account mail that syncs after a newer message is still announced", async () => {
  const h = harness([msg("cf1", 1000)], { on: true });
  await h.n.start();
  await h.n.check();                                        // learns cf1
  h.setPage({ messages: [msg("cf2", 3000), msg("cf1", 1000)] });
  await h.n.check();
  assert.deepEqual(h.shown.map((s) => s.body), ["Subject cf2"]);
  const gmail = msg("g1", 2000, { accountId: "gmail:a1", id: JSON.stringify(["gmail:a1", "g1"]) });
  h.setPage({ messages: [msg("cf2", 3000), gmail, msg("cf1", 1000)] });
  await h.n.check();
  assert.deepEqual(h.shown.map((s) => s.body), ["Subject cf2", "Subject g1"], "older-stamped, but new to the feed");
});

test("N-6: the same email in two accounts, or a merged row whose id changes, is announced once", async () => {
  const h = harness([], { on: true });
  await h.n.start();
  await h.n.check();
  h.setPage({ messages: [msg("cf", 1000, { rfcMessageId: "<one@x.invalid>" })] });
  await h.n.check();
  const copy = msg("g", 1500, { accountId: "gmail:a1", id: JSON.stringify(["gmail:a1", "g"]), rfcMessageId: "<one@x.invalid>",
    alsoIn: ["cloudflare:me@x.invalid"] });
  h.setPage({ messages: [copy] });
  await h.n.check();
  assert.equal(h.shown.length, 1);
});

test("N-7: a read that was out when the switch went off announces nothing", async () => {
  let release: (v: unknown) => void = () => {};
  const userData = mkdtempSync(path.join(os.tmpdir(), "fabric-new-mail-"));
  writeFileSync(path.join(userData, "new-mail-notifications"), "on\n");
  let calls = 0;
  const shown: unknown[] = [];
  const n = newMail.createNewMailNotifier({ fs: fsPromises, userData, t: (s: string) => s, notify: (...a: unknown[]) => shown.push(a), open: () => {},
    read: async () => (++calls === 1 ? { messages: [] } : new Promise((r) => { release = r; })), setTimer: () => ({}), clearTimer: () => {} });
  await n.start();
  await n.check();                                          // baseline
  const pending = n.check();
  await n.setEnabled(false);
  release({ messages: [msg("late", 5000)] });
  assert.deepEqual(await pending, []);
  assert.equal(shown.length, 0);
});

// B-233 part 2: every server the app holds, each read through its own session; a message opens on its own server.
function servers2(pages: Record<string, unknown[] | null>, { focused = null as string | null, held = ["https://a.example", "https://b.example"] } = {}) {
  const userData = mkdtempSync(path.join(os.tmpdir(), "fabric-new-mail-"));
  writeFileSync(path.join(userData, "new-mail-notifications"), "on\n");
  const shown: { title: string; body: string; click: () => void }[] = [];
  const opened: [string, string][] = [];
  let all = 0;
  const reads: string[] = [];
  let list = held;
  const n = newMail.createNewMailNotifier({
    fs: fsPromises, userData, t: (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_: string, k: string) => String(p?.[k])),
    servers: () => list.map((origin) => ({ origin, label: origin === "https://a.example" ? "Personal" : "Acme" })),
    read: async (origin: string) => { reads.push(origin); const m = pages[origin]; return m === null ? null : { messages: m }; },
    open: (origin: string, link: string) => opened.push([origin, link]), openAll: () => { all++; },
    notify: (title: string, body: string, click: () => void) => shown.push({ title, body, click }),
    focused: () => focused, setTimer: () => ({ live: true }), clearTimer: () => {},
  });
  return { n, shown, opened, reads, all: () => all, setList: (l: string[]) => { list = l; } };
}

test("every server is read on its own; new mail names its server and opens there (B-233)", async () => {
  const pages: Record<string, unknown[] | null> = { "https://a.example": [msg("a1", 1)], "https://b.example": [msg("b1", 1)] };
  const h = servers2(pages);
  await h.n.start();
  await h.n.check();
  assert.equal(h.shown.length, 0, "the first read learns what is there");
  pages["https://b.example"] = [msg("b2", 5), msg("b1", 1)];
  await h.n.check();
  assert.deepEqual(h.shown.map((s) => [s.title, s.body]), [["Ann b2", "Subject b2\nAcme"]]);
  h.shown[0].click();
  assert.deepEqual(h.opened, [["https://b.example", messageLink("cloudflare:me@x.invalid", "b2")]]);
  assert.deepEqual([...new Set(h.reads)].sort(), ["https://a.example", "https://b.example"]);
});

test("looking at one server's inbox hides only that server's new mail; a server that cannot be read hides nothing (B-233)", async () => {
  const pages: Record<string, unknown[] | null> = { "https://a.example": [], "https://b.example": [] };
  const h = servers2(pages, { focused: "https://a.example" });
  await h.n.start();
  await h.n.check();
  pages["https://a.example"] = [msg("a2", 5)];
  pages["https://b.example"] = [msg("b2", 6)];
  await h.n.check();
  assert.deepEqual(h.shown.map((s) => s.title), ["Ann b2"]);
  pages["https://a.example"] = null;
  pages["https://b.example"] = [msg("b3", 7), msg("b2", 6)];
  await h.n.check();
  assert.deepEqual(h.shown.map((s) => s.title), ["Ann b2", "Ann b3"]);
});

test("many new messages on several servers make one summary that opens the inbox with All chosen; one server's open its inbox (B-233, B-244)", async () => {
  const pages: Record<string, unknown[] | null> = { "https://a.example": [], "https://b.example": [] };
  const h = servers2(pages);
  await h.n.start();
  await h.n.check();
  pages["https://a.example"] = [msg("a1", 1), msg("a2", 2)];
  pages["https://b.example"] = [msg("b1", 3), msg("b2", 4)];
  await h.n.check();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].title, "New messages: 4");
  h.shown[0].click();
  assert.equal(h.all(), 1);
  pages["https://b.example"] = [msg("b3", 5), msg("b4", 6), msg("b5", 7), msg("b6", 8), msg("b1", 3), msg("b2", 4)];
  await h.n.check();
  h.shown[1].click();
  assert.deepEqual(h.opened, [["https://b.example", "/"]]);
});

test("a server added later is learned first, never announced for what it already holds (B-233)", async () => {
  const pages: Record<string, unknown[] | null> = { "https://a.example": [], "https://b.example": [msg("old", 1)] };
  const h = servers2(pages, { held: ["https://a.example"] });
  await h.n.start();
  await h.n.check();
  h.setList(["https://a.example", "https://b.example"]);
  await h.n.check();
  assert.equal(h.shown.length, 0);
  pages["https://b.example"] = [msg("new", 2), msg("old", 1)];
  await h.n.check();
  assert.deepEqual(h.shown.map((s) => s.title), ["Ann new"]);
});
