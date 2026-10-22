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
  assert.match(main, /if \(mailNotifier\) mailNotifier\.reset\(\);/, "a new server starts from its own baseline");
});
