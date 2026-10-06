import test from "node:test";
import assert from "node:assert/strict";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { ProviderError } from "../workers/providers/gmail-client";
import type { ImapAccount } from "../workers/providers/imap/types";
import { MemoryStore } from "./memory-store";
import { FakeImap, type FakeImapOptions } from "./fake-imap";
import { FakeSmtp, nodeSockets, type FakeSmtpOptions } from "./fake-smtp";

/**
 * IMAP/SMTP accounts end to end through AccountService (WS4): connect with an app password, the
 * first import, new mail, flag changes, deletions, a renumbered folder, mail actions, sends with
 * their receipts, drafts, a refused password and a new one — against an in-process IMAP server
 * (imapflow speaking to it over node net) and an in-process SMTP server.
 */
const EMAIL = "ann@fastmail.com", PASS = "app-pass-1234-5678";
const KEY = Buffer.alloc(32, 4).toString("base64url");
const DAY = 86_400_000;
const mail = (subject: string, o: { id?: string; from?: string; refs?: string; body?: string; extra?: string } = {}) =>
  `From: ${o.from ?? "Bob <bob@example.org>"}\r\nTo: ${EMAIL}\r\nSubject: ${subject}\r\nMessage-ID: ${o.id ?? `<${subject.replace(/\W/g, "")}@example.org>`}\r\n` +
  `${o.refs ? `In-Reply-To: ${o.refs}\r\nReferences: ${o.refs}\r\n` : ""}Date: Mon, 5 Oct 2026 10:00:00 +0000\r\n${o.extra ?? ""}Content-Type: text/plain; charset=utf-8\r\n\r\n${o.body ?? `Hello, ${subject}`}\r\n`;

async function fixture(t: test.TestContext, imapOptions: FakeImapOptions = {}, smtpOptions: FakeSmtpOptions = {}) {
  const imap = await new FakeImap({ users: { [EMAIL]: PASS }, ...imapOptions }).start();
  const smtp = await new FakeSmtp({ users: { [EMAIL]: PASS }, ...smtpOptions }).start();
  t.after(async () => { await imap.stop(); await smtp.stop(); });
  const store = new MemoryStore();
  const sockets = nodeSockets({ port: () => smtp.port });
  const service = new AccountService(store, { MAIL_CREDENTIAL_KEY: KEY }, async () => { throw new Error("no HTTP in this test"); }, {
    imap: { transport: { secure: false, timeoutMs: 3_000, resolve: () => ({ host: "127.0.0.1", port: imap.port }) }, sockets },
  });
  return { imap, smtp, store, service, sockets };
}
const account = async (store: MemoryStore, id: string) => (await store.get<ImapAccount>("account:" + id))!;
/** Syncs until nothing is waiting (or 20 rounds). */
async function settle(service: AccountService, id: string) {
  for (let i = 0; i < 20; i++) {
    const a = await service.sync(id, { deadline: Date.now() + 10_000 });
    const sync = a.sync as ImapAccount["sync"];
    if (sync.mode === "history" && !sync.more) return a;
  }
  throw new Error("sync did not settle");
}

