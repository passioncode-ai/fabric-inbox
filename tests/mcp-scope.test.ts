// Agent keys limited to mailboxes (AP-11): a key that names its accounts reaches those accounts
// and nothing else — not another mailbox, not the workspace's settings — and fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseKeys, principalFor, type AgentKey, type Principal } from "../workers/mcp/keys";
import { runTool, toolsFor, type Api, type ApiResponse, type Ledger } from "../workers/mcp/protocol";
import { normaliseAccountId, scopedApi, toolFitsScope } from "../workers/mcp/scope";
import { TOOLS } from "../workers/mcp/tools";
import { validateNewKey } from "../workers/routes/agent-keys";

const key = (over: Partial<AgentKey> = {}): AgentKey => ({
  id: "tok-1", clientId: "abc.access", name: "Research agent", level: "read", send: "drafts", dailySendLimit: 50,
  createdAt: "2026-10-03T00:00:00.000Z", expiresAt: "2027-10-03T00:00:00.000Z", accounts: null, ...over,
});
const scoped = (accounts: string[], over: Partial<Principal> = {}): Principal =>
  ({ kind: "agent", label: "Research agent", level: "read", send: "drafts", dailySendLimit: 50, keyId: "tok-1", accounts, ...over }) as Principal;
const ledger = (): Ledger => ({
  issueConfirmation: async () => ({ code: "CODE", expiresAt: 0 }), consumeConfirmation: async () => true,
  reserveSend: async () => ({ ok: true, used: 1, limit: 5 }), refundSend: async () => {}, record: async () => {},
});

/** An API that records what was asked and answers like the app would. */
function fakeApi(answers: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; query?: Record<string, unknown> }[] = [];
  const api: Api = {
    async request(method, path, init = {}): Promise<ApiResponse> {
      calls.push({ method, path, query: init.query });
      const found = Object.entries(answers).find(([p]) => path === p || path.startsWith(`${p}?`));
      return { status: 200, data: found ? found[1] : { ok: true }, contentType: "application/json" };
    },
  };
  return { api, calls };
}

const RESEARCH = "cloudflare:research@sshlg.me";

test("account ids normalise the way list_accounts names them, and anything else is refused", () => {
  assert.equal(normaliseAccountId("cloudflare:Research@SSHLG.me"), RESEARCH);
  assert.equal(normaliseAccountId("research@sshlg.me"), RESEARCH, "a bare address is a Cloudflare mailbox");
  assert.equal(normaliseAccountId("gmail:abc_DEF-1"), "gmail:abc_DEF-1");
  for (const bad of ["", "cloudflare:", "cloudflare:a/b@x.com", "gmail:a/b", "smtp:x@y.z", "research"]) assert.equal(normaliseAccountId(bad), null, bad);
});

test("a key file keeps a key's accounts; none is the whole workspace; a damaged list reaches nothing (fails closed)", () => {
  const [all, some, damaged, empty] = normaliseKeys({ keys: [
    { id: "a", clientId: "a" },
    { id: "b", clientId: "b", accounts: ["cloudflare:Research@sshlg.me", "research@sshlg.me", "nonsense"] },
    { id: "c", clientId: "c", accounts: ["nonsense", 7] },
    { id: "d", clientId: "d", accounts: "cloudflare:x@y.z" },
  ] });
  assert.equal(all!.accounts, null);
  assert.deepEqual(some!.accounts, [RESEARCH], "lower-cased, de-duplicated, invalid entries dropped");
  assert.deepEqual(damaged!.accounts, [], "a list with nothing valid in it reaches no mailbox");
  assert.deepEqual(empty!.accounts, [], "a non-list where a list belongs reaches no mailbox");
});

test("a limited key's principal carries its accounts; the owner and a whole-workspace key carry none", () => {
  const now = Date.parse("2026-10-04T00:00:00Z");
  assert.deepEqual(principalFor({ common_name: "abc.access" }, [key({ accounts: [RESEARCH] })], now)?.accounts, [RESEARCH]);
  assert.equal(principalFor({ common_name: "abc.access" }, [key()], now)?.accounts, null);
  assert.equal(principalFor({ email: "owner@x.invalid" }, [], now)?.accounts, null);
});

