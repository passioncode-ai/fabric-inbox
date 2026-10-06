// Automatic updates and what survives removing the app (docs/desktop-data-and-updates.md, LC-16).
// A fake autoUpdater stands in for Squirrel.Mac, a fake verifier for desktop/update-verify.cjs
// (tested on its own in desktop-update-verify.test.ts) and fake timers for the cadence; nothing
// here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const updates = require("../desktop/updater.cjs");
const backup = require("../desktop/backup.cjs");
const policy = require("../desktop/policy.cjs");

const FEED = "https://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-mac.json";
const HOUR = 3600 * 1000;
const LOCAL = "file:///Users/x/Library/Caches/Fabric%20Inbox/updates/0.12.0/feed.json";

function fakeUpdater() {
  const calls: string[] = [];
  const u = Object.assign(new EventEmitter(), {
    feed: null as any,
    setFeedURL(options: any) { calls.push("squirrel-feed"); u.feed = options; },
    checkForUpdates() { calls.push("squirrel-check"); },
    quitAndInstall() { calls.push("install"); },
  });
  return { u, calls };
}
type Verdict = { outcome: string; version?: string; localFeed?: string; migration?: any } | { error: { code: string; reason: string; message?: string } };
function updater(extra: Record<string, unknown> = {}) {
  const userData = mkdtempSync(path.join(os.tmpdir(), "fabric-updates-"));
  let clock = Date.parse("2026-10-07T12:00:00Z");
  const { u, calls } = fakeUpdater();
  const lines: any[] = [];
  const timers: { fn: () => void; ms: number; at: number; live: boolean }[] = [];
  const feedState = { fail: false };
  // What the verifier answers next: a newer verified release by default.
  const verdicts: Verdict[] = [];
  const fetchFeed = async (url: string) => {
    assert.equal(url, FEED);
    calls.push("feed-read");
    if (feedState.fail) throw new Error("offline");
    return Buffer.from("{}");
  };
  const verifier = {
    async verify(_bytes: Buffer, { onDownload }: { onDownload: (v: string) => void }) {
      calls.push("verify");
      const v = verdicts.shift() ?? { outcome: "verified", version: "0.12.0", localFeed: LOCAL, migration: null };
      if ("error" in v) throw Object.assign(new Error(v.error.message || v.error.reason), v.error);
      if (v.outcome === "verified") onDownload(v.version!, !!v.migration);
      return v;
    },
    async clean() { calls.push("clean"); },
  };
  const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, at: clock + ms, live: true }; timers.push(t); return t; };
  const clearTimer = (t: any) => { if (t) t.live = false; };
  const make = () => updates.createUpdater({ autoUpdater: u, fs: fsPromises, userData, feed: FEED, appVersion: "0.11.0", fetchFeed, verifier,
    now: () => clock, setTimer, clearTimer, log: (l: unknown) => lines.push(l), ...extra });
  /** Moves the clock and fires every live timer that comes due, in order. */
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at; due.live = false; due.fn();
      await settle();
    }
    clock = until;
  };
  const pending = () => timers.filter((t) => t.live).map((t) => t.ms);
  return { make, u, calls, lines, userData, feedState, verdicts, advance, pending };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Waits (real time, briefly) for a file write the code awaits before it acts. */
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(ok()); };
const RELEASED = { packaged: true, mas: false, inApplications: true };
const events = (lines: any[]) => lines.map((l) => `${l.event}:${l.outcome}`);

test("only the release feed is read: GitHub's latest-release update-mac.json, nothing else", () => {
  assert.equal(updates.readFeed(JSON.stringify({ feed: FEED })), FEED);
  for (const feed of ["http://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-mac.json",
    "https://example.com/update-mac.json", "https://github.com/a/b/releases/download/v1.0.0/update-mac.json", ""]) {
    assert.equal(updates.readFeed(JSON.stringify({ feed })), null, feed);
  }
  assert.equal(updates.readFeed("not json"), null);
  assert.equal(updates.feedURL("passioncode-ai/fabric-inbox"), FEED);
});

