import test from "node:test";
import assert from "node:assert/strict";
import { addressLabel, groupAccounts } from "../app/components/inbox/account-groups";
import { isRemote, messagePath, rulesPath, type InboxAccount, type InboxMessage } from "../app/components/inbox/model";
import { refreshScope, refreshSummary } from "../app/lib/mail-refresh";
import { listServerDrafts, syncDraft, type Request } from "../app/components/inbox/server-drafts";
import { changeMessage } from "../app/components/inbox/MessageActions";
import type { AttachmentStorage } from "../app/components/inbox/attachment-store";

/** The main window with IMAP accounts (WS4): the sidebar, the routes it calls, Refresh and drafts. */
const account = (id: string, provider: InboxAccount["provider"], email: string): InboxAccount => ({ id, provider, email, name: email, status: "connected" });

test("IMAP accounts are one group, Other mail, after Gmail; each is shown by its address", () => {
  const groups = groupAccounts([account("imap:b", "imap", "b@icloud.com"), account("cloudflare:x@shop.invalid", "cloudflare", "x@shop.invalid"),
    account("gmail:g", "gmail", "g@gmail.com"), account("imap:a", "imap", "a@fastmail.com")]);
  assert.deepEqual(groups.map((g) => [g.key, g.kind, g.accounts.map((a) => a.id)]), [
    ["gmail", "gmail", ["gmail:g"]], ["imap", "imap", ["imap:a", "imap:b"]], ["shop.invalid", "domain", ["cloudflare:x@shop.invalid"]]]);
  assert.equal(groups[1]!.label, "Other mail");
  assert.equal(addressLabel(account("imap:a", "imap", "a@fastmail.com")), "a@fastmail.com");
});

test("an IMAP message is read, changed and its rules reached through /api/accounts/<id>, as Gmail's", async () => {
  const m = { id: "x", accountId: "imap:acc1", provider: "imap", providerMessageId: "i-17-4", starred: false } as InboxMessage;
  assert.equal(isRemote("imap"), true);
  assert.equal(isRemote("cloudflare"), false);
  assert.equal(messagePath(m), "/api/accounts/acc1/messages/i-17-4");
  assert.equal(rulesPath(account("imap:acc1", "imap", "a@x.org")), "/automation/imap%3Aacc1");
  const calls: [string, unknown, string | undefined][] = [];
  await changeMessage(m, { starred: true }, async (url, body, method) => { calls.push([url, body, method]); return { labels: ["INBOX", "STARRED"] }; });
  await changeMessage(m, { trashed: true }, async (url, body, method) => { calls.push([url, body, method]); return {}; });
  assert.deepEqual(calls, [["/api/accounts/acc1/messages/i-17-4/starred", { starred: true }, "POST"], ["/api/accounts/acc1/messages/i-17-4/trashed", { trashed: true }, "POST"]]);
});

test("Refresh reads an IMAP account in view, and says what its server did", () => {
  assert.deepEqual(refreshScope({ accountId: "imap:acc1", domain: "" }), ["imap:acc1"]);
  const summary = refreshSummary([{ accountId: "imap:acc1", email: "a@icloud.com", result: "failed", error: "provider_unavailable" },
    { accountId: "imap:acc2", email: "b@yahoo.com", result: "reconnect" }]);
  assert.match(summary.text, /a@icloud\.com: Its mail server could not be reached/);
  assert.match(summary.text, /b@yahoo\.com needs to be connected again \(Settings → Accounts\)/);
  assert.doesNotMatch(summary.text, /Gmail/);
});

test("IMAP drafts are listed and saved through the same routes as Gmail's, and say who keeps them", async () => {
  const calls: string[] = [];
  const request: Request = async <T,>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    calls.push(`${method} ${url}`);
    if (url === "/api/accounts/acc1/drafts" && method === "GET") return { drafts: [{ draftId: "d-1-5", revision: "d-1-5", to: "b@x.org", subject: "S", date: "2026-10-06T10:00:00Z", snippet: "", attachments: [] }] } as T;
    throw Object.assign(new Error("no route"), { status: 404, body: { error: "no route" } });
  };
  const listed = await listServerDrafts(["imap:acc1"], request);
  assert.deepEqual(listed.drafts.map((d) => [d.accountId, d.serverId]), [["imap:acc1", "d-1-5"]]);
  const files: AttachmentStorage = { add: async () => {}, get: async () => undefined, remove: async () => {} };
  const waiting = await syncDraft({ id: "l1", accountId: "imap:acc1", to: "", subject: "", text: "x", idempotencyKey: "k", mode: "new" }, files, request);
  assert.equal(!waiting.ok && waiting.reason, "incomplete");
  assert.match(!waiting.ok ? waiting.message : "", /^Your mail server saves a draft once it has a recipient/);
});
