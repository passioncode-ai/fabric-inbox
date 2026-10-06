import test from "node:test";
import assert from "node:assert/strict";
import { headerBlock, labelsFor, messageFromRaw, messageKey, parseMessageKey, threadKey } from "../workers/providers/imap/mime";
import { mapFolders } from "../workers/providers/imap/sync";
import { makeMime, rawMime } from "../workers/providers/gmail-client";

const meta = { accountId: "acc", role: "inbox" as const, uidValidity: 1700000000, uid: 7, flags: ["\\Flagged"], internalDate: new Date("2026-10-05T10:00:00Z") };

test("encoded-word headers, a windows-1251 body and an 8-bit UTF-8 subject are read as text", async () => {
  const raw = "From: =?UTF-8?B?0JDQvdC90LA=?= <ann@example.org>\r\nTo: =?KOI8-R?Q?=E2=CF=C2?= <bob@example.org>\r\nSubject: Café =?UTF-8?Q?=E2=82=AC?= 100\r\n" +
    "Message-ID: <m1@example.org>\r\nContent-Type: text/plain; charset=windows-1251\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=CF=F0=E8=E2=E5=F2\r\n";
  const m = await messageFromRaw(new TextEncoder().encode(raw), meta, true);
  assert.equal(m.from, "Анна <ann@example.org>");
  assert.equal(m.to, "Боб <bob@example.org>");
  assert.equal(m.subject, "Café € 100");
  assert.equal(m.text.trim(), "Привет");
  assert.equal(m.snippet, "Привет");
  assert.deepEqual(m.labels, ["INBOX", "UNREAD", "STARRED"]);
  assert.equal(m.providerMessageId, "i-1700000000-7");
  assert.equal(m.timestamp, Date.parse("2026-10-05T10:00:00Z"));
  const head = await messageFromRaw(new TextEncoder().encode(raw), meta, false);
  assert.equal(head.text, "", "a header-only read has no body");
  assert.equal(head.subject, "Café € 100");
});

test("folders and flags become the cache's labels", () => {
  assert.deepEqual(labelsFor("sent", ["\\Seen"]), ["SENT"]);
  assert.deepEqual(labelsFor("archive", ["\\Seen"]), []);
  assert.deepEqual(labelsFor("junk", []), ["SPAM", "UNREAD"]);
  assert.deepEqual(labelsFor("drafts", ["\\Draft", "\\Seen"]), ["DRAFT"]);
  assert.deepEqual(parseMessageKey(messageKey("trash", 9, 12)), { role: "trash", uidValidity: 9, uid: 12 });
  assert.equal(parseMessageKey("gmail-id-abc"), null);
});

test("a reply joins its conversation through References, else In-Reply-To", () => {
  const root = threadKey(undefined, undefined, "<Root@Example.org>", "x");
  assert.equal(threadKey("<root@example.org> <mid@example.org>", "<mid@example.org>", "<leaf@example.org>", "y"), root);
  assert.equal(threadKey(undefined, "<root@example.org>", "<other@example.org>", "z"), root);
  assert.notEqual(threadKey(undefined, undefined, undefined, "a"), threadKey(undefined, undefined, undefined, "b"));
  assert.match(root, /^t[0-9a-f]{16}$/);
});

test("the header block ends at the first empty line, with any line ending", () => {
  assert.equal(new TextDecoder().decode(headerBlock("A: 1\nB: 2\n\nbody")), "A: 1\nB: 2\r\n\r\n");
  assert.equal(new TextDecoder().decode(headerBlock("A: 1\r\n\r\nbody")), "A: 1\r\n\r\n");
});

test("folders are found by SPECIAL-USE, else by their usual names; Gmail's All Mail is an archive target only", () => {
  const special = mapFolders([{ path: "INBOX", flags: [] }, { path: "[Gmail]/Sent Mail", specialUse: "\\Sent", flags: [] }, { path: "[Gmail]/All Mail", specialUse: "\\All", flags: [] },
    { path: "[Gmail]/Spam", specialUse: "\\Junk", flags: [] }, { path: "[Gmail]", flags: ["\\Noselect"] }]);
  assert.deepEqual(special.roles, { inbox: "INBOX", sent: "[Gmail]/Sent Mail", junk: "[Gmail]/Spam" });
  assert.deepEqual(special.targets, { archive: "[Gmail]/All Mail" });
  const named = mapFolders([{ path: "INBOX", flags: [] }, { path: "INBOX.Sent Messages", delimiter: ".", flags: [] }, { path: "INBOX.Deleted Messages", delimiter: ".", flags: [] },
    { path: "Спам", flags: [] }, { path: "Черновики", flags: [] }]);
  assert.deepEqual(named.roles, { inbox: "INBOX", sent: "INBOX.Sent Messages", trash: "INBOX.Deleted Messages", junk: "Спам", drafts: "Черновики" });
});

test("the SMTP copy leaves Bcc out and carries Date and Message-ID; Gmail's base64url copy is unchanged", () => {
  const input = { to: ["b@example.org"], bcc: ["c@example.org"], subject: "S", text: "t" };
  const kept = rawMime("a@example.org", input, ["Date: Mon, 05 Oct 2026 10:00:00 +0000", "Message-ID: <x@example.org>"]);
  const wire = rawMime("a@example.org", input, ["Date: Mon, 05 Oct 2026 10:00:00 +0000", "Message-ID: <x@example.org>"], { omitBcc: true });
  assert.match(kept, /^Bcc: c@example\.org$/m);
  assert.doesNotMatch(wire, /^Bcc:/m);
  assert.match(wire, /^Message-ID: <x@example\.org>$/m);
  const gmail = Buffer.from(makeMime("a@example.org", input), "base64url").toString();
  assert.match(gmail, /^Bcc: c@example\.org$/m, "Gmail gets the Bcc header and strips it itself");
  assert.doesNotMatch(gmail, /^(Date|Message-ID):/m, "Gmail adds Date and Message-ID itself");
  assert.throws(() => rawMime("a@example.org", input, ["Evil: x\r\nBcc: d@example.org"]), /invalid_header/, "an extra header cannot smuggle another");
});
