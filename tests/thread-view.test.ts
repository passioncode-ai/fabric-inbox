// B-114 (M1): the main inbox shows a message's whole conversation — every message of its thread,
// oldest first, your sent replies and drafts included — for Cloudflare and for Gmail, IMAP and
// Outlook, and opening one of them makes it the message replied to or forwarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConversation } from "../app/components/inbox/thread";

const open = (over: Record<string, unknown> = {}) => ({
  id: JSON.stringify(["cloudflare:me@x.invalid", "m2"]), accountId: "cloudflare:me@x.invalid", provider: "cloudflare", providerMessageId: "m2",
  subject: "Re: Plan", sender: "Ann <ann@x.invalid>", recipient: "me@x.invalid", date: "2026-10-13T10:00:00Z", timestamp: 0, read: true, starred: false,
  snippet: "", threadId: "t1", ...over,
}) as never;

test("Cloudflare: the thread route, oldest first, sent and draft marked, the open message flagged", async () => {
  const asked: string[] = [];
  const rows = await loadConversation(open(), async (url: string) => {
    asked.push(url);
    return [
      { id: "m3", subject: "Re: Plan", sender: "me@x.invalid", recipient: "ann@x.invalid", date: "2026-10-13T11:00:00Z", read: true, starred: false, folder_id: "sent", thread_id: "t1", body: "<p>Thanks, <b>Ann</b>.</p>" },
      { id: "m1", subject: "Plan", sender: "ann@x.invalid", sender_name: "Ann", recipient: "me@x.invalid", date: "2026-10-12T09:00:00Z", read: true, starred: false, folder_id: "inbox", thread_id: "t1", body: "First" },
      { id: "m2", subject: "Re: Plan", sender: "ann@x.invalid", recipient: "me@x.invalid", date: "2026-10-13T10:00:00Z", read: false, starred: false, folder_id: "inbox", thread_id: "t1", body: "Second" },
      { id: "d1", subject: "Re: Plan", sender: "me@x.invalid", recipient: "ann@x.invalid", date: "2026-10-13T12:00:00Z", read: true, starred: false, folder_id: "draft", thread_id: "t1", body: "draft" },
    ];
  });
  assert.deepEqual(asked, ["/api/v1/mailboxes/me%40x.invalid/threads/t1"]);
  assert.deepEqual(rows.map((r) => [r.message.providerMessageId, r.kind, r.open]), [["m1", "received", false], ["m2", "received", true], ["m3", "sent", false], ["d1", "draft", false]]);
  assert.equal(rows[2]!.message.snippet, "Thanks, Ann.");
  assert.equal(rows[0]!.message.id, JSON.stringify(["cloudflare:me@x.invalid", "m1"]));
  assert.equal(rows[0]!.message.provider, "cloudflare");
});

test("Gmail, IMAP and Outlook: the account's messages with this thread id, across folders", async () => {
  const asked: string[] = [];
  const message = open({ id: JSON.stringify(["gmail:g1", "r2"]), accountId: "gmail:g1", provider: "gmail", providerMessageId: "r2", threadId: "th/9" });
  const rows = await loadConversation(message, async (url: string) => {
    asked.push(url);
    return { messages: [
      { providerMessageId: "r2", threadId: "th/9", subject: "Re: Hi", from: "Bob <bob@x.invalid>", to: "me@x.invalid", date: "2026-10-13T10:00:00Z", timestamp: 2, read: true, labels: ["INBOX"], snippet: "two" },
      { providerMessageId: "r1", threadId: "th/9", subject: "Hi", from: "me@x.invalid", to: "bob@x.invalid", date: "2026-10-12T10:00:00Z", timestamp: 1, read: true, labels: ["SENT"], snippet: "one" },
    ] };
  });
  assert.deepEqual(asked, ["/api/accounts/g1/messages?threadId=th%2F9&limit=100"]);
  assert.deepEqual(rows.map((r) => [r.message.providerMessageId, r.kind, r.open]), [["r1", "sent", false], ["r2", "received", true]]);
  assert.equal(rows[0]!.message.provider, "gmail");
});

test("a message without a thread, or a thread the server cannot read, is shown alone", async () => {
  assert.deepEqual((await loadConversation(open({ threadId: undefined }), async () => { throw new Error("never asked"); })).map((r) => r.open), [true]);
  assert.deepEqual((await loadConversation(open(), async () => { throw new Error("offline"); })).map((r) => r.open), [true]);
  const lone = await loadConversation(open(), async () => []);
  assert.equal(lone.length, 1, "the open message stays even if the thread answer misses it");
});

test("the reader shows the conversation above the open message and opens any of its messages", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(route, /queryKey: \["conversation", selected\?\.accountId, selected\?\.threadId\]/);
  assert.match(route, /<ConversationList rows=\{conversation\.data \?\? \[\]\} openId=\{selected\.providerMessageId\}\s+onOpen=\{\(message\) => setSelected\(message\)\}/);
  assert.match(route, /invalidateQueries\(\{ queryKey: \["conversation"\] \}\)/, "a reply just sent joins the conversation");
  const list = readFileSync("app/components/inbox/ConversationList.tsx", "utf8");
  assert.match(list, /if \(rows\.length < 2\) return null;/);
  assert.match(list, /aria-current=\{open \? "true" : undefined\}/);
});
