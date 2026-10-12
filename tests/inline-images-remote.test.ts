// B-89: the embedded (cid:) pictures of Gmail, IMAP and Outlook messages were shown broken. Those
// providers kept no Content-ID for a message's parts and had no route that answers a part's bytes,
// so the reader left `cid:` in the HTML (Cloudflare mail was fixed by `inlineView`, bug hunt 2026-10-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineView, normalizeMessage as openMessage, type OpenMessage } from "../app/components/inbox/model";
import { mailImagePolicy } from "../app/lib/mail-image-policy";
import { normalizeMessage as gmailMessage, ProviderError, type GmailMessage } from "../workers/providers/gmail-client";
import { messageFromRaw } from "../workers/providers/imap/mime";
import { messageWithBody, type GraphMessage } from "../workers/providers/outlook/convert";
import { listAttachments } from "../workers/providers/outlook/sync";
import { inlinePart, needsInlineRefresh } from "../workers/providers/account-service";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

test("B-89: Gmail keeps each part's Content-ID and whether it is inline", () => {
  const raw: GmailMessage = {
    id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "0", snippet: "",
    payload: {
      mimeType: "multipart/related", headers: [{ name: "Subject", value: "S" }],
      parts: [
        { mimeType: "text/html", headers: [], body: { data: b64url('<img src="cid:logo@x">') } },
        { mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-ID", value: "<logo@x>" }, { name: "Content-Disposition", value: 'inline; filename="logo.png"' }], body: { attachmentId: "att-logo", size: 10 } },
        { mimeType: "image/jpeg", filename: "photo.jpg", headers: [{ name: "X-Attachment-Id", value: "ii_1" }, { name: "Content-ID", value: "<ii_1>" }], body: { attachmentId: "att-photo", size: 20 } },
        { mimeType: "application/pdf", filename: "r.pdf", headers: [{ name: "Content-Disposition", value: 'attachment; filename="r.pdf"' }], body: { attachmentId: "att-pdf", size: 30 } },
      ],
    },
  } as GmailMessage;
  const files = gmailMessage("gmail:g1", raw).attachments;
  assert.deepEqual(files.map((f) => [f.providerAttachmentId, f.contentId, f.inline]), [
    ["att-logo", "logo@x", true],
    ["att-photo", "ii_1", false],
    ["att-pdf", undefined, false],
  ]);
});

test("B-89: IMAP keeps each part's Content-ID and whether it is inline", async () => {
  const raw = [
    "From: a@x.invalid", "To: me@p.invalid", "Subject: S", "Message-ID: <m1@x>", "Date: Mon, 12 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="b"', "",
    "--b", "Content-Type: text/html; charset=utf-8", "", '<p>Hi</p><img src="cid:logo@x">',
    "--b", 'Content-Type: image/png; name="logo.png"', 'Content-Disposition: inline; filename="logo.png"', "Content-ID: <logo@x>",
    "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=",
    "--b", 'Content-Type: application/pdf; name="r.pdf"', 'Content-Disposition: attachment; filename="r.pdf"',
    "Content-Transfer-Encoding: base64", "", "JVBERi0=", "--b--", "",
  ].join("\r\n");
  const m = await messageFromRaw(raw, { accountId: "imap:i1", role: "inbox", uidValidity: 1, uid: 7, flags: [] }, true);
  assert.deepEqual(m.attachments.map((f) => [f.filename, f.contentId, f.inline]), [["logo.png", "logo@x", true], ["r.pdf", undefined, false]]);
});

test("B-89: Outlook keeps the Content-ID Graph gives a file attachment", async () => {
  const meta = { id: "g1", subject: "S", receivedDateTime: "2026-10-12T10:00:00Z", isRead: true, hasAttachments: true } as GraphMessage;
  const m = await messageWithBody("outlook:o1", meta, "inbox", null, [
    { id: "att-1", "@odata.type": "#microsoft.graph.fileAttachment", name: "logo.png", contentType: "image/png", size: 10, isInline: true, contentId: "logo@x" },
    { id: "att-2", "@odata.type": "#microsoft.graph.fileAttachment", name: "r.pdf", contentType: "application/pdf", size: 30, isInline: false, contentId: null },
  ]);
  assert.deepEqual(m.attachments.map((f) => [f.filename, f.contentId, f.inline]), [["logo.png", "logo@x", true], ["r.pdf", undefined, false]]);
});

test("B-89: Outlook asks Graph for the Content-ID and falls back to the old list when Graph refuses the cast", async () => {
  const asked: string[] = [];
  const graph = (refuse: boolean) => ({
    json: async <T>(path: string): Promise<T> => {
      asked.push(path);
      if (refuse && path.includes("microsoft.graph.fileAttachment/contentId")) throw new ProviderError("provider_rejected", 400);
      return { value: [{ id: "a", name: "n", isInline: true }] } as T;
    },
  });
  assert.equal((await listAttachments(graph(false), "g1")).length, 1);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\$select=id,name,contentType,size,isInline,microsoft\.graph\.fileAttachment\/contentId$/);
  asked.length = 0;
  assert.equal((await listAttachments(graph(true), "g1")).length, 1);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /\$select=id,name,contentType,size,isInline$/);
  const other = { json: async () => { throw new ProviderError("access_denied", 403); } };
  await assert.rejects(listAttachments(other, "g1"), /access_denied/);
});

