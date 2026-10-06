// Everything the app's interface does, an agent can do over MCP (operator requirement, 0.11 WS3).
// Each test names the gap of the 2026-10-06 parity audit it closes; the tools run against a
// recording API (tests/mcp-fake-api.ts), the routes have their own tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TOOLS } from "../workers/mcp/tools";
import { call, CF, CF_BOX, cfEmail, fakeApi, GMAIL_ACCOUNTS, gmailMessage, HI_BASE64, ok, type Call } from "./mcp-fake-api";

const posted = (calls: Call[]) => calls.find((c) => c.method === "POST" || c.method === "PUT")!.body as Record<string, unknown>;
const pdf = { filename: "invoice.pdf", type: "application/pdf", base64: HI_BASE64 };

// ── Gap 1 (part): read_message carries In-Reply-To and Bcc ──────────

test("read_message returns inReplyTo and bcc on both providers (parity gap 1)", async () => {
  const cf = fakeApi({ [`GET ${CF_BOX}/emails/d1`]: ok(cfEmail({ id: "d1", folder_id: "draft", in_reply_to: "m1", bcc: "boss@shop.invalid", sender: CF })) });
  const read = await call(cf.api, "read_message", { accountId: `cloudflare:${CF}`, messageId: "d1" });
  assert.equal(read.isError, false, JSON.stringify(read.data));
  assert.equal(read.data.inReplyTo, "m1");
  assert.equal(read.data.bcc, "boss@shop.invalid");

  const gm = fakeApi({ "GET /api/accounts/g1/messages/m9": ok(gmailMessage({ providerMessageId: "m9", inReplyTo: "<orig@x.invalid>", bcc: "boss@x.invalid", labels: ["DRAFT"] })) });
  const gread = await call(gm.api, "read_message", { accountId: "gmail:g1", messageId: "m9" });
  assert.equal(gread.data.inReplyTo, "<orig@x.invalid>");
  assert.equal(gread.data.bcc, "boss@x.invalid");
  assert.equal(gread.data.folder, "draft");
});

// ── Gap 1: drafts on the server, changed and sent over MCP (Gmail; Cloudflare end to end in mcp-workerd) ──

