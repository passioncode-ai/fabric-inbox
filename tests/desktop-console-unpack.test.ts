// B-84: node-pty must run from app.asar.unpacked. It finds its own helper (spawn-helper on macOS,
// the conpty agent on Windows) by replacing app.asar with app.asar.unpacked in its path, and native
// code cannot read inside an asar. 0.15.0 shipped with no app.asar.unpacked on any platform: the
// packager's `unpack` glob is matched against each file's absolute path, and `**` does not cross a
// folder whose name starts with a dot (macOS packs under `release/.build-tmp`, Windows and Linux
// under `.stage-<p>-<a>`).
// These tests pack a real asar with @electron/asar in such a folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { CONSOLE_ASAR, verifyConsoleUnpacked } from "../desktop/console-assets.mjs";

const PTY_FILES: Record<string, string[]> = {
  darwin: ["prebuilds/darwin-arm64/pty.node", "prebuilds/darwin-arm64/spawn-helper", "prebuilds/darwin-x64/pty.node", "prebuilds/darwin-x64/spawn-helper"],
  win32: ["prebuilds/win32-x64/pty.node", "prebuilds/win32-x64/conpty.node", "prebuilds/win32-x64/conpty/OpenConsole.exe"],
  linux: ["build/Release/pty.node"],
};

/** An app folder under `.stage-…/app`, with node-pty's files for `platform` and one ordinary file. */
function stagedApp(platform: string) {
  const base = mkdtempSync(path.join(os.tmpdir(), "fi-unpack-"));
  const app = path.join(base, `.stage-${platform}-x64`, "app");
  for (const rel of ["package.json", "lib/index.js", ...PTY_FILES[platform]]) {
    const file = path.join(app, "node_modules", "node-pty", rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, rel);
  }
  writeFileSync(path.join(app, "main.cjs"), "// the app");
  return { base, app, resources: path.join(base, "resources") };
}

test("B-84: the 0.15.0 glob unpacks nothing when the app is staged in a dot folder", async () => {
  const { base, app, resources } = stagedApp("win32");
  try {
    mkdirSync(resources);
    await createPackageWithOptions(app, path.join(resources, "app.asar"), { unpack: "**/node_modules/node-pty/**" });
    assert.equal(existsSync(path.join(resources, "app.asar.unpacked")), false, "the regression this change fixes");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`B-84: CONSOLE_ASAR unpacks node-pty whole on ${platform}, wherever the app is staged; the check passes`, async () => {
    const { base, app, resources } = stagedApp(platform);
    try {
      mkdirSync(resources);
      await createPackageWithOptions(app, path.join(resources, "app.asar"), CONSOLE_ASAR);
      for (const rel of ["package.json", "lib/index.js", ...PTY_FILES[platform]])
        assert.ok(existsSync(path.join(resources, "app.asar.unpacked", "node_modules", "node-pty", rel)), `${rel} is outside the asar`);
      assert.equal(existsSync(path.join(resources, "app.asar.unpacked", "main.cjs")), false, "nothing else is unpacked");
      assert.deepEqual(verifyConsoleUnpacked(resources, { platform, arch: "x64" }).missing, []);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

test("B-84: verifyConsoleUnpacked names what is missing, so a build without it fails", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "fi-unpack-"));
  try {
    assert.throws(() => verifyConsoleUnpacked(base, { platform: "darwin", arch: "universal" }, { throwOnMissing: true }),
      /agent console.*app\.asar\.unpacked.*spawn-helper/s);
    const dir = path.join(base, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "win32-arm64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "pty.node"), "");
    assert.deepEqual(verifyConsoleUnpacked(base, { platform: "win32", arch: "arm64" }).missing, []);
    assert.deepEqual(verifyConsoleUnpacked(base, { platform: "win32", arch: "x64" }).missing, ["prebuilds/win32-x64/pty.node"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
