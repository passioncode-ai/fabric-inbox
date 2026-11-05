// B-205 (Fabric's ADR-0188): the Mac app folds its own log into hourly and daily digests, counts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDigest, foldHour, foldDay, outcomeOf } = require("../desktop/ops-digest.cjs");
const { createLog } = require("../desktop/log.cjs");
const H = 3600_000;
const T0 = Date.parse("2026-11-04T10:00:00Z");

test("B-212: the app's own outcomes map to ok, failed or unknown as DEC-0153 OD-3 allows (a published map)", () => {
  for (const o of ["failed", "check_failed", "install_failed", "not_saved", "not_written", "storage_not_cleared", "directory_not_removed", "lost", "unparsed", "timeout", "leftovers"])
    assert.equal(outcomeOf(o), "failed", o);
  for (const o of ["ok", "done", "current", "newer", "older", "installed", "verified", "ready", "started", "running", "connected", "on", "off"]) assert.equal(outcomeOf(o), "ok", o);
  // A skip, a person's choice, a setup or policy answer, and anything unnamed: never a failure, so no rise.
  for (const o of ["unknown", "skipped", "refused", "denied", "held", "waiting", "unsupported", "unavailable", "needs_approval", "needs_migration", "something_new"])
    assert.equal(outcomeOf(o), "unknown", o);
});

