import { test } from "node:test";
import assert from "node:assert/strict";

test("B-105: the update check passes on ready for this version, the install on installed and running it", async () => {
  const { eventsOf, readyVerdict, installedVerdict, parseUpdateArgs } = await import("../scripts/update-e2e.mjs");
  const ev = (...objs: object[]) => eventsOf(["noise", ...objs.map((o) => JSON.stringify(o))]);
  assert.equal(readyVerdict(ev({ event: "update_check", outcome: "current" }), "1.2.3"), null, "a check that finds nothing yet waits");
  assert.deepEqual(readyVerdict(ev({ event: "update_check", outcome: "ready", version: "1.2.3" }), "1.2.3"), { ok: true });
  assert.match(readyVerdict(ev({ event: "update_check", outcome: "ready", version: "1.2.2" }), "1.2.3").reason, /readied 1\.2\.2, not 1\.2\.3/);
  assert.match(readyVerdict(ev({ event: "update_check", outcome: "check_failed", reason: "not_replaceable" }), "1.2.3").reason, /not_replaceable/);
  assert.match(readyVerdict(ev({ event: "key_store_refused", backend: "basic_text" }), "1.2.3").reason, /no system key store/);
  assert.equal(installedVerdict(ev({ event: "window_shown", window: "setup" }), "1.2.3"), null);
  assert.deepEqual(installedVerdict(ev({ event: "update_install", outcome: "installed", version: "1.2.3", running: "1.2.3" }), "1.2.3"), { ok: true });
  assert.match(installedVerdict(ev({ event: "update_install", outcome: "failed", version: "1.2.3", running: "1.2.2" }), "1.2.3").reason, /failed/);
  assert.deepEqual(parseUpdateArgs(["--exe", "/x.AppImage", "--to", "1.2.3"]), { exe: "/x.AppImage", to: "1.2.3", timeout: 600 });
  assert.throws(() => parseUpdateArgs(["--exe", "/x", "--to", "v1.2"]), /--to must be a version/);
});
