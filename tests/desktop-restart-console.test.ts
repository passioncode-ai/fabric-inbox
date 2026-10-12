// Platform sweep 2026-10-12 (B-104): Restart Now in the update-ready dialog called updater.restart()
// without asking about a running agent console, while the menu's Restart to Install asked. On macOS
// the console prompt then came up with no window; on a Linux AppImage the restart's app.exit(0) skips
// before-quit, so the session's 30-day key stayed live. Every restart now goes through one function
// that asks and revokes first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync("desktop/main.cjs", "utf8");

test("B-104: updater.restart() is called in one place, after the console may end", () => {
  const calls = main.match(/updater\.restart\(\)/g) ?? [];
  assert.equal(calls.length, 1, "one restart call");
  const fn = main.slice(main.indexOf("async function restartToUpdate"), main.indexOf("async function restartToUpdate") + 400);
  assert.match(fn, /await consoleMayEnd\(\)/);
  assert.match(fn, /updater\.restart\(\)/);
});

test("B-104: both the dialog and the menu restart through restartToUpdate", () => {
  assert.match(main, /if \(answer\.response === 1\) void restartToUpdate\(\);/, "the update-ready dialog");
  assert.match(main, /now\.state === 'ready'\) void restartToUpdate\(\);/, "the menu item");
});

test("B-99: a Linux run without Chromium's sandbox is logged", () => {
  assert.match(main, /process\.platform === 'linux' && app\.commandLine\.hasSwitch\('no-sandbox'\)\) logEvent\(\{ event: 'sandbox_off'/);
});
