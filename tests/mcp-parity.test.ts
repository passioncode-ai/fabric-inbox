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

test("get_attachment says it returns files up to 5 MB and what happens to a larger one (parity gap 13)", () => {
  const d = TOOLS.find((t) => t.name === "get_attachment")!.description;
  assert.match(d, /5 MB/);
  assert.match(d, /413/);
});
