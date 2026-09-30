import test from "node:test";
import assert from "node:assert/strict";
import type { Store } from "../workers/providers/google-oauth";
class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({
    prefix = "",
    limit,
    startAfter,
  }: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<
    Map<string, T>
  > {
    return new Map(
      [...this.data.entries()]
        .filter(
          ([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit)
        .map(([k, v]) => [k, structuredClone(v) as T]),
    );
  }
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    const p = this.tail.then(() =>
      fn({
        ...this,
        get: this.get.bind(this),
        put: this.put.bind(this),
        delete: this.delete.bind(this),
        list: this.list.bind(this),
        transaction: this.transaction.bind(this),
      }),
    );
    this.tail = p.catch(() => {});
    return p;
  }
}
const configEnv = {
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};

import {
  AccountService,
  type AccountRecord,
} from "../workers/providers/account-service";
import { seal, configuration } from "../workers/providers/google-oauth";
import { ProviderError } from "../workers/providers/gmail-client";
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status });
async function fixture(http: typeof fetch) {
  const store = new MemoryStore();
  const config = configuration(configEnv);
  if (config.status !== "configured") throw new Error();
  for (const id of ["a", "b"])
    await store.put<AccountRecord>("account:" + id, {
      id,
      provider: "gmail",
      email: id + "@example.invalid",
      runtime: "cloud",
      status: "connected",
      createdAt: 1,
      credentials: await seal(config.encryptionKey, id, {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3600000,
      }),
      sync: { mode: "initial" },
    });
  return { store, service: new AccountService(store, configEnv, http) };
}
test("initial import resumes pagination and stores account-scoped messages before advancing baseline", async () => {
  const seen: string[] = [];
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    seen.push(u.href);
    if (u.pathname.endsWith("/profile"))
      return json({ historyId: "10", emailAddress: "a@example.invalid" });
    if (u.pathname.endsWith("/messages"))
      return json(
        u.searchParams.has("pageToken")
          ? { messages: [{ id: "older" }] }
          : { messages: [{ id: "same" }], nextPageToken: "page-two" },
      );
    return json({
      id: u.pathname.split("/").at(-1),
      threadId: "thread",
      payload: { headers: [{ name: "Subject", value: "Fixture" }] },
    });
  });
  await service.sync("a");
  let account = await store.get<AccountRecord>("account:a");
  assert.equal(account?.sync.pageToken, "page-two");
  assert.equal(account?.sync.mode, "initial");
  await service.sync("a");
  account = await store.get<AccountRecord>("account:a");
  assert.equal(account?.sync.historyId, "10");
  assert.equal(account?.sync.mode, "history");
  assert.equal((await service.listMessages("a")).messages.length, 2);
  await service.sync("b");
  assert.notEqual(
    (await service.getMessage("a", "same")).id,
    (await service.getMessage("b", "same")).id,
  );
  assert.equal((await store.list({ prefix: "event:" })).size, 0);
  assert.ok(seen.some((u) => u.includes("pageToken=page-two")));
});
test("failed merge does not advance page; expired history returns to initial resync", async () => {
  let fail = true;
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/profile")) return json({ historyId: "10" });
    if (u.pathname.endsWith("/history")) return json({}, 404);
    if (u.pathname.endsWith("/messages"))
      return json({ messages: [{ id: "one" }], nextPageToken: "second" });
    if (fail) return json({}, 500);
    return json({ id: "one", threadId: "one" });
  });
  await assert.rejects(service.sync("a"));
  assert.equal(
    (await store.get<AccountRecord>("account:a"))?.sync.pageToken,
    undefined,
  );
  fail = false;
  const retry = (await store.get<AccountRecord>("account:a"))!;
  retry.retryAt = 0;
  await store.put("account:a", retry);
  await service.sync("a");
  let account = (await store.get<AccountRecord>("account:a"))!;
  account.sync = { mode: "history", historyId: "old" };
  await store.put("account:a", account);
  await service.sync("a");
  assert.equal(
    (await store.get<AccountRecord>("account:a"))?.sync.mode,
    "initial",
  );
});
test("incremental additions queue once, label changes do not re-trigger automation", async () => {
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/history"))
      return json({
        historyId: "20",
        history: [
          {
            messagesAdded: [{ message: { id: "new" } }],
            labelsAdded: [{ message: { id: "old" } }],
          },
        ],
      });
    return json({
      id: u.pathname.split("/").at(-1),
      threadId: "t",
      payload: { headers: [{ name: "Subject", value: "Synthetic" }] },
    });
  });
  const a = (await store.get<AccountRecord>("account:a"))!;
  a.sync = { mode: "history", historyId: "10" };
  await store.put("account:a", a);
  await service.sync("a");
  await service.sync("a");
  assert.equal((await store.list({ prefix: "event:" })).size, 1);
  assert.equal(
    (await store.get<AccountRecord>("account:a"))?.sync.historyId,
    "20",
  );
});
test("send persists intent before side effect; duplicate accepted replays; changed payload conflicts", async () => {
  let sends = 0;
  let store: MemoryStore;
  const setup = await fixture(async (input) => {
    assert.match(String(input), /messages\/send/);
    sends++;
    assert.equal(
      (await store.list<{ status: string }>({ prefix: "send:a:" }))
        .values()
        .next().value?.status,
      "sending",
    );
    return json({ id: "sent", threadId: "thread" });
  });
  store = setup.store;
  const request = {
    idempotencyKey: "request-one",
    to: ["recipient@example.invalid"],
    subject: "Hello",
    text: "Fixture",
  };
  const first = await setup.service.send("a", request);
  assert.equal(first.status, "accepted");
  assert.deepEqual(await setup.service.send("a", request), first);
  assert.equal(sends, 1);
  await assert.rejects(
    setup.service.send("a", { ...request, text: "Changed" }),
    (e: ProviderError) => e.code === "idempotency_conflict",
  );
  assert.equal(sends, 1);
});
test("ambiguous sends remain unknown across service restart and never automatically resend", async () => {
  let sends = 0;
  const { service, store } = await fixture(async () => {
    sends++;
    throw new Error("socket lost");
  });
  const request = {
    idempotencyKey: "request-two",
    to: ["recipient@example.invalid"],
    subject: "Hello",
    text: "Fixture",
  };
  assert.equal((await service.send("a", request)).status, "unknown");
  const restarted = new AccountService(store, configEnv, async () => {
    sends++;
    return json({ id: "unsafe" });
  });
  assert.equal((await restarted.send("a", request)).status, "unknown");
  assert.equal(sends, 1);
});
test("durable sending intent after lost receipt becomes unknown after restart", async () => {
  let sends = 0;
  const { service, store } = await fixture(async () => {
    sends++;
    return json({ id: "accepted-at-provider" });
  });
  const put = store.put.bind(store);
  store.put = async (key, value) => {
    if (
      key.startsWith("send:") &&
      (value as { status?: string }).status === "accepted"
    )
      throw new Error("storage write lost");
    await put(key, value);
  };
  const request = {
    idempotencyKey: "crash-test",
    to: ["recipient@example.invalid"],
    subject: "Hello",
    text: "Fixture",
  };
  await assert.rejects(service.send("a", request), /storage write lost/);
  store.put = put;
  const restarted = new AccountService(store, configEnv, async () => {
    sends++;
    return json({ id: "unsafe" });
  });
  assert.equal((await restarted.send("a", request)).status, "unknown");
  assert.equal(sends, 1);
});
test("durable event delivery retries failure and records acknowledgement; sent messages never trigger", async () => {
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/history"))
      return json({
        historyId: "20",
        history: [
          {
            messagesAdded: [
              { message: { id: "new" } },
              { message: { id: "sent" } },
            ],
          },
        ],
      });
    const id = u.pathname.split("/").at(-1);
    return json({
      id,
      threadId: "t",
      labelIds: id === "sent" ? ["SENT"] : ["INBOX"],
      payload: {
        mimeType: "text/plain",
        body: { data: Buffer.from("Fixture").toString("base64url") },
      },
    });
  });
  const a = (await store.get<AccountRecord>("account:a"))!;
  a.sync = { mode: "history", historyId: "10" };
  await store.put("account:a", a);
  await service.sync("a");
  let calls = 0;
  // A consumer that fails leaves the event waiting its backoff, not the whole drain failing.
  assert.deepEqual(await service.drainEvents(async () => {
    calls++;
    throw new Error("automation unavailable");
  }), { delivered: 0, failed: 1, dead: 0 });
  assert.deepEqual(await service.drainEvents(async () => { calls++; }), { delivered: 0, failed: 0, dead: 0 }, "not before its backoff");
  await service.drainEvents(async (event) => {
    calls++;
    assert.equal(event.account, "gmail:a");
    assert.equal(event.body, "Fixture");
  }, Date.now() + 60_000);
  await service.drainEvents(async () => {
    calls++;
  }, Date.now() + 120_000);
  assert.equal(calls, 2);
});
test("an event that always fails is set aside after 10 attempts with its error, and the others still arrive (reliability audit M3)", async () => {
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/history"))
      return json({
        historyId: "20",
        history: [
          {
            messagesAdded: [
              { message: { id: "new" } },
              { message: { id: "sent" } },
            ],
          },
        ],
      });
    const id = u.pathname.split("/").at(-1);
    return json({
      id,
      threadId: "t",
      labelIds: id === "sent" ? ["SENT"] : ["INBOX"],
      payload: {
        mimeType: "text/plain",
        body: { data: Buffer.from("Fixture").toString("base64url") },
      },
    });
  });
  const a = (await store.get<AccountRecord>("account:a"))!;
  a.sync = { mode: "history", historyId: "10" };
  await store.put("account:a", a);
  await service.sync("a");
  const now = Date.now();
  let delivered = 0;
  for (let i = 0; i < 10; i++)
    await service.drainEvents(async () => { throw new Error("categories refused it"); }, now + i * 4_000_000);
  const dead = await store.list<any>({ prefix: "dead:event:" });
  assert.equal(dead.size, 1, "set aside, not retried forever");
  assert.match([...dead.values()][0].lastError, /categories refused it/);
  assert.equal((await store.list({ prefix: "pending:event:" })).size, 0);
  await service.drainEvents(async () => { delivered++; }, now + 50_000_000);
  assert.equal(delivered, 0, "a set-aside event is not delivered again by itself");
});
test("large body is stored in bounded chunks and reconstructed without truncation", async () => {
  const body = "Long unicode 日本語 ".repeat(15000);
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/profile")) return json({ historyId: "10" });
    if (u.pathname.endsWith("/messages"))
      return json({ messages: [{ id: "large" }] });
    return json({
      id: "large",
      threadId: "t",
      payload: {
        mimeType: "text/plain",
        body: { data: Buffer.from(body).toString("base64url") },
      },
    });
  });
  await service.sync("a");
  assert.equal((await service.getMessage("a", "large")).text, body);
  for (const value of store.data.values())
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024);
});
test("OAuth callback persists encrypted token envelope only and public response omits credentials", async () => {
  const { service, store } = await fixture(async (input) =>
    String(input).includes("/token")
      ? json({
          access_token: "access-fixture",
          refresh_token: "refresh-fixture",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        })
      : json({ emailAddress: "connected@example.invalid", historyId: "10" }),
  );
  const flow = await service.connect();
  const result = await service.callback(
    new URL(flow.authorizationUrl).searchParams.get("state")!,
    flow.browserToken,
    "synthetic-code",
  );
  assert.equal(result.email, "connected@example.invalid");
  assert.ok(!JSON.stringify(result).includes("credentials"));
  assert.ok(!JSON.stringify([...store.data]).includes("refresh-fixture"));
  assert.ok(
    !JSON.stringify(await service.listAccounts()).includes("access-fixture"),
  );
  await assert.rejects(
    service.callback(
      new URL(flow.authorizationUrl).searchParams.get("state")!,
      flow.browserToken,
      "synthetic-code",
    ),
    /invalid_state/,
  );
});
test("draft creation is durable and idempotent; receipt lookup never resends", async () => {
  let writes = 0;
  const { service } = await fixture(async (input, init) => {
    writes++;
    assert.match(String(input), /\/drafts$/);
    const payload = JSON.parse(String(init?.body));
    assert.ok(payload.message.raw);
    return json({
      id: "draft-one",
      message: { id: "message-one", threadId: "thread" },
    });
  });
  const request = {
    idempotencyKey: "draft-request",
    to: ["recipient@example.invalid"],
    subject: "Draft",
    text: "Not sent",
  };
  const first = await service.createDraft("a", request);
  assert.equal(first.status, "accepted");
  assert.equal(first.providerDraftId, "draft-one");
  assert.deepEqual(await service.createDraft("a", request), first);
  assert.deepEqual(await service.getDraftReceipt("a", "draft-request"), first);
  assert.equal(writes, 1);
});
test("cached message remains intact if new body chunk persistence fails midway", async () => {
  let updating = false;
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/profile")) return json({ historyId: "10" });
    if (u.pathname.endsWith("/messages"))
      return json({ messages: [{ id: "one" }] });
    if (u.pathname.endsWith("/history"))
      return json({
        historyId: "20",
        history: [{ messages: [{ id: "one" }] }],
      });
    return json({
      id: "one",
      threadId: "t",
      payload: {
        mimeType: "text/plain",
        body: {
          data: Buffer.from(
            updating ? "x".repeat(100000) : "original",
          ).toString("base64url"),
        },
      },
    });
  });
  await service.sync("a");
  updating = true;
  const put = store.put.bind(store);
  store.put = async (key, value) => {
    if (key.includes(":body:") && key.endsWith(":1"))
      throw new Error("storage failed");
    await put(key, value);
  };
  await assert.rejects(service.sync("a"));
  assert.equal((await service.getMessage("a", "one")).text, "original");
});

