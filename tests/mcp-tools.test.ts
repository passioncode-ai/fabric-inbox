// The mail tools against a recording API (agent audit, 2026-10-05): what each tool asks the app's
// routes, and what the agent gets back. The routes themselves are tested in their own files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Principal } from "../workers/mcp/keys";
import { instructionsFor } from "../workers/mcp/instructions";
import { runTool, toolsFor, type Api, type ApiResponse, type Ledger } from "../workers/mcp/protocol";
import { TOOLS } from "../workers/mcp/tools";

const owner: Principal = { kind: "owner", label: "owner@shop.invalid", level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null };
type Call = { method: string; path: string; query?: Record<string, unknown>; body?: unknown };
type Answer = ApiResponse | ((call: Call) => ApiResponse);

/** Answers "METHOD /path" (the exact path, before any query) as the app would; anything else is a 404. */
function fakeApi(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const api: Api = {
    async request(method, path, init = {}) {
      const call = { method, path, query: init.query, body: init.body };
      calls.push(call);
      const answer = answers[`${method} ${path}`];
      if (!answer) return { status: 404, data: { error: `no route ${method} ${path}` }, contentType: "application/json" };
      return typeof answer === "function" ? answer(call) : answer;
    },
  };
  return { api, calls };
}
const ok = (data: unknown, status = 200): ApiResponse => ({ status, data, contentType: "application/json" });

function ledger() {
  const journal: { tool: string; outcome: string; detail: string }[] = [];
  const l: Ledger = {
    issueConfirmation: async () => ({ code: "CODE", expiresAt: 0 }), consumeConfirmation: async () => true,
    reserveSend: async () => ({ ok: true, used: 1, limit: null }), refundSend: async () => {},
    record: async (e) => { journal.push({ tool: e.tool, outcome: e.outcome, detail: e.detail }); },
  };
  return { ledger: l, journal };
}

/** One tool call as the MCP server makes it: the arguments parsed with their defaults, then runTool. */
async function call(api: Api, name: string, args: Record<string, unknown>, principal: Principal = owner) {
  const tool = TOOLS.find((t) => t.name === name)!;
  const { ledger: l, journal } = ledger();
  const parsed = z.object(tool.input).parse(args);
  const result = await runTool(tool, parsed, { api, principal }, l);
  return { isError: !!result.isError, data: JSON.parse(result.content[0]!.text), journal };
}

const CF = "support@shop.invalid";
const CF_BOX = `/api/v1/mailboxes/${encodeURIComponent(CF)}`;
const cfEmail = (over: Record<string, unknown> = {}) => ({
  id: "m1", thread_id: "t1", message_id: "orig@x.invalid", subject: "Order", sender: "ann@customer.invalid", recipient: CF,
  cc: null, date: "2026-10-05T10:00:00Z", folder_id: "inbox", read: false, starred: false, body: "<p>Where is my order?</p>",
  raw_headers: null, attachments: [], ...over,
});
const gmailMessage = (over: Record<string, unknown> = {}) => ({
  providerMessageId: "m1", threadId: "t1", rfcMessageId: "<orig@x.invalid>", references: "", subject: "Order",
  from: "Ann <ann@customer.invalid>", to: "me@gmail.invalid", date: "Mon, 5 Oct 2026 10:00:00 +0000",
  text: "Where is my order?", html: "", read: false, labels: ["INBOX"], attachments: [], ...over,
});
const GMAIL_ACCOUNTS = ok({ configuration: "configured", accounts: [{ id: "g1", email: "Me@Gmail.invalid", status: "connected" }] });

// ── 1. Reply-To ─────────────────────────────────────────────────────

