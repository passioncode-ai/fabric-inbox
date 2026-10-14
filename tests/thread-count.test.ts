// B-114: every row of the main inbox says how long its conversation is, and the reader can mark the
// whole conversation read or read any message of it in place — for Cloudflare and for Gmail, IMAP
// and Outlook. A Gmail, IMAP or Outlook conversation is found from a conversation index kept with the
// cache (a scan of a few pages missed messages of a large cache), built in the background for mail
// cached before it existed; trash, spam and discarded mail are not part of a conversation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore } from "./memory-store";
import { GmailCache } from "../workers/providers/gmail-cache";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, configuration } from "../workers/providers/google-oauth";
import { markRead, messageText, unreadOf, type ThreadRow } from "../app/components/inbox/thread";
import type { Message } from "../workers/providers/gmail-client";

const message = (id: string, threadId: string, over: Partial<Message> = {}): Message => ({
  id: "a:" + id, accountId: "a", providerMessageId: id, threadId, subject: "Plan", from: "ann@x.invalid", to: "a@x.invalid", cc: "",
  replyTo: "", date: "", rfcMessageId: "", references: "", timestamp: 1000 + Number(id.replace(/\D/g, "") || 0), snippet: "", read: true,
  archived: false, labels: ["INBOX"], attachments: [], text: "t", html: "", ...over,
} as Message);

test("the conversation index counts a conversation's messages, trash, spam and discarded left out", async () => {
  const store = new MemoryStore();
  const cache = new GmailCache(store);
  await cache.save("a", message("m1", "t1"), "g");
  await cache.save("a", message("m2", "t1", { labels: ["SENT"] }), "g");
  await cache.save("a", message("m3", "t1", { labels: ["DRAFT"] }), "g");
  await cache.save("a", message("m4", "t1", { labels: ["TRASH"] }), "g");
  await cache.save("a", message("m5", "t:2/x"), "g");
  assert.equal(await cache.migrate("a", () => false, Date.now()), true);
  assert.equal(await cache.indexThreads("a", Date.now()), true, "a cache on the current layout with nothing to backfill is done at once");
  assert.deepEqual(Object.fromEntries((await cache.threadCounts("a", ["t1", "t:2/x", "t1"]))!), { t1: 3, "t:2/x": 1 });
  await cache.relabel("a", "m1", ["SPAM"]);
  assert.equal((await cache.threadCounts("a", ["t1"]))!.get("t1"), 2, "a message moved to Spam leaves the count");
  await cache.relabel("a", "m4", ["INBOX"]);
  assert.equal((await cache.threadCounts("a", ["t1"]))!.get("t1"), 3, "one brought back from Trash joins it again");
  await cache.remove("a", "m2");
  assert.equal((await cache.threadCounts("a", ["t1"]))!.get("t1"), 2, "a removed message leaves the index");
  assert.deepEqual((await cache.threadMembers("a", "t1"))!.map((m) => m.id).sort(), ["m1", "m3", "m4"]);
  await cache.clear("a");
  assert.equal([...store.data.keys()].filter((k) => k.startsWith("thx:") || k.startsWith("threads:")).length, 0, "disconnecting forgets the index");
});

