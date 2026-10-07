import test from "node:test";
import assert from "node:assert/strict";
import { AccountService, type AccountRecord, type ArrivalFilter } from "../workers/providers/account-service";
import { ProviderError } from "../workers/providers/gmail-client";
import { configuration, seal } from "../workers/providers/google-oauth";
import type { ImapAccount } from "../workers/providers/imap/types";
import type { OutlookAccount } from "../workers/providers/outlook/types";
import { MemoryStore } from "./memory-store";
import { FakeImap, type FakeImapOptions } from "./fake-imap";
import { FakeSmtp, nodeSockets } from "./fake-smtp";
import { FakeGraph } from "./fake-graph";
import { DISCARD_RETENTION_MS } from "../shared/mail/discard";
import { discardErrorText } from "../workers/routes/discard";

/**
 * Discarded in each remote provider (operator, 2026-10-06): a message discarded goes to the
 * account's own Discarded place — Gmail's "Discarded" label, an IMAP or Outlook folder named
 * Discarded, made when missing — read, with why; it is out of the inbox and its counts, listed in
 * the Discarded folder, brought back by restore, sent to Trash after 30 days; and new mail a rule
 * matches goes there on arrival before any rule, agent or category sees it.
 */
const quiet = (t: test.TestContext) => {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  t.after(() => { console.log = log; console.warn = warn; });
};

// ── IMAP ─────────────────────────────────────────────────────────────────────────

const EMAIL = "ann@fastmail.com", PASS = "app-pass-1234-5678";
const mail = (subject: string, o: { from?: string; extra?: string; refs?: string } = {}) =>
  `From: ${o.from ?? "Digest <digest@news.example.org>"}\r\nTo: ${EMAIL}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, "")}@example.org>\r\n` +
  `${o.refs ? `In-Reply-To: ${o.refs}\r\nReferences: ${o.refs}\r\n` : ""}Date: Mon, 5 Oct 2026 10:00:00 +0000\r\n${o.extra ?? ""}Content-Type: text/plain; charset=utf-8\r\n\r\nHello, ${subject}\r\n`;

async function imapFixture(t: test.TestContext, options: FakeImapOptions = {}) {
  quiet(t);
  const imap = await new FakeImap({ users: { [EMAIL]: PASS }, ...options }).start();
  const smtp = await new FakeSmtp({ users: { [EMAIL]: PASS } }).start();
  t.after(async () => { await imap.stop(); await smtp.stop(); });
  const store = new MemoryStore();
  const service = new AccountService(store, { MAIL_CREDENTIAL_KEY: Buffer.alloc(32, 4).toString("base64url") }, async () => { throw new Error("no HTTP"); }, {
    imap: { transport: { secure: false, timeoutMs: 3_000, resolve: () => ({ host: "127.0.0.1", port: imap.port }) }, sockets: nodeSockets({ port: () => smtp.port }) },
  });
  return { imap, store, service };
}
async function settle(service: AccountService, id: string) {
  for (let i = 0; i < 30; i++) {
    const a = await service.sync(id, { deadline: Date.now() + 10_000 });
    const sync = a.sync as { mode: string; more?: boolean };
    if (sync.mode === "history" && !sync.more) return;
  }
  throw new Error("sync did not settle");
}
const page = (service: AccountService, id: string, folder: "inbox" | "discarded" | "trash") => service.listInboxMessages(id, { folder, query: "", limit: 20 });

