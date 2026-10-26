import { test } from "node:test";
import assert from "node:assert/strict";
import { accountAddress, accountMailbox, isAccountMailbox, receiptOutcome, type AccountsPort } from "../workers/agents/account-deps";
import { rawMime, type Message } from "../workers/providers/gmail-client";
import type { SendReceipt, SendRequest, SubmitOptions } from "../workers/providers/account-service";

/**
 * B-171: a reply agent on a Gmail, IMAP or Outlook account reads the message from the account's
 * cache with its real headers, and its reply leaves from the account under the run's key. The
 * accounts object is a fake with the RPC's shape; the runner over it is in tests/agents-runner.test.ts.
 */
function message(over: Partial<Message> = {}): Message {
  return {
    id: "acc-1:m1", accountId: "acc-1", providerMessageId: "m1", threadId: "t1", subject: "Price?", from: "Ann <ann@customer.invalid>",
    to: "help@acme.example", cc: "", replyTo: "", date: "2026-10-26T08:00:00.000Z", rfcMessageId: "<m1@customer.invalid>",
    references: "<m0@customer.invalid>", timestamp: Date.parse("2026-10-26T08:00:00Z"), snippet: "How much", text: "How much is it?",
    html: "", read: false, archived: false, labels: ["INBOX", "UNREAD"], attachments: [], ...over,
  };
}

function fakePort(options: { send?: (request: SendRequest, options?: SubmitOptions) => Promise<SendReceipt>; receipt?: () => Promise<SendReceipt>; headers?: () => Promise<{ key: string; value: string }[]> } = {}) {
  const sends: { request: SendRequest; options?: SubmitOptions }[] = [];
  const drafts: { request: SendRequest; options?: SubmitOptions }[] = [];
  const messages = new Map<string, Message>([
    ["m1", message()],
    ["s1", message({ id: "acc-1:s1", providerMessageId: "s1", from: "help@acme.example", to: "ann@customer.invalid", labels: ["SENT"], snippet: "We will", text: "We will answer you within a day. And more text.", date: "2026-10-26T08:05:00.000Z", timestamp: Date.parse("2026-10-26T08:05:00Z") })],
  ]);
  const port: AccountsPort = {
    listAccounts: async () => ({ accounts: [{ id: "acc-1", provider: "gmail", email: "Help@Acme.example" }, { id: "acc-2", provider: "imap", email: "box@acme.example" }] }),
    async getMessage(_account, id) {
      const found = messages.get(id);
      if (!found) throw new Error("message_not_found");
      return found;
    },
    getHeaders: async () => ({ headers: await (options.headers ?? (async () => [{ key: "Auto-Submitted", value: "no" }]))() }),
    listMessages: async () => ({ messages: [...messages.values()].reverse() }),
    async send(_account, request, submit) {
      sends.push({ request, options: submit });
      return options.send ? options.send(request, submit) : { status: "accepted", idempotencyKey: request.idempotencyKey, providerMessageId: "out-1" };
    },
    async createDraft(_account, request, submit) {
      drafts.push({ request, options: submit });
      return { status: "accepted", idempotencyKey: request.idempotencyKey, providerDraftId: "d1" };
    },
    getSendReceipt: async () => (options.receipt ? options.receipt() : Promise.reject(new Error("receipt_not_found"))),
  };
  return { port, sends, drafts };
}
const bucket = (settings: Record<string, unknown> | null) =>
  ({ get: async () => (settings ? { json: async () => settings } : null) }) as unknown as R2Bucket;

test("an account's mailbox id is told from an address", () => {
  assert.equal(isAccountMailbox("gmail:3f0c1d2e-aaaa-4bbb-8ccc-000000000001"), true);
  assert.equal(isAccountMailbox("imap:abc"), true);
  assert.equal(isAccountMailbox("outlook:abc"), true);
  assert.equal(isAccountMailbox("support@acme.example"), false);
  assert.equal(isAccountMailbox("cloudflare:support@acme.example"), false);
});

test("the account's address is its email; a removed account has none", async () => {
  const { port } = fakePort();
  assert.equal(await accountAddress(port, "gmail:acc-1"), "help@acme.example");
  assert.equal(await accountAddress(port, "gmail:acc-2"), null, "the id belongs to another provider");
  assert.equal(await accountAddress(port, "outlook:gone"), null);
});

test("REQ-3: a receipt reads as the runner's outbox entry; sending and unknown are unknown, never sent again", () => {
  const of = (status: SendReceipt["status"]) => receiptOutcome("gmail:acc-1", { status, idempotencyKey: "agent-1", error: status === "failed" ? "rejected" : undefined });
  assert.equal(of("accepted").status, "accepted");
  assert.equal(of("failed").status, "failed");
  assert.equal(of("failed").errorCode, "rejected");
  assert.equal(of("sending").status, "unknown");
  assert.equal(of("unknown").status, "unknown");
});

test("the message is read from the account with its real headers, folder and Message-ID", async () => {
  const { port } = fakePort({ headers: async () => [{ key: "List-Id", value: "news.example" }] });
  const box = accountMailbox({ BUCKET: bucket({ agent: { id: "support" } }) }, port, "gmail:acc-1", "help@acme.example");
  assert.equal(box.address, "help@acme.example");
  const email = (await box.email("m1"))!;
  assert.equal(email.id, "m1");
  assert.equal(email.folder_id, "inbox");
  assert.equal(email.message_id, "m1@customer.invalid");
  assert.equal(email.body, "How much is it?");
  assert.deepEqual(JSON.parse(email.raw_headers!), [{ key: "List-Id", value: "news.example" }]);
  assert.equal(await box.email("missing"), null, "a message gone is no run");
  assert.deepEqual(await box.settings(), { agent: { id: "support" } });

  const failing = fakePort({ headers: async () => { throw new Error("provider_unavailable"); } });
  await assert.rejects(accountMailbox({ BUCKET: bucket(null) }, failing.port, "gmail:acc-1", "help@acme.example").email("m1"), /provider_unavailable/,
    "decision 4: headers that cannot be read hold the run, never answer blind");
});