const remoteOpen = (): OpenMessage => openMessage({
  subject: "S", from: "a@x.invalid", to: "me@p.invalid", date: "2026-10-12T10:00:00Z", read: true, threadId: "t1",
  html: '<p>Hi</p><img src="cid:logo@x"><img src="cid:ii_1">',
  attachments: [
    { filename: "logo.png", mimeType: "image/png", size: 10, providerAttachmentId: "att-logo", contentId: "logo@x", inline: true },
    { filename: "photo.jpg", mimeType: "image/jpeg", size: 20, providerAttachmentId: "att-photo", contentId: "ii_1", inline: false },
    { filename: "r.pdf", mimeType: "application/pdf", size: 30, providerAttachmentId: "att-pdf", inline: false },
  ],
} as never, "gmail");

test("B-89: a Gmail, IMAP or Outlook message's cid: pictures point at the account's inline route and leave the download list", () => {
  const v = inlineView(remoteOpen(), "gmail", "gmail:g1", "m/1");
  assert.match(v.html!, /src="\/api\/accounts\/g1\/messages\/m%2F1\/attachments\/att-logo\/inline"/);
  assert.match(v.html!, /src="\/api\/accounts\/g1\/messages\/m%2F1\/attachments\/att-photo\/inline"/, "a referenced Content-ID counts even without an inline disposition");
  assert.doesNotMatch(v.html!, /cid:/);
  assert.deepEqual(v.inline, { mailboxId: "g1", emailId: "m/1", attachmentIds: ["att-logo", "att-photo"], remote: true });
  assert.deepEqual(v.listed.map((a) => a.id), ["att-pdf"]);
  for (const provider of ["imap", "outlook"] as const) assert.equal(inlineView(remoteOpen(), provider, `${provider}:x1`, "m1").inline?.remote, true);
});

test("B-89: the reader's frame may load exactly those inline routes", () => {
  const policy = mailImagePolicy(false, "https://mail.example.invalid", { mailboxId: "g1", emailId: "m/1", attachmentIds: ["att-logo"], remote: true });
  assert.match(policy, /img-src data: cid: https:\/\/mail\.example\.invalid\/api\/accounts\/g1\/messages\/m%2F1\/attachments\/att-logo\/inline;/);
});

test("B-89: the inline route answers only a picture the message names by Content-ID", () => {
  const files = [
    { filename: "logo.png", mimeType: "image/png", size: 10, providerAttachmentId: "att-logo", contentId: "logo@x", inline: true },
    { filename: "x.svg", mimeType: "image/svg+xml", size: 10, providerAttachmentId: "att-svg", contentId: "svg@x", inline: true },
    { filename: "page.html", mimeType: "text/html", size: 10, providerAttachmentId: "att-html", contentId: "h@x", inline: true },
    { filename: "r.pdf", mimeType: "application/pdf", size: 30, providerAttachmentId: "att-pdf", inline: false },
  ];
  assert.equal(inlinePart(files, "att-logo")?.mimeType, "image/png");
  assert.equal(inlinePart(files, "att-svg"), null, "SVG can carry script; it stays a download");
  assert.equal(inlinePart(files, "att-html"), null);
  assert.equal(inlinePart(files, "att-pdf"), null);
  assert.equal(inlinePart(files, "missing"), null);
});

test("B-89: a message cached before parts kept their Content-ID is read again once", () => {
  assert.equal(needsInlineRefresh([{ filename: "a", mimeType: "image/png", size: 1, providerAttachmentId: "a" }]), true);
  assert.equal(needsInlineRefresh([{ filename: "a", mimeType: "image/png", size: 1, providerAttachmentId: "a", inline: false }]), false);
  assert.equal(needsInlineRefresh([]), false);
});