test("IMAP: discard makes the Discarded folder once, moves the message there read, and restore brings it back", async (t) => {
  const { imap, store, service } = await imapFixture(t);
  imap.deliver("INBOX", mail("Weekly digest", { extra: "List-Id: Weekly Digest <weekly.news.example.org>\r\n" }));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const first = (await page(service, id, "inbox"))[0]!;
  assert.equal(first.read, false);
  const facts = await service.discardFacts(id, first.providerMessageId);
  assert.equal(facts.headers.find((h) => h.key === "List-Id")?.value, "Weekly Digest <weekly.news.example.org>", "the List-Id is kept from the cache");
  assert.equal(facts.known, false);
  const moved = await service.discard(id, first.providerMessageId, "You discarded it");
  assert.equal(moved.from, "inbox");
  assert.equal(moved.unread, true, "Undo can make it unread again");
  assert.match(moved.id, /^x-\d+-\d+$/, "its id is its new folder's");
  assert.deepEqual(imap.created, ["Discarded"]);
  assert.equal(imap.folder("INBOX").messages.length, 0);
  assert.deepEqual([...imap.folder("Discarded").messages[0]!.flags], ["\\Seen"], "read");
  const record = (await store.get<ImapAccount>("account:" + id))!;
  assert.ok(record.sync.folders.some((f) => f.role === "discarded" && f.path === "Discarded"), "the folder joins the synced ones");
  assert.deepEqual(await page(service, id, "inbox"), []);
  assert.deepEqual(await service.countInbox(id), { unread: 0, total: 0 }, "out of the inbox's counts");
  const discarded = await page(service, id, "discarded");
  assert.equal(discarded[0]!.subject, "Weekly digest");
  assert.equal(discarded[0]!.discardReason, "You discarded it");
  // A sync afterwards neither imports it twice nor brings it back.
  await settle(service, id);
  assert.equal((await page(service, id, "discarded")).length, 1);
  // A second discard reuses the folder.
  imap.deliver("INBOX", mail("Another"));
  await settle(service, id);
  await service.discard(id, (await page(service, id, "inbox"))[0]!.providerMessageId, "You discarded it");
  assert.deepEqual(imap.created, ["Discarded"], "made once");
  const back = await service.restoreDiscarded(id, moved.id, false);
  assert.match(back.id, /^i-\d+-\d+$/);
  const inbox = await page(service, id, "inbox");
  assert.deepEqual(inbox.map((m) => m.subject), ["Weekly digest"]);
  assert.equal(inbox[0]!.read, false, "unread again, as before the discard");
  assert.equal(await store.get(`discarded:${id}:${moved.id}`), undefined, "its reason goes with it");
});

test("IMAP: a folder the person already named Discarded is used; a server that refuses to make one says so", async (t) => {
  const own = await imapFixture(t, { folders: [{ path: "Sent", specialUse: "\\Sent" }, { path: "Trash", specialUse: "\\Trash" }, { path: "discarded" }] });
  own.imap.deliver("INBOX", mail("Old one"));
  const a = await own.service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(own.service, a.id);
  const record = (await own.store.get<ImapAccount>("account:" + a.id))!;
  assert.ok(record.sync.folders.some((f) => f.role === "discarded"), "found by name at connect");
  await own.service.discard(a.id, (await page(own.service, a.id, "inbox"))[0]!.providerMessageId, "You discarded it");
  assert.deepEqual(own.imap.created, []);
  assert.equal(own.imap.folder("discarded").messages.length, 1);

  const refused = await imapFixture(t, { createRefused: true });
  refused.imap.deliver("INBOX", mail("Keep me"));
  const b = await refused.service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(refused.service, b.id);
  const m = (await page(refused.service, b.id, "inbox"))[0]!;
  await assert.rejects(refused.service.discard(b.id, m.providerMessageId, "x"), (e: ProviderError) => e.code === "folder_create_refused");
  assert.equal(refused.imap.folder("INBOX").messages.length, 1, "nothing moved");
});

test("IMAP: new mail a rule matches is discarded on arrival, before rules, agents and categories; a sender you wrote to never is", async (t) => {
  const { imap, service } = await imapFixture(t);
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  imap.deliver("INBOX", mail("Digest 2", { extra: "List-Id: <weekly.news.example.org>\r\n" }));
  imap.deliver("INBOX", mail("From Bob", { from: "bob@example.org" }));
  imap.deliver("Sent", mail("To Bob", { from: EMAIL }).replace(`To: ${EMAIL}`, "To: Bob <bob@example.org>"), { flags: ["\\Seen"] });
  await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
  const filter: ArrivalFilter = async (event, message) => {
    const contact = await service.sentContact(event.accountId, message.from, message.threadId);
    if (contact.known) return null;
    return message.subject.startsWith("Digest") || message.from.includes("bob@") ? { reason: "Discarded automatically: you discarded 1 message from this newsletter (Weekly)", ruleId: "l-00000001" } : null;
  };
  const delivered: string[] = [], applied: string[] = [];
  const result = await service.drainEvents(async (e) => { delivered.push(e.subject); }, Date.now(), filter, async (rule) => { applied.push(rule); });
  assert.equal(result.discarded, 1);
  assert.deepEqual(delivered, ["From Bob"], "Bob was written to: his mail reaches the inbox and its consumers");
  assert.deepEqual(applied, ["l-00000001"]);
  assert.equal(imap.folder("Discarded").messages.length, 1);
  const discarded = await page(service, id, "discarded");
  assert.equal(discarded[0]!.discardReason, "Discarded automatically: you discarded 1 message from this newsletter (Weekly)");
  assert.equal((await service.drainEvents(async () => {}, Date.now(), filter)).discarded, 0, "never twice");
});