test("the release's feed names only that release, with its sha256 and size, and can hold it for a migration", () => {
  const sha = "a".repeat(64);
  const feed = updates.feedFor({ repository: "passioncode-ai/fabric-inbox", version: "0.10.1", zipName: "Fabric-Inbox-0.10.1-mac.zip", sha256: sha, size: 123, pubDate: "2026-10-05T12:00:00Z" });
  assert.equal(feed.currentRelease, "0.10.1");
  assert.deepEqual(feed.releases.map((r: any) => r.version), ["0.10.1"]);
  assert.equal(feed.releases[0].updateTo.url, "https://github.com/passioncode-ai/fabric-inbox/releases/download/v0.10.1/Fabric-Inbox-0.10.1-mac.zip");
  assert.equal(feed.releases[0].updateTo.sha256, sha);
  assert.equal(feed.releases[0].updateTo.size, 123);
  assert.equal(feed.releases[0].updateTo.migration, undefined);
  const held = updates.feedFor({ repository: "a/b", version: "0.10.1", zipName: "z", sha256: sha, size: 1, migration: "https://example.com/runbook" });
  assert.deepEqual(held.releases[0].updateTo.migration, { runbook: "https://example.com/runbook" });
  assert.throws(() => updates.feedFor({ repository: "a/b", version: "0.10.1", zipName: "z", sha256: sha, size: 1, migration: "see docs" }), /runbook/);
  assert.throws(() => updates.feedFor({ repository: "x", version: "0.10.1", zipName: "z", sha256: sha, size: 1 }), /owner\/name/);
  assert.throws(() => updates.feedFor({ repository: "a/b", version: "0.10.1-rc.1", zipName: "z", sha256: sha, size: 1 }), /release version/);
  assert.throws(() => updates.feedFor({ repository: "a/b", version: "0.10.1", zipName: "z", sha256: "x", size: 1 }), /sha256/);
});

test("a released app in Applications checks 90 s after start, then every six hours while it runs", async () => {
  const h = updater();
  h.verdicts.push({ outcome: "current", version: "0.11.0" }, { outcome: "current", version: "0.11.0" });
  const up = h.make();
  await up.start(RELEASED);
  assert.deepEqual(h.calls, [], "nothing at launch itself");
  assert.deepEqual(h.pending(), [90 * 1000]);
  assert.equal(up.status().automatic, true);
  await h.advance(90 * 1000);
  assert.deepEqual(h.calls, ["feed-read", "verify"]);
  assert.equal(up.status().state, "idle");
  assert.deepEqual(h.pending(), [6 * HOUR], "one timer, the next check in six hours — window or not");
  await h.advance(6 * HOUR);
  assert.deepEqual(h.calls, ["feed-read", "verify", "feed-read", "verify"]);
  assert.deepEqual(events(h.lines), ["update_check:current", "update_check:current"]);
  assert.ok(!/browser-window-focus[^\n]*updater/.test(readFileSync("desktop/main.cjs", "utf8")), "a window coming forward is not a trigger");
});

test("copies that cannot or must not update themselves never check, and say why", async () => {
  for (const [options, reason, state] of [
    [{ ...RELEASED, packaged: false }, "development", "off"],
    [{ ...RELEASED, mas: true }, "app_store", "off"],
    [{ ...RELEASED, inApplications: false }, "not_in_applications", "unavailable"],
  ] as const) {
    const h = updater();
    const up = h.make();
    await up.start(options);
    await h.advance(7 * HOUR);
    assert.deepEqual(h.calls, [], reason);
    assert.deepEqual(h.pending(), [], `${reason}: no timer`);
    assert.equal(up.status().state, state);
    assert.equal(up.status().reason, reason);
    assert.deepEqual(await up.checkNow(), { outcome: "unavailable", reason });
  }
  for (const extra of [{ feed: null }, { appVersion: "0.11.0-dev" }, { fetchFeed: undefined }, { verifier: undefined }]) {
    const h = updater(extra);
    const up = h.make();
    await up.start(RELEASED);
    await h.advance(7 * HOUR);
    assert.deepEqual(h.calls, [], JSON.stringify(extra));
    assert.ok(["no_feed", "no_version_check"].includes(up.status().reason));
  }
});

