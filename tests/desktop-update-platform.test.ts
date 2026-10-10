// Updates on Windows and Linux (fabric-workspace knowledge/platforms.md PL-03, PL-04): the same
// verifier and updater core as macOS, the platform's feed and release file, and the installer step
// that stands where Squirrel.Mac stands — the NSIS installer at quit, the AppImage put in place.
// The fixtures are signed by a throwaway key made for them (platform-key.asc); nothing here touches
// the network or runs a real installer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, createWriteStream, writeFileSync, statSync, readdirSync, existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createVerifier, feedNameFor } = require("../desktop/update-verify.cjs");
const { createPlatformInstaller, updateTarget } = require("../desktop/platform-installer.cjs");
const updates = require("../desktop/updater.cjs");

const FIX = "tests/fixtures/release-signing";
const KEY = readFileSync(`${FIX}/platform-key.asc`, "utf8");
const FPR = "13C3F0CD6E5DAB873A1C11385C9DE748793FC425";
const BASE = "https://github.com/passioncode-ai/fabric-inbox/releases/download/v0.12.0/";
const FILES = { win32: "Fabric-Inbox-0.12.0-win-x64-setup.exe", linux: "Fabric-Inbox-0.12.0-linux-x64.AppImage" } as const;

function harness(platform: "win32" | "linux", { productVersion = "0.12.0.0", authenticode = "NotSigned|", requireAuthenticode = false, feedOf = platform } = {}) {
  const d = `${FIX}/test-release-0.12.0-${platform}`;
  const files = new Map<string, Buffer>([
    [`${BASE}SHA256SUMS`, readFileSync(`${d}/SHA256SUMS`)],
    [`${BASE}SHA256SUMS.asc`, readFileSync(`${d}/SHA256SUMS.asc`)],
    [`${BASE}${FILES[platform]}`, readFileSync(`${d}/${FILES[platform]}`)],
  ]);
  const feed = readFileSync(`${FIX}/test-release-0.12.0-${feedOf}/${feedNameFor(feedOf, "x64")}`);
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(`GET ${url.replace(BASE, "")}`);
    const body = files.get(url);
    return body ? new Response(body) : new Response("missing", { status: 404 });
  };
  const exec = async (file: string, args: string[]) => {
    const command = args.at(-1)!;
    calls.push(`${path.win32.basename(file)} ${/Get-AuthenticodeSignature/.test(command) ? "authenticode" : "version"}`);
    return { stdout: /Get-AuthenticodeSignature/.test(command) ? `${authenticode}\r\n` : `${productVersion}\r\n` };
  };
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-verify-")), "updates");
  const verifier = createVerifier({ repository: "passioncode-ai/fabric-inbox", appVersion: "0.11.0", appName: "Fabric Inbox",
    zipName: updateTarget({ platform, arch: "x64", execPath: "C:\\x\\Fabric Inbox.exe" }).fileName, runningApp: "", dir, fetch, exec,
    fs: fsPromises, createWriteStream, key: KEY, fingerprint: FPR, platform, arch: "x64", requireAuthenticode });
  return { verifier, feed, calls, files, dir };
}
const refusal = async (promise: Promise<unknown>, code: string, reason: string) => {
  await assert.rejects(promise, (error: any) => { assert.equal(error.code, code); assert.equal(error.reason, reason); return true; });
};

test("each platform reads its own feed: update-mac.json, update-<platform>-<arch>.json", () => {
  assert.equal(feedNameFor("darwin", "arm64"), "update-mac.json");
  assert.equal(feedNameFor("win32", "arm64"), "update-win32-arm64.json");
  assert.equal(feedNameFor("linux", "x64"), "update-linux-x64.json");
  const repo = "passioncode-ai/fabric-inbox";
  for (const [platform, arch] of [["darwin", "x64"], ["win32", "x64"], ["win32", "arm64"], ["linux", "x64"], ["linux", "arm64"]]) {
    const url = updates.feedURL(repo, platform, arch);
    assert.ok(url.endsWith(`/releases/latest/download/${feedNameFor(platform, arch)}`), url);
    assert.equal(updates.readFeed(JSON.stringify({ feed: url })), url, "a release build of every platform carries a feed the app accepts");
  }
  assert.equal(updates.readFeed(JSON.stringify({ feed: `https://github.com/${repo}/releases/latest/download/update-win32-ia32.json` })), null);
});