test("IMAP: a discard that fails on arrival (the server refuses to make Discarded) still delivers the message, once, to rules, agents and categories", async (t) => {
  const { imap, service } = await imapFixture(t, { createRefused: true });
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  imap.deliver("INBOX", mail("Digest 3", { extra: "List-Id: <weekly.news.example.org>\r\n" }));
  await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
  const filter: ArrivalFilter = async () => ({ reason: "Discarded automatically: you discarded 1 message from this newsletter (Weekly)", ruleId: "l-00000001" });
  const delivered: string[] = [], applied: string[] = [];
  const warnings: string[] = [];
  console.warn = (line: string) => { warnings.push(line); };
  const result = await service.drainEvents(async (e) => { delivered.push(e.subject); }, Date.now(), filter, async (rule) => { applied.push(rule); });
  assert.deepEqual(result, { delivered: 1, failed: 0, dead: 0, discarded: 0 });
  assert.deepEqual(delivered, ["Digest 3"], "it reaches its consumers as if no rule matched");
  assert.deepEqual(applied, [], "the rule did not take it");
  assert.equal(imap.folder("INBOX").messages.length, 1, "it stays in the inbox");
  const logged = warnings.map((w) => JSON.parse(w)).find((w) => w.event === "discard_arrival_failed");
  assert.equal(logged?.error, "folder_create_refused");
  assert.equal(logged?.rule, "l-00000001");
  assert.deepEqual(await service.drainEvents(async (e) => { delivered.push(e.subject); }, Date.now(), filter), { delivered: 0, failed: 0, dead: 0, discarded: 0 }, "never again");
});

test("a discard on arrival runs under the object's lock, never alongside a sync page or a mail action", async (t) => {
  const { imap, service } = await imapFixture(t);
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  imap.deliver("INBOX", mail("Digest 4", { extra: "List-Id: <weekly.news.example.org>\r\n" }));
  await service.sync(id, { historyOnly: true, deadline: Date.now() + 10_000 });
  // The object's lock, as GmailAccountsDO.serial chains it: one holder at a time.
  let held = 0, overlapped = false, locked = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => { held++; locked++; try { return await fn(); } finally { held--; } });
    tail = run.catch(() => {});
    return run;
  };
  const discard = service.discard.bind(service);
  let discardsLocked = 0;
  service.discard = async (...args: Parameters<typeof discard>) => { if (held === 1) discardsLocked++; if (held > 1) overlapped = true; return discard(...args); };
  // A mail action that holds the lock while the drain wants it.
  let release!: () => void;
  const action = serial(() => new Promise<void>((resolve) => { release = resolve; }));
  const filter: ArrivalFilter = async () => ({ reason: "Discarded automatically", ruleId: "l-00000001" });
  const drained = service.drainEvents(async () => {}, Date.now(), filter, undefined, serial);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(imap.folder("INBOX").messages.length, 1, "the discard waits for the action holding the lock");
  release();
  await action;
  assert.equal((await drained).discarded, 1);
  assert.equal(discardsLocked, 1, "the discard ran holding the lock");
  assert.equal(overlapped, false);
  assert.equal(locked, 2);
});

