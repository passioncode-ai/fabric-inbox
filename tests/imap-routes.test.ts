import test from "node:test";
import assert from "node:assert/strict";
import { accountsRouter } from "../workers/routes/accounts";
import { ProviderError } from "../workers/providers/gmail-client";
import { normaliseAccountId, scopedApi, toolFitsScope } from "../workers/mcp/scope";
import { NOT_TOOLS, TOOLS, parseAccount } from "../workers/mcp/tools";
import { call, fakeApi, gmailMessage, ledger, ok, owner } from "./mcp-fake-api";
import { runTool } from "../workers/mcp/protocol";
import { PRESETS } from "../shared/mail/imap-presets";

/** The IMAP routes (WS4) and the agent protocol over IMAP accounts. */
const SERVER = "https://inbox.example.org";
const KEY = Buffer.alloc(32, 5).toString("base64url");
const PASSWORD = "app-password-for-tests";

function env(stub: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { MAIL_CREDENTIAL_KEY: KEY, GMAIL_ACCOUNTS: { getByName: () => stub }, ...extra } as never;
}
const json = (body: unknown, origin = SERVER) => ({ method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("connecting an IMAP account works without Google's setup, from the app's own origin only", async () => {
  const received: unknown[] = [];
  const stub = { connectImap: async (input: unknown) => { received.push(input); return { id: "acc1", provider: "imap", email: "ann@fastmail.com", status: "syncing" }; } };
  const body = { preset: "fastmail", email: "Ann@Fastmail.com", password: PASSWORD };
  const created = await accountsRouter.request(SERVER + "/api/accounts/imap", json(body), env(stub));
  assert.equal(created.status, 201);
  assert.deepEqual(received, [{ preset: "fastmail", email: "ann@fastmail.com", password: PASSWORD }], "the address is lower-cased before anything else");
  for (const origin of ["https://evil.example.org", ""]) {
    const refused = await accountsRouter.request(SERVER + "/api/accounts/imap", { ...json(body), headers: origin ? { Origin: origin } : {} }, env(stub));
    assert.equal(refused.status, 403);
  }
  assert.equal(received.length, 1);
  const bad = await accountsRouter.request(SERVER + "/api/accounts/imap", json({ preset: "nowhere", email: "x", password: "" }), env(stub));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_account_settings" });
  // Gmail's own connect routes still need Google's setup.
  const gmail = await accountsRouter.request(SERVER + "/api/accounts/gmail/connect", { method: "POST", headers: { Origin: SERVER } }, env(stub));
  assert.equal(gmail.status, 503);
});

test("what went wrong while connecting is a public code with a status the app can act on", async () => {
  for (const [code, status] of [["auth_failed", 400], ["app_password_required", 400], ["imap_disabled", 400], ["smtp_auth_failed", 400],
    ["tls_failed", 502], ["host_unreachable", 502], ["smtp_unreachable", 502], ["already_connected", 409], ["port_blocked", 400]] as const) {
    const stub = { connectImap: async () => { throw new ProviderError(code, 400); } };
    const response = await accountsRouter.request(SERVER + "/api/accounts/imap", json({ preset: "icloud", email: "ann@icloud.com", password: PASSWORD }), env(stub));
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code });
  }
});

test("a new password goes to its account; the providers list carries the presets and no secret", async () => {
  const seen: unknown[] = [];
  const stub = {
    updateImapPassword: async (...a: unknown[]) => { seen.push(a); return { id: "acc1", status: "connected" }; },
    mailProviders: async () => ({ providers: [{ id: "imap", status: "configured" }], presets: PRESETS.map((p) => ({ id: p.id })) }),
  };
  const put = await accountsRouter.request(SERVER + "/api/accounts/acc1/password", { method: "PUT", headers: { Origin: SERVER, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) }, env(stub));
  assert.equal(put.status, 200);
  assert.deepEqual(seen, [["acc1", PASSWORD]]);
  const empty = await accountsRouter.request(SERVER + "/api/accounts/acc1/password", { method: "PUT", headers: { Origin: SERVER }, body: JSON.stringify({ password: "" }) }, env(stub));
  assert.equal(empty.status, 400);
  const providers = await accountsRouter.request(SERVER + "/api/accounts/providers", {}, env(stub));
  assert.equal(providers.status, 200);
  assert.equal(((await providers.json()) as { presets: unknown[] }).presets.length, PRESETS.length);
});