const configEnv = {
  GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
async function service() {
  const store = new MemoryStore();
  const config = configuration(configEnv);
  if (config.status !== "configured") throw new Error();
  await store.put<AccountRecord>("account:a", {
    id: "a", provider: "gmail", email: "a@x.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000 }),
    sync: { mode: "history", historyId: "10", generation: "g" },
  });
  return { store, service: new AccountService(store, configEnv, async () => { throw new Error("no network"); }) };
}

test("mail cached before the index existed is indexed on the next read; until then rows carry no count", async () => {
  const { store, service: s } = await service();
  const cache = new GmailCache(store);
  for (let i = 0; i < 250; i++) await cache.save("a", message("m" + i, "t" + (i % 50)), "g");
  // As a cache migrated by an earlier release holds it: no conversation index, no backfill state.
  for (const key of [...store.data.keys()]) if (key.startsWith("thx:") || key.startsWith("threads:")) await store.delete(key);
  const fresh = new AccountService(store, configEnv, async () => { throw new Error("no network"); });
  const page = await fresh.listInboxMessages("a", { folder: "inbox", query: "", limit: 20 });
  assert.ok(page.every((m) => m.threadCount === 5), "each of 50 conversations holds 5 messages");
  const thread = await fresh.listMessages("a", { threadId: "t7" });
  assert.deepEqual(thread.messages.map((m) => m.providerMessageId).sort(), ["m107", "m157", "m207", "m57", "m7"], "the conversation from the index");
  void s;
});

test("a row alone in its conversation carries no count", async () => {
  const { store, service: s } = await service();
  await new GmailCache(store).save("a", message("m1", "solo"), "g");
  const [row] = await s.listInboxMessages("a", { folder: "inbox", query: "", limit: 20 });
  assert.equal(row!.threadCount, undefined);
});

const row = (id: string, over: Partial<ThreadRow["message"]> = {}, kind: ThreadRow["kind"] = "received"): ThreadRow => ({
  message: { id, accountId: "cloudflare:me@x.invalid", provider: "cloudflare", providerMessageId: id, subject: "", sender: "", recipient: "",
    date: "", timestamp: 0, read: false, starred: false, snippet: "", threadId: "t1", ...over } as ThreadRow["message"],
  kind, open: false, at: 0,
});

test("Mark conversation read: one request for a Cloudflare conversation, each unread message for the others", async () => {
  const sent: [string, unknown, string | undefined][] = [];
  const send = async (url: string, body?: unknown, method?: string) => { sent.push([url, body, method]); };
  const rows = [row("m1"), row("m2", { read: true }), row("d1", {}, "draft"), row("m3")];
  assert.deepEqual(unreadOf(rows).map((r) => r.message.id), ["m1", "m3"], "drafts and read mail are not marked");
  await markRead(rows, send, true);
  assert.deepEqual(sent, [["/api/v1/mailboxes/me%40x.invalid/threads/t1/read", {}, undefined]]);
  sent.length = 0;
  await markRead([row("m1")], send, false);
  assert.deepEqual(sent, [["/api/v1/mailboxes/me%40x.invalid/emails/m1", { read: true }, "PUT"]], "one message shown in place");
  sent.length = 0;
  const gmail = { accountId: "gmail:g1", provider: "gmail" as const };
  await markRead([row("r1", gmail), row("r2", gmail)], send, true);
  assert.deepEqual(sent.map((s) => s[0]), ["/api/accounts/g1/messages/r1/read", "/api/accounts/g1/messages/r2/read"]);
  await assert.rejects(markRead([row("r1", gmail), row("r2", gmail)], async (url) => { sent.push([url, 0, ""]); if (url.includes("r1")) throw new Error("refused"); }, true),
    /refused/, "a refusal is reported after every message was tried");
  assert.ok(sent.some((s) => s[0].includes("r2") && s[1] === 0), "the second was still tried");
  await markRead([row("m1", { read: true })], async () => { throw new Error("never asked"); }, true);
});

test("a message shown in place reads as plain text", async () => {
  const m = row("m1").message;
  assert.equal(await messageText(m, async () => ({ body: "<p>Hello <b>Ann</b></p><p>Bye</p>" })), "Hello Ann\nBye");
  assert.equal(await messageText({ ...m, provider: "gmail", accountId: "gmail:g1" }, async (url) => { assert.equal(url, "/api/accounts/g1/messages/m1"); return { text: " Hi ", html: "<p>x</p>" }; }), "Hi");
});

test("the list shows the count and the reader offers Show and Mark conversation read", () => {
  const list = readFileSync("app/components/inbox/TriagedList.tsx", "utf8");
  assert.match(list, /\(message\.threadCount \?\? 0\) > 1/);
  const conversation = readFileSync("app/components/inbox/ConversationList.tsx", "utf8");
  assert.match(conversation, /aria-expanded=\{shown\}/);
  assert.match(conversation, /t\("Mark conversation read"\)/);
  assert.match(conversation, /onMarkRead\(unread, true\)/);
  const route = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(route, /onMarkRead=\{markConversationRead\}/);
  assert.match(route, /loadText=\{\(message\) => messageText\(message, \(url\) => fabric\(url\)\)\}/);
});

test("agents see the count too: list_messages passes threadCount through", () => {
  const tools = readFileSync("workers/mcp/tools.ts", "utf8");
  assert.match(tools, /\.\.\.\(m\.threadCount \? \{ threadCount: m\.threadCount \} : \{\}\)/);
  assert.match(tools, /threadCount says how many messages a row's conversation holds/);
});