test("connecting checks IMAP, the folders and SMTP before anything is stored; the password is sealed", async (t) => {
  const { service, store, imap, smtp } = await fixture(t);
  const logs: string[] = [];
  const log = console.log, warn = console.warn;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.warn = (...a: unknown[]) => logs.push(a.join(" "));
  t.after(() => { console.log = log; console.warn = warn; });
  await assert.rejects(service.connectImap({ preset: "fastmail", email: EMAIL, password: "wrong" }), (e: ProviderError) => e.code === "auth_failed");
  assert.equal((await store.list({ prefix: "account:" })).size, 0, "nothing is kept for a refused password");
  smtp.options.users = { [EMAIL]: "another" };
  await assert.rejects(service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS }), (e: ProviderError) => e.code === "smtp_auth_failed");
  assert.equal((await store.list({ prefix: "account:" })).size, 0, "an IMAP login alone is not a connection");
  smtp.options.users = { [EMAIL]: PASS };
  const connected = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  assert.equal(connected.provider, "imap");
  assert.equal(connected.status, "syncing");
  assert.ok(!("credentials" in connected), "the public account carries no credentials");
  const stored = await account(store, connected.id);
  assert.equal(stored.credentials.version, 2);
  assert.ok(!JSON.stringify([...store.data.values()]).includes(PASS), "the password is nowhere in storage in the clear");
  assert.deepEqual(stored.sync.folders.map((f) => f.role).sort(), ["archive", "drafts", "inbox", "junk", "sent", "trash"]);
  assert.equal(stored.server.imap.host, "imap.fastmail.com");
  assert.equal(stored.server.smtp.port, 465);
  assert.ok(imap.logins >= 2 && smtp.commands.includes("AUTH PLAIN <secret>"));
  assert.ok(!logs.join("\n").includes(PASS), "the password is never logged");
  const listed = await service.listAccounts();
  assert.equal(listed.accounts[0]!.capabilities!.organization, "folders");
  assert.equal(listed.accounts[0]!.capabilities!.archive, true);
  assert.equal(listed.accounts[0]!.providerName, "Fastmail");
  assert.equal(listed.providers.find((p) => p.id === "imap")!.status, "configured");
  // Connecting the same mailbox again (a new password) keeps the account and its id.
  assert.equal((await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS })).id, connected.id);
});

test("the first sync imports newest first: the recent Inbox whole, older mail and other folders headers only, no events", async (t) => {
  const { service, imap, store } = await fixture(t);
  imap.deliver("INBOX", mail("Old news"), { date: new Date(Date.now() - 90 * DAY), flags: ["\\Seen"] });
  imap.deliver("INBOX", mail("Fresh", { extra: "List-Id: <news.example.org>\r\n" }), { date: new Date(Date.now() - DAY) });
  imap.deliver("Sent", mail("My reply", { from: EMAIL }), { flags: ["\\Seen"] });
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  const synced = await settle(service, id);
  assert.equal(synced.status, "connected");
  const inbox = await service.listInboxMessages(id, { folder: "inbox", query: "", limit: 10 });
  assert.deepEqual(inbox.map((m) => m.subject), ["Fresh", "Old news"]);
  assert.equal(inbox[0]!.accountId, "imap:" + id);
  assert.equal(inbox[0]!.provider, "imap");
  assert.equal(inbox[0]!.read, false);
  assert.equal(inbox[1]!.read, true);
  assert.equal(inbox[0]!.triage?.group !== undefined, true, "triage reads IMAP mail as it reads Gmail's");
  const sent = await service.listInboxMessages(id, { folder: "sent", query: "", limit: 10 });
  assert.deepEqual(sent.map((m) => m.subject), ["My reply"]);
  const rows = await service.listMessages(id, {});
  const fresh = rows.messages.find((m) => m.subject === "Fresh")!;
  const old = rows.messages.find((m) => m.subject === "Old news")!;
  assert.match(fresh.providerMessageId, /^i-\d+-\d+$/);
  assert.equal(fresh.signals?.listId, true);
  assert.equal((await store.get<{ bodyless?: boolean }>(`message:${id}:${old.providerMessageId}`))!.bodyless, true, "older mail waits for its body");
  assert.equal((await store.get<{ bodyless?: boolean }>(`message:${id}:${fresh.providerMessageId}`))!.bodyless, undefined);
  assert.match((await service.getMessage(id, old.providerMessageId)).text, /Hello, Old news/, "the body is read when first opened");
  assert.equal((await store.list({ prefix: "pending:event:" })).size, 0, "an import queues no automation");
  assert.deepEqual(await service.countInbox(id), { unread: 1, total: 2 });
});

