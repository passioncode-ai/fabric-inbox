import test from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_KEY,
  DRAFT_PREFIX,
  DraftStore,
  type Draft,
  type Exclusive,
} from "../app/components/inbox/draft-store";
class MemoryStorage {
  rows = new Map<string, string>();
  blocked = false;
  get length() {
    return this.rows.size;
  }
  key(i: number) {
    return [...this.rows.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.rows.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.blocked) throw new Error("quota");
    this.rows.set(k, v);
  }
}
function fixture() {
  const storage = new MemoryStorage();
  const queues = new Map<string, Promise<unknown>>();
  const exclusive: Exclusive = (name, run) => {
    const next = (queues.get(name) ?? Promise.resolve()).then(run);
    queues.set(
      name,
      next.catch(() => {}),
    );
    return next;
  };
  return {
    storage,
    store: new DraftStore(storage, exclusive),
    tab: () => new DraftStore(storage, exclusive),
  };
}
const draft = (id: string): Draft => ({
  id,
  mode: "reply",
  accountId: "gmail:a",
  to: "to@example.com",
  subject: id,
  text: "Message",
  idempotencyKey: "attempt-" + id,
  originalId: "original",
  threadId: "thread",
  inReplyTo: "<message>",
  references: "<ancestor>",
});
test("multiple drafts and locked attempts survive restart with context and independent identity", async () => {
  const { store, tab } = fixture();
  const a = await store.save(draft("a"));
  await store.lock(a);
  await store.save({
    ...draft("b"),
    accountId: "cloudflare:b",
    mode: "forward",
  });
  const reopened = tab();
  assert.equal(reopened.list().drafts.length, 2);
  assert.deepEqual(reopened.open("a"), { ...a, locked: true });
  assert.equal(reopened.open("b").accountId, "cloudflare:b");
  assert.notEqual(a.id, a.idempotencyKey);
});
test("acceptance removes only matching draft; tombstones refuse stale resurrection", async () => {
  const { store, tab } = fixture();
  const a = await store.save(draft("a"));
  const stale = tab();
  stale.open("a");
  await store.save(draft("b"));
  const fixed = await store.lock(a);
  await store.settle(fixed, "accepted");
  assert.deepEqual(
    store.list().drafts.map((d) => d.id),
    ["b"],
  );
  await assert.rejects(stale.save(a), /another window/);
  await assert.rejects(store.save(a), /another window/);
});
test("legacy migration preserves source bytes, strips extra fields and never resurrects settled attempts", async () => {
  const { storage, store, tab } = fixture();
  const legacy = {
    ...draft("ignored"),
    locked: true,
    attachments: ["not migrated"],
    token: "not migrated",
  };
  const raw = JSON.stringify(legacy);
  storage.setItem(DRAFT_KEY, raw);
  await store.migrate();
  const [d] = store.list().drafts;
  assert.equal(d.id, "legacy:attempt-ignored");
  assert.equal(d.idempotencyKey, legacy.idempotencyKey);
  assert.equal((d as any).token, undefined);
  assert.equal((d as any).attachments, undefined);
  store.open(d.id);
  await store.settle(d, "accepted");
  await tab().migrate();
  assert.equal(store.list().drafts.length, 0);
  assert.equal(storage.getItem(DRAFT_KEY), raw);
});
test("malformed legacy and collection rows remain byte-for-byte recoverable", async () => {
  const { storage, store } = fixture();
  storage.setItem(DRAFT_KEY, '{"locked":true');
  storage.setItem(DRAFT_PREFIX + "bad", '{"version":99}');
  await assert.rejects(store.migrate());
  await store.save(draft("new"));
  assert.equal(store.list().unreadable, true);
  assert.equal(store.list().drafts.length, 1);
  assert.equal(storage.getItem(DRAFT_KEY), '{"locked":true');
  assert.equal(storage.getItem(DRAFT_PREFIX + "bad"), '{"version":99}');
});
test("storage quota failure never provides persisted send recovery", async () => {
  const { storage, store, tab } = fixture();
  const a = await store.save(draft("a"));
  storage.blocked = true;
  await assert.rejects(store.lock(a), /quota/);
  assert.equal(tab().open("a").locked, undefined);
  await assert.rejects(store.save({ ...a, text: "unsaved" }), /quota/);
  assert.equal(tab().open("a").text, "Message");
});
test("concurrent different drafts merge and same-draft stale writes are refused", async () => {
  const { store, tab } = fixture();
  const second = tab();
  await Promise.all([store.save(draft("a")), second.save(draft("b"))]);
  const a = store.open("a"),
    other = second.open("a");
  const results = await Promise.allSettled([
    store.save({ ...a, text: "one" }),
    second.save({ ...other, text: "two" }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(tab().open("a").text, "one");
  assert.equal(tab().open("b").text, "Message");
});
test("edit racing with send cannot change the persisted locked payload", async () => {
  const { store, tab } = fixture();
  const a = await store.save(draft("a"));
  const second = tab();
  const other = second.open("a");
  const results = await Promise.allSettled([
    store.lock(a),
    second.save({ ...other, text: "changed" }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(tab().open("a").text, "Message");
  assert.equal(tab().open("a").locked, true);
});
test("edit winning the race prevents send with stale content", async () => {
  const { store, tab } = fixture();
  const a = await store.save(draft("a"));
  const second = tab();
  const other = second.open("a");
  await second.save({ ...other, text: "changed" });
  await assert.rejects(store.lock(a), /another window/);
  assert.equal(tab().open("a").locked, undefined);
});
test("locked attempts cannot be edited or discarded and retry keeps recovery key", async () => {
  const { store, tab } = fixture();
  const a = await store.save(draft("a"));
  await store.lock(a);
  const restart = tab();
  const locked = restart.open("a");
  await assert.rejects(
    restart.save({ ...locked, locked: false }),
    /another window/,
  );
  await assert.rejects(restart.discard("a"), /uncertain send/);
  const retry = await restart.lock(locked);
  assert.equal(retry.idempotencyKey, a.idempotencyKey);
  await assert.rejects(
    restart.settle({ ...retry, idempotencyKey: "wrong" }, "accepted"),
  );
});
test("definite failure rotates send identity only; late callbacks cannot settle the new attempt", async () => {
  const { store } = fixture();
  const a = await store.save(draft("a"));
  const fixed = await store.lock(a);
  const editable = await store.settle(fixed, "failed");
  assert.equal(editable?.id, a.id);
  assert.notEqual(editable?.idempotencyKey, a.idempotencyKey);
  const next = await store.lock(editable!);
  await assert.rejects(store.settle(fixed, "accepted"), /another window/);
  assert.equal(store.open("a").idempotencyKey, next.idempotencyKey);
});
test("discard is per-draft and unsupported serialization fails closed", async () => {
  const { store, storage } = fixture();
  await store.save(draft("a"));
  await store.save(draft("b"));
  await store.discard("a");
  assert.deepEqual(
    store.list().drafts.map((d) => d.id),
    ["b"],
  );
  const unavailable = new DraftStore(storage, async () => {
    throw new Error("unsupported");
  });
  await assert.rejects(unavailable.save(draft("c")), /unsupported/);
  assert.equal(store.list().drafts.length, 1);
});

test("queued saves cannot overwrite a lock or resurrect an accepted draft", async () => {
  const { store } = fixture();
  const a = await store.save(draft("a"));
  const [locked, edited] = await Promise.allSettled([
    store.lock(a),
    store.save({ ...a, text: "late edit" }),
  ]);
  assert.equal(locked.status, "fulfilled");
  assert.equal(edited.status, "rejected");
  const fixed = store.open("a");
  const [accepted, stale] = await Promise.allSettled([
    store.settle(fixed, "accepted"),
    store.save(a),
  ]);
  assert.equal(accepted.status, "fulfilled");
  assert.equal(stale.status, "rejected");
  assert.equal(store.list().drafts.length, 0);
});

test("failed persistence of provider result retains immutable recovery after restart", async () => {
  const { store, storage, tab } = fixture();
  const fixed = await store.lock(await store.save(draft("a")));
  storage.blocked = true;
  await assert.rejects(store.settle(fixed, "accepted"), /quota/);
  await assert.rejects(store.settle(fixed, "failed"), /quota/);
  assert.equal(tab().open("a").locked, true);
  assert.equal(tab().open("a").idempotencyKey, fixed.idempotencyKey);
});
