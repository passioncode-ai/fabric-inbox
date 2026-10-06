import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory-store";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, configuration } from "../workers/providers/google-oauth";
import { ProviderError } from "../workers/providers/gmail-client";

const configEnv = {
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });

async function fixture(http: typeof fetch, sync: AccountRecord["sync"] = { mode: "history", historyId: "10" }, expiresAt = Date.now() + 3600000) {
  const store = new MemoryStore();
  const config = configuration(configEnv);
  if (config.status !== "configured") throw new Error();
  await store.put<AccountRecord>("account:a", {
    id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "access", refreshToken: "refresh", expiresAt }),
    sync,
  });
  return { store, service: new AccountService(store, configEnv, http) };
}

// ── P2-9: only a revoked grant disconnects; everything else backs off ─────────────

test("a Gmail 401 that a fresh token does not cure backs off; it does not disconnect the account (P2-9)", async () => {
  let tokenCalls = 0;
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth2.googleapis.com") { tokenCalls++; return json({ access_token: "fresh", expires_in: 3600 }); }
    return json({ error: { code: 401 } }, 401);
  });
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "provider_auth_failed");
  const account = (await store.get<AccountRecord>("account:a"))!;
  assert.equal(tokenCalls, 1, "one forced refresh, then the request is retried once");
  assert.equal(account.status, "error");
  assert.equal(account.error, "provider_auth_failed");
  assert.ok(account.retryAt && account.retryAt > Date.now(), "it waits and tries again");
});

test("only invalid_grant from Google's token endpoint asks for a reconnect (P2-9)", async () => {
  const { service, store } = await fixture(async () => json({ error: "invalid_grant" }, 400), undefined, 0);
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "reconnect_required");
  assert.equal((await store.get<AccountRecord>("account:a"))!.status, "reconnect_required");
});

test("a token endpoint answering 5xx with an HTML page is a transient outage, not sync_failed (P2-9)", async () => {
  const { service, store } = await fixture(async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }), undefined, 0);
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "provider_unavailable");
  const account = (await store.get<AccountRecord>("account:a"))!;
  assert.equal(account.status, "error");
  assert.equal(account.error, "provider_unavailable");
});

test("a Gmail answer that is not JSON is a provider failure with its own code (P2-9)", async () => {
  const { service, store } = await fixture(async () => new Response("<html>oops</html>", { status: 200 }));
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "provider_failed");
  assert.equal((await store.get<AccountRecord>("account:a"))!.error, "provider_failed");
});

// ── A small Gmail: a mailbox, its history, and the four reads sync makes ─────────────

interface FakeMessage { id: string; labels: string[]; date: number; subject: string; body: string }
export class FakeGmail {
  messages = new Map<string, FakeMessage>();
  history: { id: number; added?: string; deleted?: string }[] = [];
  historyId = 100;
  requests: string[] = [];
  /** Ids whose get fails with 500, and how many more times. */
  failing = new Map<string, number>();
  constructor(count = 0, now = Date.now()) {
    for (let i = 0; i < count; i++) {
      const id = "old" + String(i).padStart(5, "0");
      // Every tenth one is recent and in the inbox; of the rest, every third is in the inbox.
      const recent = i % 10 === 0;
      this.messages.set(id, { id, labels: i % 3 === 0 || recent ? ["INBOX"] : [], date: recent ? now - 86_400_000 - i : now - 90 * 86_400_000 - i, subject: "Old " + i, body: "body " + id });
    }
  }
  deliver(id: string, labels = ["INBOX", "UNREAD"]) {
    this.messages.set(id, { id, labels, date: Date.now(), subject: "New " + id, body: "body " + id });
    this.history.push({ id: ++this.historyId, added: id });
  }
  fetch = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(String(input));
    this.requests.push(u.pathname.replace("/gmail/v1/users/me/", "") + u.search);
    if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "fresh", expires_in: 3600 });
    const path = u.pathname.replace("/gmail/v1/users/me/", "");
    if (path === "profile") return json({ emailAddress: "a@example.invalid", historyId: String(this.historyId), messagesTotal: this.messages.size });
    if (path === "history") {
      const start = Number(u.searchParams.get("startHistoryId"));
      const items = this.history.filter((h) => h.id > start);
      return json({ historyId: String(this.historyId), history: items.map((h) => h.added ? { messagesAdded: [{ message: { id: h.added } }] }
        : { messagesDeleted: [{ message: { id: h.deleted! } }] }) });
    }
    if (path === "messages") {
      const labels = u.searchParams.getAll("labelIds");
      const recentOnly = u.searchParams.get("q") === "newer_than:30d";
      const all = [...this.messages.values()]
        .filter((m) => labels.every((l) => m.labels.includes(l)) && (!recentOnly || m.date > Date.now() - 30 * 86_400_000))
        .sort((a, b) => b.date - a.date);
      const size = Number(u.searchParams.get("maxResults"));
      const from = Number(u.searchParams.get("pageToken") || 0);
      const page = all.slice(from, from + size);
      return json({ messages: page.map((m) => ({ id: m.id })), ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}) });
    }
    const id = path.split("/")[1];
    const left = this.failing.get(id);
    if (left) { this.failing.set(id, left - 1); return json({ error: { code: 500 } }, 500); }
    const m = this.messages.get(id);
    if (!m) return json({ error: { code: 404 } }, 404);
    const full = u.searchParams.get("format") !== "metadata";
    return json({ id, threadId: id, internalDate: String(m.date), labelIds: m.labels, snippet: m.subject,
      payload: { headers: [{ name: "Subject", value: m.subject }], ...(full ? { mimeType: "text/plain", body: { data: Buffer.from(m.body).toString("base64url") } } : {}) } });
  };
}
const unblock = async (store: MemoryStore) => {
  const a = (await store.get<AccountRecord>("account:a"))!;
  a.retryAt = 0;
  await store.put("account:a", a);
};

