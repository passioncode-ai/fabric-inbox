import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = () => import("../desktop/dist-platform.mjs");

test("arguments: a platform and an architecture, nothing else", async () => {
  const { parsePlatformArgs } = await load();
  assert.deepEqual({ ...parsePlatformArgs(["--platform", "win32", "--arch", "arm64"]), out: "" }, { platform: "win32", arch: "arm64", out: "" });
  assert.equal(parsePlatformArgs(["--platform=linux", "--arch=x64"]).platform, "linux");
  assert.throws(() => parsePlatformArgs(["--platform", "darwin"]), /--platform must be/);
  assert.throws(() => parsePlatformArgs(["--platform", "linux", "--arch", "ia32"]), /--arch must be/);
  assert.throws(() => parsePlatformArgs(["--platform", "linux", "--sign"]), /Unknown option/);
});

test("Windows: a per-user NSIS installer that registers fabric-inbox:// in HKCU (PL-01, PL-04)", async () => {
  const { builderConfig } = await load();
  const c = builderConfig({ platform: "win32", version: "0.14.0", arch: "arm64", signing: null }) as any;
  assert.deepEqual([c.nsis.oneClick, c.nsis.perMachine, c.nsis.allowElevation], [true, false, false]);
  assert.match(c.nsis.include, /desktop[\\/]windows[\\/]installer\.nsh$/);
  assert.equal(c.win.azureSignOptions, undefined, "no signing configured: built NOT_SIGNED");
  assert.equal(c.artifactName, "Fabric-Inbox-0.14.0-win-arm64-setup.${ext}", "our arch names, as the feed and the workflow expect");
  const nsh = readFileSync("desktop/windows/installer.nsh", "utf8");
  assert.match(nsh, /WriteRegStr HKCU "Software\\Classes\\fabric-inbox" "URL Protocol" ""/);
  assert.match(nsh, /DeleteRegKey HKCU "Software\\Classes\\fabric-inbox"/);
});

test("Linux: AppImage and a .deb named fabric-inbox, with the scheme handler and the Secret Service library (PL-01, PL-04, PL-05)", async () => {
  const { builderConfig, PLATFORMS } = await load();
  assert.deepEqual(PLATFORMS.linux.targets, ["AppImage", "deb"]);
  const c = builderConfig({ platform: "linux", version: "0.14.0", arch: "x64", signing: null }) as any;
  // electron-builder's ${arch} would say amd64 (.deb) and x86_64 (AppImage) on x64.
  assert.deepEqual([c.artifactName, c.appImage.artifactName], ["Fabric-Inbox-0.14.0-linux-x64.${ext}", "Fabric-Inbox-0.14.0-linux-x64.AppImage"]);
  assert.throws(() => builderConfig({ platform: "linux", version: "0.14.0", arch: "ia32", signing: null }), /--arch/);
  assert.equal(c.deb.packageName, "fabric-inbox");
  assert.ok(c.deb.depends.includes("libsecret-1-0"));
  assert.deepEqual(c.protocols[0].schemes, ["fabric-inbox"]);
  assert.equal(c.linux.executableName, "fabric-inbox");
  assert.equal(c.productName, "fabric-inbox", "/opt/fabric-inbox: Chromium's zygote cannot start from a path with a space");
  assert.equal(c.linux.desktop.entry.Name, "Fabric Inbox");
  assert.match(readFileSync("desktop/linux/after-install.sh", "utf8"), /ln -sf "\$APP_DIR\/fabric-inbox" \/usr\/bin\/fabric-inbox/);
  assert.match(readFileSync("desktop/linux/after-install.sh", "utf8"), /chmod 755 "\$APP_DIR"/, "a 0700 /opt folder would refuse everyone but root");
  assert.match(readFileSync("desktop/dist-platform.mjs", "utf8"), /if \(platform === 'linux'\) chmodSync\(appDir, 0o755\);/);
  assert.match(readFileSync("desktop/linux/after-remove.sh", "utf8"), /rm -f \/usr\/bin\/fabric-inbox/);
  assert.equal(JSON.parse(readFileSync("desktop/package.json", "utf8")).desktopName, "fabric-inbox.desktop");
});

test("Windows signing only with all three Azure Artifact Signing values; a feed only in the release workflow (PL-02, PL-03)", async () => {
  const { windowsSigning, platformFeed } = await load();
  assert.equal(windowsSigning({}), null);
  assert.equal(windowsSigning({ AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net", AZURE_SIGNING_ACCOUNT: "passioncodesigning" }), null);
  assert.deepEqual(windowsSigning({ AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net", AZURE_SIGNING_ACCOUNT: "passioncodesigning", AZURE_SIGNING_PROFILE: "public" }),
    { endpoint: "https://weu.codesigning.azure.net", codeSigningAccountName: "passioncodesigning", certificateProfileName: "public", publisherName: "PassionCode" });
  assert.equal(platformFeed({}, "linux", "x64"), null);
  assert.equal(platformFeed({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "o/r" }, "linux", "x64"), null, "a nightly mirror is not a release build");
  assert.deepEqual(platformFeed({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "passioncode-ai/fabric-inbox", FABRIC_INBOX_RELEASE_BUILD: "1" }, "win32", "arm64"),
    { feed: "https://github.com/passioncode-ai/fabric-inbox/releases/latest/download/update-win32-arm64.json" });
});

test("builder files and installer scripts never ship inside the app", async () => {
  const { PACKAGE_IGNORE } = await load();
  const ignored = (p: string) => PACKAGE_IGNORE.some((r: RegExp) => r.test(p));
  for (const p of ["/dist-platform.mjs", "/dist-mac.mjs", "/hardening.mjs", "/icon.icns", "/icon.ico", "/linux/after-install.sh", "/windows/installer.nsh"]) assert.ok(ignored(p), p);
  for (const p of ["/main.cjs", "/icon.png", "/connect.cjs", "/menu.cjs", "/server-bundle/manifest.json"]) assert.ok(!ignored(p), p);
});
