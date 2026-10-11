// SCN-025, B12-03: when an incoming message can be neither rejected nor stored, the Worker's log
// keeps whom it was for and when, structured, and nothing of its content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { incomingFailure } from "../workers/incoming-log";

const AT = new Date("2026-10-07T14:30:05.000Z");

test("the last-resort record names the recipient and the time, as one JSON line", () => {
  const record = incomingFailure({ to: " Hello@Project.Example ", rawSize: 2048 }, new Error("storage unavailable"), AT);
  assert.equal(record.event, "incoming_failed");
  assert.equal(record.to, "hello@project.example", "the envelope recipient, lower-cased");
  assert.equal(record.at, "2026-10-07T14:30:05.000Z");
  assert.equal(record.size, 2048);
  assert.equal(record.error, "storage unavailable");
  assert.match(record.stack ?? "", /^Error: storage unavailable/);
  const line = JSON.stringify(record);
  assert.deepEqual(JSON.parse(line), record, "one parseable line");
});

test("it never carries the sender, subject or body, and cuts the failure short", () => {
  const event = { to: "a@project.example", from: "sender@outside.example", rawSize: 10, subject: "Secret plans", body: "the body" };
  const record = incomingFailure(event, new Error("x".repeat(2000)), AT);
  const line = JSON.stringify(record);
  for (const leaked of ["sender@outside.example", "Secret plans", "the body"]) assert.ok(!line.includes(leaked), leaked);
  assert.deepEqual(Object.keys(record).sort(), ["at", "error", "event", "size", "stack", "to"]);
  assert.equal(record.error.length, 300);
  assert.ok((record.stack ?? "").length <= 800);
});

test("an event without an envelope or a thrown non-error still makes an honest record", () => {
  const record = incomingFailure({}, "boom", AT);
  assert.deepEqual(record, { event: "incoming_failed", to: null, at: "2026-10-07T14:30:05.000Z", size: null, error: "boom" });
  assert.equal(incomingFailure({ to: "  " }, undefined, AT).to, null);
  assert.equal(incomingFailure({}, undefined, AT).error, "unknown error");
});

test("the Email Routing entry point logs a failure with it, keeps it for the owner, then rethrows", () => {
  const worker = readFileSync("workers/index.ts", "utf8");
  const handler = worker.slice(worker.indexOf("async function handleIncomingEmail"));
  assert.match(handler, /catch \(e\) \{[\s\S]*?const failure = incomingFailure\(event, e\);\s*console\.error\(JSON\.stringify\(failure\)\);\s*await recordIncomingFailure\(env\.BUCKET, failure\);\s*throw e;/, "logged, kept for the owner (B-40), then rethrown");
  assert.doesNotMatch(worker, /Failed to process incoming email/, "the unstructured line is gone");
});

// B-40: the failure is kept where the owner sees it, not only in the Worker's log.
import { clearIncomingFailures, listIncomingFailures, recordIncomingFailure, KEEP } from "../workers/incoming-log";

function fakeBucket() {
  const items = new Map<string, string>();
  return {
    items,
    async put(key: string, value: string) { items.set(key, value); },
    async get(key: string) { const v = items.get(key); return v === undefined ? null : { json: async () => JSON.parse(v) }; },
    async list({ prefix, limit }: { prefix: string; limit?: number }) {
      const keys = [...items.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: keys.slice(0, limit ?? 1000).map((key) => ({ key })) };
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) items.delete(k); },
  };
}

test("a failure is kept for the owner without its stack, newest first, the last 50 only (B-40)", async () => {
  const bucket = fakeBucket();
  for (let i = 0; i < KEEP + 3; i++) {
    await recordIncomingFailure(bucket as never, incomingFailure({ to: `a${i}@example.com`, rawSize: 10 }, new Error(`boom ${i}`), new Date(Date.UTC(2026, 9, 1, 0, i))));
  }
  const kept = await listIncomingFailures(bucket as never);
  assert.equal(kept.length, KEEP);
  assert.equal(kept[0]!.to, `a${KEEP + 2}@example.com`, "newest first");
  assert.equal(kept.at(-1)!.to, "a3@example.com", "the oldest beyond 50 are gone");
  assert.ok(kept.every((f) => !("stack" in f) && !("event" in f)), "the stack stays in the log only");
});

test("clearing removes one domain's failures, or all (B-40)", async () => {
  const bucket = fakeBucket();
  for (const to of ["x@one.example", "y@two.example", "z@one.example"]) await recordIncomingFailure(bucket as never, incomingFailure({ to }, new Error("e")));
  assert.equal(await clearIncomingFailures(bucket as never, "one.example"), 2);
  assert.deepEqual((await listIncomingFailures(bucket as never)).map((f) => f.to), ["y@two.example"]);
  assert.equal(await clearIncomingFailures(bucket as never), 1);
  assert.deepEqual(await listIncomingFailures(bucket as never), []);
});

test("a storage failure while recording never replaces the delivery's own error (B-40)", async () => {
  const broken = { put: async () => { throw new Error("R2 down"); }, list: async () => ({ objects: [] }), delete: async () => {} };
  await recordIncomingFailure(broken as never, incomingFailure({ to: "a@b.example" }, new Error("e")));
});