test("Windows: the signed installer is downloaded, its version read, and handed over as itself", async () => {
  const h = harness("win32");
  const out = await h.verifier.verify(h.feed);
  assert.equal(out.outcome, "verified");
  assert.deepEqual(h.calls, ["GET SHA256SUMS", "GET SHA256SUMS.asc", `GET ${FILES.win32}`, "powershell.exe version"],
    "an unsigned running copy (PL-02 interim) does not ask for Authenticode");
  assert.deepEqual(readFileSync(fileURLToPath(out.localFeed)), h.files.get(`${BASE}${FILES.win32}`), "the very bytes that were checked");
});

test("Windows: a signed running copy accepts only an installer signed by the organization", async () => {
  const ok = harness("win32", { requireAuthenticode: true, authenticode: "Valid|CN=PassionCode.ai, O=PassionCode.ai" });
  assert.equal((await ok.verifier.verify(ok.feed)).outcome, "verified");
  assert.deepEqual(ok.calls.slice(-2), ["powershell.exe version", "powershell.exe authenticode"]);
  for (const authenticode of ["NotSigned|", "Valid|CN=Someone Else", "HashMismatch|CN=PassionCode.ai"]) {
    const h = harness("win32", { requireAuthenticode: true, authenticode });
    await refusal(h.verifier.verify(h.feed), "signature_failed", "authenticode");
  }
});

test("Windows: the installer's version is the release's, in either form; another version is refused", async () => {
  // electron-builder writes ProductVersion as the plain version (0.12.0); the 0.14.0-rc.2 rehearsal
  // refused its own installer because a trailing ".0" was stripped from "0.14.0".
  for (const productVersion of ["0.12.0", "0.12.0.0"]) {
    const h = harness("win32", { productVersion });
    assert.equal((await h.verifier.verify(h.feed)).outcome, "verified", productVersion);
  }
  for (const productVersion of ["0.11.0.0", "0.12", "0.12.0.1", ""]) {
    const h = harness("win32", { productVersion });
    await refusal(h.verifier.verify(h.feed), "signature_failed", "version_mismatch");
  }
});

test("Linux: the signed AppImage is checked for its magic and handed over; no program is run", async () => {
  const h = harness("linux");
  const out = await h.verifier.verify(h.feed);
  assert.equal(out.outcome, "verified");
  assert.deepEqual(h.calls, ["GET SHA256SUMS", "GET SHA256SUMS.asc", `GET ${FILES.linux}`]);
  assert.deepEqual(readFileSync(fileURLToPath(out.localFeed)), h.files.get(`${BASE}${FILES.linux}`));
});

test("another platform's feed names a file this platform does not take, and nothing is downloaded", async () => {
  const h = harness("win32", { feedOf: "linux" });
  await refusal(h.verifier.verify(h.feed), "signature_failed", "feed_foreign_file");
  assert.ok(!h.calls.some((c) => c.startsWith(`GET Fabric-Inbox`)));
});

test("what updates where: the NSIS install, an AppImage; a .deb is left to the package manager", () => {
  const exe = "C:\\Users\\p\\AppData\\Local\\Programs\\Fabric Inbox\\Fabric Inbox.exe";
  const win = updateTarget({ platform: "win32", arch: "arm64", execPath: exe, exists: (p: string) => p === "C:\\Users\\p\\AppData\\Local\\Programs\\Fabric Inbox\\Uninstall Fabric Inbox.exe" });
  assert.deepEqual([win.fileName("1.2.3"), win.installed, win.packageManager, win.writable], ["Fabric-Inbox-1.2.3-win-arm64-setup.exe", true, false, ["C:\\Users\\p\\AppData\\Local\\Programs\\Fabric Inbox"]]);
  assert.equal(updateTarget({ platform: "win32", arch: "x64", execPath: "D:\\unpacked\\Fabric Inbox.exe" }).installed, false, "an unpacked copy has no uninstaller");
  const appImage = updateTarget({ platform: "linux", arch: "x64", execPath: "/tmp/.mount_x/fabric-inbox", env: { APPIMAGE: "/home/p/Apps/Fabric-Inbox.AppImage" } });
  assert.deepEqual([appImage.fileName("1.2.3"), appImage.installed, appImage.packageManager, appImage.writable],
    ["Fabric-Inbox-1.2.3-linux-x64.AppImage", true, false, ["/home/p/Apps/Fabric-Inbox.AppImage", "/home/p/Apps"]]);
  const deb = updateTarget({ platform: "linux", arch: "x64", execPath: "/opt/fabric-inbox/fabric-inbox", env: {} });
  assert.deepEqual([deb.installed, deb.packageManager, deb.writable], [false, true, []]);
  const mac = updateTarget({ platform: "darwin", arch: "arm64", execPath: "/Applications/Fabric Inbox.app/Contents/MacOS/Fabric Inbox", installedOnMac: true });
  assert.deepEqual([mac.fileName("1.2.3"), mac.runningApp], ["Fabric-Inbox-1.2.3-mac.zip", "/Applications/Fabric Inbox.app"]);
});

