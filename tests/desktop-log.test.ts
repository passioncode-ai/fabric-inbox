// The app's log file (LC-12, LC-16): JSON lines in its own Logs folder, capped at about 2 MB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLog, MAX_BYTES } = require("../desktop/log.cjs");

test("events are written in order as JSON lines with a timestamp", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-log-")), "Logs", "Fabric Inbox");
  const echoed: string[] = [];
  const log = createLog({ fs: fsPromises, dir, now: () => Date.parse("2026-10-07T10:00:00Z"), echo: (l: string) => echoed.push(l) });
  log({ event: "update_check", outcome: "current" });
  log({ event: "auto_update", outcome: "off" });
  await log.flush();
  const lines = readFileSync(path.join(dir, "fabric-inbox.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { ts: "2026-10-07T10:00:00.000Z", event: "update_check", outcome: "current" },
    { ts: "2026-10-07T10:00:00.000Z", event: "auto_update", outcome: "off" },
  ]);
  assert.equal(echoed.length, 2);
  if (process.platform !== "win32") assert.equal(statSync(path.join(dir, "fabric-inbox.log")).mode & 0o777, 0o600);
});

test("past 1 MB the file rolls over once; at most two files are kept", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-log-"));
  writeFileSync(path.join(dir, "fabric-inbox.log"), "x".repeat(MAX_BYTES - 10));
  writeFileSync(path.join(dir, "fabric-inbox.1.log"), "old");
  const log = createLog({ fs: fsPromises, dir, echo: () => {} });
  log({ event: "update_check", outcome: "current" });
  await log.flush();
  assert.equal(readFileSync(path.join(dir, "fabric-inbox.1.log"), "utf8").length, MAX_BYTES - 10, "the full file became the previous one");
  assert.match(readFileSync(path.join(dir, "fabric-inbox.log"), "utf8"), /^\{"ts":/);
  assert.ok(!existsSync(path.join(dir, "fabric-inbox.2.log")));
});

test("a log that cannot be written never throws, and writing resumes when it can", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fabric-log-"));
  writeFileSync(path.join(root, "Logs"), "a file where the folder should be");
  const log = createLog({ fs: fsPromises, dir: path.join(root, "Logs"), echo: () => {} });
  await log({ event: "update_check", outcome: "check_failed" });
  await fsPromises.rm(path.join(root, "Logs"));
  await log({ event: "update_check", outcome: "current" });
  assert.match(readFileSync(path.join(root, "Logs", "fabric-inbox.log"), "utf8"), /"outcome":"current"/);
});