test("new mail arrives through history, whole, and reaches rules, agents and categories once", async (t) => {
  const { service, imap } = await fixture(t);
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  imap.deliver("INBOX", mail("Invoice 42", { body: "Please pay 42" }));
  imap.deliver("Sent", mail("Outgoing", { from: EMAIL }), { flags: ["\\Seen"] });
  await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
  const delivered: { account: string; subject: string; body: string }[] = [];
  const result = await service.drainEvents(async (e) => { delivered.push(e); });
  assert.equal(result.delivered, 1, "only the Inbox's new mail is an incoming event");
  assert.equal(delivered[0]!.account, "imap:" + id);
  assert.equal(delivered[0]!.subject, "Invoice 42");
  assert.match(delivered[0]!.body, /Please pay 42/);
  await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
  assert.equal((await service.drainEvents(async () => {})).delivered, 0, "never twice");
});

for (const condstore of [true, false]) {
  test(`flag changes made elsewhere reach the cache (${condstore ? "CONDSTORE" : "the newest messages' flags read again"})`, async (t) => {
    const { service, imap } = await fixture(t, { condstore });
    const uid = imap.deliver("INBOX", mail("Flag me"));
    const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
    await settle(service, id);
    const [m] = (await service.listMessages(id, { folder: "inbox" })).messages;
    assert.equal(m!.read, false);
    imap.setFlags("INBOX", uid, ["\\Seen", "\\Flagged"]);
    await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
    const after = (await service.listMessages(id, { folder: "inbox" })).messages[0]!;
    assert.equal(after.read, true);
    assert.ok(after.labels.includes("STARRED"));
    assert.deepEqual(await service.countInbox(id), { unread: 0, total: 1 }, "the counters follow");
  });
}