test("a key limited to mailboxes sees only tools that stay inside a mailbox or the feed", () => {
  const names = (p: Principal) => toolsFor(p, TOOLS).map((t) => t.name).sort();
  const read = names(scoped([RESEARCH]));
  for (const t of ["list_accounts", "list_messages", "search_mailbox", "list_mailbox_messages", "read_message", "read_thread", "get_attachment", "list_folders"]) assert.ok(read.includes(t), t);
  for (const t of ["list_addresses", "list_domains", "list_agents", "list_rules", "get_spam_settings", "list_categories", "search_knowledge", "list_cloudflare_accounts", "check_address_routing"])
    assert.ok(!read.includes(t), `${t} reads the whole workspace`);
  const mail = names(scoped([RESEARCH], { level: "mail", send: "send" }));
  for (const t of ["save_draft", "send_email", "reply", "move_messages", "update_messages", "delete_message", "manage_folder"]) assert.ok(mail.includes(t), t);
  for (const t of ["mark_spam", "mark_category_seen", "approve_rule_run"]) assert.ok(!mail.includes(t), `${t} changes something shared by every mailbox`);
  const whole = names(scoped(null as never, { accounts: null } as never));
  assert.ok(whole.includes("list_addresses") && whole.includes("list_domains"), "a whole-workspace key is unchanged");
});

test("whether a tool fits a mailbox scope is read from its routes, so a new workspace tool is hidden by default", () => {
  assert.equal(toolFitsScope({ routes: ["GET /api/v1/mailboxes/:mailboxId/emails"] } as never), true);
  assert.equal(toolFitsScope({ routes: ["GET /api/inbox", "GET /api/accounts"] } as never), true);
  assert.equal(toolFitsScope({ routes: ["GET /api/v1/mailboxes/:mailboxId/emails", "POST /api/spam/report"] } as never), false);
  assert.equal(toolFitsScope({ routes: ["GET /api/v1/mailboxes"] } as never), false, "the list of every mailbox is the workspace");
  assert.equal(toolFitsScope({ routes: [] } as never), false);
});

test("the scoped API lets a key into its own mailbox and refuses every other path", async () => {
  const { api, calls } = fakeApi();
  const s = scopedApi(api, [RESEARCH, "gmail:g1"]);
  await s.request("GET", "/api/v1/mailboxes/research%40sshlg.me/emails/42");
  await s.request("GET", "/api/v1/mailboxes/RESEARCH%40sshlg.me/threads/t1");
  await s.request("POST", "/api/accounts/g1/messages/m1/read", { body: { read: true } });
  assert.equal(calls.length, 3);
  for (const [method, path] of [
    ["GET", "/api/v1/mailboxes/contact%40sshlg.me/emails"],
    ["GET", "/api/v1/mailboxes"],
    ["GET", "/api/v1/mailboxes/research%40sshlg.me%2F..%2Fcontact%40sshlg.me/emails"],
    ["POST", "/api/spam/report"],
    ["GET", "/api/project-addresses"],
    ["GET", "/api/accounts/g2/messages"],
    ["PUT", "/api/inbox/hidden"],
  ] as const) {
    await assert.rejects(s.request(method, path), (e: Error & { status?: number }) => e.status === 403 && /limited to/.test(e.message), `${method} ${path}`);
  }
  assert.equal(calls.length, 3, "nothing refused reached the app");
});

test("the feed is narrowed to the key's mailboxes, in the request and in the answer", async () => {
  const feed = {
    accounts: [{ id: RESEARCH, email: "research@sshlg.me" }, { id: "cloudflare:contact@sshlg.me", email: "contact@sshlg.me" }],
    messages: [{ accountId: RESEARCH, providerMessageId: "1" }, { accountId: "cloudflare:contact@sshlg.me", providerMessageId: "2" }],
    issues: [], hasMore: false,
  };
  const one = fakeApi({ "/api/inbox": feed, "/api/accounts": { accounts: [{ id: "g1" }, { id: "g2" }] }, "/api/inbox/hidden": { hidden: ["cloudflare:research@sshlg.me", "cloudflare:contact@sshlg.me", "gmail:g1"] } });
  const s = scopedApi(one.api, [RESEARCH]);
  const got = (await s.request("GET", "/api/inbox", { query: { limit: 25 } })).data as typeof feed;
  assert.equal(one.calls[0]!.query!.account, RESEARCH, "the only mailbox is named for the key");
  assert.deepEqual(got.accounts.map((a) => a.id), [RESEARCH]);
  assert.deepEqual(got.messages.map((m) => m.accountId), [RESEARCH], "a row from another mailbox never leaves, even if the app returned it");
  assert.deepEqual(((await s.request("GET", "/api/accounts")).data as { accounts: unknown[] }).accounts, [], "no Gmail account is in this scope");
  assert.deepEqual(((await s.request("GET", "/api/inbox/hidden")).data as { hidden: string[] }).hidden, [RESEARCH], "hidden entries are stored as account ids");
  await assert.rejects(s.request("GET", "/api/inbox", { query: { account: "cloudflare:contact@sshlg.me" } }), (e: Error & { status?: number }) => e.status === 403);

});

