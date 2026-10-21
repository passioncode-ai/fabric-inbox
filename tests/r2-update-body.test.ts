// B-78 (adjacent): every R2 object the server reads, changes and writes back conditionally. A body
// that cannot be read must stop the write; reading it as "nothing stored" would replace the object
// (its etag still matches) with an empty one plus the change — every agent key, spam rule, discard
// rule, relay, hidden address or creation time gone. A body that is not JSON stays what it was:
// the normalised default, so a damaged object can still be repaired by the next change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeBucket } from "./fake-r2";
import { bodyForUpdate } from "../workers/lib/r2-json";
import { updateDiscardStore } from "../workers/discard/store";
import { updateSpamLists } from "../workers/spam/lists";
import { updateAgentKeys } from "../workers/mcp/keys";
import { updateRelays } from "../workers/relay/install";
import { changeHidden } from "../workers/lib/hidden-accounts";
import { recordCreated } from "../workers/lib/address-created";

/** A bucket whose stored body breaks when read once `broken` is set (a stream already read, a reset). */
function breakable() {
  const bucket = fakeBucket();
  const state = { broken: false };
  const get = bucket.get.bind(bucket);
  bucket.get = async (key: string) => {
    const o = await get(key);
    if (!o || !state.broken) return o;
    const fail = async () => { throw new TypeError("Body is unusable: Body has already been read"); };
    return { ...o, json: fail, text: fail };
  };
  return { bucket, state };
}

test("bodyForUpdate: JSON is parsed, a damaged body is null, an unreadable body throws", async () => {
  assert.deepEqual(await bodyForUpdate({ text: async () => '{"a":1}' }), { a: 1 });
  assert.equal(await bodyForUpdate({ text: async () => "{not json" }), null);
  await assert.rejects(bodyForUpdate({ text: async () => { throw new TypeError("Body is unusable"); } }), /Body is unusable/);
});

const stores: [string, string, (b: R2Bucket) => Promise<unknown>][] = [
  ["discard rules", "config/discard.json", (b) => updateDiscardStore(b, (s) => ({ ...s, allowed: [...s.allowed, "new@example.org"] }))],
  ["spam lists", "config/spam.json", (b) => updateSpamLists(b, (l) => ({ ...l, blockedDomains: [...l.blockedDomains, "new.example.org"] }))],
  ["agent keys", "config/agent-keys.json", (b) => updateAgentKeys(b, (k) => k)],
  ["relays", "config/relays.json", (b) => updateRelays(b, (r) => r)],
  ["hidden addresses", "config/hidden-accounts.json", (b) => changeHidden(b, { hide: ["cloudflare:new@example.org"] })],
  ["address creation times", "config/address-created.json", (b) => recordCreated(b, "new@example.org", 1)],
];

for (const [name, key, update] of stores) {
  test(`${name}: an unreadable stored body stops the write and leaves the object as it was`, async () => {
    const { bucket, state } = breakable();
    const before = JSON.stringify({ kept: "what was there" });
    bucket.objects.set(key, { value: before, etag: "v0" });
    state.broken = true;
    await assert.rejects(update(bucket as unknown as R2Bucket), /Body is unusable/);
    assert.equal(bucket.objects.get(key)?.value, before, "nothing replaced what could not be read");
  });
}

test("B-33: a field a newer version added to the spam lists survives a change made by this version", async () => {
  const bucket = fakeBucket();
  await bucket.put("config/spam.json", JSON.stringify({ blockedSenders: [], blockedDomains: [], allowedSenders: [], allowedDomains: [], futureRules: [{ x: 1 }] }));
  await updateSpamLists(bucket as unknown as R2Bucket, (l) => ({ ...l, blockedDomains: [...l.blockedDomains, "new.example.org"] }));
  const stored = JSON.parse(await (await bucket.get("config/spam.json"))!.text());
  assert.deepEqual(stored.futureRules, [{ x: 1 }]);
  assert.deepEqual(stored.blockedDomains, ["new.example.org"]);
});