test("B-212: every outcome the app's code logs is named in the map or ends in _failed", () => {
  const src = readdirSync("desktop").filter((f) => /\.(c?js)$/.test(f)).map((f) => readFileSync(path.join("desktop", f), "utf8")).join("\n");
  const named = new Set([...src.matchAll(/outcome: ?['"]([a-z_]+)['"]/g)].map((m) => m[1]));
  const unknownOnPurpose = new Set(["skipped", "refused", "denied", "held", "waiting", "unsupported", "unavailable", "needs_migration"]);
  for (const o of named) assert.ok(outcomeOf(o) !== "unknown" || unknownOnPurpose.has(o), `${o} is not in the map`);
});

test("B-205: an hour folds into counts by event, and a rise against the hour before is named (Fabric's rule)", () => {
  const counts = new Map([["update_check", { ok: 2, failed: 12, unknown: 0 }], ["window_shown", { ok: 3, failed: 0, unknown: 0 }]]);
  const first = foldHour(counts, T0, null);
  assert.deepEqual([first.schema, first.from, first.to], ["ops.digest.hourly@1", "2026-11-04T10:00:00.000Z", "2026-11-04T11:00:00.000Z"]);
  assert.deepEqual(first.total, { ok: 5, failed: 12, unknown: 0 });
  assert.deepEqual(first.risen, [{ op: "update_check", failed: 12, previous: 0 }], "10 or more against none");
  const second = foldHour(new Map([["update_check", { ok: 0, failed: 15, unknown: 0 }]]), T0 + H, first);
  assert.deepEqual(second.risen, [], "15 is not twice 12");
  const gap = foldHour(new Map([["update_check", { ok: 0, failed: 15, unknown: 0 }]]), T0 + 3 * H, first);
  assert.equal(gap.risen.length, 1, "after a gap the hour compares with nothing");
  const day = foldDay("2026-11-04", [first, second, second]);
  assert.deepEqual([day.schema, day.hours, day.total.failed, day.risen], ["ops.digest.daily@1", 2, 27, [{ op: "update_check", hours: 1, failed: 12 }]], "a second line of one hour is not folded again");
  assert.equal(foldDay("2026-11-03", [first, second]), null, "a day with no hour has no digest (OD-5)");
});

test("B-205: closed hours and days are written under digests/, the open hour is not, and nothing but counts leaves an event", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-digest-")), "digests");
  const logged: any[] = [];
  const d = createDigest({ fs: fsPromises, dir, log: (e: unknown) => logged.push(e) });
  d.count({ event: "update_check", outcome: "current", email: "ann@acme.example" }, T0 + 60_000);
  d.count({ event: "window_shown" }, T0 + 120_000); // no outcome: not counted
  for (let i = 0; i < 11; i++) d.count({ event: "server_update", outcome: "failed", code: "x" }, T0 + 30 * 60_000);
  await d.flush();
  assert.equal(existsSync(dir), false, "the open hour is not written");
  d.count({ event: "update_check", outcome: "check_failed" }, T0 + H + 1);
  await d.flush();
  const hourly = readFileSync(path.join(dir, "hourly-2026-11.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(hourly.length, 1);
  assert.deepEqual(hourly[0].ops, [{ op: "server_update", ok: 0, failed: 11, unknown: 0 }, { op: "update_check", ok: 1, failed: 0, unknown: 0 }]);
  assert.ok(!readFileSync(path.join(dir, "hourly-2026-11.jsonl"), "utf8").includes("acme"), "no detail of an event");
  assert.deepEqual(logged, [{ event: "failures_rose", op: "server_update", failed: 11, previous: 0 }]);
  // The next UTC day closes the day: one daily line.
  d.count({ event: "update_check", outcome: "current" }, Date.parse("2026-11-05T00:10:00Z"));
  await d.flush();
  const daily = readFileSync(path.join(dir, "daily-2026-11.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([daily.length, daily[0].day, daily[0].hours, daily[0].total], [1, "2026-11-04", 2, { ok: 1, failed: 12, unknown: 0 }]);
  assert.deepEqual(readdirSync(dir).sort(), ["daily-2026-11.jsonl", "hourly-2026-11.jsonl"]);
});

test("B-205: the log hands each event to the digest, and a digest that throws never stops the log", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-log-"));
  const seen: any[] = [];
  const log = createLog({ fs: fsPromises, dir, now: () => T0, echo: () => {}, onEvent: (e: any, at: number) => { seen.push([e.event, at]); throw new Error("boom"); } });
  await log({ event: "update_check", outcome: "current" });
  assert.deepEqual(seen, [["update_check", T0]]);
  assert.match(readFileSync(path.join(dir, "fabric-inbox.log"), "utf8"), /update_check/);
});

test("B-212: at start, each closed day with hours and no daily line gets one from the hourly file, once (OD-5)", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-digest-")), "digests");
  await fsPromises.mkdir(dir, { recursive: true });
  const hour = (from: string, failed: number) => ({ schema: "ops.digest.hourly@1", from, to: new Date(Date.parse(from) + H).toISOString(),
    ops: [{ op: "update_check", ok: 1, failed, unknown: 0 }], total: { ok: 1, failed, unknown: 0 }, risen: [] });
  // 10-31 in last month's file, 11-03 with a line written twice, 11-04 already folded, 11-05 still open (today).
  await fsPromises.writeFile(path.join(dir, "hourly-2026-10.jsonl"), JSON.stringify(hour("2026-10-31T22:00:00.000Z", 1)) + "\n");
  await fsPromises.writeFile(path.join(dir, "hourly-2026-11.jsonl"), [hour("2026-11-03T09:00:00.000Z", 2), hour("2026-11-03T09:00:00.000Z", 2),
    hour("2026-11-03T10:00:00.000Z", 3), hour("2026-11-04T08:00:00.000Z", 4), hour("2026-11-05T01:00:00.000Z", 5)].map((h) => JSON.stringify(h)).join("\n") + "\n");
  await fsPromises.writeFile(path.join(dir, "daily-2026-11.jsonl"), JSON.stringify({ schema: "ops.digest.daily@1", day: "2026-11-04", hours: 1, ops: [], total: { ok: 0, failed: 0, unknown: 0 }, risen: [] }) + "\n");
  const d = createDigest({ fs: fsPromises, dir });
  const now = Date.parse("2026-11-05T12:00:00Z");
  await d.catchUp(now);
  await d.catchUp(now);
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(read("daily-2026-10.jsonl").map((x: any) => [x.day, x.hours]), [["2026-10-31", 1]]);
  assert.deepEqual(read("daily-2026-11.jsonl").map((x: any) => [x.day, x.hours, x.total.failed]), [["2026-11-04", 1, 0], ["2026-11-03", 2, 5]],
    "11-03 once with each hour once, 11-04 left as it was, today not folded");
});

test("B-212: a day closing while the app runs is folded from the file, with hours written before a restart", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-digest-")), "digests");
  const before = createDigest({ fs: fsPromises, dir });
  before.count({ event: "update_check", outcome: "failed" }, T0);
  before.count({ event: "update_check", outcome: "current" }, T0 + H);
  await before.flush();
  const after = createDigest({ fs: fsPromises, dir }); // the app restarted in the same day
  after.count({ event: "update_check", outcome: "current" }, T0 + 3 * H);
  after.count({ event: "update_check", outcome: "current" }, Date.parse("2026-11-05T00:30:00Z"));
  await after.flush();
  const daily = readFileSync(path.join(dir, "daily-2026-11.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(daily.map((x: any) => [x.day, x.hours, x.total]), [["2026-11-04", 2, { ok: 1, failed: 1, unknown: 0 }]]);
});


const readLines = (dir: string, f: string) => readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const newDir = () => path.join(mkdtempSync(path.join(os.tmpdir(), "fabric-digest-")), "digests");

test("B-213: the hour open at quit is kept and written at the next start, before the day it closed is folded (OD-1, OD-5)", async () => {
  const dir = newDir();
  const D = (t: string) => Date.parse(`2026-11-04T${t}:00Z`);
  const before = createDigest({ fs: fsPromises, fsSync: require("node:fs"), dir });
  before.start(D("19:59"));
  before.count({ event: "update_check", outcome: "current" }, D("20:10"));
  before.count({ event: "update_check", outcome: "failed" }, D("22:10"));
  before.count({ event: "server_update", outcome: "failed" }, D("23:30"));
  await before.flush();
  assert.equal(before.hold(), true, "kept at quit");
  assert.deepEqual(readLines(dir, "hourly-2026-11.jsonl").map((h: any) => h.from.slice(11, 13)), ["20", "22"], "23 is still open");
  // The next start is the next day: hour 23 is written first, then day 11-04 folded with it.
  const after = createDigest({ fs: fsPromises, fsSync: require("node:fs"), dir });
  await after.start(Date.parse("2026-11-05T01:00:00Z"));
  const hours = readLines(dir, "hourly-2026-11.jsonl");
  assert.deepEqual(hours.map((h: any) => h.from.slice(11, 13)), ["20", "22", "23"]);
  assert.deepEqual(hours[2].ops, [{ op: "server_update", ok: 0, failed: 1, unknown: 0 }]);
  const daily = readLines(dir, "daily-2026-11.jsonl");
  assert.deepEqual(daily.map((d: any) => [d.day, d.hours, d.total]), [["2026-11-04", 3, { ok: 1, failed: 2, unknown: 0 }]], "the day includes hour 23");
  assert.equal(existsSync(path.join(dir, "open-hour.json")), false, "kept once, then removed");
  await createDigest({ fs: fsPromises, dir }).start(Date.parse("2026-11-05T02:00:00Z"));
  assert.equal(readLines(dir, "hourly-2026-11.jsonl").length, 3, "a later start writes nothing twice");
});

test("B-213: a start in the same hour goes on counting it; one line for the hour", async () => {
  const dir = newDir();
  const first = createDigest({ fs: fsPromises, fsSync: require("node:fs"), dir });
  for (let i = 0; i < 6; i++) first.count({ event: "update_check", outcome: "failed" }, T0 + 5 * 60_000);
  await first.flush();
  first.hold();
  const second = createDigest({ fs: fsPromises, fsSync: require("node:fs"), dir });
  second.start(T0 + 30 * 60_000);
  for (let i = 0; i < 5; i++) second.count({ event: "update_check", outcome: "failed" }, T0 + 40 * 60_000);
  second.count({ event: "update_check", outcome: "current" }, T0 + H + 60_000);
  await second.flush();
  const hours = readLines(dir, "hourly-2026-11.jsonl");
  assert.equal(hours.length, 1);
  assert.deepEqual([hours[0].from, hours[0].ops[0].failed, hours[0].risen], ["2026-11-04T10:00:00.000Z", 11, [{ op: "update_check", failed: 11, previous: 0 }]]);
});

test("B-213: previous is read back from the last hourly line, so a restart does not make a rise of a steady failure", async () => {
  const dir = newDir();
  const first = createDigest({ fs: fsPromises, dir });
  for (let i = 0; i < 12; i++) first.count({ event: "update_check", outcome: "failed" }, T0 - H + 60_000);
  first.count({ event: "window_shown" }, T0 + 60_000); // closes hour 09
  await first.flush();
  const second = createDigest({ fs: fsPromises, dir });
  second.start(T0 + 2 * 60_000);
  for (let i = 0; i < 15; i++) second.count({ event: "update_check", outcome: "failed" }, T0 + 10 * 60_000);
  second.count({ event: "window_shown" }, T0 + H + 60_000);
  await second.flush();
  const hours = readLines(dir, "hourly-2026-11.jsonl");
  assert.deepEqual(hours.map((h: any) => [h.from.slice(11, 13), h.risen.length]), [["09", 1], ["10", 0]], "15 against 12 read back is no rise");
});

test("B-213: an hour the app ran in is written even with nothing counted; one with no line is a gap", async () => {
  const dir = newDir();
  const d = createDigest({ fs: fsPromises, dir });
  d.count({ event: "window_shown" }, T0 + 60_000);
  d.count({ event: "window_shown" }, T0 + 3 * H + 60_000);
  await d.flush();
  assert.deepEqual(readLines(dir, "hourly-2026-11.jsonl").map((h: any) => [h.from.slice(11, 13), h.ops.length, h.total]), [["10", 0, { ok: 0, failed: 0, unknown: 0 }]]);
});

test("B-213: past 4095 operation names in a UTC day the rest are counted under ops_overflow (OD-3)", async () => {
  const { MAX_NAMED_OPS, OVERFLOW_OP } = require("../desktop/ops-digest.cjs");
  assert.deepEqual([MAX_NAMED_OPS, OVERFLOW_OP], [4095, "ops_overflow"]);
  const dir = newDir();
  const d = createDigest({ fs: fsPromises, dir });
  for (let i = 0; i < MAX_NAMED_OPS + 2; i++) d.count({ event: `op_${i}`, outcome: "failed" }, T0 + 60_000);
  d.count({ event: "op_0", outcome: "ok" }, T0 + H + 60_000); // a name already kept stays its own
  d.count({ event: "op_new", outcome: "ok" }, T0 + H + 60_000);
  d.count({ event: "op_new", outcome: "ok" }, Date.parse("2026-11-05T00:30:00Z")); // a new day keeps names again
  await d.flush();
  const [ten, eleven] = readLines(dir, "hourly-2026-11.jsonl");
  assert.equal(ten.ops.length, MAX_NAMED_OPS + 1);
  assert.deepEqual(ten.ops.find((c: any) => c.op === OVERFLOW_OP), { op: OVERFLOW_OP, ok: 0, failed: 2, unknown: 0 });
  assert.equal(ten.total.failed, MAX_NAMED_OPS + 2, "their counts kept");
  assert.deepEqual(eleven.ops.map((c: any) => c.op), ["op_0", OVERFLOW_OP]);
  const daily = readLines(dir, "daily-2026-11.jsonl");
  assert.equal(daily[0].ops.length, MAX_NAMED_OPS + 1, "the day's line validates: 4096 operations");
});
