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

test("B-108: --until ready checks where the readied update waits: the staging folder holds it, the roaming one nothing", async () => {
  const { parseUpdateArgs, stagedVerdict } = await import("../scripts/update-e2e.mjs");
  assert.deepEqual(parseUpdateArgs(["--exe", "C:/x.exe", "--to", "1.2.3", "--until", "ready", "--staged", "L", "--not-staged", "R"]),
    { exe: "C:/x.exe", to: "1.2.3", timeout: 600, until: "ready", staged: "L", notStaged: "R" });
  assert.throws(() => parseUpdateArgs(["--exe", "x", "--to", "1.2.3", "--until", "quit"]), /--until is ready or installed/);
  const dirs: Record<string, string[]> = { L: ["Fabric-Inbox-1.2.3-win-x64-setup.exe"], R: [], E: [] };
  const list = (d: string) => dirs[d] ?? [];
  assert.deepEqual(stagedVerdict({ staged: "L", notStaged: "R" }, list), { ok: true });
  assert.match(stagedVerdict({ staged: "E" }, list).reason, /nothing waits in E/);
  assert.match(stagedVerdict({ notStaged: "L" }, list).reason, /L holds Fabric-Inbox-1\.2\.3-win-x64-setup\.exe/);
  assert.deepEqual(stagedVerdict({}, list), { ok: true }, "nothing asked, nothing checked");
});
