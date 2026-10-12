// The main inbox showed broken images for every embedded picture (logos, signatures, pasted
// screenshots): it passed the HTML with its cid: references as they were, and listed the inline parts
// as attachments to download (bug hunt 2026-10-12). The legacy reader already rewrote them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineView, type OpenMessage } from "../app/components/inbox/model";

const open = (over: Partial<OpenMessage> = {}): OpenMessage => ({
  subject: "S", from: "a@x.invalid", to: "me@p.invalid", date: "2026-10-12T10:00:00Z", read: true,
  html: '<p>Hi</p><img src="cid:logo@x"><img src="cid:other">',
  attachments: [
    { id: "a1", filename: "logo.png", mimeType: "image/png", size: 100, disposition: "inline", contentId: "<logo@x>" },
    { id: "a2", filename: "report.pdf", mimeType: "application/pdf", size: 2000, disposition: "attachment" },
  ], ...over,
});

test("a Cloudflare message's cid: images point at its inline parts, which leave the download list", () => {
  const v = inlineView(open(), "cloudflare", "cloudflare:me@p.invalid", "e1");
  assert.match(v.html!, /src="\/api\/v1\/mailboxes\/me%40p\.invalid\/emails\/e1\/attachments\/a1"/);
  assert.doesNotMatch(v.html!, /cid:logo@x/);
  assert.deepEqual(v.inline, { mailboxId: "me@p.invalid", emailId: "e1", attachmentIds: ["a1"] });
  assert.deepEqual(v.listed.map((a) => a.id), ["a2"], "the inline picture is not offered as a download");
});

test("an inline part the HTML never references stays downloadable; other providers use their inline route (B-89)", () => {
  const unused = inlineView(open({ html: "<p>No pictures</p>" }), "cloudflare", "cloudflare:me@p.invalid", "e1");
  assert.deepEqual(unused.listed.map((a) => a.id), ["a1", "a2"]);
  const gmail = inlineView(open(), "gmail", "gmail:g1", "m1");
  assert.deepEqual(gmail.inline, { mailboxId: "g1", emailId: "m1", attachmentIds: ["a1"], remote: true });
  assert.match(gmail.html!, /src="\/api\/accounts\/g1\/messages\/m1\/attachments\/a1\/inline"/);
});
