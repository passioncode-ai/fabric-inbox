import test from "node:test";
import assert from "node:assert/strict";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { ProviderError } from "../workers/providers/gmail-client";
import { consumeState } from "../workers/providers/google-oauth";
import { authorizeOutcome, retryAfter } from "../workers/providers/outlook/oauth";
import type { OutlookAccount } from "../workers/providers/outlook/types";
import { MemoryStore } from "./memory-store";
import { FakeGraph, type FakeGraphOptions } from "./fake-graph";

/**
 * Outlook accounts end to end through AccountService (WS5): Microsoft sign-in with PKCE, the
 * import and the delta rounds, new mail, changes made in another mail app, a delta reset, mail
 * actions, sends and drafts with their files, refreshed and rotated tokens, refusals that need the
 * person, the owner or only patience, and throttling — against a fake of Microsoft's identity
 * platform and Microsoft Graph that answers as their documented contracts do (fake-graph.ts).
 */
const KEY = Buffer.alloc(32, 5).toString("base64url");
const ENV = {
  MAIL_CREDENTIAL_KEY: KEY,
  MICROSOFT_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
  MICROSOFT_CLIENT_SECRET: ["made", "up", "client", "secret", "words"].join("-"),
  PUBLIC_APP_URL: "https://mail.example.invalid",
};
const EMAIL = "ann@outlook.example";

async function fixture(t: test.TestContext, options: FakeGraphOptions = {}) {
  const graph = new FakeGraph(options);
  const store = new MemoryStore();
  const service = new AccountService(store, ENV, graph.fetch);
  const logs: string[] = [];
  const log = console.log, warn = console.warn;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.warn = (...a: unknown[]) => logs.push(a.join(" "));
  t.after(() => { console.log = log; console.warn = warn; });
  return { graph, store, service, logs };
}
async function begin(service: AccountService) {
  const { authorizationUrl, browserToken } = await service.outlookConnect();
  return { url: new URL(authorizationUrl), browserToken, state: new URL(authorizationUrl).searchParams.get("state")! };
}
async function connect(service: AccountService, graph: FakeGraph) {
  const { state, browserToken } = await begin(service);
  return service.outlookCallback(state, browserToken, graph.issueCode());
}
const record = async (store: MemoryStore, id: string) => (await store.get<OutlookAccount>("account:" + id))!;
async function settle(service: AccountService, id: string) {
  for (let i = 0; i < 30; i++) {
    const a = await service.sync(id, { deadline: Date.now() + 10_000 });
    const sync = a.sync as OutlookAccount["sync"];
    if (sync.mode === "history" && !sync.more) return a;
  }
  throw new Error("sync did not settle");
}
const rows = async (service: AccountService, id: string, folder?: Parameters<AccountService["listMessages"]>[1]) =>
  (await service.listMessages(id, { limit: 100, ...folder })).messages;

// ── Signing in ───────────────────────────────────────────────────────────────────

test("the sign-in asks Microsoft's common endpoint for exactly the mail permissions, with PKCE and a state bound to Outlook", async (t) => {
  const { service, store } = await fixture(t);
  const { url, state, browserToken } = await begin(service);
  assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(url.searchParams.get("scope"), "offline_access Mail.ReadWrite Mail.Send User.Read");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("response_mode"), "query");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get("redirect_uri"), "https://mail.example.invalid/api/accounts/outlook/callback");
  assert.equal(url.searchParams.get("client_id"), ENV.MICROSOFT_CLIENT_ID);
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.ok(!url.searchParams.has("client_secret"));
  // A Gmail callback cannot use an Outlook state (and uses it up).
  await assert.rejects(consumeState(store, state, browserToken, Date.now(), "gmail"), /invalid_state/);
  await assert.rejects(consumeState(store, state, browserToken, Date.now(), "outlook"), /invalid_state/);
});

