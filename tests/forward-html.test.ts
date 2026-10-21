import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardBody, splitForward, withForward, withForwardText } from "../shared/mail/forward";
import { syncDraft, openServerDraft } from "../app/components/inbox/server-drafts";
import { prepareMessage } from "../app/components/inbox/compose-payload";
import type { AttachmentStorage } from "../app/components/inbox/attachment-store";
import type { Draft } from "../app/components/inbox/draft-store";

// Operator, 2026-10-21: a forwarded mail with buttons arrived as text, and nobody could press them.
const ORIGINAL = '<html><head><style>.b{color:red}</style></head><body><p>Confirm your order</p><a class="b" href="https://shop.example/confirm?o=7">Confirm</a></body></html>';
const files: AttachmentStorage = { add: async () => {}, get: async () => undefined, remove: async () => {} };
const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "d1", accountId: "cloudflare:me@x.invalid", to: "ann@y.invalid", subject: "Fwd: Order", idempotencyKey: "k1", mode: "forward",
  text: "Look at this.\n\nForwarded message\nFrom: shop@shop.example\nSubject: Order", forwardHtml: forwardBody(ORIGINAL),
  forwardSource: { accountId: "cloudflare:me@x.invalid", originalId: "m1", provider: "cloudflare", files: [] }, ...over,
});

test("the original goes below the text as it was: its button and link stay, and it splits back out", () => {
  const html = withForward("Look at this.", forwardBody(ORIGINAL));
  assert.match(html, /<a class="b" href="https:\/\/shop\.example\/confirm\?o=7">Confirm<\/a>/);
  assert.doesNotMatch(html, /<html|<body/, "a whole document is reduced to its body so it nests");
  const parts = splitForward(html);
  assert.equal(parts.original, forwardBody(ORIGINAL));
  assert.match(parts.before, /Look at this\./);
  assert.deepEqual(splitForward("<p>plain</p>"), { before: "<p>plain</p>", original: null });
  assert.match(withForwardText("Look at this.", ORIGINAL), /^Look at this\.\n\nConfirm your order/);
});

test("a send carries the original's HTML and the same content as text", async () => {
  const m = await prepareMessage(draft(), files) as { text: string; html?: string };
  assert.match(m.html!, /href="https:\/\/shop\.example\/confirm\?o=7"/);
  assert.match(m.text, /Forwarded message[\s\S]*Confirm your order/);
  const plain = await prepareMessage(draft({ forwardHtml: undefined, mode: "new", forwardSource: undefined }), files) as { html?: string };
  assert.equal(plain.html, undefined, "a message without an original is sent as before");
});

test("a Cloudflare draft keeps the original as HTML and opens again with the text apart from it", async () => {
  let saved: Record<string, unknown> = {};
  const request = (async (url: string, body?: unknown) => {
    if (body) { saved = body as Record<string, unknown>; return { id: "d1", revision: 1, attachments: [] }; }
    return { id: "d1", revision: 1, to: "ann@y.invalid", cc: null, bcc: null, subject: "Fwd: Order", body: saved.body, inReplyTo: null, threadId: null, attachments: [] };
  }) as never;
  assert.equal((await syncDraft(draft(), files, request)).ok, true);
  assert.match(String(saved.body), /href="https:\/\/shop\.example\/confirm\?o=7"/);
  const opened = await openServerDraft({ accountId: "cloudflare:me@x.invalid", serverId: "d1" }, request);
  assert.equal(opened.forwardHtml, forwardBody(ORIGINAL));
  assert.match(opened.text, /Look at this\./);
  assert.doesNotMatch(opened.text, /Confirm your order/, "the original is not turned into text to edit");
});

test("a Gmail draft sends the original as its HTML part and the whole as text", async () => {
  let saved: Record<string, unknown> = {};
  const request = (async (url: string, body?: unknown) => {
    if (body) { saved = body as Record<string, unknown>; return { status: "accepted", providerDraftId: "g1", providerMessageId: "r1", draftId: "g1", revision: "r1", attachments: [] }; }
    return null;
  }) as never;
  await syncDraft(draft({ accountId: "gmail:a1", pendingCreateKey: "draft-d1-k", forwardSource: { accountId: "gmail:a1", originalId: "m1", provider: "gmail", files: [] } }), files, request);
  const message = (saved.message ?? saved) as { text: string; html?: string };
  assert.match(String(message.html), /href="https:\/\/shop\.example\/confirm\?o=7"/);
  assert.match(message.text, /Confirm your order/);
});
