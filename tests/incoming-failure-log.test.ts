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

test("the Email Routing entry point logs a failure with it, then rethrows", () => {
  const worker = readFileSync("workers/index.ts", "utf8");
  const handler = worker.slice(worker.indexOf("async function handleIncomingEmail"));
  assert.match(handler, /catch \(e\) \{[\s\S]*?console\.error\(JSON\.stringify\(incomingFailure\(event, e\)\)\);\s*throw e;/);
  assert.doesNotMatch(worker, /Failed to process incoming email/, "the unstructured line is gone");
});