test("a .deb copy never checks, and says the package manager updates it", async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), "fabric-updates-"));
  const up = updates.createUpdater({ autoUpdater: new EventEmitter(), fs: fsPromises, userData, appVersion: "0.11.0",
    feed: "https://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-linux-x64.json",
    fetchFeed: async () => { throw new Error("must not read"); }, verifier: { verify: async () => ({}), clean: async () => {} } });
  await up.start({ packaged: true, mas: false, inApplications: false, packageManager: true });
  assert.deepEqual([up.status().state, up.status().reason], ["off", "package_manager"]);
  assert.deepEqual(await up.checkNow(), { outcome: "unavailable", reason: "package_manager" });
});

function fakes() {
  const spawned: { file: string; args: string[]; options: any; unref: boolean }[] = [];
  const spawn = (file: string, args: string[], options: any) => { const c = { file, args, options, unref: false }; spawned.push(c); return { unref() { c.unref = true; } }; };
  const app = { calls: [] as string[], relaunched: null as any, quit() { app.calls.push("quit"); }, exit(code: number) { app.calls.push(`exit ${code}`); }, relaunch(o: any) { app.relaunched = o; app.calls.push("relaunch"); } };
  return { spawn, spawned, app };
}
const nextEvent = (emitter: EventEmitter) => new Promise<string>((resolve) => { emitter.once("update-downloaded", () => resolve("update-downloaded")); emitter.once("error", (e: Error) => resolve(`error: ${e.message}`)); });

test("Windows: the verified installer is kept apart from the cache, runs silently at quit, or at once with --force-run", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-install-"));
  const verified = path.join(root, "updates", FILES.win32);
  await fsPromises.mkdir(path.dirname(verified), { recursive: true });
  writeFileSync(verified, "installer bytes");
  const f = fakes();
  const stagingDir = path.join(root, "pending-update");
  const installer = createPlatformInstaller({ platform: "win32", app: f.app, spawn: f.spawn, fs: fsPromises, stagingDir });
  assert.throws(() => installer.setFeedURL({ url: "https://github.com/x" }), /local file/);
  installer.setFeedURL({ url: pathToFileURL(verified).href });
  const event = nextEvent(installer);
  installer.checkForUpdates();
  assert.equal(await event, "update-downloaded");
  await fsPromises.rm(path.dirname(verified), { recursive: true });  // the updater cleans its cache once handed over
  const staged = path.join(stagingDir, FILES.win32);
  assert.equal(readFileSync(staged, "utf8"), "installer bytes");
  installer.installOnQuit();
  assert.deepEqual(f.spawned.map((s) => [s.file, s.args, s.options.detached, s.unref]), [[staged, ["/S", "--updated"], true, true]]);
  assert.deepEqual(f.app.calls, [], "at quit the app is already leaving");
  installer.quitAndInstall();
  assert.deepEqual(f.spawned[1].args, ["/S", "--updated", "--force-run"]);
  assert.deepEqual(f.app.calls, ["quit"]);
  await installer.clean();
  assert.ok(!existsSync(stagingDir), "the next launch removes the installer that ran");
});

test("Linux: the verified AppImage replaces $APPIMAGE atomically; Restart starts the file, not the mount", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-install-"));
  const verified = path.join(root, "cache", FILES.linux);
  await fsPromises.mkdir(path.dirname(verified), { recursive: true });
  writeFileSync(verified, "new appimage");
  const apps = path.join(root, "Apps");
  await fsPromises.mkdir(apps);
  const appImage = path.join(apps, "Fabric-Inbox.AppImage");
  writeFileSync(appImage, "old appimage", { mode: 0o755 });
  const f = fakes();
  const installer = createPlatformInstaller({ platform: "linux", app: f.app, spawn: f.spawn, fs: fsPromises, appImage });
  installer.setFeedURL({ url: pathToFileURL(verified).href });
  const event = nextEvent(installer);
  installer.checkForUpdates();
  assert.equal(await event, "update-downloaded");
  assert.equal(readFileSync(appImage, "utf8"), "new appimage");
  if (process.platform !== "win32") assert.equal(statSync(appImage).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(apps), ["Fabric-Inbox.AppImage"], "no .new file is left beside it");
  installer.installOnQuit();
  assert.deepEqual(f.spawned, [], "nothing to run at quit: the next launch is the new version");
  installer.quitAndInstall();
  assert.equal(f.app.relaunched.execPath, appImage);
  assert.deepEqual(f.app.calls, ["relaunch", "exit 0"]);
});