test("a verified update is handed to Squirrel.Mac as a local feed, installed on quit or at once on Restart", async () => {
  const h = updater();
  const up = h.make();
  await up.start(RELEASED);
  await h.advance(90 * 1000);
  assert.deepEqual(h.calls, ["feed-read", "verify", "squirrel-feed", "squirrel-check"]);
  assert.deepEqual(h.u.feed, { url: LOCAL, serverType: "json" }, "Squirrel.Mac never reads the network feed itself");
  assert.equal(up.status().state, "downloading");
  assert.deepEqual(await up.checkNow(), { outcome: "downloading" });
  h.u.emit("update-downloaded", {}, "notes", "0.12.0");
  await settle();
  assert.deepEqual([up.status().state, up.status().readyVersion], ["ready", "0.12.0"]);
  assert.ok(h.calls.includes("clean"), "the verified zip is removed once Squirrel.Mac has its copy");
  assert.deepEqual(h.pending(), [], "nothing more is checked while an update waits");
  assert.deepEqual(await up.checkNow(), { outcome: "ready", version: "0.12.0" });
  assert.equal(up.restart(), true);
  await until(() => h.calls.includes("install"));
  assert.deepEqual(events(h.lines), ["update_check:ready", "update_restart:requested", "update_install:started"]);
  assert.equal(up.status().installing, true);
  await up.quitting();
  assert.equal(events(h.lines).filter((e) => e === "update_install:started").length, 1, "the restart's own quit is not noted twice");
  assert.deepEqual(JSON.parse(readFileSync(path.join(h.userData, "update-install.json"), "utf8")).version, "0.12.0");
  await h.advance(60 * 1000);
  assert.deepEqual(events(h.lines).at(-1), "update_install:timeout", "a restart that never happens is logged");
});

test("the next launch says whether the install happened", async () => {
  for (const [running, outcome] of [["0.12.0", "installed"], ["0.11.0", "failed"]]) {
    const h = updater({ appVersion: running });
    writeFileSync(path.join(h.userData, "update-install.json"), JSON.stringify({ version: "0.12.0", from: "0.11.0" }));
    await h.make().start(RELEASED);
    assert.deepEqual(events(h.lines), [`update_install:${outcome}`]);
    assert.ok(!existsSync(path.join(h.userData, "update-install.json")), "read once");
  }
  const quit = updater();
  const up = quit.make();
  await up.start(RELEASED);
  await quit.advance(90 * 1000);
  quit.u.emit("update-downloaded", {}, "", "0.12.0");
  await up.quitting();
  assert.deepEqual(events(quit.lines), ["update_check:ready", "update_install:started"]);
  assert.equal(JSON.parse(readFileSync(path.join(quit.userData, "update-install.json"), "utf8")).version, "0.12.0");
  const idle = updater();
  const off = idle.make();
  await off.start(RELEASED);
  await off.quitting();
  assert.deepEqual(idle.lines, [], "quitting with nothing ready records nothing");
  assert.equal(off.restart(), false);
  assert.deepEqual(events(idle.lines), ["update_restart:refused"]);
});

test("a failed check is retried once within the hour, then every six hours", async () => {
  const h = updater();
  h.feedState.fail = true;
  const up = h.make();
  await up.start(RELEASED);
  await h.advance(90 * 1000);
  assert.equal(up.status().state, "error");
  assert.deepEqual(h.pending(), [30 * 60 * 1000]);
  await h.advance(30 * 60 * 1000);
  assert.deepEqual(h.pending(), [6 * HOUR], "after the one retry, back to six hours");
  assert.deepEqual(events(h.lines), ["update_check:check_failed", "update_check:check_failed"]);
  assert.equal(h.lines[0].reason, "feed_unreachable");
  h.feedState.fail = false;
  h.verdicts.push({ outcome: "current", version: "0.11.0" });
  await h.advance(6 * HOUR);
  assert.equal(up.status().state, "idle");
  assert.deepEqual(h.pending(), [6 * HOUR]);
});

