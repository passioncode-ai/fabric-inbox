import { test } from "node:test";
import assert from "node:assert/strict";
import { trimReferences } from "../shared/mail/references";
import { rawMime } from "../workers/providers/gmail-client";
import { buildThreadingHeaders } from "../workers/lib/email-helpers";

// M-1: a reply in a long thread was refused (invalid_header) once References passed one header line.
const ids = Array.from({ length: 14 }, (_, i) => `<CAF${String(i).padStart(2, "0")}${"x".repeat(60)}@mail.gmail.invalid>`);

test("a long References chain keeps its root and its most recent ids, within one header line", () => {
  const trimmed = trimReferences(ids.join(" "));
  assert.ok(trimmed.length <= 900, String(trimmed.length));
  const kept = trimmed.split(" ");
  assert.equal(kept[0], ids[0], "the root");
  assert.equal(kept.at(-1), ids.at(-1), "the parent");
  assert.deepEqual(kept.slice(1), ids.slice(ids.length - kept.length + 1), "the newest, in order");
  assert.equal(trimReferences("<a@b.invalid>  <c@d.invalid>"), "<a@b.invalid> <c@d.invalid>", "a short one is only tidied");
  assert.equal(trimReferences(""), "");
});

test("a reply from an account in a 14-message thread is built, not refused", () => {
  const raw = rawMime("me@mail.invalid", { to: ["ann@x.invalid"], subject: "Re: hi", text: "ok", inReplyTo: ids.at(-1), references: ids.join(" ") } as never);
  const line = raw.split("\r\n").find((l) => l.startsWith("References: "))!;
  assert.ok(line.length <= 998);
  assert.ok(line.includes(ids[0]!) && line.includes(ids.at(-1)!));
});

test("a Cloudflare mailbox's reply trims the chain the same way", () => {
  const h = buildThreadingHeaders("parent@x.invalid", ids.map((i) => i.slice(1, -1)));
  assert.ok(h.References!.length <= 900);
  assert.ok(h.References!.startsWith(ids[0]!));
});

test("M-5: a reply from the app carries the parent's chain and the parent's own Message-ID", async () => {
  const { replyReferences } = await import("../shared/mail/references");
  assert.equal(replyReferences(undefined, "<p@x.invalid>"), "<p@x.invalid>", "a reply to the first message has a References header");
  assert.equal(replyReferences("<a@x.invalid> <b@x.invalid>", "<p@x.invalid>"), "<a@x.invalid> <b@x.invalid> <p@x.invalid>");
  assert.equal(replyReferences(undefined, undefined), undefined);
});