test("a sender the account wrote to in Cc or Bcc is known, as in To — also from Sent rows indexed before Cc and Bcc were kept", async (t) => {
  const { imap, store, service } = await imapFixture(t);
  const sent = (subject: string, header: string) =>
    mail(subject, { from: EMAIL }).replace(`To: ${EMAIL}\r\n`, `To: Someone <someone@example.org>\r\n${header}\r\n`);
  imap.deliver("Sent", sent("Copy to Carol", "Cc: Carol <carol@example.org>, dave@example.org"), { flags: ["\\Seen"] });
  imap.deliver("Sent", sent("Blind to Erin", "Bcc: erin@example.org"), { flags: ["\\Seen"] });
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  for (const who of ["someone@example.org", "Carol <carol@example.org>", "dave@example.org", "erin@example.org"])
    assert.equal((await service.sentContact(id, who, undefined)).known, true, who);
  assert.equal((await service.sentContact(id, "arol@example.org", undefined)).known, false, "the whole address, never a part");
  // Index rows written before 0.12 kept To only: the message row says the rest.
  for (const [key, row] of await store.list<Record<string, unknown>>({ prefix: `idx:${id}:sent:` })) {
    const { cc: _cc, bcc: _bcc, ...old } = row;
    await store.put(key, old);
  }
  assert.equal((await service.sentContact(id, "carol@example.org", undefined)).known, true);
  assert.equal((await service.sentContact(id, "erin@example.org", undefined)).known, true);
  // The workspace's question: any connected account.
  assert.equal(await service.knownAnywhere("Erin <erin@example.org>"), true);
  assert.equal(await service.knownAnywhere("nobody@example.org"), false);
});

