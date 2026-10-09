// LC-13 and LC-07 (knowledge/lifecycle.md): every Mac build ships hardened Electron fuses and only
// the purpose strings the app uses. The builders (desktop/dist-mac.mjs, desktop/mas-package.mjs,
// desktop/package.mjs) apply both to the extracted Electron template through one packager hook and
// then read the built binary's fuse wire and Info.plist back as a release gate. Real Electron
// binaries are 100+ MB, so the reader is held here against a synthetic binary that has the same
// layout: a sentinel, a version byte, a length byte and one ASCII byte per fuse, once per Mach-O
// slice (two in a universal build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import plist from "plist";
import {
  FUSE_SENTINEL, REQUIRED_FUSES, readFuseWires, checkFuses, fuseFile,
  usageDescriptionKeys, stripUsageDescriptions, checkUsageDescriptions, DECLARED_USAGE_DESCRIPTIONS,
  hardenElectronTemplate, hardenTemplateHook, verifyHardening,
} from "../desktop/hardening.mjs";

// Electron's stock wire as the audit read it from Fabric Inbox 0.8.2 (raw/fabric-inbox.md §5):
// RunAsNode=on, EnableCookieEncryption=off, NodeOptions=on, NodeCliInspect=on, AsarIntegrity=off,
// OnlyLoadAppFromAsar=off, V8Snapshot=off, GrantFileProtocolExtraPrivileges=on, WasmTrapHandlers=on.
const STOCK = "101100011";
const HARDENED = "010011011";

function slice(wire: string, version = 1) {
  return Buffer.concat([Buffer.from(FUSE_SENTINEL), Buffer.from([version, wire.length]), Buffer.from(wire, "latin1")]);
}
function binary(...wires: string[]) {
  const parts: Buffer[] = [Buffer.alloc(4096, 0xcf)];
  for (const wire of wires) parts.push(slice(wire), Buffer.alloc(8192, 0xfe));
  return Buffer.concat(parts);
}
const STOCK_PLIST = {
  CFBundleIdentifier: "com.github.Electron",
  CFBundleName: "Electron",
  NSCameraUsageDescription: "This app needs access to the camera",
  NSMicrophoneUsageDescription: "This app needs access to the microphone",
  NSBluetoothAlwaysUsageDescription: "This app needs access to Bluetooth",
  NSBluetoothPeripheralUsageDescription: "This app needs access to Bluetooth",
  NSAudioCaptureUsageDescription: "This app needs access to audio capture",
  NSPrincipalClass: "AtomApplication",
  NSSupportsAutomaticGraphicsSwitching: true,
};

test("the required fuses are the six the lifecycle contract names, in the states it names", () => {
  assert.deepEqual(REQUIRED_FUSES, {
    RunAsNode: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    EnableCookieEncryption: true,
  });
});

test("the fuse wire is read from every slice of a binary: one for an arch build, two for universal", () => {
  assert.deepEqual(readFuseWires(binary(STOCK)), [{ version: 1, wire: STOCK }]);
  assert.deepEqual(readFuseWires(binary(STOCK, HARDENED)), [{ version: 1, wire: STOCK }, { version: 1, wire: HARDENED }]);
  assert.deepEqual(readFuseWires(Buffer.alloc(1024)), []);
  // A wire cut off by the end of the file is reported as far as it goes, never padded.
  const truncated = Buffer.concat([Buffer.alloc(16), Buffer.from(FUSE_SENTINEL), Buffer.from([1, 9]), Buffer.from("0100")]);
  assert.deepEqual(readFuseWires(truncated), [{ version: 1, wire: "0100" }]);
});

test("the release gate refuses Electron's stock fuses and accepts only the hardened wire in every slice", () => {
  assert.throws(() => checkFuses(readFuseWires(binary(STOCK))), /RunAsNode is on.*EnableCookieEncryption is off/s);
  const summary = checkFuses(readFuseWires(binary(HARDENED, HARDENED)));
  assert.match(summary, /^2 slices: RunAsNode=off, EnableNodeOptionsEnvironmentVariable=off, EnableNodeCliInspectArguments=off, EnableEmbeddedAsarIntegrityValidation=on, OnlyLoadAppFromAsar=on, EnableCookieEncryption=on$/);
  // One hardened slice is not a hardened universal app: the Intel half would still run as Node.
  assert.throws(() => checkFuses(readFuseWires(binary(HARDENED, STOCK))), /slice 2: RunAsNode is on/);
  assert.throws(() => checkFuses([]), /no fuse wire/);
  assert.throws(() => checkFuses(readFuseWires(binary(HARDENED, HARDENED, HARDENED))), /3 fuse wires/);
  assert.throws(() => checkFuses([{ version: 2, wire: HARDENED }]), /version 2/);
  assert.throws(() => checkFuses([{ version: 1, wire: "0100" }]), /EnableEmbeddedAsarIntegrityValidation is missing/);
  // A fuse Electron removed ('r') is not a fuse that is on.
  assert.throws(() => checkFuses([{ version: 1, wire: "01001r011" }]), /OnlyLoadAppFromAsar is removed/);
});

test("the fuse wire lives in Electron Framework inside the app bundle", () => {
  assert.equal(fuseFile("/x/Fabric Inbox.app"), path.join("/x/Fabric Inbox.app", "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"));
});

