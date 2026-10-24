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
  assert.deepEqual(parseSmokeArgs(["--exe", "/x/fabric-inbox", "--timeout", "30", "--", "--no-sandbox"]), { exe: "/x/fabric-inbox", timeout: 30, extra: ["--no-sandbox"] });
  assert.throws(() => parseSmokeArgs([]), /--exe is required/);
});

test("the smoke dismisses the sandbox warning under the name the app reads (B-99, B-105)", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const policy = createRequire(import.meta.url)("../desktop/policy.cjs");
  assert.ok(readFileSync(new URL("../scripts/smoke-desktop.mjs", import.meta.url), "utf8").includes(`'${policy.SANDBOX_WARNING_FILE}'`));
});