test("remote purge reads every record, not the first thousand, and takes the oldest due first", async (t) => {
  const { imap, store, service } = await imapFixture(t);
  imap.deliver("INBOX", mail("Older"));
  imap.deliver("INBOX", mail("Newer"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const [a, b] = await page(service, id, "inbox");
  const first = await service.discard(id, a!.providerMessageId, "You discarded it");
  const second = await service.discard(id, b!.providerMessageId, "You discarded it");
  // 1,200 younger records whose keys sort before the real ones (other mail discarded since).
  for (let i = 0; i < 1200; i++) await store.put(`discarded:${id}:a${String(i).padStart(5, "0")}`, { reason: "You discarded it", at: Date.now() });
  await store.put(`discarded:${id}:${second.id}`, { reason: "You discarded it", at: Date.now() - DISCARD_RETENTION_MS - 120_000 });
  await store.put(`discarded:${id}:${first.id}`, { reason: "You discarded it", at: Date.now() - DISCARD_RETENTION_MS - 60_000 });
  assert.deepEqual(await service.purgeDiscarded(Date.now(), 1), { trashed: 1, deleted: 0, forgotten: 0 });
  assert.equal(await store.get(`discarded:${id}:${second.id}`), undefined, "the one due longest went first");
  assert.ok(await store.get(`discarded:${id}:${first.id}`));
  assert.deepEqual(await service.purgeDiscarded(Date.now(), 1), { trashed: 1, deleted: 0, forgotten: 0 });
  assert.equal(imap.folder("Trash").messages.length, 2);
});

test("IMAP without UIDPLUS: a message with no Message-ID is found in Discarded by its headers, so Undo and the 30-day purge reach it", async (t) => {
  const { imap, store, service } = await imapFixture(t, { uidplus: false });
  imap.deliver("INBOX", mail("No id").replace(/Message-ID: [^\r]*\r\n/, ""));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const m = (await page(service, id, "inbox"))[0]!;
  const moved = await service.discard(id, m.providerMessageId, "You discarded it");
  assert.match(moved.id, /^x-\d+-\d+$/, "its id in Discarded, found without UIDPLUS or a Message-ID");
  assert.ok(await store.get(`discarded:${id}:${moved.id}`), "its record is under the id it has now");
  await service.restoreDiscarded(id, moved.id);
  assert.equal(imap.folder("INBOX").messages.length, 1, "Undo reached it");
  await settle(service, id);
  const again = await service.discard(id, (await page(service, id, "inbox"))[0]!.providerMessageId, "You discarded it");
  await store.put(`discarded:${id}:${again.id}`, { reason: "You discarded it", at: Date.now() - DISCARD_RETENTION_MS - 60_000 });
  assert.deepEqual(await service.purgeDiscarded(), { trashed: 1, deleted: 0, forgotten: 0 });
  assert.equal(imap.folder("Trash").messages.length, 1);
});

test("a discard whose new place the provider could not say is resolved from the next sync: Undo and the purge still reach it", async (t) => {
  const { imap, store, service } = await imapFixture(t);
  imap.deliver("INBOX", mail("Lost and found"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const m = (await page(service, id, "inbox"))[0]!;
  const moved = await service.discard(id, m.providerMessageId, "You discarded it");
  // As if the move had not said where it went: the record is kept under the old id, marked lost.
  const row = (await service.cache.row(id, moved.id))!;
  await store.delete(`discarded:${id}:${moved.id}`);
  await store.put(`discarded:${id}:${m.providerMessageId}`, { reason: "You discarded it", at: Date.now(),
    lost: { rfcMessageId: row.message.rfcMessageId, from: row.message.from, subject: row.message.subject, timestamp: row.message.timestamp } });
  assert.deepEqual(await service.purgeDiscarded(), { trashed: 0, deleted: 0, forgotten: 0 });
  assert.deepEqual(await store.get(`discarded:${id}:${moved.id}`), { reason: "You discarded it", at: (await store.get<{ at: number }>(`discarded:${id}:${moved.id}`))!.at }, "found: kept under its id now");
  assert.equal(await store.get(`discarded:${id}:${m.providerMessageId}`), undefined);
  // Undo by the id the app knew finds it too.
  await service.restoreDiscarded(id, m.providerMessageId);
  assert.equal(imap.folder("INBOX").messages.length, 1);
});

test("IMAP without a Trash folder: Discarded mail is deleted for good after 30 days, not kept forever", async (t) => {
  const { imap, store, service } = await imapFixture(t, { folders: [{ path: "Sent", specialUse: "\\Sent" }] });
  imap.deliver("INBOX", mail("Gone in 30"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const moved = await service.discard(id, (await page(service, id, "inbox"))[0]!.providerMessageId, "You discarded it");
  await store.put(`discarded:${id}:${moved.id}`, { reason: "You discarded it", at: Date.now() - DISCARD_RETENTION_MS - 60_000 });
  assert.deepEqual(await service.purgeDiscarded(), { trashed: 0, deleted: 1, forgotten: 0 });
  assert.equal(imap.folder("Discarded").messages.length, 0, "expunged");
  assert.equal(await store.get(`discarded:${id}:${moved.id}`), undefined);
  assert.deepEqual(await page(service, id, "discarded"), [], "out of the cache too");
});

test("IMAP: Discarded mail goes to Trash after 30 days; younger mail stays", async (t) => {
  const { imap, store, service } = await imapFixture(t);
  imap.deliver("INBOX", mail("Old"));
  imap.deliver("INBOX", mail("New"));
  const { id } = await service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(service, id);
  const [a, b] = await page(service, id, "inbox");
  const oldOne = await service.discard(id, a!.providerMessageId, "You discarded it");
  await service.discard(id, b!.providerMessageId, "You discarded it");
  await store.put(`discarded:${id}:${oldOne.id}`, { reason: "You discarded it", at: Date.now() - DISCARD_RETENTION_MS - 60_000 });
  const result = await service.purgeDiscarded();
  assert.deepEqual(result, { trashed: 1, deleted: 0, forgotten: 0 });
  assert.equal(imap.folder("Trash").messages.length, 1);
  assert.equal(imap.folder("Discarded").messages.length, 1);
  assert.deepEqual(await service.purgeDiscarded(), { trashed: 0, deleted: 0, forgotten: 0 }, "nothing else is due");
});

// ── Outlook ──────────────────────────────────────────────────────────────────────

const OUTLOOK_ENV = {
  MAIL_CREDENTIAL_KEY: Buffer.alloc(32, 5).toString("base64url"),
  MICROSOFT_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
  MICROSOFT_CLIENT_SECRET: ["made", "up", "client", "secret", "words"].join("-"),
  PUBLIC_APP_URL: "https://mail.example.invalid",
};
async function outlookFixture(t: test.TestContext) {
  quiet(t);
  const graph = new FakeGraph();
  const store = new MemoryStore();
  const service = new AccountService(store, OUTLOOK_ENV, graph.fetch);
  const { authorizationUrl, browserToken } = await service.outlookConnect();
  const account = await service.outlookCallback(new URL(authorizationUrl).searchParams.get("state")!, browserToken, graph.issueCode());
  return { graph, store, service, id: account.id };
}

test("Outlook: discard makes a top-level folder named Discarded, reads and moves the message there; restore moves it back", async (t) => {
  const { graph, store, service, id } = await outlookFixture(t);
  const message = graph.deliver("Weekly digest");
  await settle(service, id);
  const row = (await page(service, id, "inbox"))[0]!;
  const facts = await service.discardFacts(id, row.providerMessageId);
  assert.equal(facts.headers.find((h) => h.key === "List-Id")?.value, "<news.example.org>");
  const moved = await service.discard(id, row.providerMessageId, "You discarded it");
  assert.equal(moved.id, row.providerMessageId, "immutable ids: the same message");
  assert.equal(message.folder, "discarded");
  assert.equal(message.isRead, true);
  assert.deepEqual(graph.customFolders, { discarded: "Discarded" });
  const created = graph.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname.endsWith("/me/mailFolders"));
  assert.equal(created.length, 1);
  assert.deepEqual(JSON.parse(created[0]!.body!), { displayName: "Discarded", isHidden: false });
  assert.ok((await store.get<OutlookAccount>("account:" + id))!.sync.folders.some((f) => f.role === "discarded"), "kept with the account");
  assert.equal((await page(service, id, "discarded"))[0]!.discardReason, "You discarded it");
  assert.deepEqual(await page(service, id, "inbox"), []);
  // A sync reads the new folder without bringing the message back to the inbox.
  await settle(service, id);
  assert.equal((await page(service, id, "discarded")).length, 1);
  assert.deepEqual(await page(service, id, "inbox"), []);
  const back = await service.restoreDiscarded(id, moved.id);
  assert.equal(back.id, moved.id);
  assert.equal(message.folder, "inbox");
  assert.equal((await page(service, id, "inbox")).length, 1);
});

test("Outlook: a Discarded folder already there is found at connect and used", async (t) => {
  quiet(t);
  const graph = new FakeGraph();
  graph.addFolder("Discarded");
  const store = new MemoryStore();
  const service = new AccountService(store, OUTLOOK_ENV, graph.fetch);
  const { authorizationUrl, browserToken } = await service.outlookConnect();
  const account = await service.outlookCallback(new URL(authorizationUrl).searchParams.get("state")!, browserToken, graph.issueCode());
  assert.ok((await store.get<OutlookAccount>("account:" + account.id))!.sync.folders.some((f) => f.role === "discarded"));
  const message = graph.deliver("Hello");
  await settle(service, account.id);
  await service.discard(account.id, (await page(service, account.id, "inbox"))[0]!.providerMessageId, "You discarded it");
  assert.equal(message.folder, "discarded");
  assert.equal(graph.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname.endsWith("/me/mailFolders")).length, 0, "none made");
});

// ── Gmail ────────────────────────────────────────────────────────────────────────

const GMAIL_ENV = { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url") };
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });

/** Gmail's messages, labels and modify, enough for Discarded. */
class FakeGmail {
  labels = new Map<string, string[]>([["m1", ["INBOX", "UNREAD"]]]);
  userLabels: { id: string; name: string }[] = [];
  seen: string[] = [];
  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace("/gmail/v1/users/me/", "");
    const method = init?.method ?? "GET";
    this.seen.push(`${method} ${path}${init?.body ? " " + init.body : ""}`);
    if (path === "labels" && method === "GET") return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, ...this.userLabels] });
    if (path === "labels" && method === "POST") {
      const { name } = JSON.parse(String(init!.body));
      const label = { id: "Label_" + (this.userLabels.length + 7), name };
      this.userLabels.push(label);
      return json(label);
    }
    const m = /^messages\/([^/]+)(\/modify|\/untrash|\/trash)?$/.exec(path);
    if (m) {
      const labels = this.labels.get(m[1]!);
      if (!labels) return json({ error: { code: 404 } }, 404);
      if (m[2] === "/modify") {
        const { addLabelIds, removeLabelIds } = JSON.parse(String(init!.body)) as { addLabelIds: string[]; removeLabelIds: string[] };
        if (addLabelIds.some((l) => l.startsWith("Label_") && !this.userLabels.some((x) => x.id === l))) return json({ error: { code: 400, message: "Invalid label" } }, 400);
        this.labels.set(m[1]!, [...new Set([...labels.filter((l) => !removeLabelIds.includes(l)), ...addLabelIds])]);
      }
      if (m[2] === "/trash") this.labels.set(m[1]!, [...labels.filter((l) => l !== "INBOX"), "TRASH"]);
      if (m[2] === "/untrash") this.labels.set(m[1]!, labels.filter((l) => l !== "TRASH"));
      return json({ id: m[1], threadId: "t1", internalDate: "1759658400000", labelIds: this.labels.get(m[1]!),
        payload: { headers: [{ name: "From", value: "Shop <deals@shop.example>" }, { name: "Subject", value: "Sale" }, { name: "List-Id", value: "<deals.shop.example>" }] } });
    }
    return json({ error: { code: 404 } }, 404);
  };
}
async function gmailFixture() {
  const gmail = new FakeGmail();
  const store = new MemoryStore();
  const config = configuration(GMAIL_ENV);
  if (config.status !== "configured") throw new Error("not configured");
  await store.put<AccountRecord>("account:a", { id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 }),
    sync: { mode: "history", historyId: "10", generation: "g" } } as AccountRecord);
  const service = new AccountService(store, GMAIL_ENV, gmail.fetch as typeof fetch);
  // The message as a sync cached it.
  await service.cache.save("a", { id: "a:m1", accountId: "a", providerMessageId: "m1", threadId: "t1", subject: "Sale", from: "Shop <deals@shop.example>", to: "a@example.invalid",
    date: "", rfcMessageId: "", references: "", timestamp: 1_759_658_400_000, snippet: "", text: "Sale", html: "", read: false, archived: false, labels: ["INBOX", "UNREAD"],
    signals: { listId: true, list: "<deals.shop.example>" }, attachments: [] }, "g");
  return { gmail, store, service };
}