test('unified Gmail reads sort the complete cache by date, not id; folder and query filters compose', async () => {
  const { service, store } = await fixture(async () => { throw new Error('listing must not contact Gmail'); });
  for (const [id, timestamp, labels, subject] of [
    ['aaa', 1000, ['INBOX'], 'old'], ['zzz', 9000, ['INBOX', 'STARRED'], 'new needle'],
    ['sent', 8000, ['SENT'], 'sent'], ['archive', 7000, [], 'archive'],
    ['trash', 6000, ['TRASH', 'STARRED'], 'trash'], ['spam', 5000, ['SPAM'], 'spam'],
    ['draft', 4000, ['DRAFT'], 'draft'],
  ] as [string, number, string[], string][]) {
    await store.put('message:a:' + id, { message: { providerMessageId: id, timestamp, labels, subject,
      from: 'from@example.invalid', to: 'a@example.invalid', snippet: '', date: '', read: false }, parts: 0 });
  }
  const options = { folder: 'inbox' as const, query: '', limit: 1 };
  const first = await service.listInboxMessages('a', options);
  assert.deepEqual(first.map(m => m.providerMessageId), ['zzz', 'aaa']);
  const second = await service.listInboxMessages('a', { ...options, before: first[0] });
  assert.deepEqual(second.map(m => m.providerMessageId), ['aaa']);
  assert.equal((await service.listInboxMessages('a', { ...options, query: 'NEEDLE' })).length, 1);
  for (const folder of ['sent', 'archive', 'trash', 'starred'] as const) {
    const rows = await service.listInboxMessages('a', { ...options, folder });
    assert.deepEqual(rows.map(m => m.providerMessageId), [folder === 'starred' ? 'zzz' : folder]);
  }
  assert.equal((await service.listInboxMessages('b', options)).length, 0);
});
test('unified cache scan refuses partial ordering when storage-row budget is exceeded', async () => {
  const { service, store } = await fixture(async () => { throw new Error('no network'); });
  for (let i = 0; i < 20001; i++) store.data.set('message:a:' + String(i).padStart(6, '0') + ':body:1:0', 'chunk');
  await assert.rejects(service.listInboxMessages('a', { folder: 'inbox', query: '', limit: 50 }), /cache_scan_limit/);
});

