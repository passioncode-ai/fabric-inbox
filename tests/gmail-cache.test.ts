import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory-store";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, configuration } from "../workers/providers/google-oauth";

/**
 * P0-2: a large Gmail cache must never make an account vanish. The feed reads a date index and
 * stored counters instead of scanning every key; bodies live under their own prefix and leave
 * with their message; caches of the first layout move over once, resumably, losing nothing.
 */
const configEnv = {
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const inbox = { folder: "inbox" as const, query: "", limit: 50 };

async function fixture(http: typeof fetch = async () => { throw new Error("no network in this test"); }, sync: AccountRecord["sync"] = { mode: "history", historyId: "10", generation: "g1" }) {
  const store = new MemoryStore();
  const config = configuration(configEnv);
  if (config.status !== "configured") throw new Error();
  await store.put<AccountRecord>("account:a", {
    id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000 }),
    sync,
  });
  return { store, service: new AccountService(store, configEnv, http) };
}
/** A row and its body as the first layout (before 0.11) stored them. */
function legacyRow(store: MemoryStore, id: string, over: { timestamp?: number; labels?: string[]; read?: boolean; generation?: string; body?: string } = {}) {
  const blobId = "blob-" + id;
  store.data.set("message:a:" + id, {
    message: { id: "a:" + id, accountId: "a", providerMessageId: id, threadId: id, subject: "Subject " + id, from: "x@example.invalid",
      to: "a@example.invalid", cc: "", replyTo: "", date: "", rfcMessageId: "", references: "", timestamp: over.timestamp ?? 1000,
      snippet: "", read: over.read ?? true, archived: false, labels: over.labels ?? ["INBOX"], attachments: [] },
    parts: 1, blobId, generation: over.generation ?? "g1",
  });
  store.data.set(`message:a:${id}:body:${blobId}:0`, JSON.stringify({ text: over.body ?? "body " + id, html: "" }));
}

test("a 25,000-message cache lists its newest page and counts it without scanning every key (P0-2)", async () => {
  const { service, store } = await fixture();
  const n = 25_000;
  for (let i = 0; i < n; i++)
    legacyRow(store, "m" + String(i).padStart(6, "0"), { timestamp: 1_000_000 + i * 1000, read: i % 7 !== 0, labels: i % 5 === 0 ? [] : ["INBOX"] });
  // The alarm moves a cache of the first layout over in the background; a read gives it a few seconds.
  let migrations = 0;
  while (!(await service.migrateCache("a", 2_000))) migrations++;
  assert.ok(migrations < 20);
  const page = await service.listInboxMessages("a", inbox);
  assert.equal(page.length, 51, "a full page and one more to say there is more");
  assert.equal(page[0].providerMessageId, "m024999", "the newest inbox message first");
  assert.ok(page.every((m, i) => i === 0 || m.timestamp <= page[i - 1].timestamp));
  assert.deepEqual(await service.countInbox("a"), { total: n - n / 5, unread: [...Array(n).keys()].filter((i) => i % 7 === 0 && i % 5 !== 0).length });
  const listed = store.ops.listed;
  const older = await service.listInboxMessages("a", { ...inbox, before: page[49] });
  assert.equal(older[0].providerMessageId, page[50].providerMessageId, "the next page starts right after the cursor");
  assert.ok(store.ops.listed - listed < 200, `a page reads about a page of rows, not the cache (${store.ops.listed - listed})`);
  const unread = await service.listInboxMessages("a", { ...inbox, unread: true });
  assert.ok(unread.length === 51 && unread.every((m) => !m.read), "unread-only reads its own index");
});

test("deleting a message takes its body chunks with it, including chunks a failed save left behind (P0-2)", async () => {
  let gone = false;
  let history = 0;
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/history")) return json({ historyId: String(20 + history++), history: [{ messages: [{ id: "one" }] }] });
    if (gone) return json({ error: { code: 404 } }, 404);
    return json({ id: "one", threadId: "t", labelIds: ["INBOX", "UNREAD"], payload: { mimeType: "text/plain", body: { data: Buffer.from("x".repeat(60000)).toString("base64url") } } });
  });
  await service.sync("a");
  // A second save writes its new chunks, then fails before its row: the new chunks are orphans.
  const put = store.put.bind(store);
  store.put = async (key, value) => { if (key.startsWith("message:a:one")) throw new Error("storage failed"); await put(key, value); };
  await assert.rejects(service.sync("a"));
  store.put = put;
  const account = (await store.get<AccountRecord>("account:a"))!;
  account.retryAt = 0;
  await store.put("account:a", account);
  gone = true;
  await service.sync("a");
  assert.deepEqual([...store.data.keys()].filter((k) => k.includes(":one")), [], "no row, chunk or index entry of the deleted message is left");
  assert.deepEqual(await service.countInbox("a"), { unread: 0, total: 0 });
});