test("Gmail: discard puts the account's own Discarded label on (made once), out of the inbox and read; restore takes it off", async (t) => {
  quiet(t);
  const { gmail, store, service } = await gmailFixture();
  const moved = await service.discard("a", "m1", "You discarded it");
  assert.deepEqual(moved, { id: "m1", from: "inbox", unread: true });
  assert.deepEqual(gmail.userLabels, [{ id: "Label_7", name: "Discarded" }]);
  assert.ok(gmail.seen.includes('POST messages/m1/modify {"addLabelIds":["Label_7"],"removeLabelIds":["INBOX","UNREAD","SPAM"]}'));
  assert.equal(await store.get("label:a:discarded"), "Label_7");
  const listed = await service.listInboxMessages("a", { folder: "discarded", query: "", limit: 10 });
  assert.equal(listed.length, 1, "the label reads as Discarded");
  assert.equal(listed[0]!.read, true);
  assert.deepEqual(await service.listInboxMessages("a", { folder: "inbox", query: "", limit: 10 }), []);
  assert.deepEqual(await service.countInbox("a"), { unread: 0, total: 0 });
  await service.restoreDiscarded("a", "m1");
  assert.ok(gmail.seen.includes('POST messages/m1/modify {"addLabelIds":["INBOX"],"removeLabelIds":["Label_7"]}'));
  assert.equal((await service.listInboxMessages("a", { folder: "inbox", query: "", limit: 10 })).length, 1);
  // A second discard reuses the kept label without listing again.
  gmail.seen.length = 0;
  await service.discard("a", "m1", "You discarded it");
  assert.ok(!gmail.seen.some((s) => s.startsWith("GET labels") || s.startsWith("POST labels")));
});

