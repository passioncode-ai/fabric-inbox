import { test } from "node:test";
import assert from "node:assert/strict";
import { storeInboundAttachments, INBOUND_MAX_ATTACHMENTS, INBOUND_WRITES_AT_ONCE } from "../workers/lib/inbound-attachments";

test("B-34: an incoming message's files are written a few at a time, keep their ids, and stop at the cap", async () => {
  let inFlight = 0, most = 0;
  const keys: string[] = [];
  const bucket = { put: async (key: string) => { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 2)); keys.push(key); inFlight--; return null as never; } };
  const parts = Array.from({ length: INBOUND_MAX_ATTACHMENTS + 7 }, (_, i) => ({ filename: `f${i}.txt`, mimeType: "text/plain", content: new Uint8Array(i + 1) }));
  const out = await storeInboundAttachments(bucket, "incoming-x", parts, (n) => String(n));
  assert.equal(out.stored.length, INBOUND_MAX_ATTACHMENTS);
  assert.equal(out.dropped, 7);
  assert.equal(keys.length, INBOUND_MAX_ATTACHMENTS, "nothing past the cap is written");
  assert.ok(most <= INBOUND_WRITES_AT_ONCE && most > 1, `at most ${INBOUND_WRITES_AT_ONCE} at once, and more than one (${most})`);
  assert.deepEqual(out.stored[3], { id: "incoming-x-3", email_id: "incoming-x", filename: "f3.txt", mimetype: "text/plain", size: 4, content_id: null, disposition: "attachment" },
    "the same ids and metadata as before");
  assert.ok(keys.includes("attachments/incoming-x/incoming-x-3/f3.txt"));
  const none = await storeInboundAttachments(bucket, "incoming-y", [], (n) => String(n));
  assert.deepEqual(none, { stored: [], dropped: 0 });
});