test("only declared purpose strings survive: Electron's camera, microphone and Bluetooth strings are stripped", () => {
  assert.deepEqual(DECLARED_USAGE_DESCRIPTIONS, []);
  assert.deepEqual(usageDescriptionKeys(STOCK_PLIST).sort(), [
    "NSAudioCaptureUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription", "NSMicrophoneUsageDescription",
  ]);
  const stripped = stripUsageDescriptions(STOCK_PLIST);
  assert.deepEqual(usageDescriptionKeys(stripped), []);
  // Everything else Electron needs stays exactly as it was.
  assert.equal(stripped.NSPrincipalClass, "AtomApplication");
  assert.equal(stripped.NSSupportsAutomaticGraphicsSwitching, true);
  assert.equal(stripped.CFBundleIdentifier, "com.github.Electron");
  // The input is not mutated.
  assert.equal(STOCK_PLIST.NSCameraUsageDescription, "This app needs access to the camera");
  // A declared purpose is kept.
  assert.deepEqual(usageDescriptionKeys(stripUsageDescriptions(STOCK_PLIST, ["NSCameraUsageDescription"])), ["NSCameraUsageDescription"]);
  assert.throws(() => checkUsageDescriptions(STOCK_PLIST), /undeclared purpose strings: NSAudioCaptureUsageDescription, NSBluetoothAlwaysUsageDescription/);
  assert.equal(checkUsageDescriptions(stripped), "none (declared: none)");
});

function template(wires: string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-template-"));
  const appDir = path.join(dir, "Electron.app");
  mkdirSync(path.join(appDir, "Contents", "Frameworks", "Electron Framework.framework"), { recursive: true });
  writeFileSync(fuseFile(appDir), binary(...wires));
  writeFileSync(path.join(appDir, "Contents", "Info.plist"), plist.build(STOCK_PLIST as never));
  return { dir, appDir };
}

test("the packager hook hardens the extracted template: fuses flipped in every slice, purpose strings gone", async () => {
  const { dir, appDir } = template([STOCK, STOCK]);
  await hardenElectronTemplate({ buildPath: dir, platform: "darwin", arch: "x64" });
  const wires = readFuseWires(readFileSync(fuseFile(appDir)));
  assert.deepEqual(wires.map((w) => w.wire), [HARDENED, HARDENED]);
  assert.match(checkFuses(wires), /^2 slices/);
  const info = plist.parse(readFileSync(path.join(appDir, "Contents", "Info.plist"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(usageDescriptionKeys(info), []);
  assert.equal(info.NSPrincipalClass, "AtomApplication");
});

test("the hook is the packager's afterExtract shape and refuses a template that is not an Electron app", async () => {
  const { dir, appDir } = template([STOCK]);
  const hooks = hardenTemplateHook();
  assert.equal(hooks.length, 1);
  await hooks[0]({ buildPath: dir, electronVersion: "44.4.5", platform: "mas", arch: "arm64" });
  assert.equal(readFuseWires(readFileSync(fuseFile(appDir)))[0].wire, HARDENED);
  const empty = mkdtempSync(path.join(os.tmpdir(), "fabric-template-"));
  await assert.rejects(hardenElectronTemplate({ buildPath: empty, platform: "darwin", arch: "x64" }), /no Electron\.app/);
  await assert.rejects(hardenElectronTemplate({ buildPath: dir, platform: "linux", arch: "x64" }), /no electron to harden/);
  await assert.rejects(hardenElectronTemplate({ buildPath: dir, platform: "solaris", arch: "x64" }), /Unknown platform/);
});

test("Windows and Linux: the fuses are flipped in Electron's own executable and the built executable is gated", async () => {
  for (const [platform, template, built, name] of [["win32", "electron.exe", "Fabric Inbox.exe", "Fabric Inbox"], ["linux", "electron", "fabric-inbox", "fabric-inbox"]] as const) {
    const dir = mkdtempSync(path.join(os.tmpdir(), `fabric-${platform}-`));
    writeFileSync(path.join(dir, template), binary(STOCK));
    await hardenTemplateHook()[0]({ buildPath: dir, electronVersion: "44.4.5", platform, arch: "x64" });
    assert.equal(readFuseWires(readFileSync(path.join(dir, template)))[0].wire, HARDENED, platform);
    // The packager renames the template into the app's executable; the gate reads that one.
    writeFileSync(path.join(dir, built), readFileSync(path.join(dir, template)));
    assert.equal(fuseFile(dir, platform, name), path.join(dir, built));
    const receipt = verifyHardening(dir, { platform, executableName: name });
    assert.match(receipt.fuses, /^1 slice: RunAsNode=off/);
    assert.match(receipt.usageDescriptions, /not applicable/);
    writeFileSync(path.join(dir, built), binary(STOCK));
    assert.throws(() => verifyHardening(dir, { platform, executableName: name }), /RunAsNode is on/, `${platform}: an unhardened build fails the gate`);
  }
});

test("every Mac builder applies the hardening hook and gates on the built binary", () => {
  for (const builder of ["desktop/dist-mac.mjs", "desktop/mas-package.mjs", "desktop/package.mjs"]) {
    const code = readFileSync(builder, "utf8");
    assert.match(code, /afterExtract: hardenTemplateHook\(/, `${builder} hardens the Electron template`);
    assert.match(code, /verifyHardening\(/, `${builder} reads the fuse wire and Info.plist of what it built`);
  }
});