test("Gmail, IMAP, Outlook: mail in the account's Spam is not discarded — moving it out would teach the provider it is not spam", async (t) => {
  quiet(t);
  const { gmail, service } = await gmailFixture();
  gmail.labels.set("m1", ["SPAM", "UNREAD"]);
  const row = (await service.cache.row("a", "m1"))!;
  await service.cache.save("a", { ...row.message, text: "", html: "", labels: ["SPAM", "UNREAD"] } as never, "g");
  await assert.rejects(service.discard("a", "m1", "You discarded it"), (e: ProviderError) => e.code === "spam_not_discardable" && e.status === 400);
  assert.ok(!gmail.seen.some((s) => s.includes("/modify")), "nothing was asked of Gmail");
  assert.deepEqual(gmail.labels.get("m1"), ["SPAM", "UNREAD"], "still Spam, as Gmail judged it");
  assert.equal(discardErrorText(new ProviderError("spam_not_discardable", 400)),
    "It is in Spam: moving it out would teach the account's spam filter that it is not spam. Spam is emptied on its own");
});

test("Gmail, IMAP: restore takes a discarded message back to the place it was discarded from — archive or Trash", async (t) => {
  quiet(t);
  const { gmail, service } = await gmailFixture();
  await service.discard("a", "m1", "You discarded it");
  gmail.seen.length = 0;
  await service.restoreDiscarded("a", "m1", undefined, "archive");
  assert.deepEqual(gmail.seen.filter((x) => x.includes("/modify")), ['POST messages/m1/modify {"addLabelIds":[],"removeLabelIds":["Label_7"]}'], "out of Discarded, not into the inbox");
  assert.equal((await service.listInboxMessages("a", { folder: "archive", query: "", limit: 10 })).length, 1);
  await service.discard("a", "m1", "You discarded it");
  await service.restoreDiscarded("a", "m1", undefined, "trash");
  assert.ok(gmail.labels.get("m1")!.includes("TRASH"));
  assert.ok(!gmail.labels.get("m1")!.includes("Label_7"));
  assert.equal((await service.listInboxMessages("a", { folder: "trash", query: "", limit: 10 })).length, 1);

  const imap = await imapFixture(t);
  imap.imap.deliver("INBOX", mail("Filed"));
  const { id } = await imap.service.connectImap({ preset: "fastmail", email: EMAIL, password: PASS });
  await settle(imap.service, id);
  const m = (await page(imap.service, id, "inbox"))[0]!;
  const archived = await imap.service.archive(id, m.providerMessageId);
  const moved = await imap.service.discard(id, archived.providerMessageId, "You discarded it");
  assert.equal(moved.from, "archive");
  await imap.service.restoreDiscarded(id, moved.id, undefined, "archive");
  assert.equal(imap.imap.folder("Archive").messages.length, 1);
  assert.equal(imap.imap.folder("Discarded").messages.length, 0);
  assert.equal(imap.imap.folder("INBOX").messages.length, 0);
});

