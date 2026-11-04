import { test } from "node:test";
import assert from "node:assert/strict";

test("the smoke verdict: a window drawn (B-105), refused for no key store, or not yet", async () => {
  const { verdictOf, parseSmokeArgs } = await import("../scripts/smoke-desktop.mjs");
  assert.equal(verdictOf(["[1234:ERROR] gpu", "noise"]), null);
  const sweep = '{"ts":"x","event":"profile_sweep","outcome":"ok","partitions":0,"files":0}';
  assert.equal(verdictOf([sweep]), null, "startup alone is not a window");
  assert.deepEqual(verdictOf([sweep, '{"event":"window_shown","window":"setup"}']), { ok: true, events: ["profile_sweep", "window_shown"] });
  const failed = verdictOf([sweep, '{"event":"window_shown","window":"setup","outcome":"failed","code":-6}']);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /setup window did not load \(-6\)/);
  assert.equal(verdictOf(['{"event":"profile_sweep","outcome":"failed","code":"EACCES"}']).ok, false);
  const refused = verdictOf(['{"event":"key_store_refused","backend":"basic_text"}']);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /no system key store \(basic_text\)/);
  assert.deepEqual(parseSmokeArgs(["--exe", "/x/fabric-inbox", "--timeout", "30", "--", "--no-sandbox"]), { exe: "/x/fabric-inbox", timeout: 30, extra: ["--no-sandbox"], consoleCheck: false, background: false });
  assert.throws(() => parseSmokeArgs([]), /--exe is required/);
});

test("the smoke dismisses the sandbox warning under the name the app reads (B-99, B-105)", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const policy = createRequire(import.meta.url)("../desktop/policy.cjs");
  assert.ok(readFileSync(new URL("../scripts/smoke-desktop.mjs", import.meta.url), "utf8").includes(`'${policy.SANDBOX_WARNING_FILE}'`));
});

test("with --console-check the smoke also waits for the PTY check, and fails on its failure (B-105)", async () => {
  const { verdictOf, parseSmokeArgs } = await import("../scripts/smoke-desktop.mjs");
  assert.equal(parseSmokeArgs(["--exe", "/x", "--console-check"]).consoleCheck, true);
  const shown = ['{"event":"profile_sweep","outcome":"ok"}', '{"event":"window_shown","window":"setup"}'];
  assert.equal(verdictOf(shown, { consoleCheck: true }), null, "a window alone is not enough");
  assert.equal(verdictOf([...shown, '{"event":"console_check","outcome":"ok"}'], { consoleCheck: true }).ok, true);
  const failed = verdictOf([...shown, '{"event":"console_check","outcome":"failed","reason":"load: no module"}'], { consoleCheck: true });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /PTY did not run \(load: no module\)/);
});

test("with --background the smoke passes on a quiet launch and fails when a window opens (knowledge/lifecycle.md Background launch)", async () => {
  const { verdictOf, parseSmokeArgs, BACKGROUND_QUIET_MS } = await import("../scripts/smoke-desktop.mjs");
  assert.equal(parseSmokeArgs(["--exe", "/x", "--background"]).background, true);
  assert.throws(() => parseSmokeArgs(["--exe", "/x", "--background", "--console-check"]), /separate runs/);
  const quiet = ['{"event":"profile_sweep","outcome":"ok"}', '{"event":"background_launch"}'];
  assert.equal(verdictOf(quiet.slice(0, 1), { background: true, quietFor: BACKGROUND_QUIET_MS }), null, "not yet launched in the background");
  assert.equal(verdictOf(quiet, { background: true, quietFor: BACKGROUND_QUIET_MS - 1 }), null, "not quiet long enough yet");
  assert.deepEqual(verdictOf(quiet, { background: true, quietFor: BACKGROUND_QUIET_MS }), { ok: true, events: ["profile_sweep", "background_launch"] });
  const opened = verdictOf([...quiet, '{"event":"window_shown","window":"mail"}'], { background: true, quietFor: BACKGROUND_QUIET_MS });
  assert.equal(opened.ok, false);
  assert.match(opened.reason, /mail window opened at a background launch/);
});