test("connecting reads the person and the mailbox, then keeps the tokens sealed; nothing secret is stored or logged", async (t) => {
  const { service, store, graph, logs } = await fixture(t);
  const account = await connect(service, graph);
  assert.equal(account.provider, "outlook");
  assert.equal(account.email, EMAIL);
  assert.equal(account.status, "syncing");
  assert.ok(!("credentials" in account));
  const stored = await record(store, account.id);
  assert.equal(stored.credentials.version, 2);
  assert.equal(stored.userId, "user-1");
  assert.deepEqual(stored.sync.folders.map((f) => f.role), ["inbox", "sent", "drafts", "trash", "junk", "archive"]);
  const everything = JSON.stringify([...store.data.values()]) + logs.join("\n");
  for (const token of [...graph.refreshTokens, ...graph.accessTokens]) assert.ok(!everything.includes(token), "no token in storage or logs");
  assert.ok(!everything.includes(ENV.MICROSOFT_CLIENT_SECRET));
  const listed = await service.listAccounts();
  const caps = listed.accounts[0]!.capabilities!;
  assert.deepEqual([caps.organization, caps.threads, caps.drafts, caps.archive, caps.spam, caps.trash, caps.sentCopy, caps.auth], ["folders", "provider", true, true, true, true, "provider", "oauth"]);
  assert.equal(listed.accounts[0]!.providerName, "Outlook");
  assert.equal(listed.providers.find((p) => p.id === "outlook")!.status, "configured");
  // Every Graph request asked for immutable ids.
  for (const r of graph.requests.filter((r) => r.url.startsWith("https://graph.microsoft.com/"))) assert.match(r.headers.prefer ?? "", /IdType="ImmutableId"/);
  // The code exchange carried the PKCE verifier and the client secret, to Microsoft only.
  const exchange = graph.requests.find((r) => r.url.endsWith("/oauth2/v2.0/token"))!;
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.match(form.get("code_verifier")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(form.get("client_secret"), ENV.MICROSOFT_CLIENT_SECRET);
  // Connecting the same person again keeps the account, its id and where its sync stands.
  assert.equal((await connect(service, graph)).id, account.id);
});

test("each refusal at the end of the sign-in is its own outcome, and nothing is kept", async (t) => {
  const cases: [FakeGraphOptions, string][] = [
    [{ codeError: { status: 401, error: "invalid_client", description: "AADSTS7000222: The provided client secret keys are expired." } }, "microsoft_secret_expired"],
    [{ codeError: { status: 401, error: "invalid_client", description: "AADSTS7000215: Invalid client secret provided." } }, "microsoft_client_rejected"],
    [{ codeError: { status: 400, error: "invalid_grant", description: "AADSTS54005: code already redeemed" } }, "oauth_failed"],
    [{ codeError: { status: 503, error: "temporarily_unavailable" } }, "provider_unavailable"],
    [{ noRefreshToken: true }, "insufficient_scope"],
    [{ scope: "https://graph.microsoft.com/User.Read" }, "insufficient_scope"],
    [{ noMailbox: true }, "mailbox_unavailable"],
  ];
  for (const [options, code] of cases) {
    const { service, store, graph } = await fixture(t, options);
    await assert.rejects(connect(service, graph), (e: ProviderError) => e.code === code, code);
    assert.equal((await store.list({ prefix: "account:" })).size, 0, code);
  }
  // A state from another browser, or one used twice, is refused before Microsoft is asked anything.
  const { service, graph } = await fixture(t);
  const { state, browserToken } = await begin(service);
  await assert.rejects(service.outlookCallback(state, "another-browser", graph.issueCode()), /invalid_state/);
  await service.outlookCallback(state, browserToken, graph.issueCode());
  await assert.rejects(service.outlookCallback(state, browserToken, graph.issueCode()), /invalid_state/);
  // An error Microsoft sent back is the page's outcome, after the state is checked.
  const again = await begin(service);
  await assert.rejects(service.outlookCallback(again.state, again.browserToken, "", "admin_consent_required"), (e: ProviderError) => e.code === "admin_consent_required");
});

test("an address read through IMAP is not connected a second time through Microsoft, nor the other way round", async (t) => {
  const { service, store, graph } = await fixture(t);
  await store.put("account:i1", { id: "i1", provider: "imap", email: EMAIL, runtime: "cloud", status: "connected", createdAt: 1, credentials: { version: 1, iv: "", ciphertext: "" }, sync: { mode: "history", folders: [] } });
  await assert.rejects(connect(service, graph), (e: ProviderError) => e.code === "already_connected");
  await store.delete("account:i1");
  await connect(service, graph);
  await assert.rejects(service.connectImap({ preset: "custom", email: EMAIL, password: "app-password-1", imapHost: "imap.mailhost.org", smtpHost: "smtp.mailhost.org" }),
    (e: ProviderError) => e.code === "already_connected");
});

test("what Microsoft sends back instead of a code is read into the page's outcome", () => {
  assert.equal(authorizeOutcome("access_denied", "AADSTS65004: User declined to consent to access the app."), "oauth_denied");
  assert.equal(authorizeOutcome("access_denied"), "oauth_denied");
  assert.equal(authorizeOutcome("access_denied", "AADSTS90094: Admin consent is required."), "admin_consent_required");
  assert.equal(authorizeOutcome("consent_required", "AADSTS65001: The user or administrator has not consented"), "admin_consent_required");
  assert.equal(authorizeOutcome("interaction_required", "AADSTS90095: request access"), "admin_consent_required");
  assert.equal(authorizeOutcome("consent_required"), "admin_consent_required");
  assert.equal(authorizeOutcome("invalid_request", "AADSTS50011: The redirect URI does not match"), "redirect_uri_mismatch");
  assert.equal(authorizeOutcome("unauthorized_client", "AADSTS700016: Application not found"), "microsoft_account_type");
  assert.equal(authorizeOutcome("interaction_required"), "signin_incomplete");
  assert.equal(authorizeOutcome("temporarily_unavailable"), "provider_unavailable");
  assert.equal(authorizeOutcome("something_new"), "oauth_failed");
});

// ── Sync ─────────────────────────────────────────────────────────────────────────

test("the first sync imports the Inbox first and newest first, 50 a page, properties only and with no events; then delta rounds keep it", async (t) => {
  const { service, store, graph } = await fixture(t);
  for (let i = 0; i < 120; i++) graph.deliver("Inbox " + i);
  for (let i = 0; i < 3; i++) graph.deliver("Sent " + i, { folder: "sentitems", isRead: true });
  graph.deliver("Old archive", { folder: "archive", isRead: true });
  const account = await connect(service, graph);
  const done = await settle(service, account.id);
  assert.equal(done.status, "connected");
  const firstDelta = graph.requests.find((r) => r.url.includes("/messages/delta"))!;
  assert.match(decodeURIComponent(firstDelta.url), new RegExp(`mailFolders/${graph.folderIds.inbox.replace(/[-=]/g, "\\$&")}/messages/delta`));
  assert.match(decodeURIComponent(firstDelta.url), /\$orderby=receivedDateTime desc/);
  assert.match(firstDelta.headers.prefer!, /odata\.maxpagesize=50/);
  const inbox = await rows(service, account.id, { folder: "inbox" });
  assert.equal(inbox.length, 100, "a page of 100 is read from the cache (120 cached)");
  assert.equal((await service.countInbox(account.id)).total, 120);
  assert.equal((await service.countInbox(account.id)).unread, 120);
  assert.equal((await rows(service, account.id, { folder: "sent" })).length, 3);
  assert.equal((await rows(service, account.id, { folder: "archive" })).length, 1);
  assert.equal((await store.list({ prefix: "pending:event:" })).size, 0, "imported mail is not news");
  // Imported without its body: the body is read when the message is first opened.
  const one = inbox[0]!;
  assert.match(one.providerMessageId, /^o[A-Za-z0-9_-]{24}$/);
  assert.match(one.threadId, /^c[A-Za-z0-9_-]{22}$/);
  const opened = await service.getMessage(account.id, one.providerMessageId);
  assert.match(opened.text, /^Hello, Inbox/);
  assert.equal(opened.signals?.listId !== undefined || opened.signals !== undefined, true);
  const sync = (await record(store, account.id)).sync;
  assert.ok(sync.folders.every((f) => f.deltaLink?.startsWith("https://graph.microsoft.com/v1.0/")), "every folder has its deltaLink");
});

test("new mail arrives whole and once; changes, moves and deletions made elsewhere follow", async (t) => {
  const { service, store, graph } = await fixture(t);
  const keep = graph.deliver("Keep");
  const gone = graph.deliver("Gone");
  const account = await connect(service, graph);
  await settle(service, account.id);
  const fresh = graph.deliver("Fresh", { body: "Brand new" });
  keep.isRead = true; keep.flagged = true; graph.touch(keep);
  graph.purge(gone);
  await settle(service, account.id);
  const inbox = await rows(service, account.id, { folder: "inbox" });
  assert.deepEqual(inbox.map((m) => m.subject).sort(), ["Fresh", "Keep"]);
  const k = inbox.find((m) => m.subject === "Keep")!;
  assert.equal(k.read, true);
  assert.ok(k.labels.includes("STARRED"));
  const f = inbox.find((m) => m.subject === "Fresh")!;
  assert.match((await service.getMessage(account.id, f.providerMessageId)).text, /Brand new/);
  // What only the headers said survives a read-state change made elsewhere (a delta page carries no headers).
  const fullFresh = [...graph.mails.values()].find((m) => m.subject === "Fresh")!;
  fullFresh.isRead = true; graph.touch(fullFresh);
  await settle(service, account.id);
  const kept = (await rows(service, account.id, { folder: "inbox" })).find((m) => m.subject === "Fresh")!;
  assert.equal(kept.read, true);
  assert.ok(kept.signals?.listId, "the List-Id read from the message itself is kept");
  const events = [...(await store.list<{ messageId: string }>({ prefix: "pending:event:" })).values()];
  assert.deepEqual(events.map((e) => e.messageId), [f.providerMessageId], "only the new message is news");
  // Moved to the Archive in Outlook: the same id, now archived; no new event.
  graph.move(keep, "archive");
  await settle(service, account.id);
  const archived = await rows(service, account.id, { folder: "archive" });
  assert.deepEqual(archived.map((m) => m.providerMessageId), [k.providerMessageId]);
  assert.equal((await rows(service, account.id, { folder: "inbox" })).length, 1);
  // Moved to a folder this server does not read: it leaves the cache.
  graph.mails.get(keep.id)!.folder = "someuserfolder";
  graph.movedOut.push({ id: keep.id, folder: "archive", seq: graph.seq++ });
  await settle(service, account.id);
  assert.equal((await rows(service, account.id, { folder: "archive" })).length, 0);
  assert.equal((await store.list({ prefix: "pending:event:" })).size, 1);
});

test("while a folder is still importing, its newest mail is read every tick and is news", async (t) => {
  const { service, store, graph } = await fixture(t);
  for (let i = 0; i < 200; i++) graph.deliver("Old " + i, { received: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString() });
  const account = await connect(service, graph);
  // A history-only pass (Refresh) before the import has got far.
  graph.deliver("Just now", { received: new Date().toISOString() });
  await service.sync(account.id, { historyOnly: true, deadline: Date.now() + 5_000 });
  const now = (await rows(service, account.id, { folder: "inbox", query: "Just now" }));
  assert.equal(now.length, 1);
  assert.equal((await store.list({ prefix: "pending:event:" })).size, 1);
  assert.equal((await record(store, account.id)).sync.mode, "initial");
});

test("a delta link Graph no longer knows (410 Gone) imports the folder again and removes what it no longer has", async (t) => {
  const { service, store, graph } = await fixture(t);
  const a = graph.deliver("Stays"), b = graph.deliver("Vanishes");
  const account = await connect(service, graph);
  await settle(service, account.id);
  // Removed while the delta history was lost: no @removed will ever say so.
  graph.mails.delete(b.id);
  graph.resetNext.add("inbox");
  await settle(service, account.id);
  assert.deepEqual((await rows(service, account.id, { folder: "inbox" })).map((m) => m.subject), ["Stays"]);
  void a;
  assert.ok((await record(store, account.id)).sync.folders.every((f) => !f.sweep));
});

// ── Tokens ───────────────────────────────────────────────────────────────────────

test("an ended access token is renewed; a rotated refresh token is sealed at once and the old one never used again", async (t) => {
  const { service, store, graph } = await fixture(t, { rotate: true });
  const account = await connect(service, graph);
  const before = (await record(store, account.id)).credentials;
  graph.accessTokens.clear(); // every access token ends
  await settle(service, account.id);
  const after = (await record(store, account.id)).credentials;
  assert.notDeepEqual(after, before, "the renewed tokens are sealed into the record");
  const refreshes = graph.requests.filter((r) => r.url.endsWith("/token") && /grant_type=refresh_token/.test(r.body ?? ""));
  assert.ok(refreshes.length >= 1);
  graph.accessTokens.clear();
  await service.sync(account.id, { historyOnly: true, deadline: Date.now() + 5_000 });
  const used = graph.requests.filter((r) => r.url.endsWith("/token") && /grant_type=refresh_token/.test(r.body ?? "")).map((r) => new URLSearchParams(r.body).get("refresh_token"));
  assert.equal(new Set(used).size, used.length, "each refresh used the newest refresh token");
  assert.equal((await record(store, account.id)).status, "connected");
});

test("a grant Microsoft took back needs a reconnect; the server's client refused needs the setup; a busy Microsoft only waits", async (t) => {
  const cases: [FakeGraphOptions["refreshError"], string, string, string | undefined][] = [
    [{ status: 400, error: "invalid_grant", description: "AADSTS70008: The refresh token has expired due to inactivity." }, "reconnect_required", "reconnect_required", "microsoft_access_revoked"],
    [{ status: 400, error: "interaction_required", description: "AADSTS50076: multi-factor authentication" }, "reconnect_required", "reconnect_required", "microsoft_signin_required"],
    [{ status: 401, error: "invalid_client", description: "AADSTS7000222: The provided client secret keys are expired." }, "error", "microsoft_secret_expired", "microsoft_secret_expired"],
    [{ status: 401, error: "unauthorized_client", description: "AADSTS700016: Application not found." }, "error", "microsoft_client_rejected", "microsoft_client_rejected"],
    [{ status: 503, error: "temporarily_unavailable" }, "error", "provider_unavailable", undefined],
  ];
  for (const [refreshError, status, error, reason] of cases) {
    const { service, store, graph } = await fixture(t);
    const account = await connect(service, graph);
    graph.accessTokens.clear();
    graph.options.refreshError = refreshError;
    await assert.rejects(service.sync(account.id, { deadline: Date.now() + 5_000 }));
    const stored = await record(store, account.id);
    assert.equal(stored.status, status, error);
    assert.equal(stored.error, error);
    assert.equal(stored.reason, reason);
    if (status !== "reconnect_required") assert.ok(stored.retryAt! > Date.now(), "it tries again after a wait");
  }
});

test("a throttled request waits for Retry-After: briefly in place, or as the account's next try", async (t) => {
  const { service, store, graph } = await fixture(t);
  graph.deliver("One");
  const account = await connect(service, graph);
  graph.throttles.push({ match: /\/messages\/delta/, times: 1, retryAfter: "1" });
  const started = Date.now();
  await settle(service, account.id);
  assert.ok(Date.now() - started >= 900, "waited the second Graph asked for");
  assert.equal((await rows(service, account.id, { folder: "inbox" })).length, 1);
  graph.throttles.push({ match: /\/messages\/delta/, times: 1, status: 503, retryAfter: "120" });
  graph.deliver("Two");
  await assert.rejects(service.sync(account.id, { deadline: Date.now() + 5_000 }), (e: ProviderError) => e.code === "rate_limited");
  const stored = await record(store, account.id);
  assert.equal(stored.status, "rate_limited");
  assert.ok(Math.abs(stored.retryAt! - (Date.now() + 120_000)) < 5_000, "the account waits as long as Graph said");
  await assert.rejects(service.sync(account.id, { deadline: Date.now() + 5_000 }), (e: ProviderError) => e.code === "rate_limited", "no request before then");
  const response = new Response(null, { headers: { "Retry-After": new Date(Date.now() + 30_000).toUTCString() } });
  assert.ok(Math.abs(retryAfter(response)! - (Date.now() + 30_000)) < 2_000, "an HTTP date works too");
  assert.ok(retryAfter(new Response(null, { headers: { "Retry-After": "99999" } }))! <= Date.now() + 3_600_000, "bounded to an hour");
});

// ── Actions ──────────────────────────────────────────────────────────────────────

test("read, flag, archive, trash, spam and back are Graph's own changes; the message keeps its id", async (t) => {
  const { service, graph } = await fixture(t);
  const mail = graph.deliver("Act on me");
  const account = await connect(service, graph);
  await settle(service, account.id);
  const id = (await rows(service, account.id, { folder: "inbox" }))[0]!.providerMessageId;
  assert.equal((await service.setRead(account.id, id, true)).read, true);
  assert.equal(mail.isRead, true);
  assert.ok((await service.setStarred(account.id, id, true)).labels.includes("STARRED"));
  assert.equal(mail.flagged, true);
  const archived = await service.archive(account.id, id);
  assert.equal(archived.providerMessageId, id, "immutable ids: the same message here");
  assert.equal(mail.folder, "archive");
  assert.ok(!archived.labels.includes("INBOX"));
  assert.ok((await service.setTrashed(account.id, id, true)).labels.includes("TRASH"));
  assert.equal(mail.folder, "deleteditems");
  assert.ok((await service.moveToInbox(account.id, id)).labels.includes("INBOX"));
  assert.ok((await service.setSpam(account.id, id, true)).labels.includes("SPAM"));
  assert.equal(mail.folder, "junkemail");
  assert.ok((await service.setSpam(account.id, id, false)).labels.includes("INBOX"));
  const moves = graph.requests.filter((r) => r.url.endsWith("/move")).map((r) => JSON.parse(r.body!).destinationId);
  assert.deepEqual(moves, ["archive", "deleteditems", "inbox", "junkemail", "inbox"], "well-known folder names");
  // The body opened before is kept through the moves.
  assert.match((await service.getMessage(account.id, id)).text, /Hello, Act on me/);
});

test("files are read raw ($value), and every header of a message is Graph's own", async (t) => {
  const { service, graph } = await fixture(t);
  const bytes = new Uint8Array([1, 2, 3, 250, 251]);
  graph.deliver("With a file", { attach: [{ name: "a.bin", contentType: "application/octet-stream", bytes }] });
  const account = await connect(service, graph);
  await settle(service, account.id);
  const id = (await rows(service, account.id, { folder: "inbox" }))[0]!.providerMessageId;
  const message = await service.getMessage(account.id, id);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0]!.filename, "a.bin");
  const file = await service.getAttachment(account.id, id, message.attachments[0]!.providerAttachmentId);
  assert.deepEqual(new Uint8Array(Buffer.from(file.data, "base64url")), bytes);
  assert.ok(graph.requests.some((r) => /\/attachments\/[^/]+\/\$value$/.test(decodeURIComponent(new URL(r.url).pathname))));
  const { headers } = await service.getHeaders(account.id, id);
  assert.ok(headers.some((h) => h.key === "List-Id"));
  await assert.rejects(service.getAttachment(account.id, id, "not-a-key!"), (e: ProviderError) => e.code === "invalid_id" || e.code === "attachment_not_found");
});