test("Gmail: a label deleted in Gmail since is made again, once; one the person made by hand is found by name", async (t) => {
  quiet(t);
  const { gmail, store, service } = await gmailFixture();
  await store.put("label:a:discarded", "Label_gone");
  await service.discard("a", "m1", "You discarded it");
  assert.deepEqual(gmail.userLabels.map((l) => l.name), ["Discarded"]);
  assert.equal(await store.get("label:a:discarded"), gmail.userLabels[0]!.id);

  const other = await gmailFixture();
  other.gmail.userLabels.push({ id: "Label_3", name: "discarded" });
  await other.service.discard("a", "m1", "You discarded it");
  assert.equal(other.gmail.userLabels.length, 1, "found, not made");
  assert.equal(await other.store.get("label:a:discarded"), "Label_3");
});

test("Gmail: the facts of a cached message come from the cache, with no request to Gmail", async (t) => {
  quiet(t);
  const { gmail, service } = await gmailFixture();
  const facts = await service.discardFacts("a", "m1");
  assert.equal(facts.sender, "Shop <deals@shop.example>");
  assert.deepEqual(facts.headers, [{ key: "List-Id", value: "<deals.shop.example>" }]);
  assert.deepEqual(gmail.seen, []);
  await assert.rejects(service.discardFacts("a", "nope"), (e: ProviderError) => e.code === "message_not_found");
});