test("Gmail drafts are listed with the others, changed under their revision keeping their thread, sent and deleted over MCP (parity gap 1)", async () => {
  const gDraft = { draftId: "r1", revision: "m5", messageId: "m5", threadId: "th1", to: "ann@x.invalid", cc: null, bcc: null, subject: "Re: Order", date: "2026-10-06T09:00:00Z",
    inReplyTo: "<orig@x.invalid>", references: "<orig@x.invalid>", snippet: "Soon", attachments: [{ id: "att1", filename: "a.txt", mimetype: "text/plain", size: 2 }] };
  const { api, calls } = fakeApi({
    "GET /api/inbox": ok({ accounts: [{ id: "gmail:g1" }, { id: `cloudflare:${CF}` }, { id: "gmail:broken" }], messages: [], issues: [] }),
    "GET /api/accounts/g1/drafts": ok({ drafts: [gDraft], nextCursor: null }),
    [`GET ${CF_BOX}/drafts`]: ok({ drafts: [{ id: "d1", revision: 2, to: "bob@x.invalid", subject: "New", date: "2026-10-06T10:00:00Z", inReplyTo: null, threadId: "d1", snippet: "Hi", attachments: [] }] }),
    "GET /api/accounts/broken/drafts": ok({ error: "reconnect_required" }, 401),
    "GET /api/accounts/g1/drafts/r1/content": ok({ ...gDraft, text: "Soon", html: "" }),
    "PUT /api/accounts/g1/drafts/r1": (c) => ok({ draftId: "r1", revision: "m6", messageId: "m6", threadId: (c.body as { threadId: string }).threadId }),
    "POST /api/accounts/g1/drafts/r1/send": ok({ status: "accepted", idempotencyKey: "s1", providerMessageId: "sent-1", threadId: "th1" }),
    "DELETE /api/accounts/g1/drafts/r1": ok({ deleted: "r1" }),
  });
  const listed = await call(api, "list_drafts", {});
  assert.equal(listed.isError, false, JSON.stringify(listed.data));
  assert.deepEqual(listed.data.drafts.map((d: { accountId: string; draftId: string; revision: unknown }) => [d.accountId, d.draftId, d.revision]),
    [[`cloudflare:${CF}`, "d1", 2], ["gmail:g1", "r1", "m5"]], "newest first, across providers");
  assert.deepEqual(listed.data.issues.map((i: { accountId: string }) => i.accountId), ["gmail:broken"], "an account that cannot be read is named, the others listed");

  const changed = await call(api, "save_draft", { accountId: "gmail:g1", draftId: "r1", expectedRevision: "m5", to: "ann@x.invalid", subject: "Re: Order", text: "Monday.", keepAttachments: ["att1"] });
  assert.equal(changed.isError, false, JSON.stringify(changed.data));
  const put = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
  assert.deepEqual([put.threadId, put.inReplyTo, put.expectedRevision, put.keepAttachments], ["th1", "<orig@x.invalid>", "m5", ["att1"]], "a change keeps its thread");
  assert.equal(changed.data.revision, "m6");
  const mismatched = await call(api, "send_draft", { accountId: "gmail:g1", draftId: "r1", idempotencyKey: "s1", expectedRevision: 6 });
  assert.equal(mismatched.data.status, 400, "a Gmail revision is a string");
  const sent = await call(api, "send_draft", { accountId: "gmail:g1", draftId: "r1", idempotencyKey: "s1", expectedRevision: "m6" });
  assert.equal(sent.data.status, "accepted");
  assert.deepEqual(calls.find((c) => c.path === "/api/accounts/g1/drafts/r1/send")!.body, { idempotencyKey: "s1", expectedRevision: "m6" });
  const asked = await call(api, "delete_draft", { accountId: "gmail:g1", draftId: "r1" });
  assert.equal(asked.data.needsConfirmation, true);
  assert.match(asked.data.summary, /Re: Order/);
  const tool = TOOLS.find((t) => t.name === "send_draft")!;
  assert.ok(tool.sends && tool.level === "mail", "send_draft counts as a send");
});

// ── Gap 7: View source ──────────────────────────────────────────────

test("read_message includeHeaders returns every header, as View source shows them (parity gap 7)", async () => {
  const stored = [{ key: "from", value: "ann@customer.invalid" }, { key: "dkim-signature", value: "v=1; d=customer.invalid" }];
  const cf = fakeApi({
    [`GET ${CF_BOX}/emails/m1`]: ok(cfEmail({ raw_headers: JSON.stringify(stored) })),
    [`GET ${CF_BOX}/emails/d1`]: ok(cfEmail({ id: "d1", raw_headers: null, message_id: null, in_reply_to: "m1", bcc: "boss@shop.invalid" })),
  });
  const read = await call(cf.api, "read_message", { accountId: `cloudflare:${CF}`, messageId: "m1", includeHeaders: true });
  assert.deepEqual(read.data.headers, [{ name: "from", value: "ann@customer.invalid" }, { name: "dkim-signature", value: "v=1; d=customer.invalid" }]);
  const plain = await call(cf.api, "read_message", { accountId: `cloudflare:${CF}`, messageId: "m1" });
  assert.equal(plain.data.headers, undefined, "headers only when asked");
  const draft = await call(cf.api, "read_message", { accountId: `cloudflare:${CF}`, messageId: "d1", includeHeaders: true });
  assert.deepEqual(draft.data.headers.map((h: { name: string }) => h.name), ["From", "To", "Bcc", "Subject", "Date", "In-Reply-To"],
    "mail with no stored headers shows the fields the app knows");

  const gm = fakeApi({
    "GET /api/accounts/g1/messages/m1": ok(gmailMessage()),
    "GET /api/accounts/g1/messages/m1/headers": ok({ headers: [{ key: "Received", value: "from mx.google.com" }, { key: "Subject", value: "Order" }] }),
  });
  const gread = await call(gm.api, "read_message", { accountId: "gmail:g1", messageId: "m1", includeHeaders: true });
  assert.equal(gread.isError, false, JSON.stringify(gread.data));
  assert.deepEqual(gread.data.headers, [{ name: "Received", value: "from mx.google.com" }, { name: "Subject", value: "Order" }]);
  assert.ok(TOOLS.find((t) => t.name === "read_message")!.routes.includes("GET /api/accounts/:accountId/messages/:messageId/headers"));
});

