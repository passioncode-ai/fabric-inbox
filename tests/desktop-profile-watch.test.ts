// B-236: the profile's switch files take effect while the app runs (desktop/profile-watch.cjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { watchProfile } = require("../desktop/profile-watch.cjs");

test("a burst of events on one switch file calls its handler once; other files are ignored", async () => {
  let listener: (event: string, name: string) => void = () => {};
  const timers: (() => void)[] = [];
  const calls: string[] = [];
  const lines: any[] = [];
  const w = watchProfile({ dir: "/p", watch: (_d: string, l: any) => { listener = l; return { close() {} }; },
    handlers: { "auto-update": async () => { calls.push("auto-update"); } },
    setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: (i: number) => { timers[i - 1] = () => {}; }, log: (l: unknown) => lines.push(l) });
  listener("change", "auto-update"); listener("rename", "auto-update"); listener("change", "servers.json");
  timers.forEach((t) => t());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["auto-update"]);
  assert.deepEqual(lines, [{ event: "profile_switch", outcome: "applied", file: "auto-update" }]);
  w.close();
});

test("a folder that cannot be watched is logged, never thrown", () => {
  const lines: any[] = [];
  const w = watchProfile({ dir: "/nope", watch: () => { const e: any = new Error("x"); e.code = "ENOENT"; throw e; }, handlers: {}, log: (l: unknown) => lines.push(l) });
  assert.deepEqual(lines, [{ event: "profile_switch", outcome: "not_watched", code: "ENOENT" }]);
  w.close();
});

test("a real folder: writing the file reaches its handler", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-profile-"));
  let resolve: () => void = () => {};
  const seen = new Promise<void>((r) => { resolve = r; });
  const w = watchProfile({ dir, watch, debounceMs: 20, handlers: { "new-mail-notifications": async () => resolve() } });
  writeFileSync(path.join(dir, "new-mail-notifications"), "on\n");
  await Promise.race([seen, new Promise((_, no) => setTimeout(() => no(new Error("no event in 3 s")), 3000))]);
  w.close();
});