test("the thread is in order, and what the account sent is read whole", async () => {
  const { port } = fakePort();
  const thread = await accountMailbox({ BUCKET: bucket(null) }, port, "gmail:acc-1", "help@acme.example").thread("t1");
  assert.deepEqual(thread.map((m) => [m.id, m.folder_id]), [["m1", "inbox"], ["s1", "sent"]]);
  assert.equal(thread[1]!.body, "We will answer you within a day. And more text.");
  assert.equal(thread[0]!.body, "How much", "the rest from the cache's snippet");
});

test("a reply leaves from the account under the run's key, marked Auto-Submitted, in the conversation", async () => {
  const { port, sends } = fakePort();
  const box = accountMailbox({ BUCKET: bucket(null) }, port, "gmail:acc-1", "help@acme.example");
  const result = await box.send({ mailboxId: "gmail:acc-1", idempotencyKey: "agent-abc", kind: "reply", originalEmailId: "m1",
    request: { from: { email: "help@acme.example", name: "Acme" }, to: "ann@customer.invalid", subject: "Re: Price?", text: "10 EUR.", html: "<p>10 EUR.</p>", auto_submitted: true } });
  assert.ok(!("error" in result) && result.status === "accepted");
  const { request, options } = sends[0]!;
  assert.deepEqual(options, { autoSubmitted: true });
  assert.equal(request.idempotencyKey, "agent-abc");
  assert.deepEqual(request.to, ["ann@customer.invalid"]);
  assert.equal(request.threadId, "t1");
  assert.equal(request.inReplyTo, "<m1@customer.invalid>");
  assert.equal(request.references, "<m0@customer.invalid> <m1@customer.invalid>");
  assert.equal((request as { from?: string }).from, undefined, "the account writes as itself");

  const imap = fakePort();
  await accountMailbox({ BUCKET: bucket(null) }, imap.port, "imap:acc-1", "help@acme.example").send({ mailboxId: "imap:acc-1", idempotencyKey: "agent-abc", originalEmailId: "m1",
    request: { from: "help@acme.example", to: "ann@customer.invalid", subject: "Re: Price?", text: "10 EUR." } });
  assert.equal(imap.sends[0]!.request.threadId, undefined, "IMAP threads by its headers");
  assert.equal(imap.sends[0]!.request.inReplyTo, "<m1@customer.invalid>");
});

test("REQ-3: a refusal before anything left is a refusal; a send that may have left is unknown; nothing is sent twice", async () => {
  const send = { mailboxId: "gmail:acc-1", idempotencyKey: "agent-abc", originalEmailId: "m1", request: { from: "help@acme.example", to: "ann@customer.invalid", subject: "Re", text: "x", auto_submitted: true } };
  const refused = fakePort({ send: async () => { throw new Error("recipient_rejected"); } });
  const answer = await accountMailbox({ BUCKET: bucket(null) }, refused.port, "gmail:acc-1", "help@acme.example").send(send);
  assert.ok("error" in answer, "no receipt kept: nothing left");

  const unknown = fakePort({ send: async () => { throw new Error("network lost"); }, receipt: async () => ({ status: "unknown", idempotencyKey: "agent-abc", error: "send_outcome_unknown" }) });
  const maybe = await accountMailbox({ BUCKET: bucket(null) }, unknown.port, "gmail:acc-1", "help@acme.example").send(send);
  assert.ok(!("error" in maybe) && maybe.status === "unknown");

  const unreadable = fakePort({ send: async () => { throw new Error("network lost"); }, receipt: async () => { throw new Error("object unavailable"); } });
  await assert.rejects(accountMailbox({ BUCKET: bucket(null) }, unreadable.port, "gmail:acc-1", "help@acme.example").send(send), /network lost/,
    "neither a refusal nor a receipt: the runner records send_unknown");

  const failed = fakePort({ send: async (request) => ({ status: "failed", idempotencyKey: request.idempotencyKey, error: "rejected" }) });
  const no = await accountMailbox({ BUCKET: bucket(null) }, failed.port, "gmail:acc-1", "help@acme.example").send(send);
  assert.ok(!("error" in no) && no.status === "failed");
});

test("a draft is made at the account under its id, answering the message", async () => {
  const { port, drafts } = fakePort();
  await accountMailbox({ BUCKET: bucket(null) }, port, "gmail:acc-1", "help@acme.example")
    .createDraft({ id: "agent-abc-draft", to: "ann@customer.invalid", subject: "Re: Price?", text: "10 EUR.", inReplyTo: "m1", threadId: "t1" });
  assert.equal(drafts[0]!.request.idempotencyKey, "agent-abc-draft");
  assert.equal(drafts[0]!.request.inReplyTo, "<m1@customer.invalid>");
  assert.equal(drafts[0]!.options, undefined, "a draft a person sends is not marked automatic");
});

test("rawMime writes Auto-Submitted only when asked", () => {
  const input = { to: ["ann@customer.invalid"], subject: "Re", text: "x" };
  assert.match(rawMime("help@acme.example", { ...input, autoSubmitted: true }), /^Auto-Submitted: auto-replied\r$/m);
  assert.doesNotMatch(rawMime("help@acme.example", input), /Auto-Submitted/);
});