// ── Sending ──────────────────────────────────────────────────────────────────────

test("a send is a MIME draft made here and sent by Graph: Cc, Bcc, a reply's headers and its files go out once", async (t) => {
  const { service, graph } = await fixture(t);
  const original = graph.deliver("Question");
  const account = await connect(service, graph);
  await settle(service, account.id);
  const receipt = await service.send(account.id, {
    idempotencyKey: "reply-1", to: ["bob@example.org"], cc: ["carol@example.org"], bcc: ["dave@example.org"], subject: "Re: Question", text: "Answer",
    inReplyTo: original.internetMessageId, references: original.internetMessageId,
    attachments: [{ content: Buffer.from("hello file").toString("base64"), filename: "notes.txt", type: "text/plain", disposition: "attachment" }],
  });
  assert.equal(receipt.status, "accepted");
  assert.match(receipt.providerMessageId!, /^o[A-Za-z0-9_-]{24}$/);
  assert.equal(graph.sent.length, 1);
  const sent = graph.sent[0]!;
  assert.deepEqual([sent.to, sent.cc, sent.bcc], [["bob@example.org"], ["carol@example.org"], ["dave@example.org"]]);
  assert.match(sent.mime, new RegExp(`In-Reply-To: ${original.internetMessageId}`));
  assert.match(sent.mime, /Message-ID: <[0-9a-f-]+@outlook\.example>/);
  assert.equal(sent.attachments[0]!.name, "notes.txt");
  assert.equal(sent.folder, "sentitems", "Graph keeps the copy in Sent Items");
  const create = graph.requests.find((r) => r.method === "POST" && r.url === "https://graph.microsoft.com/v1.0/me/messages")!;
  assert.equal(create.headers["content-type"], "text/plain");
  // The same key again answers the first send; nothing leaves twice.
  assert.equal((await service.send(account.id, { idempotencyKey: "reply-1", to: ["bob@example.org"], cc: ["carol@example.org"], bcc: ["dave@example.org"],
    subject: "Re: Question", text: "Answer", inReplyTo: original.internetMessageId, references: original.internetMessageId,
    attachments: [{ content: Buffer.from("hello file").toString("base64"), filename: "notes.txt", type: "text/plain", disposition: "attachment" }] })).status, "accepted");
  assert.equal(graph.sent.length, 1);
});