test("a failed staging is an error event, and nothing is installed", async () => {
  const f = fakes();
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-install-"));
  const installer = createPlatformInstaller({ platform: "linux", app: f.app, spawn: f.spawn, fs: fsPromises, appImage: path.join(root, "missing-dir", "x.AppImage") });
  writeFileSync(path.join(root, "u.AppImage"), "new");
  installer.setFeedURL({ url: pathToFileURL(path.join(root, "u.AppImage")).href });
  const event = nextEvent(installer);
  installer.checkForUpdates();
  assert.match(await event, /^error: /);
  assert.throws(() => installer.quitAndInstall(), /No update is staged/);
  assert.throws(() => createPlatformInstaller({ platform: "darwin", app: f.app, spawn: f.spawn, fs: fsPromises }), /No installer step/);
});

test("the updater asks the installer step to install as the app quits", async () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), "fabric-updates-"));
  const calls: string[] = [];
  const u = Object.assign(new EventEmitter(), {
    setFeedURL() { calls.push("feed"); }, checkForUpdates() { calls.push("check"); setImmediate(() => u.emit("update-downloaded", {}, "", "")); },
    quitAndInstall() { calls.push("now"); }, installOnQuit() { calls.push("on-quit"); },
  });
  const timers: (() => void)[] = [];
  const up = updates.createUpdater({ autoUpdater: u, fs: fsPromises, userData, appVersion: "0.11.0",
    feed: "https://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-win32-x64.json",
    fetchFeed: async () => Buffer.from("{}"), verifier: { verify: async (_b: Buffer, o: any) => { o.onDownload("0.12.0", false); return { outcome: "verified", version: "0.12.0", localFeed: "file:///C:/u.exe", migration: null }; }, clean: async () => {} },
    setTimer: (fn: () => void) => { timers.push(fn); return fn; }, clearTimer: () => {} });
  await up.start({ packaged: true, mas: false, inApplications: true });
  assert.deepEqual(await up.checkNow(), { outcome: "downloading", version: "0.12.0" });
  for (let i = 0; i < 20 && up.status().state !== "ready"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(up.status().state, "ready");
  await up.quitting();
  assert.deepEqual(calls, ["feed", "check", "on-quit"]);
  up.stop();
});

test("the release gate runs the same verification on a Windows or Linux release set", async () => {
  const { checkRelease } = await import("../scripts/check-update-release.mjs");
  const linux = `${FIX}/test-release-0.12.0-linux`;
  assert.deepEqual(await checkRelease({ dir: linux, version: "0.12.0", platform: "linux", key: KEY, fingerprint: FPR }), { version: "0.12.0", held: false });
  assert.deepEqual(await checkRelease({ dir: linux, version: "0.12.0", platform: "linux", key: KEY, fingerprint: FPR, beforeSigning: true }), { version: "0.12.0", held: false });
  await assert.rejects(checkRelease({ dir: linux, version: "0.13.0", platform: "linux", key: KEY, fingerprint: FPR }), /announces 0\.12\.0/);
  const versions: string[] = [];
  const exec = async (_file: string, args: string[]) => { versions.push(args.at(-1)!); return { stdout: "0.12.0.0\r\n" }; };
  assert.deepEqual(await checkRelease({ dir: `${FIX}/test-release-0.12.0-win32`, version: "0.12.0", platform: "win32", exec, key: KEY, fingerprint: FPR }), { version: "0.12.0", held: false });
  assert.match(versions[0], /VersionInfo\.ProductVersion/);
  await assert.rejects(checkRelease({ dir: linux, version: "0.12.0", platform: "win32", key: KEY, fingerprint: FPR }), /ENOENT/, "a Linux set has no Windows feed");
});

test("a release build writes its platform's feed, naming the installer or the AppImage", () => {
  const source = readFileSync("desktop/dist-platform.mjs", "utf8");
  assert.match(source, /platform === 'win32' \? \/-setup\\\.exe\$\/ : \/\\\.AppImage\$\//);
  assert.match(source, /feedFor\(\{ repository, version, zipName: updatable\.name, sha256: updatable\.sha256, size: updatable\.bytes/);
});
