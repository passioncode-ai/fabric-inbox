import test from "node:test";
import assert from "node:assert/strict";
import { ImapConnection, loginFailure, type ImapTransport } from "../workers/providers/imap/client";
import { ProviderError } from "../workers/providers/gmail-client";
import { FakeImap } from "./fake-imap";

const USER = "ann@example.invalid", PASS = "app-password";
const PLAIN: ImapTransport = { secure: false, timeoutMs: 3_000 };
const mail = (subject: string, id = `<${subject.replace(/\W/g, "")}@example.invalid>`) =>
  `From: Bob <bob@example.invalid>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: Mon, 5 Oct 2026 10:00:00 +0000\r\n\r\nHello ${subject}\r\n`;

async function server(options: ConstructorParameters<typeof FakeImap>[0] = {}) {
  return new FakeImap({ users: { [USER]: PASS }, ...options }).start();
}

test("a refused login is a public code; the server's words decide which one", async (t) => {
  const imap = await server();
  t.after(() => imap.stop());
  await assert.rejects(ImapConnection.connect({ host: "127.0.0.1", port: imap.port, user: USER, password: "wrong" }, PLAIN),
    (e: ProviderError) => e instanceof ProviderError && e.code === "auth_failed" && e.status === 401);
  assert.ok(imap.commands.some((c) => c.endsWith("<secret>")), "the password is never logged by the fixture either");
  assert.equal(loginFailure({ authenticationFailed: true, responseText: "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)" }), "app_password_required");
  assert.equal(loginFailure({ authenticationFailed: true, responseText: "[AUTHENTICATIONFAILED] IMAP access is disabled for this account" }), "imap_disabled");
  assert.equal(loginFailure({ authenticationFailed: true, responseText: "[ALERT] Please log in via your web browser" }), "web_login_required");
  // Real answers, read from the providers' servers on 2026-10-06 with a made-up account.
  assert.equal(loginFailure({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", responseText: "AUTHENTICATE invalid credentials or IMAP is disabled sc=x" }), "auth_or_imap_disabled");
  assert.equal(loginFailure({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", responseText: "NEOBHODIM parol prilozheniya https://help.mail.ru/mail/security/protection/external / Application password is REQUIRED" }), "app_password_required");
  assert.equal(loginFailure({ authenticationFailed: true, serverResponseCode: "ALERT", responseText: "Invalid credentials (Failure)" }), "auth_failed");
  assert.equal(loginFailure({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", responseText: "AUTHENTICATE Invalid credentials" }), "auth_failed");
  const alert = await server({ loginFailure: "NO [ALERT] Application-specific password required" });
  t.after(() => alert.stop());
  await assert.rejects(ImapConnection.connect({ host: "127.0.0.1", port: alert.port, user: USER, password: "normal" }, PLAIN), (e: ProviderError) => e.code === "app_password_required");
});

test("a server out of reach is host_unreachable", async () => {
  await assert.rejects(ImapConnection.connect({ host: "127.0.0.1", port: 1, user: USER, password: PASS }, PLAIN), (e: ProviderError) => e.code === "host_unreachable");
});

test("folders with their special use, a folder's state, fetch, search, flags, move, append and delete", async (t) => {
  const imap = await server({ condstore: true });
  t.after(() => imap.stop());
  const first = imap.deliver("INBOX", mail("one")), second = imap.deliver("INBOX", mail("two"), { flags: ["\\Seen"] });
  const c = await ImapConnection.connect({ host: "127.0.0.1", port: imap.port, user: USER, password: PASS }, PLAIN);
  t.after(() => c.close());
  const folders = await c.folders();
  assert.equal(folders.find((f) => f.path === "Sent")?.specialUse, "\\Sent");
  assert.equal(folders.find((f) => f.path === "INBOX")?.specialUse, "\\Inbox");
  const inbox = await c.open("INBOX", true);
  assert.equal(inbox.exists, 2);
  assert.equal(inbox.uidValidity, imap.folder("INBOX").uidValidity);
  assert.equal(inbox.uidNext, 3);
  assert.ok(inbox.highestModseq, "CONDSTORE servers say their highest modseq");
  const rows = await c.fetch("1:*", { source: true });
  assert.deepEqual(rows.map((r) => r.uid), [first, second]);
  assert.match(new TextDecoder().decode(rows[0]!.source), /Subject: one/);
  assert.deepEqual(rows[1]!.flags, ["\\Seen"]);
  const heads = await c.fetch(String(second), { headers: true });
  assert.match(new TextDecoder().decode(heads[0]!.headers), /Subject: two\r\n/);
  assert.ok(!new TextDecoder().decode(heads[0]!.headers).includes("Hello"), "a header fetch carries no body");
  assert.deepEqual(await c.uids(), [first, second]);
  assert.deepEqual(await c.findMessageId("<two@example.invalid>"), [second]);
  await c.setFlags(first, ["\\Flagged", "\\Seen"], []);
  assert.deepEqual([...imap.folder("INBOX").messages[0]!.flags].sort(), ["\\Flagged", "\\Seen"]);
  const since = (await c.fetch("1:*", {}, { changedSince: String(Number(inbox.highestModseq)) })).map((r) => r.uid);
  assert.deepEqual(since, [first], "only what changed since the modseq");
  const moved = await c.move(first, "Archive");
  assert.equal(moved, imap.folder("Archive").messages[0]!.uid);
  assert.equal(imap.folder("INBOX").messages.length, 1);
  const appended = await c.append("Sent", mail("sent copy"), ["\\Seen"], new Date("2026-10-05T10:00:00Z"));
  assert.equal(appended.uid, imap.folder("Sent").messages[0]!.uid);
  assert.equal(appended.uidValidity, imap.folder("Sent").uidValidity);
  await c.remove(second);
  assert.equal(imap.folder("INBOX").messages.length, 0);
  await assert.rejects(c.open("Nowhere"), (e: ProviderError) => e.code === "folder_missing");
});

test("without MOVE the move is a copy, a delete and an expunge, and still answers the new UID", async (t) => {
  const imap = await server({ move: false });
  t.after(() => imap.stop());
  const uid = imap.deliver("INBOX", mail("old style"));
  const c = await ImapConnection.connect({ host: "127.0.0.1", port: imap.port, user: USER, password: PASS }, PLAIN);
  t.after(() => c.close());
  await c.open("INBOX", true);
  const moved = await c.move(uid, "Trash");
  assert.equal(moved, 1);
  assert.equal(imap.folder("INBOX").messages.length, 0);
  assert.equal(imap.folder("Trash").messages.length, 1);
});