test('attachments participate in durable identity; invalid batches have no reservation or provider effect', async () => {
  let calls = 0;
  const { service, store } = await fixture(async () => { calls++; return json({ id: 'receipt', threadId: 'thread' }); });
  const file = { content: 'AAE=', filename: 'binary.bin', type: 'application/octet-stream', disposition: 'attachment' as const };
  const request = { idempotencyKey: 'attachment-send', to: ['other@example.invalid'], subject: 'Test', text: 'Body', threadId: 'thread', attachments: [file] };
  for (const attachments of [[file, { ...file, content: '!' }], [{ ...file, filename: 'bad\r\nheader' }]]) {
    await assert.rejects(service.send('a', { ...request, attachments }), /invalid_attachment/);
  }
  assert.equal((await store.list({ prefix: 'send:' })).size, 0);
  assert.equal(calls, 0);
  const accepted = await service.send('a', request);
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(await service.send('a', { ...request, attachments: [{ ...file, type: 'APPLICATION/OCTET-STREAM' }] }), accepted);
  for (const patch of [{ content: 'AAI=' }, { filename: 'different.bin' }, { type: 'image/png' }, { disposition: 'inline' as const }, { contentId: 'image@local' }]) {
    await assert.rejects(service.send('a', { ...request, attachments: [{ ...file, ...patch }] }), /idempotency_conflict/);
  }
  assert.equal(calls, 1);
});