// ── Gap 3: attachments on send, reply and forward ───────────────────

test("send_email, reply and forward attach files on both providers (parity gap 3)", async () => {
  const answers = {
    [`GET ${CF_BOX}`]: ok({ settings: {} }), [`GET ${CF_BOX}/emails/m1`]: ok(cfEmail()),
    [`POST ${CF_BOX}/emails`]: ok({ id: "ob-1", status: "accepted" }), [`POST ${CF_BOX}/emails/m1/reply`]: ok({ id: "ob-2", status: "accepted" }),
    [`POST ${CF_BOX}/emails/m1/forward`]: ok({ id: "ob-3", status: "accepted" }),
    "GET /api/accounts/g1/messages/m1": ok(gmailMessage()), "GET /api/accounts": GMAIL_ACCOUNTS,
    "POST /api/accounts/g1/send": ok({ status: "accepted", idempotencyKey: "k" }, 202),
  };
  const expected = [{ content: HI_BASE64, filename: "invoice.pdf", type: "application/pdf", disposition: "attachment" }];
  for (const accountId of [`cloudflare:${CF}`, "gmail:g1"]) for (const [name, extra] of [
    ["send_email", { to: "ann@customer.invalid", subject: "Invoice", text: "Attached." }],
    ["reply", { messageId: "m1", text: "Attached." }],
    ["forward", { messageId: "m1", to: "zed@x.invalid" }],
  ] as const) {
    const { api, calls } = fakeApi(answers);
    const sent = await call(api, name, { accountId, idempotencyKey: "k1", attachments: [pdf], ...extra });
    assert.equal(sent.isError, false, `${name} ${accountId}: ${JSON.stringify(sent.data)}`);
    assert.deepEqual(posted(calls).attachments, expected, `${name} on ${accountId} carries the file`);
  }

  const tool = TOOLS.find((t) => t.name === "send_email")!;
  assert.throws(() => z.object(tool.input).parse({ accountId: "gmail:g1", to: "a@x.invalid", subject: "s", text: "t", idempotencyKey: "k",
    attachments: Array.from({ length: 11 }, () => pdf) }), "more than 10 files is refused by the schema");
  const { api, calls } = fakeApi(answers);
  const big = "A".repeat(Math.ceil((5 * 1024 * 1024 + 3) / 3) * 4);
  const refused = await call(api, "send_email", { accountId: `cloudflare:${CF}`, to: "a@x.invalid", subject: "s", text: "t", idempotencyKey: "k2",
    attachments: [{ filename: "big.bin", type: "application/octet-stream", base64: big.slice(0, 6_999_996) }] });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.status, 413);
  const bad = await call(api, "send_email", { accountId: `cloudflare:${CF}`, to: "a@x.invalid", subject: "s", text: "t", idempotencyKey: "k3",
    attachments: [{ filename: "../x", type: "text/plain", base64: HI_BASE64 }] });
  assert.equal(bad.data.status, 400);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing is sent with a refused file");
});

// ── Gap 4: a Gmail forward keeps the original's attachments ────────