// ── P0-1: history from the start; the recent inbox first, the rest headers-only ────

test("new mail reaches the cache on the next sync while a large mailbox is still importing (P0-1)", async () => {
  const gmail = new FakeGmail(600);
  const { service, store } = await fixture(gmail.fetch, { mode: "initial" });
  await service.sync("a"); // the import records Gmail's historyId before listing anything
  assert.equal((await store.get<AccountRecord>("account:a"))!.sync.historyId, "100");
  await service.sync("a");
  gmail.deliver("fresh");
  await service.sync("a");
  const account = (await store.get<AccountRecord>("account:a"))!;
  assert.equal(account.sync.mode, "initial", "the import is not finished");
  const page = await service.listInboxMessages("a", { folder: "inbox", query: "", limit: 5 });
  assert.equal(page[0].providerMessageId, "fresh", "yet the new message is at the top of the inbox");
  assert.equal((await store.list({ prefix: "pending:event:a:fresh" })).size, 1, "and its automations are queued");
});

test("the import reads the last 30 days of the inbox in full first, then the rest headers-only (P0-1)", async () => {
  const gmail = new FakeGmail(300);
  const { service, store } = await fixture(gmail.fetch, { mode: "initial" });
  await service.sync("a", { deadline: Date.now() + 60_000 });
  const lists = gmail.requests.filter((r) => r.startsWith("messages?"));
  assert.match(lists[0], /labelIds=INBOX/);
  assert.match(lists[0], /q=newer_than%3A30d/);
  assert.match(lists.at(-1)!, /includeSpamTrash=true/);
  const fulls = gmail.requests.filter((r) => /^messages\/[^?]+\?format=full/.test(r)).length;
  const metas = gmail.requests.filter((r) => /^messages\/[^?]+\?format=metadata/.test(r)).length;
  assert.equal(fulls, 30, "every recent inbox message in full");
  assert.equal(metas, 270, "every other message once, headers only; recent ones are not fetched again");
  const account = (await store.get<AccountRecord>("account:a"))!;
  assert.equal(account.sync.mode, "history");
  assert.equal(account.status, "connected");
  const inInbox = [...gmail.messages.values()].filter((m) => m.labels.includes("INBOX")).length;
  assert.equal((await service.countInbox("a")).total, inInbox);
  // An older message's body is read from Gmail when it is first opened, then from the cache.
  const before = gmail.requests.length;
  assert.equal((await service.getMessage("a", "old00001")).text, "body old00001");
  assert.equal((await service.getMessage("a", "old00001")).text, "body old00001");
  assert.equal(gmail.requests.length - before, 1);
});