test('unknown attachment send is never retried across service restart', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('lost response'); };
  const { service, store } = await fixture(transport);
  const request = { idempotencyKey: 'unknown-attachment', to: ['other@example.invalid'], subject: 'Test', text: 'Body', attachments: [{ content: 'AAE=', filename: 'binary.bin', type: 'application/octet-stream', disposition: 'attachment' as const }] };
  assert.equal((await service.send('a', request)).status, 'unknown');
  assert.equal((await new AccountService(store, configEnv, transport).send('a', request)).status, 'unknown');
  assert.equal(calls, 1);
});

test('full-limit Gmail send keeps attachment payload out of durable receipt values and preserves thread', async () => {
  let calls = 0;
  const { service, store } = await fixture(async (_url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.threadId, 'original-thread');
    assert.ok(payload.raw.length > 5 * 1024 * 1024);
    return json({ id: 'large-receipt', threadId: 'original-thread' });
  });
  const request = { idempotencyKey: 'large-file', to: ['other@example.invalid'], subject: 'Test', text: 'Body', threadId: 'original-thread', attachments: [{ content: Buffer.alloc(5 * 1024 * 1024).toString('base64'), filename: 'binary.bin', type: 'application/octet-stream', disposition: 'attachment' as const }] };
  assert.equal((await service.send('a', request)).status, 'accepted');
  assert.equal(calls, 1);
  for (const value of store.data.values()) assert.ok(Buffer.byteLength(JSON.stringify(value)) < 4096);
});