test("a Gmail forward carries the original's attachments, as a Cloudflare forward does (parity gap 4)", async () => {
  const gm = fakeApi({
    "GET /api/accounts/g1/messages/m1": ok(gmailMessage({ attachments: [{ providerAttachmentId: "att-1", filename: "a.txt", mimeType: "text/plain", size: 2 }] })),
    // Gmail answers with unpadded base64url: "hi" is "aGk".
    "GET /api/accounts/g1/messages/m1/attachments/att-1": ok({ data: "aGk", size: 2 }),
    "POST /api/accounts/g1/send": ok({ status: "accepted", idempotencyKey: "f1" }, 202),
  });
  const sent = await call(gm.api, "forward", { accountId: "gmail:g1", messageId: "m1", to: "zed@x.invalid", idempotencyKey: "f1" });
  assert.equal(sent.isError, false, JSON.stringify(sent.data));
  assert.deepEqual(posted(gm.calls).attachments, [{ content: HI_BASE64, filename: "a.txt", type: "text/plain", disposition: "attachment" }]);

  const without = fakeApi({ "GET /api/accounts/g1/messages/m1": ok(gmailMessage({ attachments: [{ providerAttachmentId: "att-1", filename: "a.txt", mimeType: "text/plain", size: 2 }] })),
    "POST /api/accounts/g1/send": ok({ status: "accepted" }, 202) });
  for (const args of [{ includeOriginalAttachments: false }, { attachments: false }]) {
    await call(without.api, "forward", { accountId: "gmail:g1", messageId: "m1", to: "zed@x.invalid", idempotencyKey: "f2", ...args });
    assert.equal(without.calls.filter((c) => c.path.includes("/attachments/")).length, 0, JSON.stringify(args));
  }

  const got = await call(fakeApi({ "GET /api/accounts/g1/messages/m1/attachments/att-1": ok({ data: "aGk", size: 2 }) }).api, "get_attachment",
    { accountId: "gmail:g1", messageId: "m1", attachmentId: "att-1" });
  assert.equal(got.data.base64, HI_BASE64, "get_attachment pads Gmail's base64 like every other file");
});

// ── Gap 5: cc, bcc and subject on reply and forward ─────────────────

test("reply and forward take cc, bcc and subject (parity gap 5)", async () => {
  for (const accountId of [`cloudflare:${CF}`, "gmail:g1"]) {
    const { api, calls } = fakeApi({
      [`GET ${CF_BOX}`]: ok({ settings: {} }), [`GET ${CF_BOX}/emails/m1`]: ok(cfEmail()),
      [`POST ${CF_BOX}/emails/m1/reply`]: ok({ id: "ob-1" }), [`POST ${CF_BOX}/emails/m1/forward`]: ok({ id: "ob-2" }),
      "GET /api/accounts/g1/messages/m1": ok(gmailMessage()), "POST /api/accounts/g1/send": ok({ status: "accepted" }, 202),
    });
    await call(api, "reply", { accountId, messageId: "m1", text: "x", idempotencyKey: "r1", cc: "carol@x.invalid", bcc: ["boss@x.invalid"], subject: "About your order" });
    assert.deepEqual([posted(calls).cc, posted(calls).bcc, posted(calls).subject], [["carol@x.invalid"], ["boss@x.invalid"], "About your order"], `reply on ${accountId}`);
    calls.length = 0;
    await call(api, "forward", { accountId, messageId: "m1", to: "zed@x.invalid", idempotencyKey: "f1", cc: "carol@x.invalid", bcc: "boss@x.invalid", subject: "FYI" });
    assert.deepEqual([posted(calls).cc, posted(calls).bcc, posted(calls).subject], [["carol@x.invalid"], ["boss@x.invalid"], "FYI"], `forward on ${accountId}`);
  }
});

// ── Gap 6: HTML keeps the signature and the quote ───────────────────