test("a message deleted or moved elsewhere leaves the cache; a renumbered folder (new UIDVALIDITY) is read again", async (t) => {
  const { service, imap } = await fixture(t);
  const keep = imap.deliver("INBOX", mail("Keep"));
  const gone = imap.deliver("INBOX", mail("Gone"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  imap.expunge("INBOX", gone);
  await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
  assert.deepEqual((await service.listMessages(id, { folder: "inbox" })).messages.map((m) => m.subject), ["Keep"]);
  void keep;
  const before = (await service.listMessages(id, { folder: "inbox" })).messages[0]!.providerMessageId;
  imap.renumber("INBOX");
  await settle(service, id);
  const after = (await service.listMessages(id, { folder: "inbox" })).messages;
  assert.deepEqual(after.map((m) => m.subject), ["Keep"]);
  assert.notEqual(after[0]!.providerMessageId, before, "ids follow the new UIDVALIDITY");
  await assert.rejects(service.getMessage(id, "i-1-999"), (e: ProviderError) => e.code === "message_not_found");
});

test("mail actions change the server: read, star, archive (a move, with its old id still answering), trash, spam and back", async (t) => {
  const { service, imap } = await fixture(t);
  imap.deliver("INBOX", mail("Act on me"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const first = (await service.listMessages(id, { folder: "inbox" })).messages[0]!.providerMessageId;
  await service.setRead(id, first, true);
  await service.setStarred(id, first, true);
  assert.deepEqual([...imap.folder("INBOX").messages[0]!.flags].sort(), ["\\Flagged", "\\Seen"]);
  const archived = await service.archive(id, first);
  assert.match(archived.providerMessageId, /^a-\d+-\d+$/);
  assert.equal(imap.folder("INBOX").messages.length, 0);
  assert.equal(imap.folder("Archive").messages.length, 1);
  assert.equal(archived.read, true, "flags travel with the message");
  assert.equal(archived.text.includes("Act on me"), true, "its body is kept, not read again");
  assert.deepEqual((await service.listInboxMessages(id, { folder: "archive", query: "", limit: 5 })).map((m) => m.subject), ["Act on me"]);
  // Undo from a list read before the move: the old id still finds it.
  const back = await service.moveToInbox(id, first);
  assert.match(back.providerMessageId, /^i-\d+-\d+$/);
  assert.equal(imap.folder("INBOX").messages.length, 1);
  const trashed = await service.setTrashed(id, back.providerMessageId, true);
  assert.equal(imap.folder("Trash").messages.length, 1);
  assert.ok(trashed.labels.includes("TRASH"));
  const spam = await service.setSpam(id, trashed.providerMessageId, true);
  assert.equal(imap.folder("Junk").messages.length, 1);
  assert.ok(spam.labels.includes("SPAM"));
  const notSpam = await service.setSpam(id, spam.providerMessageId, false);
  assert.ok(notSpam.labels.includes("INBOX"));
  // Nothing of it comes back as "new mail" on the next sync.
  await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
  assert.equal((await service.drainEvents(async () => {})).delivered, 0);
  assert.deepEqual((await service.listInboxMessages(id, { folder: "inbox", query: "", limit: 5 })).map((m) => m.subject), ["Act on me"]);
});

test("an account without an Archive folder says so, and Archive is refused instead of guessed", async (t) => {
  const { service, imap } = await fixture(t, { folders: [{ path: "Sent", specialUse: "\\Sent" }, { path: "Trash", specialUse: "\\Trash" }] });
  imap.deliver("INBOX", mail("Nowhere to go"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const caps = (await service.listAccounts()).accounts[0]!.capabilities!;
  assert.deepEqual({ archive: caps.archive, spam: caps.spam, drafts: caps.drafts, trash: caps.trash }, { archive: false, spam: false, drafts: false, trash: true });
  const m = (await service.listMessages(id, { folder: "inbox" })).messages[0]!;
  await assert.rejects(service.archive(id, m.providerMessageId), (e: ProviderError) => e.code === "not_supported");
  assert.equal(imap.folder("INBOX").messages.length, 1);
});

test("sending: accepted by SMTP, the copy appended to Sent with its Bcc, never sent twice for one key", async (t) => {
  const { service, imap, smtp } = await fixture(t);
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const request = { idempotencyKey: "send-1", to: ["bob@example.org"], bcc: ["boss@example.org"], subject: "Привет", text: "Body\n.dot line" };
  const receipt = await service.send(id, request);
  assert.equal(receipt.status, "accepted");
  assert.equal(smtp.received.length, 1);
  assert.deepEqual(smtp.received[0]!.recipients, ["bob@example.org", "boss@example.org"]);
  assert.ok(!/^Bcc:/mi.test(smtp.received[0]!.data), "Bcc is not in the copy the recipients get");
  assert.match(smtp.received[0]!.data, /^Message-ID: <[^>]+@fastmail\.com>$/m);
  const sent = imap.folder("Sent").messages;
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.raw.toString(), /^Bcc: boss@example\.org$/m, "the kept copy says who was copied");
  assert.ok(sent[0]!.flags.has("\\Seen"));
  assert.match(receipt.providerMessageId!, /^s-\d+-\d+$/);
  const again = await service.send(id, request);
  assert.equal(again.status, "accepted");
  assert.equal(smtp.received.length, 1, "the same key answers the first send");
  assert.deepEqual(await service.getSendReceipt(id, "send-1"), again);
});

test("a send refused before its data is safe to retry; a connection lost after it is an unknown outcome", async (t) => {
  const { service, smtp } = await fixture(t, {}, { rejectRecipients: ["nobody@example.org"] });
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await assert.rejects(service.send(id, { idempotencyKey: "k1", to: ["nobody@example.org"], subject: "x", text: "x" }), (e: ProviderError) => e.code === "recipient_rejected");
  await assert.rejects(service.getSendReceipt(id, "k1"), (e: ProviderError) => e.code === "receipt_not_found", "no receipt holds the key");
  smtp.options.rejectRecipients = [];
  assert.equal((await service.send(id, { idempotencyKey: "k1", to: ["nobody@example.org"], subject: "x", text: "x" })).status, "accepted");
  smtp.options.dropAfterData = true;
  const unknown = await service.send(id, { idempotencyKey: "k2", to: ["bob@example.org"], subject: "y", text: "y" });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.error, "send_outcome_unknown");
  smtp.options.dropAfterData = false;
  const retry = await service.send(id, { idempotencyKey: "k2", to: ["bob@example.org"], subject: "y", text: "y" });
  assert.equal(retry.status, "unknown", "an unknown outcome is never resolved by sending again");
  assert.equal(smtp.received.length, 2);
});

test("Gmail through IMAP keeps its own Sent copy: none is appended", async (t) => {
  const { service, imap, smtp } = await fixture(t);
  const gmail = "ann@gmail.com";
  imap.options.users![gmail] = PASS;
  smtp.options.users![gmail] = PASS;
  const { id } = await service.connectImap({ preset: "gmail", email: gmail, password: PASS });
  const receipt = await service.send(id, { idempotencyKey: "g1", to: ["bob@example.org"], subject: "x", text: "x" });
  assert.equal(receipt.status, "accepted");
  assert.equal(imap.folder("Sent").messages.length, 0);
});

test("drafts live in the Drafts folder: one id for life, a new revision each save, conflicts refused, sent as kept", async (t) => {
  const { service, imap, smtp } = await fixture(t);
  imap.deliver("INBOX", mail("Question", { id: "<q1@example.org>" }));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const created = await service.createDraft(id, { idempotencyKey: "d1", to: ["bob@example.org"], subject: "Re: Question", text: "First words", inReplyTo: "<q1@example.org>", references: "<q1@example.org>",
    attachments: [{ content: Buffer.from("PDF").toString("base64"), filename: "a.pdf", type: "application/pdf", disposition: "attachment" }] });
  assert.equal(created.status, "accepted");
  const draftId = created.providerDraftId!;
  assert.equal(imap.folder("Drafts").messages.length, 1);
  assert.ok(imap.folder("Drafts").messages[0]!.flags.has("\\Draft"));
  const listed = await service.listDrafts(id);
  assert.equal(listed.drafts.length, 1);
  assert.equal(listed.drafts[0]!.draftId, draftId);
  assert.equal(listed.drafts[0]!.attachments.length, 1);
  const rev1 = listed.drafts[0]!.revision;
  const saved = await service.updateDraft(id, draftId, { to: ["bob@example.org"], subject: "Re: Question", text: "Second words", expectedRevision: rev1, inReplyTo: "<q1@example.org>", references: "<q1@example.org>" });
  assert.equal(saved.draftId, draftId, "the draft keeps its id");
  assert.notEqual(saved.revision, rev1);
  assert.equal(imap.folder("Drafts").messages.length, 1, "the old version is gone");
  const read = await service.getDraft(id, draftId);
  assert.match(read.text!, /Second words/);
  assert.equal(read.attachments.length, 1, "files are kept unless left out");
  await assert.rejects(service.updateDraft(id, draftId, { to: [], subject: "", text: "stale", expectedRevision: rev1 }), (e: ProviderError) => e.code === "draft_conflict");
  await assert.rejects(service.sendDraft(id, draftId, "sd1", rev1), (e: ProviderError) => e.code === "draft_conflict");
  const sent = await service.sendDraft(id, draftId, "sd1", saved.revision);
  assert.equal(sent.status, "accepted");
  assert.equal(smtp.received.length, 1);
  assert.match(smtp.received[0]!.data, /In-Reply-To: <q1@example\.org>/);
  assert.equal(imap.folder("Drafts").messages.length, 0, "a sent draft leaves Drafts");
  assert.equal(imap.folder("Sent").messages.length, 1);
  await assert.rejects(service.getDraft(id, draftId), (e: ProviderError) => e.code === "draft_not_found");
  assert.equal((await service.sendDraft(id, draftId, "sd1")).status, "accepted", "a retry answers the first send");
  assert.equal(smtp.received.length, 1);
});

test("a refused password during sync asks for a reconnect; a new app password brings the account back", async (t) => {
  const { service, imap, smtp, store } = await fixture(t);
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  imap.options.users = { [EMAIL]: "rotated-pass" };
  smtp.options.users = { [EMAIL]: "rotated-pass" };
  await assert.rejects(service.sync(id, { deadline: Date.now() + 5_000 }), (e: ProviderError) => e.code === "reconnect_required");
  assert.equal((await account(store, id)).status, "reconnect_required");
  await assert.rejects(service.updateImapPassword(id, "still-wrong"), (e: ProviderError) => e.code === "auth_failed");
  assert.equal((await account(store, id)).status, "reconnect_required", "a wrong new password changes nothing");
  const back = await service.updateImapPassword(id, "rotated-pass");
  assert.equal(back.status, "connected");
  assert.equal(back.error, undefined);
  await settle(service, id);
});

test("a server out of reach backs off without asking for a reconnect", async (t) => {
  const { service, imap, store } = await fixture(t);
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await imap.stop();
  await assert.rejects(service.sync(id, { deadline: Date.now() + 5_000 }), (e: ProviderError) => e.code === "provider_unavailable");
  const a = await account(store, id);
  assert.equal(a.status, "error");
  assert.ok(a.retryAt! > Date.now());
});

test("attachments and headers are read from the server; disconnecting forgets the account and its mail", async (t) => {
  const { service, imap, store } = await fixture(t);
  imap.deliver("INBOX", "From: bob@example.org\r\nTo: ann@fastmail.com\r\nSubject: File\r\nMessage-ID: <f@example.org>\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nsee file\r\n--b\r\nContent-Type: application/pdf; name=x.pdf\r\nContent-Disposition: attachment; filename=x.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n");
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const m = await service.getMessage(id, (await service.listMessages(id, {})).messages[0]!.providerMessageId);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0]!.filename, "x.pdf");
  const file = await service.getAttachment(id, m.providerMessageId, m.attachments[0]!.providerAttachmentId);
  assert.equal(Buffer.from(file.data, "base64url").toString(), "%PDF-");
  const headers = (await service.getHeaders(id, m.providerMessageId)).headers;
  assert.ok(headers.some((h) => h.key === "Message-ID" && h.value === "<f@example.org>"));
  const result = await service.disconnect(id);
  assert.deepEqual(result, { status: "disconnected", revoked: false, provider: "imap" });
  assert.equal(await store.get("account:" + id), undefined);
  assert.equal((await store.list({ prefix: `message:${id}:` })).size, 0);
  assert.equal(imap.folder("INBOX").messages.length, 1, "the mail stays at the provider");
});

test("the shared schedule reads IMAP accounts: a tick imports, Refresh names them imap:<id>", async (t) => {
  const { GmailScheduler } = await import("../workers/providers/gmail-scheduler");
  const { service, imap } = await fixture(t);
  imap.deliver("INBOX", mail("Scheduled"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = { getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
    get: async <T,>(k: string) => data.get(k) as T | undefined, put: async <T,>(k: string, v: T) => { data.set(k, v); } };
  const scheduler = new GmailScheduler(storage, { listAccounts: () => service.listAccounts(), sync: (a, o) => service.sync(a, o), ready: (a) => service.ready(a) },
    <T,>(fn: () => Promise<T>) => fn(), () => 300_000);
  for (let i = 0; i < 4; i++) await scheduler.tick();
  assert.deepEqual((await service.listInboxMessages(id, { folder: "inbox", query: "", limit: 5 })).map((m) => m.subject), ["Scheduled"]);
  imap.deliver("INBOX", mail("Refreshed"));
  const outcomes = await scheduler.refresh(["imap:" + id]);
  assert.deepEqual(outcomes.map((o) => [o.accountId, o.result]), [["imap:" + id, "synced"]]);
  assert.equal((await service.listInboxMessages(id, { folder: "inbox", query: "", limit: 5 })).length, 2);
  assert.deepEqual(await scheduler.refresh(["gmail:" + id]), [], "the same id under another provider is not this account");
});

test("an address already connected with Google sign-in is not connected again over IMAP", async (t) => {
  const { service, store } = await fixture(t);
  await store.put<Partial<AccountRecord>>("account:g1", { id: "g1", provider: "gmail", email: "ann@gmail.com", status: "connected", sync: { mode: "history" } });
  await assert.rejects(service.connectImap({ preset: "gmail", email: "ann@gmail.com", password: PASS }), (e: ProviderError) => e.code === "already_connected");
});
