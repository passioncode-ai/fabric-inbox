import { test } from "node:test";
import assert from "node:assert/strict";

test("the smoke verdict: launch reached, refused for no key store, or not yet", async () => {
  const { verdictOf, parseSmokeArgs } = await import("../scripts/smoke-desktop.mjs");
  assert.equal(verdictOf(["[1234:ERROR] gpu", "noise"]), null);
  assert.deepEqual(verdictOf(['{"ts":"x","event":"profile_sweep","outcome":"ok","partitions":0,"files":0}']), { ok: true, events: ["profile_sweep"] });
  assert.equal(verdictOf(['{"event":"profile_sweep","outcome":"failed","code":"EACCES"}']).ok, false);
  const refused = verdictOf(['{"event":"key_store_refused","backend":"basic_text"}']);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /no system key store \(basic_text\)/);
  assert.deepEqual(parseSmokeArgs(["--exe", "/x/fabric-inbox", "--timeout", "30", "--", "--no-sandbox"]), { exe: "/x/fabric-inbox", timeout: 30, extra: ["--no-sandbox"] });
  assert.throws(() => parseSmokeArgs([]), /--exe is required/);
});