test("a message given as HTML keeps the signature and the quoted or forwarded original (parity gap 6)", async () => {
  const settings = ok({ settings: { fromName: "Shop support", signature: { enabled: true, text: "— Shop <team>" } } });
  const { api, calls } = fakeApi({
    [`GET ${CF_BOX}`]: settings, [`GET ${CF_BOX}/emails/m1`]: ok(cfEmail()),
    [`POST ${CF_BOX}/emails`]: ok({ id: "ob-1" }), [`POST ${CF_BOX}/emails/m1/reply`]: ok({ id: "ob-2" }), [`POST ${CF_BOX}/emails/m1/forward`]: ok({ id: "ob-3" }),
    [`POST ${CF_BOX}/drafts`]: ok({ id: "d1" }, 201),
  });
  const html = "<html><body><p>Hello</p></body></html>";
  await call(api, "send_email", { accountId: `cloudflare:${CF}`, to: "a@x.invalid", subject: "s", text: "Hello", html, idempotencyKey: "s1" });
  let out = String(posted(calls).html);
  assert.match(out, /<p>Hello<\/p><div class="fabric-signature"[^>]*>— Shop &lt;team&gt;<\/div><\/body><\/html>$/, out);
  assert.match(String(posted(calls).text), /Hello\n\n— Shop <team>$/);

  calls.length = 0;
  await call(api, "reply", { accountId: `cloudflare:${CF}`, messageId: "m1", text: "Soon", html: "<p>Soon</p>", idempotencyKey: "r1" });
  out = String(posted(calls).html);
  assert.ok(out.startsWith("<p>Soon</p><div class=\"fabric-signature\""), out);
  assert.match(out, /class="fabric-quote".*wrote:.*Where is my order\?/s);

  calls.length = 0;
  await call(api, "forward", { accountId: `cloudflare:${CF}`, messageId: "m1", to: "z@x.invalid", text: "FYI", html: "<p>FYI</p>", idempotencyKey: "f1" });
  out = String(posted(calls).html);
  assert.match(out, /^<p>FYI<\/p><div class="fabric-signature".*class="fabric-forward".*Forwarded message.*Where is my order\?/s);

  calls.length = 0;
  await call(api, "save_draft", { accountId: `cloudflare:${CF}`, to: "a@x.invalid", text: "Draft", html: "<p>Draft</p>" });
  assert.match(String(posted(calls).body), /^<p>Draft<\/p><div class="fabric-signature"/);

  const gm = fakeApi({ "GET /api/accounts/g1/messages/m1": ok(gmailMessage()), "POST /api/accounts/g1/send": ok({ status: "accepted" }, 202) });
  await call(gm.api, "reply", { accountId: "gmail:g1", messageId: "m1", text: "Soon", html: "<p>Soon</p>", idempotencyKey: "r2" });
  assert.match(String(posted(gm.calls).html), /^<p>Soon<\/p><div class="fabric-quote".*Where is my order\?/s);
  assert.match(String(posted(gm.calls).text), /^Soon\n\nOn .* wrote:\n> Where is my order\?$/);
});

// ── Gap 13: the attachment limit is said ────────────────────────────

// ── Gap 8: a knowledge collection kept by Fabric ───────────────────

test("save_knowledge_collection makes a collection kept from a Fabric project, and refuses a source on a rename (parity gap 8)", async () => {
  const { api, calls } = fakeApi({ "POST /api/knowledge/collections": ok({ id: "c1" }, 201), "PUT /api/knowledge/collections/c1": ok({ id: "c1" }) });
  const made = await call(api, "save_knowledge_collection", { name: "Docs", source: { kind: "fabric", project: "fabric-inbox", scope: "docs" } });
  assert.equal(made.isError, false, JSON.stringify(made.data));
  assert.deepEqual(posted(calls), { name: "Docs", description: undefined, source: { kind: "fabric", project: "fabric-inbox", scope: "docs" } });
  calls.length = 0;
  const renamed = await call(api, "save_knowledge_collection", { collectionId: "c1", name: "Docs", source: { kind: "manual" } });
  assert.equal(renamed.data.status, 400);
  assert.equal(calls.length, 0);
});

// ── Gaps 9–11: what a person does, named; keys read without secrets ─

test("gmail_connect_link gives the person the server's connect address, and says when Gmail is not set up (parity gap 9)", async () => {
  const link = await call(fakeApi({ "GET /api/accounts": ok({ configuration: "configured", accounts: [], connectUrl: "https://mail.shop.invalid/api/accounts/gmail/connect" }) }).api, "gmail_connect_link", {});
  assert.equal(link.data.url, "https://mail.shop.invalid/api/accounts/gmail/connect");
  const off = await call(fakeApi({ "GET /api/accounts": ok({ configuration: "not_configured", accounts: [] }) }).api, "gmail_connect_link", {});
  assert.equal(off.data.status, 503);
  const tool = TOOLS.find((t) => t.name === "gmail_connect_link")!;
  assert.ok(tool.readOnly && tool.level === "admin");
});