test("counters and the index follow every change of a message (P0-2)", async () => {
  let labels = ["INBOX", "UNREAD"];
  let history = 0;
  const { service } = await fixture(async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/history")) return json({ historyId: String(20 + history++), history: [{ messagesAdded: [{ message: { id: "m1" } }] }] });
    if (u.pathname.endsWith("/modify")) {
      const body = JSON.parse(String(init?.body));
      labels = [...labels.filter((l) => !body.removeLabelIds.includes(l)), ...body.addLabelIds];
    }
    return json({ id: "m1", threadId: "m1", internalDate: "5000", labelIds: labels, payload: { headers: [{ name: "Subject", value: "Hi" }] } });
  });
  await service.sync("a");
  assert.deepEqual(await service.countInbox("a"), { unread: 1, total: 1 });
  assert.equal((await service.listInboxMessages("a", { ...inbox, unread: true })).length, 1);
  await service.setRead("a", "m1", true);
  assert.deepEqual(await service.countInbox("a"), { unread: 0, total: 1 });
  assert.equal((await service.listInboxMessages("a", { ...inbox, unread: true })).length, 0);
  await service.archive("a", "m1");
  assert.deepEqual(await service.countInbox("a"), { unread: 0, total: 0 });
  assert.equal((await service.listInboxMessages("a", inbox)).length, 0);
  assert.deepEqual((await service.listInboxMessages("a", { ...inbox, folder: "archive" })).map((m) => m.providerMessageId), ["m1"]);
  await service.setStarred("a", "m1", true);
  assert.deepEqual((await service.listInboxMessages("a", { ...inbox, folder: "starred" })).map((m) => m.providerMessageId), ["m1"]);
});

test("a first-layout cache moves over once, resumably, never losing or double-counting mail (P0-2)", async () => {
  const { service, store } = await fixture();
  for (let i = 0; i < 260; i++) legacyRow(store, "k" + String(i).padStart(4, "0"), { timestamp: 10_000 + i, read: i % 3 !== 0 });
  // Rows the first layout already hid (an earlier import's leftovers) and a chunk of a replaced body.
  legacyRow(store, "old", { generation: "g0" });
  store.data.set("message:a:k0001:body:replaced-blob:0", "stale");
  const expected = { total: 260, unread: [...Array(260).keys()].filter((i) => i % 3 === 0).length };
  // Interrupted twice: one batch commits, then a write fails mid-batch and that batch rolls back.
  assert.equal(await service.migrateCache("a", 0), false, "one batch, not done");
  const put = store.put.bind(store);
  let writes = 0;
  store.put = async (key, value) => { if (key.startsWith("idx:") && ++writes === 30) throw new Error("process restarted"); await put(key, value); };
  await assert.rejects(service.migrateCache("a", 0));
  store.put = put;
  // Mid-migration the old read still answers, from both layouts at once.
  assert.deepEqual(await service.cache.legacyCounts("a", (row) => row.generation === "g1"), expected);
  while (!(await service.migrateCache("a", 0)));
  assert.equal(await service.migrateCache("a", 0), true, "a finished migration is not run again");
  assert.deepEqual(await service.countInbox("a"), expected, "nothing counted twice");
  assert.equal([...store.data.keys()].filter((k) => /^message:a:[^:]+:body:/.test(k)).length, 0, "no chunk left under the old key");
  assert.equal(store.data.has("message:a:old"), false, "a hidden leftover is dropped");
  assert.equal([...store.data.keys()].some((k) => k.includes("replaced-blob")), false, "an orphan chunk is dropped");
  for (const id of ["k0000", "k0001", "k0259"]) assert.equal((await service.getMessage("a", id)).text, "body " + id, "every body survives");
  const all: string[] = [];
  let before;
  for (;;) {
    const page = await service.listInboxMessages("a", { ...inbox, limit: 100, before });
    all.push(...page.slice(0, 100).map((m) => m.providerMessageId));
    if (page.length <= 100) break;
    before = page[99];
  }
  assert.equal(all.length, 260, "every message is in the index once");
  assert.equal(new Set(all).size, 260);
});
