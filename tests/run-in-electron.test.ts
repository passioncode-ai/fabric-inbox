// B-86 follow-up: the release's update check runs inside Electron (scripts/run-in-electron.mjs), so it
// sees the asar-aware file system an installed copy sees. Under plain Node it passed while every
// installed copy failed; run against the published 0.15.2 under Electron with node:fs it fails with
// the installed copies' ENOTEMPTY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { electronBinary, lockedElectronVersion } from "../scripts/run-in-electron.mjs";

test("B-86: the Electron version is the one package-lock.json pins", () => {
  assert.equal(lockedElectronVersion({ packages: { "node_modules/electron": { version: "44.4.5" } } }), "44.4.5");
  assert.throws(() => lockedElectronVersion({ packages: {} }), /pins no electron version/);
  assert.match(lockedElectronVersion(), /^\d+\.\d+\.\d+$/);
});

test("B-86: this checkout's Electron is used when it is installed", () => {
  const bin = electronBinary({ install: false });
  if (bin) assert.match(bin, /electron/i);
});

test("B-86: every update check in the release workflow runs inside Electron", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const calls = workflow.match(/[^\n]*scripts\/check-update-release\.mjs[^\n]*/g) ?? [];
  assert.equal(calls.length, 5);
  for (const call of calls) assert.match(call, /node scripts\/run-in-electron\.mjs scripts\/check-update-release\.mjs/, call.trim());
});
