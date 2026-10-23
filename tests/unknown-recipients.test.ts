import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeBucket } from "./fake-r2";
import { recordUnknownRecipient, unknownRecipientKey, UNKNOWN_PER_DOMAIN, UNKNOWN_STALE_MS } from "../workers/lib/unknown-recipients";

const read = async (bucket: ReturnType<typeof fakeBucket>, address: string) => (await bucket.get(unknownRecipientKey(address)))?.json();

test("B-10: deliveries to one unknown address at the same time each count, none is lost", async () => {
  const bucket = fakeBucket();
  const results = await Promise.all(Array.from({ length: 6 }, () => recordUnknownRecipient(bucket as never, "sales@project.invalid", "rejected")));
  assert.deepEqual(results, Array(6).fill("counted"));
  const row = await read(bucket, "sales@project.invalid");
  assert.equal(row.count, 6);
  assert.equal(row.domain, "project.invalid");
  assert.deepEqual(Object.keys(row).sort(), ["action", "address", "count", "domain", "firstSeen", "lastSeen"], "no sender, subject or body is kept");
});

test("B-10: a domain keeps at most its share; a full domain of recent addresses refuses a new one but still counts the known", async () => {
  let now = new Date("2026-10-23T10:00:00Z");
  const bucket = fakeBucket(() => now);
  for (let i = 0; i < UNKNOWN_PER_DOMAIN; i++) await recordUnknownRecipient(bucket as never, `a${i}@project.invalid`, "rejected", now);
  assert.equal(await recordUnknownRecipient(bucket as never, "new@project.invalid", "rejected", now), "capped");
  assert.equal(await read(bucket, "new@project.invalid"), undefined);
  assert.equal(await recordUnknownRecipient(bucket as never, "a7@project.invalid", "rejected", now), "counted", "a known address still counts");
  assert.equal((await read(bucket, "a7@project.invalid")).count, 2);
  assert.equal(await recordUnknownRecipient(bucket as never, "x@other.invalid", "rejected", now), "counted", "another domain has its own share");
});

test("B-10: at the cap, the address seen longest ago gives way once it is older than the stale window", async () => {
  let now = new Date("2026-09-01T10:00:00Z");
  const bucket = fakeBucket(() => now);
  await recordUnknownRecipient(bucket as never, "old@project.invalid", "rejected", now);
  now = new Date(now.getTime() + UNKNOWN_STALE_MS + 60_000);
  for (let i = 1; i < UNKNOWN_PER_DOMAIN; i++) await recordUnknownRecipient(bucket as never, `a${i}@project.invalid`, "rejected", now);
  assert.equal(await recordUnknownRecipient(bucket as never, "new@project.invalid", "catch_all", now), "counted");
  assert.equal(await read(bucket, "old@project.invalid"), undefined, "the stale one made room");
  assert.equal((await read(bucket, "new@project.invalid")).action, "catch_all");
});
