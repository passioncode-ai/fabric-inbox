// B-210 (DEC-0153 OD-9, DEC-0069): the desktop app's own descriptor, declaring its digests folder for a collector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const { ensureDescriptor, descriptorAction, servicesDir, appPathOf, OPS_DIGEST_EXTENSION, FILE } = require("../desktop/fabric-descriptor.cjs");
const dir = new URL("./fixtures/fabric-contract/", import.meta.url);
const ajv = new (Ajv2020 as unknown as typeof import("ajv").default)({ allErrors: true, strict: false });
(addFormats as unknown as (a: unknown) => void)(ajv);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) ajv.addSchema(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
const validDescriptor = ajv.getSchema("https://fabric.passioncode.ai/agent-contract/0.1.0/schemas/service-descriptor.schema.json")!;

const APP = "/Applications/Fabric Inbox.app";
function setup(over: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-descriptor-"));
  const services = path.join(root, "services");
  mkdirSync(services);
  const userData = path.join(root, "user");
  const deps = { fs: fsPromises, platform: "darwin", env: { FABRIC_SERVICES_DIR: services }, home: root, execPath: `${APP}/Contents/MacOS/Fabric Inbox`,
    userData, logs: path.join(root, "logs"), version: "0.98.0", now: Date.parse("2026-11-05T18:00:00.000Z"), packaged: true, ownProfile: true, mas: false, ...over };
  return { root, services, userData, deps, file: path.join(services, FILE) };
}

test("B-210: an installed app writes its own descriptor once, naming only its digests folder (source mac-app)", async () => {
  const s = setup();
  assert.deepEqual(await ensureDescriptor(s.deps), { outcome: "ok" });
  const d = JSON.parse(readFileSync(s.file, "utf8"));
  assert.ok(validDescriptor(d), JSON.stringify(validDescriptor.errors));
  assert.equal(FILE, "fabric-inbox.desktop.json");
  assert.deepEqual([d.id, d.instance, d.placement, d.lifecycle, d.installedBy], ["fabric-inbox", "desktop", "local", { manager: "person", app: APP },
    { by: "person", role: "operator", tool: "Fabric Inbox 0.98.0" }]);
  assert.equal(d.origin, undefined, "an app's descriptor claims no port");
  assert.deepEqual(d.paths, { data: s.userData, logs: [path.join(s.root, "logs")] });
  assert.deepEqual(d.extensions[OPS_DIGEST_EXTENSION], [{ dir: "digests", source: "mac-app" }], "its own folder only, relative to paths.data");
  // POSIX modes only: Windows answers 0666 for any file (the folder's ACL guards it).
  if (process.platform !== "win32") {
    assert.equal(statSync(s.file).mode & 0o777, 0o600);
    assert.equal(statSync(d.auth.tokenFile).mode & 0o777, 0o600, "the token file the protocol requires, 0600");
  }
  assert.ok(existsSync(d.auth.tokenFile), "the token file the protocol requires");
  const token = readFileSync(d.auth.tokenFile, "utf8");
  // A second start of the same version and path rewrites nothing; an update writes again, the token kept.
  assert.deepEqual(await ensureDescriptor({ ...s.deps, now: s.deps.now + 1000 }), { outcome: "current" });
  assert.deepEqual(await ensureDescriptor({ ...s.deps, version: "0.99.0" }), { outcome: "ok" });
  assert.equal(JSON.parse(readFileSync(s.file, "utf8")).installedBy.tool, "Fabric Inbox 0.99.0");
  assert.equal(readFileSync(d.auth.tokenFile, "utf8"), token);
  assert.deepEqual(readdirSync(s.services), [FILE], "no temporary file left");
});

test("B-210: a development run, a throwaway profile, the App Store build or a computer without Fabric writes nothing", async () => {
  for (const [over, reason] of [[{ packaged: false }, "not_packaged"], [{ ownProfile: false }, "other_profile"], [{ mas: true }, "app_store"]] as const) {
    const s = setup(over);
    assert.deepEqual(await ensureDescriptor(s.deps), { outcome: "skipped", reason });
    assert.equal(existsSync(s.file), false);
  }
  const s = setup({ env: { FABRIC_SERVICES_DIR: "/nonexistent/fabric/services" } });
  assert.deepEqual(await ensureDescriptor(s.deps), { outcome: "skipped", reason: "no_services_dir" }, "Fabric's directory is never created by the app");
});

test("B-210: the contract's start rule: write when none, another version, a moved app or not an app's descriptor; never record a translocated path", () => {
  const mine = { installedBy: { by: "person", role: "operator", tool: "Fabric Inbox 0.98.0" }, lifecycle: { manager: "person", app: APP } };
  assert.equal(descriptorAction(null, "Fabric Inbox 0.98.0", APP), "write");
  assert.equal(descriptorAction(mine, "Fabric Inbox 0.98.0", APP), "keep");
  assert.equal(descriptorAction(mine, "Fabric Inbox 0.97.0", APP), "write");
  assert.equal(descriptorAction(mine, "Fabric Inbox 0.98.0", "/Volumes/Apps/Fabric Inbox.app"), "write");
  assert.equal(descriptorAction({ installedBy: "installer 1" }, "Fabric Inbox 0.98.0", APP), "write");
  assert.equal(descriptorAction(null, "Fabric Inbox 0.98.0", "/private/var/folders/x/AppTranslocation/1/d/Fabric Inbox.app"), "keep");
});

test("B-210: the services directory and the installed app on each system", () => {
  assert.equal(servicesDir({ platform: "darwin", env: {}, home: "/h" }), "/h/Library/Application Support/ai.passioncode.fabric/services");
  assert.equal(servicesDir({ platform: "linux", env: {}, home: "/h" }), "/h/.local/share/passioncode-fabric/services");
  assert.equal(servicesDir({ platform: "linux", env: { XDG_DATA_HOME: "/x" }, home: "/h" }), "/x/passioncode-fabric/services");
  assert.equal(servicesDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, home: "C:\\Users\\a" }), "C:\\Users\\a\\AppData\\Local\\passioncode-fabric\\services");
  assert.equal(servicesDir({ platform: "darwin", env: { FABRIC_SERVICES_DIR: "/s" }, home: "/h" }), "/s");
  assert.equal(appPathOf({ platform: "darwin", execPath: `${APP}/Contents/MacOS/Fabric Inbox`, env: {} }), APP);
  assert.equal(appPathOf({ platform: "linux", execPath: "/tmp/.mount_x/fabric-inbox", env: { APPIMAGE: "/opt/Fabric_Inbox.AppImage" } }), "/opt/Fabric_Inbox.AppImage");
  assert.equal(appPathOf({ platform: "win32", execPath: "C:\\Program Files\\Fabric Inbox\\Fabric Inbox.exe", env: {} }), "C:\\Program Files\\Fabric Inbox\\Fabric Inbox.exe");
});

test("B-210: an unreadable descriptor is written again; a write that fails says so and never throws", async () => {
  const s = setup();
  writeFileSync(s.file, "{not json");
  assert.deepEqual(await ensureDescriptor(s.deps), { outcome: "ok" });
  const broken = setup();
  const fs = { ...fsPromises, writeFile: async () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } };
  assert.deepEqual(await ensureDescriptor({ ...broken.deps, fs }), { outcome: "failed", reason: "EACCES" });
  assert.deepEqual(await ensureDescriptor({ ...broken.deps, env: undefined, home: undefined, fs: undefined }), { outcome: "skipped", reason: "no_services_dir" }, "missing deps never throw");
  assert.deepEqual(await ensureDescriptor(undefined), { outcome: "failed", reason: "unexpected" });
});