test("a key with several mailboxes gets each one's feed merged, one page, newest first (list_accounts works)", async () => {
  const calls: (string | undefined)[] = [];
  const api: Api = { async request(_m, _p, init = {}) {
    const account = String(init.query?.account);
    calls.push(account);
    const n = account === RESEARCH ? 1 : 2;
    return { status: 200, contentType: "application/json", data: {
      accounts: [{ id: account }], issues: [{ provider: "x", accountId: account, error: "slow" }], hasMore: true, cursor: "abc",
      messages: [{ accountId: account, providerMessageId: `m${n}`, date: `2026-10-0${n}T00:00:00Z` }] } };
  } };
  const s = scopedApi(api, [RESEARCH, "gmail:g1"]);
  const out = (await s.request("GET", "/api/inbox", { query: { limit: 25 } })).data as { accounts: { id: string }[]; messages: { providerMessageId: string }[]; cursor?: unknown; hasMore: boolean; issues: unknown[] };
  assert.deepEqual(calls, [RESEARCH, "gmail:g1"]);
  assert.deepEqual(out.accounts.map((a) => a.id), [RESEARCH, "gmail:g1"]);
  assert.deepEqual(out.messages.map((m) => m.providerMessageId), ["m2", "m1"], "newest first");
  assert.equal(out.cursor, undefined, "a merged page has no cursor; page one mailbox at a time");
  assert.match(JSON.stringify(out.issues), /page one mailbox at a time/);
});

test("categories are the workspace's, so a limited key cannot filter the feed by one (review AP-11 #1)", async () => {
  const { api, calls } = fakeApi();
  const s = scopedApi(api, [RESEARCH]);
  await assert.rejects(s.request("GET", "/api/inbox", { query: { account: RESEARCH, category: "c1" } }), (e: Error & { status?: number }) => e.status === 403 && /categor/i.test(e.message));
  assert.equal(calls.length, 0);
});

test("nothing in a feed answer names another mailbox: issues and cursors that do are dropped", async () => {
  const otherCursor = btoa(JSON.stringify({ version: 1, scope: "s", position: { accountId: "cloudflare:contact@sshlg.me", providerMessageId: "9", timestamp: 1 } }));
  const ownCursor = btoa(JSON.stringify({ version: 1, scope: "s", position: { accountId: RESEARCH, providerMessageId: "1", timestamp: 1 } }));
  const answer = (cursor: string) => fakeApi({ "/api/inbox": { accounts: [], messages: [], hasMore: true, cursor,
    issues: [{ provider: "cloudflare", accountId: "cloudflare:contact@sshlg.me", error: "x" }, { provider: "cloudflare", accountId: RESEARCH, error: "y" }] } }).api;
  const leaked = (await scopedApi(answer(otherCursor), [RESEARCH]).request("GET", "/api/inbox", { query: {} })).data as { issues: { accountId: string }[]; cursor?: string; hasMore: boolean };
  assert.deepEqual(leaked.issues.map((i) => i.accountId), [RESEARCH]);
  assert.equal(leaked.cursor, undefined);
  assert.equal(leaked.hasMore, false);
  const own = (await scopedApi(answer(ownCursor), [RESEARCH]).request("GET", "/api/inbox", { query: {} })).data as { cursor?: string };
  assert.equal(own.cursor, ownCursor, "a cursor inside the key's mailbox pages on");
});

test("an address with % is not an account (it would decode into another mailbox); an empty scope sees no tools", () => {
  assert.equal(normaliseAccountId("cloudflare:x%40y@d.com"), null);
  assert.deepEqual(toolsFor(scoped([]), TOOLS), []);
});

test("through a tool, another mailbox is refused with the reason and nothing is read", async () => {
  const { api, calls } = fakeApi();
  const principal = scoped([RESEARCH]);
  const readMessage = TOOLS.find((t) => t.name === "read_message")!;
  const out = await runTool(readMessage, { accountId: "cloudflare:contact@sshlg.me", messageId: "1" }, { api: scopedApi(api, [RESEARCH]), principal }, ledger());
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /limited to research@sshlg\.me/);
  assert.equal(calls.length, 0);
});