test("each refusal is logged under its own LC-16 code, and nothing reaches Squirrel.Mac", async () => {
  for (const code of ["signature_failed", "download_failed", "check_failed"]) {
    const h = updater();
    h.verdicts.push({ error: { code, reason: "zip_sha256", message: "The update's bytes are not the ones its release signed." } });
    const up = h.make();
    await up.start(RELEASED);
    const answer = up.checkNow();
    assert.deepEqual(await answer, { outcome: "failed", code, reason: "zip_sha256", error: "The update's bytes are not the ones its release signed." });
    assert.ok(!h.calls.some((c) => c.startsWith("squirrel")), code);
    assert.ok(h.calls.includes("clean"), "what a failed verification left is removed");
    assert.deepEqual(events(h.lines), [`update_check:${code}`]);
  }
  const s = updater();
  const up = s.make();
  await up.start(RELEASED);
  await s.advance(90 * 1000);
  s.u.emit("error", new Error("Code signature at URL did not pass validation"));
  assert.deepEqual(events(s.lines), ["update_check:install_failed"]);
  assert.equal(up.status().state, "error");
});

test("a release held for a migration is verified but not installed, and says where its runbook is", async () => {
  const h = updater();
  h.verdicts.push({ outcome: "verified", version: "0.12.0", localFeed: LOCAL, migration: { runbook: "https://example.com/runbook" } });
  const up = h.make();
  await up.start(RELEASED);
  assert.deepEqual(await up.checkNow(), { outcome: "held", version: "0.12.0", runbook: "https://example.com/runbook" });
  assert.ok(!h.calls.some((c) => c.startsWith("squirrel")));
  assert.deepEqual([up.status().state, up.status().heldVersion], ["held", "0.12.0"]);
  assert.deepEqual(events(h.lines), ["update_check:needs_migration"]);
  assert.deepEqual(h.pending(), [6 * HOUR], "a later release may not need the step");
});

test("the switch is the file auto-update: absent is on, only off is off, and off stops checks, downloads and installs", async () => {
  const h = updater();
  const up = h.make();
  await up.start(RELEASED);
  await up.setAutomatic(false);
  assert.equal(readFileSync(path.join(h.userData, "auto-update"), "utf8"), "off\n");
  assert.deepEqual(h.pending(), [], "off: no timer");
  await h.advance(7 * HOUR);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(events(h.lines), ["auto_update:off"]);
  // Reinstalled or updated: the file is the person's, and the app reads it again.
  const next = updater();
  writeFileSync(path.join(next.userData, "auto-update"), "off");
  const again = next.make();
  await again.start(RELEASED);
  assert.equal(again.status().automatic, false);
  assert.deepEqual(next.pending(), []);
  // A manual check still works when off.
  next.verdicts.push({ outcome: "current", version: "0.11.0" });
  assert.deepEqual(await again.checkNow(), { outcome: "current" });
  await again.setAutomatic(true);
  assert.ok(!existsSync(path.join(next.userData, "auto-update")), "on is the file's absence");
  assert.equal(next.calls.filter((c) => c === "verify").length, 2, "on: a check runs at once");
  assert.ok(next.lines.some((l) => l.event === "auto_update" && l.outcome === "on"));
  for (const text of ["", "on", "OFF please", "yes"]) {
    const any = updater();
    writeFileSync(path.join(any.userData, "auto-update"), text);
    const u = any.make();
    await u.start(RELEASED);
    assert.equal(u.status().automatic, true, JSON.stringify(text));
  }
});