test("a file over 3 MB goes through an upload session in ranges, without the Authorization header", async (t) => {
  const { service, graph } = await fixture(t);
  const account = await connect(service, graph);
  const big = Buffer.alloc(4 * 1024 * 1024 + 17, 7);
  const receipt = await service.send(account.id, { idempotencyKey: "big-1", to: ["bob@example.org"], subject: "Big", text: "See file",
    attachments: [{ content: big.toString("base64"), filename: "big.bin", type: "application/octet-stream", disposition: "attachment" }] });
  assert.equal(receipt.status, "accepted");
  const puts = graph.requests.filter((r) => r.method === "PUT");
  assert.ok(puts.length >= 2, "more than one range");
  assert.ok(puts.every((r) => !r.headers.authorization));
  assert.ok(puts.every((r) => /^bytes \d+-\d+\/4194321$/.test(r.headers["content-range"]!)));
  assert.equal(graph.sent[0]!.attachments[0]!.bytes.length, big.length);
  const draft = graph.requests.find((r) => r.method === "POST" && r.url.endsWith("/me/messages"))!;
  assert.ok(draft.body!.length < 1_000_000, "the draft itself was made without the file");
});

test("a send Graph refuses is not sent (the key may try again); a send with no answer is an unknown outcome", async (t) => {
  const { service, graph } = await fixture(t);
  const account = await connect(service, graph);
  graph.throttles.push({ match: /^POST \/v1\.0\/me\/messages\/[^/]+\/send$/, times: 1, retryAfter: "30" });
  await assert.rejects(service.send(account.id, { idempotencyKey: "t-1", to: ["bob@example.org"], subject: "S", text: "x" }), (e: ProviderError) => e.code === "rate_limited");
  assert.equal(graph.sent.length, 0);
  assert.equal([...graph.mails.values()].filter((m) => m.folder === "drafts").length, 0, "the refused draft left Drafts");
  assert.equal((await service.send(account.id, { idempotencyKey: "t-1", to: ["bob@example.org"], subject: "S", text: "x" })).status, "accepted", "the same key tries again");
  // The send request leaves and no answer comes back.
  const real = graph.fetch;
  graph.fetch = async (input, init) => { if (/\/send$/.test(String(input))) { await real(input, init); throw new TypeError("connection reset"); } return real(input, init); };
  const lost = await new AccountService((service as unknown as { store: MemoryStore }).store, ENV, graph.fetch).send(account.id, { idempotencyKey: "t-2", to: ["bob@example.org"], subject: "S2", text: "y" });
  assert.equal(lost.status, "unknown");
  assert.equal(lost.error, "provider_unavailable");
});