test("a new key may name its mailboxes; an Admin key cannot be limited, and a bad account is refused", () => {
  const ok = validateNewKey({ name: "Research agent", level: "read", accounts: ["cloudflare:Research@sshlg.me", "research@sshlg.me"] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.value.accounts, [RESEARCH]);
  const whole = validateNewKey({ name: "Assistant", level: "mail" });
  assert.equal(whole.ok && whole.value.accounts, null);
  const admin = validateNewKey({ name: "Ops", level: "admin", accounts: [RESEARCH] });
  assert.ok(!admin.ok && /Admin key manages the whole workspace/.test(admin.error));
  const bad = validateNewKey({ name: "Ops", level: "read", accounts: ["not an account"] });
  assert.ok(!bad.ok && /not an account/.test(bad.error));
  const none = validateNewKey({ name: "Ops", level: "read", accounts: [] });
  assert.ok(!none.ok, "an empty list would make a key that reaches nothing; leave accounts out for the whole workspace");
});

test("a key whose only mailbox does not exist here gets an empty feed with the reason; a named one still gets 404", async () => {
  const gone: Api = { async request() { return { status: 404, data: { error: "account_not_found" }, contentType: "application/json" }; } };
  const s = scopedApi(gone, [RESEARCH]);
  const out = await s.request("GET", "/api/inbox", { query: { limit: 1 } });
  assert.equal(out.status, 200);
  assert.deepEqual((out.data as { accounts: unknown[] }).accounts, []);
  assert.match(JSON.stringify((out.data as { issues: unknown[] }).issues), /research@sshlg\.me has no mailbox/);
  assert.equal((await s.request("GET", "/api/inbox", { query: { account: RESEARCH } })).status, 404);
});

// ── The narrowing header (ADR-0115 §5 in passioncode-ai/fabric): a hub holding one key narrows each call ──
import { narrowPrincipal, NARROW_HEADER } from "../workers/mcp/scope";

test("X-Fabric-Accounts narrows any key to the named mailboxes, and never widens one", () => {
  assert.equal(NARROW_HEADER, "X-Fabric-Accounts");
  const admin = { kind: "agent", label: "Fabric", level: "admin", send: "send", dailySendLimit: 50, keyId: "k", accounts: null } as Principal;
  assert.deepEqual(narrowPrincipal(admin, "cloudflare:News@example.com, research@sshlg.me")?.accounts, ["cloudflare:news@example.com", RESEARCH]);
  assert.equal(narrowPrincipal(admin, null), admin, "no header, no change");
  const limited = scoped([RESEARCH, "cloudflare:a@x.invalid"]);
  assert.deepEqual(narrowPrincipal(limited, `${RESEARCH},cloudflare:other@x.invalid`)?.accounts, [RESEARCH], "intersection, never the union");
  assert.deepEqual(narrowPrincipal(admin, "nonsense, ")?.accounts, [], "a header with nothing valid reaches nothing");
  assert.deepEqual(narrowPrincipal(admin, "")?.accounts, [], "an empty header is a limit to nothing, not no header");
  const owner = principalFor({ email: "owner@x.invalid" }, [])!;
  assert.deepEqual(narrowPrincipal(owner, RESEARCH)?.accounts, [RESEARCH], "the owner's own session can be narrowed too");
});

test("an admin key narrowed by the header sees mailbox tools, sends from them, and loses the workspace tools", () => {
  const narrowed = narrowPrincipal({ kind: "agent", label: "Fabric", level: "admin", send: "send", dailySendLimit: 50, keyId: "k", accounts: null } as Principal, RESEARCH)!;
  const names = toolsFor(narrowed, TOOLS).map((t) => t.name);
  assert.ok(names.includes("read_message") && names.includes("send_email"));
  for (const t of ["create_address", "list_addresses", "save_agent", "connect_domain"]) assert.ok(!names.includes(t), t);
});

test("a comma is never part of an account id, so a stored limit or a request cannot smuggle a second mailbox", () => {
  assert.equal(normaliseAccountId("cloudflare:digest,ceo@corp.example"), null);
  assert.equal(normaliseAccountId("digest,ceo@corp.example"), null);
  assert.deepEqual(normaliseKeys({ keys: [{ id: "k", clientId: "c", accounts: ["cloudflare:digest,ceo@corp.example"] }] })[0]!.accounts, [], "a stored limit with a comma reaches nothing");
  assert.equal(validateNewKey({ name: "x", level: "read", accounts: ["digest,ceo@corp.example"] }).ok, false);
});