test("the old updates.json choice is carried over once into auto-update", async () => {
  const h = updater();
  writeFileSync(path.join(h.userData, "updates.json"), JSON.stringify({ automatic: false }));
  const up = h.make();
  await up.start(RELEASED);
  assert.equal(up.status().automatic, false);
  assert.equal(readFileSync(path.join(h.userData, "auto-update"), "utf8"), "off\n");
  assert.ok(!existsSync(path.join(h.userData, "updates.json")));
  const on = updater();
  writeFileSync(path.join(on.userData, "updates.json"), JSON.stringify({ automatic: true }));
  await on.make().start(RELEASED);
  assert.ok(!existsSync(path.join(on.userData, "auto-update")), "on writes nothing");
  assert.ok(!existsSync(path.join(on.userData, "updates.json")));
});

test("the release build tells Squirrel.Mac to refuse a downgrade, and the app pins the organization's key and team", () => {
  assert.match(readFileSync("desktop/dist-mac.mjs", "utf8"), /ElectronSquirrelPreventDowngrades:\s*true/);
  assert.match(readFileSync("desktop/update-verify.cjs", "utf8"), /const TEAM = 'KJ35UYYL22';/);
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /release-key\.asc/);
  assert.ok(!/process\.env[^\n]*(FEED|UPDATE)/i.test(main), "no environment variable can point a release at another feed");
});

test("only the release workflow's app stage writes the feed, for its own repository, and the release publishes the update", async () => {
  const { updateBundle } = await import("../desktop/dist-mac.mjs");
  assert.equal(updateBundle({}, "app"), null, "a local build never checks");
  assert.equal(updateBundle({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "passioncode-ai/fabric-inbox" }, ""), null, "only the CI app stage");
  assert.deepEqual(updateBundle({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "passioncode-ai/fabric-inbox" }, "app"), { feed: FEED });
  assert.throws(() => updateBundle({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "" }, "app"), /owner\/repository/);
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /release\/Fabric-Inbox-\$\{\{ needs\.gate\.outputs\.version \}\}-mac\.zip/);
  assert.match(workflow, /release\/update-mac\.json/);
  assert.match(readFileSync(".gitignore", "utf8"), /^desktop\/updates\.json$/m);
  const builder = readFileSync("desktop/dist-mac.mjs", "utf8");
  assert.match(builder, /unpacked from the update zip fails codesign/);
  assert.match(builder, /unpacked from the update zip is not stapled/);
  assert.ok(!/updates\.json|autoUpdater/.test(readFileSync("desktop/mas-package.mjs", "utf8")), "the store updates the store build");
});

test("the server's address is kept in the shared PassionCode folder and read back when the profile is gone", async () => {
  const appData = mkdtempSync(path.join(os.tmpdir(), "fabric-backup-"));
  const config = { origin: "https://inbox.example.com", accessOrigin: "https://team.cloudflareaccess.com" };
  assert.equal(await backup.readBackup({ fs: fsPromises, appData, validate: policy.validateConfig }), null);
  assert.equal(await backup.saveBackup({ fs: fsPromises, appData, config }), true);
  const file = JSON.parse(readFileSync(backup.backupFile(appData), "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(file.server, config);
  assert.deepEqual(await backup.readBackup({ fs: fsPromises, appData, validate: policy.validateConfig }), config);
  // A tampered copy is refused like a tampered server.json.
  writeFileSync(backup.backupFile(appData), JSON.stringify({ version: 1, server: { origin: "http://evil.example.com" } }));
  assert.equal(await backup.readBackup({ fs: fsPromises, appData, validate: policy.validateConfig }), null);
  writeFileSync(backup.backupFile(appData), "{not json");
  assert.equal(await backup.readBackup({ fs: fsPromises, appData, validate: policy.validateConfig }), null);
  // A copy that cannot be written is logged, never fatal.
  const lines: any[] = [];
  const blocked = mkdtempSync(path.join(os.tmpdir(), "fabric-backup-"));
  mkdirSync(path.join(blocked, "PassionCode"));
  writeFileSync(path.join(blocked, "PassionCode", "backups"), "a file where the folder should be");
  assert.equal(await backup.saveBackup({ fs: fsPromises, appData: blocked, config, log: (l: unknown) => lines.push(l) }), false);
  assert.equal(lines[0].outcome, "not_written");
});