test("every preset names its servers, its help page and how to make an app password; IMAP is always TLS and never port 25", () => {
  for (const p of PRESETS) {
    assert.match(p.source, /^https:\/\//, p.id);
    assert.match(p.appPasswordUrl, /^https:\/\//, p.id);
    assert.equal(p.imap.port, 993, p.id);
    assert.ok(p.smtp.port === 465 ? p.smtp.security === "tls" : p.smtp.port === 587 && p.smtp.security === "starttls", p.id);
    assert.ok(p.steps.length > 0, p.id);
  }
  assert.deepEqual(PRESETS.map((p) => p.id).sort(), ["aol", "fastmail", "gmail", "gmx-com", "gmx-net", "icloud", "mailru", "yahoo", "yandex", "zoho", "zoho-org"]);
});

test("the agent protocol names IMAP accounts imap:<id> and never takes a person's password", () => {
  assert.deepEqual(parseAccount("imap:acc-1"), { provider: "imap", remoteId: "acc-1", id: "imap:acc-1" });
  assert.equal(normaliseAccountId("imap:acc-1"), "imap:acc-1");
  assert.equal(normaliseAccountId("imap:bad/id"), null);
  assert.match(NOT_TOOLS["POST /api/accounts/imap"]!, /never receive a person's password/);
  assert.match(NOT_TOOLS["PUT /api/accounts/:accountId/password"]!, /never receive a person's password/);
  for (const tool of TOOLS) assert.ok(!tool.routes.includes("POST /api/accounts/imap") && !tool.routes.includes("PUT /api/accounts/:accountId/password"), tool.name);
  assert.equal(toolFitsScope(TOOLS.find((t) => t.name === "list_mail_providers")!), false, "a limited key does not list the whole workspace's accounts");
});

test("a key limited to an IMAP account reaches it and nothing else", async () => {
  const { api, calls } = fakeApi({ "GET /api/accounts/acc1/messages/m1": ok(gmailMessage()), "GET /api/accounts/other/messages/m1": ok(gmailMessage()),
    "GET /api/accounts": ok({ accounts: [{ id: "acc1", provider: "imap", email: "a@fastmail.com" }, { id: "g2", provider: "gmail", email: "b@gmail.com" }] }) });
  const s = scopedApi(api, ["imap:acc1"]);
  assert.equal((await s.request("GET", "/api/accounts/acc1/messages/m1")).status, 200);
  await assert.rejects(s.request("GET", "/api/accounts/other/messages/m1"), /limited to imap:acc1/);
  const listed = (await s.request("GET", "/api/accounts")).data as { accounts: { id: string }[] };
  assert.deepEqual(listed.accounts.map((a) => a.id), ["acc1"], "another account of another provider is not listed");
  assert.equal(calls.filter((c) => c.path.includes("other")).length, 0);
});

test("read_thread, sync_account, refresh_inbox and move_messages take an IMAP account", async () => {
  const thread = [gmailMessage({ providerMessageId: "i-1-2", timestamp: 2, subject: "Re: Order" }), gmailMessage({ providerMessageId: "i-1-1", timestamp: 1 })];
  const { api, calls } = fakeApi({
    "GET /api/accounts/acc1/messages": ok({ messages: thread }),
    "GET /api/accounts/acc1/messages/i-1-1": ok(gmailMessage({ providerMessageId: "i-1-1" })),
    "GET /api/accounts/acc1/messages/i-1-2": ok(gmailMessage({ providerMessageId: "i-1-2", subject: "Re: Order" })),
    "POST /api/accounts/acc1/sync": ok({ status: "connected" }),
    "POST /api/inbox/refresh": ok({ accounts: [] }),
    "POST /api/accounts/acc1/messages/i-1-1/archive": ok(gmailMessage({ providerMessageId: "a-1-9" })),
  });
  const read = await call(api, "read_thread", { accountId: "imap:acc1", threadId: "t1" });
  assert.equal(read.isError, false);
  assert.deepEqual(read.data.messages.map((m: { messageId: string }) => m.messageId), ["i-1-1", "i-1-2"], "oldest first");
  assert.equal(calls[0]!.query!.threadId, "t1");
  assert.equal((await call(api, "sync_account", { accountId: "imap:acc1" })).isError, false);
  await call(api, "refresh_inbox", { accountIds: ["imap:acc1"] });
  assert.deepEqual(calls.find((c) => c.path === "/api/inbox/refresh")!.body, { accounts: ["imap:acc1"] });
  const moved = await call(api, "move_messages", { messages: [{ accountId: "imap:acc1", messageId: "i-1-1" }], to: "archive" });
  assert.equal(moved.isError, false);
});

test("list_mail_providers says where a person connects an IMAP account, with every account's state", async () => {
  const { api } = fakeApi({
    "GET /api/accounts/providers": ok({ providers: [{ id: "imap", status: "configured" }], presets: [{ id: "icloud" }] }),
    "GET /api/accounts": ok({ accounts: [{ id: "acc1", provider: "imap", providerName: "iCloud Mail", email: "a@icloud.com", status: "reconnect_required", capabilities: { archive: true } }] }),
  });
  const out = await call(api, "list_mail_providers", {});
  assert.equal(out.isError, false);
  assert.equal(out.data.settingsUrl, "/settings/accounts?connect=imap");
  assert.deepEqual(out.data.accounts[0], { accountId: "imap:acc1", provider: "imap", providerName: "iCloud Mail", email: "a@icloud.com", status: "reconnect_required",
    lastSyncAt: null, error: null, capabilities: { archive: true } });
  assert.ok(!JSON.stringify(out.data).includes("password\":"), "no secret is in the answer");
});

test("disconnect_account takes Gmail and IMAP accounts, in two calls", async () => {
  const { api, calls } = fakeApi({ "POST /api/accounts/acc1/disconnect": ok({ status: "disconnected", revoked: false, provider: "imap" }) });
  const first = await call(api, "disconnect_account", { accountId: "imap:acc1" });
  assert.equal(first.data.needsConfirmation, true);
  assert.equal(calls.length, 0, "the first call only asks");
  const tool = TOOLS.find((t) => t.name === "disconnect_account")!;
  const done = await runTool(tool, { accountId: "imap:acc1", confirm: "CODE" }, { api, principal: owner }, ledger().ledger);
  assert.equal(done.isError, undefined);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/accounts/acc1/disconnect"]);
  const refused = await runTool(tool, { accountId: "cloudflare:support@shop.invalid", confirm: "CODE" }, { api, principal: owner }, ledger().ledger);
  assert.equal(refused.isError, true);
});
