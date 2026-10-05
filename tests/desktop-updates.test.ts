// Automatic updates and what survives removing the app (docs/desktop-data-and-updates.md).
// A fake autoUpdater stands in for Squirrel.Mac; nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

function fakeUpdater() {
  const calls: string[] = [];
  const u = Object.assign(new EventEmitter(), {
    feed: null as any,
    setFeedURL(options: any) { calls.push("feed"); u.feed = options; },
    checkForUpdates() { calls.push("check"); },
    quitAndInstall() { calls.push("install"); },
  });
  return { u, calls };
}
function updater(extra: Record<string, unknown> = {}) {
  const userData = mkdtempSync(path.join(os.tmpdir(), "fabric-updates-"));
  let clock = Date.parse("2026-10-05T12:00:00Z");
  const { u, calls } = fakeUpdater();
  const lines: any[] = [];
  const make = () => updates.createUpdater({ autoUpdater: u, fs: fsPromises, userData, feed: FEED, now: () => clock, log: (l: unknown) => lines.push(l), ...extra });
  return { make, u, calls, lines, userData, advance: (ms: number) => { clock += ms; } };
}
const RELEASED = { packaged: true, mas: false, inApplications: true };

test("only the release feed is read: GitHub's latest-release update-mac.json, nothing else", () => {
  assert.equal(updates.readFeed(JSON.stringify({ feed: FEED })), FEED);
  for (const feed of ["http://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-mac.json",
    "https://example.com/update-mac.json", "https://github.com/a/b/releases/download/v1.0.0/update-mac.json", ""]) {
    assert.equal(updates.readFeed(JSON.stringify({ feed })), null, feed);
  }
  assert.equal(updates.readFeed("not json"), null);
  assert.equal(updates.feedURL("passioncode-ai/fabric-inbox"), FEED);
});

test("the release's feed names only that release, with the sha256 and size Squirrel.Mac checks", () => {
  const sha = "a".repeat(64);
  const feed = updates.feedFor({ repository: "passioncode-ai/fabric-inbox", version: "0.10.1", zipName: "Fabric-Inbox-0.10.1-mac.zip", sha256: sha, size: 123, pubDate: "2026-10-05T12:00:00Z" });
  assert.equal(feed.currentRelease, "0.10.1");
  assert.deepEqual(feed.releases.map((r: any) => r.version), ["0.10.1"]);
  assert.equal(feed.releases[0].updateTo.url, "https://github.com/passioncode-ai/fabric-inbox/releases/download/v0.10.1/Fabric-Inbox-0.10.1-mac.zip");
  assert.equal(feed.releases[0].updateTo.sha256, sha);
  assert.equal(feed.releases[0].updateTo.size, 123);
  assert.throws(() => updates.feedFor({ repository: "x", version: "0.10.1", zipName: "z", sha256: sha, size: 1 }), /owner\/name/);
  assert.throws(() => updates.feedFor({ repository: "a/b", version: "0.10.1-rc.1", zipName: "z", sha256: sha, size: 1 }), /release version/);
  assert.throws(() => updates.feedFor({ repository: "a/b", version: "0.10.1", zipName: "z", sha256: "x", size: 1 }), /sha256/);
});

test("a released app in Applications checks at launch by default, with Squirrel.Mac's json feed", async () => {
  const h = updater();
  const up = h.make();
  await up.start(RELEASED);
  assert.deepEqual(h.u.feed, { url: FEED, serverType: "json" });
  assert.deepEqual(h.calls, ["feed", "check"]);
  assert.equal(up.status().automatic, true);
  assert.equal(up.status().state, "idle");
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
    assert.deepEqual(h.calls, [], reason);
    assert.equal(up.status().state, state);
    assert.equal(up.status().reason, reason);
    assert.deepEqual(await up.checkNow(), { outcome: "unavailable", reason });
  }
  const none = updater({ feed: null });
  const up = none.make();
  await up.start(RELEASED);
  assert.deepEqual(none.calls, []);
  assert.equal(up.status().reason, "no_feed");
});

test("a window coming forward checks again only after six hours; no timer runs", async () => {
  const h = updater();
  const up = h.make();
  await up.start(RELEASED);
  h.u.emit("update-not-available");
  assert.equal(up.wake(), false);
  h.advance(5 * HOUR);
  assert.equal(up.wake(), false);
  h.advance(1 * HOUR);
  assert.equal(up.wake(), true);
  assert.deepEqual(h.calls, ["feed", "check", "check"]);
  const code = readFileSync("desktop/updater.cjs", "utf8");
  assert.ok(!/setInterval|setTimeout/.test(code), "the updater owns no timer (LC-08)");
});

test("a found update downloads by itself and is installed on quit, or at once on Restart", async () => {
  const h = updater();
  const changes: any[] = [];
  const up = h.make();
  await up.start(RELEASED);
  h.u.emit("update-available");
  assert.equal(up.status().state, "downloading");
  assert.equal(up.wake(), false, "no second check while downloading");
  h.u.emit("update-downloaded", {}, "notes", "0.10.2");
  assert.deepEqual([up.status().state, up.status().readyVersion], ["ready", "0.10.2"]);
  assert.deepEqual(await up.checkNow(), { outcome: "ready", version: "0.10.2" });
  assert.equal(up.restart(), true);
  assert.deepEqual(h.calls, ["feed", "check", "install"]);
  assert.ok(h.lines.some((l) => l.outcome === "ready" && l.version === "0.10.2"));
  void changes;
});

test("a failed check is logged and retried later; Check for Updates says what happened", async () => {
  const h = updater();
  const up = h.make();
  await up.start(RELEASED);
  h.u.emit("error", new Error("Could not get code signature for running application"));
  assert.equal(up.status().state, "error");
  assert.ok(h.lines.some((l) => l.outcome === "failed"));
  const answer = up.checkNow();
  h.u.emit("update-not-available");
  assert.deepEqual(await answer, { outcome: "current" });
  const failing = up.checkNow();
  h.u.emit("error", new Error("offline"));
  assert.deepEqual(await failing, { outcome: "failed", error: "offline" });
  h.advance(6 * HOUR);
  assert.equal(up.wake(), true, "an error does not stop later checks");
});

test("turning automatic updates off is remembered; a manual check still works", async () => {
  const h = updater();
  const up = h.make();
  await up.start(RELEASED);
  h.u.emit("update-not-available");
  await up.setAutomatic(false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(h.userData, "updates.json"), "utf8")), { automatic: false });
  h.advance(7 * HOUR);
  assert.equal(up.wake(), false);
  const next = updater();
  writeFileSync(path.join(next.userData, "updates.json"), JSON.stringify({ automatic: false }));
  const again = next.make();
  await again.start(RELEASED);
  assert.deepEqual(next.calls, ["feed"], "no check at launch when off");
  const manual = again.checkNow();
  next.u.emit("update-available");
  assert.deepEqual(await manual, { outcome: "downloading" });
  await again.setAutomatic(true);
  assert.equal(again.status().automatic, true);
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
