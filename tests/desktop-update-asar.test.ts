// B-86: inside Electron, node:fs treats any `*.asar` file as a folder (an archive), so removing the
// update cache — which holds the downloaded app, app.asar included — fails with ENOTEMPTY. Every
// update check of the installed 0.12.0 failed that way from 2026-10-09 ("update_check ENOTEMPTY"),
// and no release after 0.12.0 was installed. Node itself has no asar support, so only a run under
// Electron shows it: this test runs the real Electron binary in node mode (ELECTRON_RUN_AS_NODE).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createPackageWithOptions } from "@electron/asar";

const require = createRequire(import.meta.url);
let electron: string | null = null;
try { electron = require("electron") as unknown as string; if (!existsSync(electron)) electron = null; } catch { electron = null; }

/** An update cache as the verifier leaves it: <dir>/<version>/unpacked/Fabric Inbox.app/…/app.asar. */
async function updateCache() {
  const base = mkdtempSync(path.join(os.tmpdir(), "fi-asar-"));
  const src = path.join(base, "src");
  mkdirSync(src);
  writeFileSync(path.join(src, "main.cjs"), "// the app");
  const resources = path.join(base, "updates", "0.13.0", "unpacked", "Fabric Inbox.app", "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  await createPackageWithOptions(src, path.join(resources, "app.asar"), {});
  return { base, dir: path.join(base, "updates") };
}

/** Runs `rm(dir, { recursive, force })` with the named module under Electron; returns the error code or "ok". */
function rmUnderElectron(module: string, dir: string): string {
  const script = `require(${JSON.stringify(module)}).promises.rm(process.argv[1], { recursive: true, force: true }).then(() => console.log("ok"), (e) => console.log(e.code || e.message))`;
  return execFileSync(electron!, ["-e", script, dir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60_000 }).trim().split("\n").pop()!;
}

test("B-86: under Electron, node:fs cannot remove an update cache holding app.asar; original-fs can", { skip: electron ? false : "no Electron binary" }, async () => {
  const { base, dir } = await updateCache();
  try {
    assert.equal(rmUnderElectron("node:fs", dir), "ENOTEMPTY", "the failure the installed 0.12.0 logged");
    assert.equal(rmUnderElectron("original-fs", dir), "ok");
    assert.equal(existsSync(dir), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("B-86: the update verifier and the installer get original-fs, not Electron's asar-aware fs", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /const updateFs = loadUpdateFs\(\);/);
  assert.match(main, /updateVerify\.createVerifier\(\{[\s\S]*?fs: updateFs\.promises, createWriteStream: updateFs\.createWriteStream,/);
  assert.match(main, /createPlatformInstaller\(\{ platform: process\.platform, app, spawn, fs: updateFs\.promises,/);
});