// ── Drafts ───────────────────────────────────────────────────────────────────────

test("drafts are the Drafts folder's own: listed, read, changed with a revision, sent and deleted", async (t) => {
  const { service, graph } = await fixture(t);
  const account = await connect(service, graph);
  const made = await service.createDraft(account.id, { idempotencyKey: "d-1", to: ["bob@example.org"], subject: "Draft", text: "First",
    attachments: [{ content: Buffer.from("one").toString("base64"), filename: "one.txt", type: "text/plain", disposition: "attachment" }] });
  assert.equal(made.status, "accepted");
  const draftId = made.providerDraftId!;
  const listed = await service.listDrafts(account.id);
  assert.deepEqual(listed.drafts.map((d) => d.draftId), [draftId]);
  const read = await service.getDraft(account.id, draftId);
  assert.match(read.text!, /First/);
  assert.equal(read.attachments.length, 1);
  const updated = await service.updateDraft(account.id, draftId, { to: ["bob@example.org", "carol@example.org"], subject: "Draft 2", text: "Second", expectedRevision: read.revision, keepAttachments: [] });
  assert.equal(updated.draftId, draftId, "a draft keeps its id");
  assert.notEqual(updated.revision, read.revision);
  await assert.rejects(service.updateDraft(account.id, draftId, { to: ["bob@example.org"], subject: "Stale", text: "x", expectedRevision: read.revision }),
    (e: ProviderError) => e.code === "draft_conflict");
  const again = await service.getDraft(account.id, draftId);
  assert.equal(again.subject, "Draft 2");
  assert.equal(again.attachments.length, 0, "the file not kept was removed");
  await assert.rejects(service.sendDraft(account.id, draftId, "send-d-1", read.revision), (e: ProviderError) => e.code === "draft_conflict");
  const sent = await service.sendDraft(account.id, draftId, "send-d-1", updated.revision);
  assert.equal(sent.status, "accepted");
  assert.equal(sent.providerMessageId, draftId, "immutable ids: the draft's id is the sent copy's");
  assert.deepEqual(graph.sent[0]!.to, ["bob@example.org", "carol@example.org"]);
  await assert.rejects(service.getDraft(account.id, draftId), (e: ProviderError) => e.code === "draft_not_found");
  const other = await service.createDraft(account.id, { idempotencyKey: "d-2", to: ["bob@example.org"], subject: "Bin me", text: "x" });
  assert.deepEqual(await service.deleteDraft(account.id, other.providerDraftId!), { deleted: other.providerDraftId });
  assert.equal((await service.listDrafts(account.id)).drafts.length, 0);
});

test("disconnecting forgets the tokens, the cache and the id map, and says the access must be removed at Microsoft", async (t) => {
  const { service, store, graph } = await fixture(t);
  graph.deliver("One");
  const account = await connect(service, graph);
  await settle(service, account.id);
  await service.createDraft(account.id, { idempotencyKey: "d-x", to: ["bob@example.org"], subject: "x", text: "x" });
  const result = await service.disconnect(account.id);
  assert.deepEqual(result, { status: "disconnected", revoked: false, provider: "outlook" });
  for (const prefix of ["account:", "message:", "gid:", "body:", "idx:"]) assert.equal((await store.list({ prefix })).size, 0, prefix);
});

test("an Outlook account's provider not set up on this server is left alone by the schedule", async (t) => {
  const { service, graph, store } = await fixture(t);
  const account = await connect(service, graph);
  const bare = new AccountService(store, { MAIL_CREDENTIAL_KEY: KEY }, graph.fetch);
  assert.equal(bare.ready(await record(store, account.id) as AccountRecord), false);
  await assert.rejects(bare.sync(account.id, { deadline: Date.now() + 1000 }), (e: ProviderError) => e.code === "not_configured");
});