test("the exclusions say where a person does what no tool does (parity gaps 9–11)", async () => {
  const { NOT_TOOLS } = await import("../workers/mcp/tools");
  assert.match(NOT_TOOLS["POST /api/cloudflare/accounts"]!, /Settings → Accounts/);
  assert.equal(NOT_TOOLS["GET /api/agent-keys"], undefined, "reading keys is a tool now");
  assert.ok(NOT_TOOLS["POST /api/agent-keys"] && NOT_TOOLS["DELETE /api/agent-keys/:id"], "making and revoking keys stays a person's");
  assert.ok(NOT_TOOLS["GET /api/accounts/gmail/connect"] && NOT_TOOLS["POST /api/accounts/gmail/connect"]);
});

test("list_agent_keys lists the keys without anything secret (parity gap 11)", async () => {
  const { api } = fakeApi({ "GET /api/agent-keys": ok({ keys: [{ id: "k1", clientId: "abc.access", name: "Research", level: "read", send: "drafts", dailySendLimit: 50,
    createdAt: "2026-10-01T00:00:00Z", expiresAt: null, accounts: ["cloudflare:support@shop.invalid"], clientSecret: "never" }], mcpUrl: "https://mail.shop.invalid/mcp", canIssue: true }) });
  const listed = await call(api, "list_agent_keys", {});
  assert.deepEqual(listed.data.keys, [{ id: "k1", name: "Research", level: "read", send: "drafts", dailySendLimit: 50, accounts: ["cloudflare:support@shop.invalid"],
    createdAt: "2026-10-01T00:00:00Z", expiresAt: null }]);
  assert.doesNotMatch(JSON.stringify(listed.data), /never|abc\.access/);
});

// ── Misleading descriptions and dangerous replaces ─────────────────

test("save_rule changes only what it is given: a rename keeps a rule on, its mode and its limit", async () => {
  const BASE = `/api/automation/${encodeURIComponent(CF)}/rules`;
  const existing = { id: "r1", version: 3, name: "Invoices", enabled: true, mode: "automatic", conditions: { from: "billing@x.invalid" }, action: { type: "archive" }, dailyLimit: 50 };
  const { api, calls } = fakeApi({ [`GET ${BASE}`]: ok([existing]), [`PUT ${BASE}`]: (c) => ok(c.body) });
  const renamed = await call(api, "save_rule", { accountId: `cloudflare:${CF}`, rule: { id: "r1", name: "Bills" } });
  assert.equal(renamed.isError, false, JSON.stringify(renamed.data));
  assert.deepEqual(posted(calls), { ...existing, name: "Bills" });

  calls.length = 0;
  await call(api, "save_rule", { accountId: `cloudflare:${CF}`, rule: { id: "r2", name: "New", conditions: { subject: "hi" }, action: { type: "mark_read" } } });
  assert.deepEqual(posted(calls), { id: "r2", name: "New", conditions: { subject: "hi" }, action: { type: "mark_read" }, enabled: false, mode: "approval", dailyLimit: 20, version: 1 });
  calls.length = 0;
  const incomplete = await call(api, "save_rule", { accountId: `cloudflare:${CF}`, rule: { id: "r3", name: "Half" } });
  assert.equal(incomplete.data.status, 400);
  assert.match(incomplete.data.error, /conditions, action/);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  assert.doesNotMatch(TOOLS.find((t) => t.name === "save_rule")!.description, /raise version/);
});