test("a re-import after expired history keeps the cache visible, then removes what Gmail no longer has (P0-1)", async () => {
  const gmail = new FakeGmail(40);
  const { service, store } = await fixture(gmail.fetch, { mode: "initial" });
  await service.sync("a", { deadline: Date.now() + 60_000 });
  const total = (await service.countInbox("a")).total;
  gmail.messages.delete("old00003"); // gone from Gmail while history was unavailable (it is in the inbox)
  const account = (await store.get<AccountRecord>("account:a"))!;
  account.sync = { mode: "initial" }; // what history_expired leaves
  await store.put("account:a", account);
  await service.sync("a");
  assert.equal((await service.countInbox("a")).total, total, "the old cache still shows while importing");
  await service.sync("a", { deadline: Date.now() + 60_000 });
  assert.equal((await store.get<AccountRecord>("account:a"))!.sync.mode, "history");
  assert.equal(await service.cache.row("a", "old00003"), undefined, "the sweep removed it");
  assert.equal((await service.countInbox("a")).total, total - 1);
});

test("an account saved mid-import by 0.10 continues: history from its baseline, the listing where it stopped (P0-1)", async () => {
  const gmail = new FakeGmail(20);
  const { service, store } = await fixture(gmail.fetch, { mode: "initial", baseline: "100", pageToken: "10", generation: "g-old" });
  gmail.deliver("fresh");
  await service.sync("a");
  assert.ok(await service.cache.row("a", "fresh"), "history ran from the old baseline");
  assert.ok(gmail.requests.some((r) => r.startsWith("messages?") && r.includes("pageToken=10")), "the listing resumed");
  assert.equal((await store.get<AccountRecord>("account:a"))!.sync.generation, "g-old");
});

// ── P1-7: one bad message never stops its account ─────────────────────────────────

test("a message Gmail keeps failing is set aside after five attempts and the account moves on (P1-7)", async () => {
  const gmail = new FakeGmail();
  gmail.historyId = 10;
  const { service, store } = await fixture(gmail.fetch);
  gmail.deliver("good");
  gmail.deliver("bad");
  gmail.failing.set("bad", 1000);
  for (let i = 0; i < 4; i++) {
    await assert.rejects(service.sync("a"));
    assert.equal((await store.get<AccountRecord>("account:a"))!.sync.historyId, "10", "not advanced past the failing message yet");
    await unblock(store);
  }
  await service.sync("a");
  const account = (await store.get<AccountRecord>("account:a"))!;
  assert.equal(account.sync.historyId, "12", "advanced");
  assert.equal(account.status, "connected");
  assert.equal(account.skipped, 1);
  assert.ok(await store.get("skipped:a:bad"));
  assert.ok(await service.cache.row("a", "good"));
  gmail.deliver("later");
  await service.sync("a");
  assert.ok(await service.cache.row("a", "later"), "later mail still arrives");
});

test("a message that fails a few times and then reads is not set aside; account-wide failures never count (P1-7)", async () => {
  const gmail = new FakeGmail();
  gmail.historyId = 10;
  const { service, store } = await fixture(gmail.fetch);
  gmail.deliver("flaky");
  gmail.failing.set("flaky", 2);
  for (let i = 0; i < 2; i++) { await assert.rejects(service.sync("a")); await unblock(store); }
  await service.sync("a");
  assert.ok(await service.cache.row("a", "flaky"));
  assert.equal((await store.list({ prefix: "attempts:" })).size, 0, "its attempt count is cleared");
  const busy = await fixture(async (input) => new URL(String(input)).pathname.endsWith("/history")
    ? json({ historyId: "20", history: [{ messagesAdded: [{ message: { id: "x" } }] }] }) : json({}, 429));
  for (let i = 0; i < 6; i++) { await assert.rejects(busy.service.sync("a")); await unblock(busy.store); }
  assert.equal((await busy.store.list({ prefix: "skipped:" })).size, 0, "a rate limit is Gmail's, not the message's");
  assert.equal((await busy.store.list({ prefix: "attempts:" })).size, 0);
});

test("failed syncs wait longer each time, up to 15 minutes (P1-7)", async () => {
  const { service, store } = await fixture(async () => json({}, 500));
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const at = Date.now();
    await assert.rejects(service.sync("a"));
    const a = (await store.get<AccountRecord>("account:a"))!;
    waits.push(Math.round((a.retryAt! - at) / 60_000));
    await unblock(store);
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 15, 15]);
});