test("reply answers the Reply-To address, not the sender, on both providers, and read_message shows it (agent audit 1)", async () => {
  const cf = fakeApi({
    [`GET ${CF_BOX}/emails/m1`]: ok(cfEmail({ raw_headers: JSON.stringify([{ key: "from", value: "ann@customer.invalid" }, { key: "reply-to", value: "\"Help, Desk\" <help@customer.invalid>, team@customer.invalid" }]) })),
    [`GET ${CF_BOX}`]: ok({ settings: {} }),
    [`POST ${CF_BOX}/emails/m1/reply`]: ok({ id: "ob-1", status: "accepted" }),
  });
  const read = await call(cf.api, "read_message", { accountId: `cloudflare:${CF}`, messageId: "m1" });
  assert.equal(read.data.replyTo, "\"Help, Desk\" <help@customer.invalid>, team@customer.invalid");
  const sent = await call(cf.api, "reply", { accountId: `cloudflare:${CF}`, messageId: "m1", text: "Soon.", idempotencyKey: "r1" });
  assert.equal(sent.isError, false, JSON.stringify(sent.data));
  const body = cf.calls.find((c) => c.method === "POST")!.body as { to: string[] };
  assert.deepEqual(body.to, ["help@customer.invalid", "team@customer.invalid"]);

  const gm = fakeApi({
    "GET /api/accounts/g1/messages/m1": ok(gmailMessage({ replyTo: "Help <help@customer.invalid>" })),
    "GET /api/accounts": GMAIL_ACCOUNTS,
    "POST /api/accounts/g1/send": ok({ status: "accepted", idempotencyKey: "r2" }, 202),
  });
  const gread = await call(gm.api, "read_message", { accountId: "gmail:g1", messageId: "m1" });
  assert.equal(gread.data.replyTo, "Help <help@customer.invalid>");
  const gsent = await call(gm.api, "reply", { accountId: "gmail:g1", messageId: "m1", text: "Soon.", idempotencyKey: "r2" });
  assert.equal(gsent.isError, false, JSON.stringify(gsent.data));
  assert.deepEqual((gm.calls.find((c) => c.method === "POST")!.body as { to: string[] }).to, ["help@customer.invalid"]);

  const plain = fakeApi({
    [`GET ${CF_BOX}/emails/m1`]: ok(cfEmail({ raw_headers: JSON.stringify([{ key: "reply-to", value: "not an address" }]) })),
    [`GET ${CF_BOX}`]: ok({ settings: {} }),
    [`POST ${CF_BOX}/emails/m1/reply`]: ok({ id: "ob-2", status: "accepted" }),
  });
  await call(plain.api, "reply", { accountId: `cloudflare:${CF}`, messageId: "m1", text: "Hi.", idempotencyKey: "r3" });
  assert.deepEqual((plain.calls.find((c) => c.method === "POST")!.body as { to: string[] }).to, ["ann@customer.invalid"], "a Reply-To with no address falls back to the sender");
});

// ── 2. Gmail reply-all ──────────────────────────────────────────────

test("a Gmail reply-all keeps the Cc and leaves out the account's own address (agent audit 2)", async () => {
  const gm = fakeApi({
    "GET /api/accounts/g1/messages/m1": ok(gmailMessage({ to: "Me <me@gmail.invalid>, bob@customer.invalid", cc: "carol@customer.invalid, ME@gmail.invalid" })),
    "GET /api/accounts": GMAIL_ACCOUNTS,
    "POST /api/accounts/g1/send": ok({ status: "accepted", idempotencyKey: "r1" }, 202),
  });
  const read = await call(gm.api, "read_message", { accountId: "gmail:g1", messageId: "m1" });
  assert.equal(read.data.cc, "carol@customer.invalid, ME@gmail.invalid");
  const sent = await call(gm.api, "reply", { accountId: "gmail:g1", messageId: "m1", text: "All of you.", idempotencyKey: "r1", replyAll: true });
  assert.equal(sent.isError, false, JSON.stringify(sent.data));
  const body = gm.calls.find((c) => c.method === "POST")!.body as { to: string[]; cc: string[] };
  assert.deepEqual(body.to, ["ann@customer.invalid"]);
  assert.deepEqual(body.cc, ["bob@customer.invalid", "carol@customer.invalid"]);
});