test("save_project changes only what it is given: a rename keeps the project's domains and addresses", async () => {
  const project = { id: "p1", name: "Shop", domains: ["shop.invalid"], addresses: ["ceo@other.invalid"] };
  const { api, calls } = fakeApi({ "GET /api/projects": ok({ projects: [project] }), "PUT /api/projects/p1": (c) => ok(c.body), "POST /api/projects": (c) => ok(c.body, 201) });
  await call(api, "save_project", { projectId: "p1", name: "Shop EU" });
  assert.deepEqual(posted(calls), { name: "Shop EU", domains: ["shop.invalid"], addresses: ["ceo@other.invalid"] });
  calls.length = 0;
  await call(api, "save_project", { name: "New", domains: ["new.invalid"] });
  assert.deepEqual(posted(calls), { name: "New", domains: ["new.invalid"], addresses: [] });
  const missing = await call(api, "save_project", { projectId: "ghost", name: "x" });
  assert.equal(missing.data.status, 404);
  const nameless = await call(api, "save_project", { domains: ["a.invalid"] });
  assert.equal(nameless.data.status, 400);
});

test("create_address asks the server to make the rule when it can, unless told otherwise", async () => {
  const { api, calls } = fakeApi({ "POST /api/project-addresses": (c) => ok(c.body, 201) });
  await call(api, "create_address", { localPart: "help", domain: "shop.invalid" });
  assert.equal(posted(calls).createRoute, "auto");
  calls.length = 0;
  await call(api, "create_address", { localPart: "help", domain: "shop.invalid", createRoute: false });
  assert.equal(posted(calls).createRoute, false);
});

// ── WS7 (0.12): everything the Add address dialog does, an agent does (SCN-066) ──

test("check_address asks the server about a domain and several names at once", async () => {
  const answer = { domain: "shop.invalid", state: "receiving", names: [{ localPart: "help", status: "available" }] };
  const { api, calls } = fakeApi({ "GET /api/project-addresses/check": ok(answer) });
  const r = await call(api, "check_address", { domain: "Shop.invalid", localParts: ["help", "sales"] });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(calls[0]!.query, { domain: "shop.invalid", names: "help,sales" });
  assert.deepEqual(r.data, answer);
  assert.throws(() => z.object(TOOLS.find((t) => t.name === "check_address")!.input).parse({ domain: "shop.invalid", localParts: Array.from({ length: 51 }, (_, i) => `n${i}`) }));
});

test("create_address passes the signature; create_addresses passes the same settings for every name", async () => {
  const { api, calls } = fakeApi({
    "POST /api/project-addresses": (c) => ok(c.body, 201),
    "POST /api/project-addresses/batch": (c) => ok({ created: 2, failed: 0, results: [], echo: c.body }),
  });
  await call(api, "create_address", { localPart: "help", domain: "shop.invalid", signature: { enabled: true, text: "Help desk" } });
  assert.deepEqual(posted(calls).signature, { enabled: true, text: "Help desk" });
  calls.length = 0;
  const r = await call(api, "create_addresses", { domain: "Shop.invalid", localParts: ["sales", "hello"], agent: { agentId: "a1" }, forwardTo: "me@x.invalid" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(posted(calls), { domain: "shop.invalid", localParts: ["sales", "hello"], name: undefined, agent: { id: "a1" },
    signature: undefined, createRoute: "auto", forwardTo: "me@x.invalid" });
  assert.throws(() => z.object(TOOLS.find((t) => t.name === "create_address")!.input).parse({ localPart: "first..last", domain: "shop.invalid" }), "two dots are refused before the call");
});

test("check_test_message reads whether the test arrived", async () => {
  const { api, calls } = fakeApi({ [`GET /api/project-addresses/${encodeURIComponent(CF)}/test`]: ok({ email: CF, test: { state: "arrived" } }) });
  const r = await call(api, "check_test_message", { address: CF.toUpperCase() });
  assert.equal(r.data.test.state, "arrived");
  assert.equal(calls[0]!.method, "GET");
});

test("descriptions say what the tools do: list_addresses names the chat assistant's instructions", () => {
  const d = (name: string) => TOOLS.find((t) => t.name === name)!.description;
  assert.match(d("list_addresses"), /chat assistant/);
  assert.doesNotMatch(d("list_addresses"), /agent instructions/);
});

test("get_attachment says it returns files up to 5 MB and what happens to a larger one (parity gap 13)", () => {
  const d = TOOLS.find((t) => t.name === "get_attachment")!.description;
  assert.match(d, /5 MB/);
  assert.match(d, /413/);
});
