// Agent keys limited to mailboxes (AP-11): a key that names its accounts reaches those accounts
// and nothing else — not another mailbox, not the workspace's settings — and fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseKeys, principalFor, type AgentKey, type Principal } from "../workers/mcp/keys";
import { runTool, toolsFor, type Api, type ApiResponse, type Ledger } from "../workers/mcp/protocol";
import { describeScope, expandDomains, narrowPrincipal, normaliseAccountId, scopedApi, toolFitsScope } from "../workers/mcp/scope";
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

const RESEARCH = "cloudflare:research@owner.example";

test("account ids normalise the way list_accounts names them, and anything else is refused", () => {
  assert.equal(normaliseAccountId("cloudflare:Research@owner.example"), RESEARCH);
  assert.equal(normaliseAccountId("research@owner.example"), RESEARCH, "a bare address is a Cloudflare mailbox");
  assert.equal(normaliseAccountId("gmail:abc_DEF-1"), "gmail:abc_DEF-1");
  for (const bad of ["", "cloudflare:", "cloudflare:a/b@x.com", "gmail:a/b", "smtp:x@y.z", "research"]) assert.equal(normaliseAccountId(bad), null, bad);
});

test("a key file keeps a key's accounts; none is the whole workspace; a damaged list reaches nothing (fails closed)", () => {
  const [all, some, damaged, empty] = normaliseKeys({ keys: [
    { id: "a", clientId: "a" },
    { id: "b", clientId: "b", accounts: ["cloudflare:Research@owner.example", "research@owner.example", "nonsense"] },
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
  await s.request("GET", "/api/v1/mailboxes/research%40owner.example/emails/42");
  await s.request("GET", "/api/v1/mailboxes/RESEARCH%40owner.example/threads/t1");
  await s.request("POST", "/api/accounts/g1/messages/m1/read", { body: { read: true } });
  assert.equal(calls.length, 3);
  for (const [method, path] of [
    ["GET", "/api/v1/mailboxes/contact%40owner.example/emails"],
    ["GET", "/api/v1/mailboxes"],
    ["GET", "/api/v1/mailboxes/research%40owner.example%2F..%2Fcontact%40owner.example/emails"],
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
    accounts: [{ id: RESEARCH, email: "research@owner.example" }, { id: "cloudflare:contact@owner.example", email: "contact@owner.example" }],
    messages: [{ accountId: RESEARCH, providerMessageId: "1" }, { accountId: "cloudflare:contact@owner.example", providerMessageId: "2" }],
    issues: [], hasMore: false,
  };
  const one = fakeApi({ "/api/inbox": feed, "/api/accounts": { accounts: [{ id: "g1" }, { id: "g2" }] }, "/api/inbox/hidden": { hidden: ["cloudflare:research@owner.example", "cloudflare:contact@owner.example", "gmail:g1"] } });
  const s = scopedApi(one.api, [RESEARCH]);
  const got = (await s.request("GET", "/api/inbox", { query: { limit: 25 } })).data as typeof feed;
  assert.equal(one.calls[0]!.query!.account, RESEARCH, "the only mailbox is named for the key");
  assert.deepEqual(got.accounts.map((a) => a.id), [RESEARCH]);
  assert.deepEqual(got.messages.map((m) => m.accountId), [RESEARCH], "a row from another mailbox never leaves, even if the app returned it");
  assert.deepEqual(((await s.request("GET", "/api/accounts")).data as { accounts: unknown[] }).accounts, [], "no Gmail account is in this scope");
  assert.deepEqual(((await s.request("GET", "/api/inbox/hidden")).data as { hidden: string[] }).hidden, [RESEARCH], "hidden entries are stored as account ids");
  await assert.rejects(s.request("GET", "/api/inbox", { query: { account: "cloudflare:contact@owner.example" } }), (e: Error & { status?: number }) => e.status === 403);

});

test("a key with several mailboxes gets each one's feed merged, one page, newest first (list_accounts works)", async () => {
  const calls: (string | undefined)[] = [];
  const api: Api = { async request(_m, p, init = {}) {
    if (p === "/api/inbox/hidden") return { status: 200, contentType: "application/json", data: { hidden: [] } };
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
  const otherCursor = btoa(JSON.stringify({ version: 1, scope: "s", position: { accountId: "cloudflare:contact@owner.example", providerMessageId: "9", timestamp: 1 } }));
  const ownCursor = btoa(JSON.stringify({ version: 1, scope: "s", position: { accountId: RESEARCH, providerMessageId: "1", timestamp: 1 } }));
  const answer = (cursor: string) => fakeApi({ "/api/inbox": { accounts: [], messages: [], hasMore: true, cursor,
    issues: [{ provider: "cloudflare", accountId: "cloudflare:contact@owner.example", error: "x" }, { provider: "cloudflare", accountId: RESEARCH, error: "y" }] } }).api;
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
  const out = await runTool(readMessage, { accountId: "cloudflare:contact@owner.example", messageId: "1" }, { api: scopedApi(api, [RESEARCH]), principal }, ledger());
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /limited to research@owner\.example/);
  assert.equal(calls.length, 0);
});

test("a new key may name its mailboxes; an Admin key cannot be limited, and a bad account is refused", () => {
  const ok = validateNewKey({ name: "Research agent", level: "read", accounts: ["cloudflare:Research@owner.example", "research@owner.example"] });
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
  assert.match(JSON.stringify((out.data as { issues: unknown[] }).issues), /research@owner\.example has no mailbox/);
  assert.equal((await s.request("GET", "/api/inbox", { query: { account: RESEARCH } })).status, 404);
});

// ── The narrowing header (ADR-0115 §5 in passioncode-ai/fabric): a hub holding one key narrows each call ──
import { narrowPrincipal, NARROW_HEADER } from "../workers/mcp/scope";

test("X-Fabric-Accounts narrows any key to the named mailboxes, and never widens one", () => {
  assert.equal(NARROW_HEADER, "X-Fabric-Accounts");
  const admin = { kind: "agent", label: "Fabric", level: "admin", send: "send", dailySendLimit: 50, keyId: "k", accounts: null } as Principal;
  assert.deepEqual(narrowPrincipal(admin, "cloudflare:News@example.com, research@owner.example")?.accounts, ["cloudflare:news@example.com", RESEARCH]);
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

test("a key limited to an Outlook account reaches that account's mail (bug hunt 2026-10-12: every call was refused)", async () => {
  const { api, calls } = fakeApi();
  const s = scopedApi(api, ["outlook:o1"]);
  await s.request("GET", "/api/accounts/o1/messages");
  await s.request("POST", "/api/accounts/o1/messages/m1/read", { body: { read: true } });
  assert.equal(calls.length, 2);
  await assert.rejects(() => s.request("GET", "/api/accounts/o2/messages"), /limited to outlook:o1/);
});

test("export_setup returns the setup itself, not the bytes of its file (bug hunt 2026-10-12)", async () => {
  const setup = { format: "fabric-inbox-setup/1", name: "Workspace", domains: ["p.invalid"], mailboxes: [] };
  const bytes = new TextEncoder().encode(JSON.stringify(setup));
  const api: Api = { async request() { return { status: 200, data: bytes, contentType: "application/json" }; } };
  const tool = TOOLS.find((t) => t.name === "export_setup")!;
  const out = await (tool as any).call({ fromCloudflare: false }, { api });
  assert.deepEqual(out, setup);
});

test("B-36: a key may name a whole domain; it becomes the addresses on exactly that domain, later ones too, and nothing else", async () => {
  assert.equal(normaliseAccountId("domain:Owner.Example"), "domain:owner.example");
  for (const bad of ["domain:", "domain:owner", "domain:a/b.example", "domain:a%40b.example", "domain:a,b.example", "domain:x@owner.example"])
    assert.equal(normaliseAccountId(bad), null, bad);
  const made = validateNewKey({ name: "Domain agent", level: "mail", accounts: ["domain:owner.example", "gmail:g1"] });
  assert.ok(made.ok);
  assert.deepEqual(made.ok && made.value.accounts, ["domain:owner.example", "gmail:g1"]);
  assert.ok(!validateNewKey({ name: "Ops", level: "admin", accounts: ["domain:owner.example"] }).ok, "an Admin key stays workspace-wide");
  const addresses = ["research@owner.example", "Contact@owner.example", "a@sub.owner.example", "b@other.example"];
  assert.deepEqual(expandDomains(["domain:owner.example", "gmail:g1"], addresses), ["gmail:g1", RESEARCH, "cloudflare:contact@owner.example"],
    "exactly that domain: not a subdomain, not another domain; Gmail entries stay");
  assert.deepEqual(expandDomains(["domain:owner.example"], [...addresses, "later@owner.example"]).at(-1), "cloudflare:later@owner.example", "an address made later is in");
  assert.deepEqual(expandDomains(["domain:empty.example"], addresses), [], "a domain with no address reaches nothing (fails closed)");
  assert.deepEqual(expandDomains([RESEARCH, "domain:owner.example"], ["research@owner.example"]), [RESEARCH], "no duplicate");
  assert.equal(describeScope(["domain:owner.example", RESEARCH]), "every address at owner.example, research@owner.example");
  // After expansion the scoped API sees concrete mailboxes only: the other domain stays refused.
  const { api, calls } = fakeApi();
  const s = scopedApi(api, expandDomains(["domain:owner.example"], addresses));
  await s.request("GET", "/api/v1/mailboxes/contact%40owner.example/emails");
  await assert.rejects(s.request("GET", "/api/v1/mailboxes/b%40other.example/emails"), (e: Error & { status?: number }) => e.status === 403);
  await assert.rejects(s.request("GET", "/api/v1/mailboxes/a%40sub.owner.example/emails"), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(calls.length, 1);
  // A narrowing header cannot widen a limited key to a domain it was not given.
  const limited = { kind: "agent", label: "k", level: "read", send: "drafts", dailySendLimit: 0, keyId: "k", accounts: [RESEARCH] } as Principal;
  assert.deepEqual(narrowPrincipal(limited, "domain:other.example")?.accounts, []);
  // Review 2026-10-24: a key limited to a domain, narrowed by that same domain, keeps its addresses.
  const domainKey = { ...limited, accounts: expandDomains(["domain:owner.example"], addresses) } as Principal;
  assert.deepEqual(narrowPrincipal(domainKey, "domain:owner.example", addresses)?.accounts, [RESEARCH, "cloudflare:contact@owner.example"]);
  assert.deepEqual(narrowPrincipal(domainKey, "domain:other.example", addresses)?.accounts, [], "another domain still narrows to nothing");
});

test("B-178: a limited key reads the safety state and the held list of its own mailboxes only, and decides only for them", async () => {
  const seen: { method: string; path: string }[] = [];
  const base: Api = { async request(method, path) {
    seen.push({ method, path });
    if (path === "/api/safety/held") return { status: 200, contentType: "application/json", data: { held: [{ accountId: "cloudflare:a@shop.invalid", messageId: "m1" }, { accountId: "gmail:other", messageId: "m2" }] } };
    return { status: 200, contentType: "application/json", data: { records: {} } } as ApiResponse;
  } };
  const api = scopedApi(base, ["cloudflare:a@shop.invalid"]);
  assert.equal((await api.request("POST", "/api/safety/lookup", { body: { keys: [{ accountId: "cloudflare:A@shop.invalid", messageId: "m1" }] } })).status, 200);
  await assert.rejects(api.request("POST", "/api/safety/lookup", { body: { keys: [{ accountId: "cloudflare:a@shop.invalid", messageId: "m1" }, { accountId: "gmail:other", messageId: "m2" }] } }), /limited to/);
  await assert.rejects(api.request("POST", "/api/safety/lookup", { body: { keys: [] } }), /limited to/);
  assert.deepEqual(((await api.request("GET", "/api/safety/held")).data as { held: unknown[] }).held, [{ accountId: "cloudflare:a@shop.invalid", messageId: "m1" }]);
  await assert.rejects(api.request("POST", "/api/safety/decide", { body: { accountId: "gmail:other", messageId: "m2", action: "keep" } }), /limited to/);
  assert.equal(seen.filter((s) => s.path === "/api/safety/decide").length, 0);
});

test("N-3: an admin key narrowed to a mailbox loses that mailbox's administrator actions, as a member does", async () => {
  const narrowed = narrowPrincipal({ kind: "agent", label: "Fabric", level: "admin", send: "send", dailySendLimit: 50, keyId: "k", accounts: null } as Principal, "gmail:g1")!;
  const names = toolsFor(narrowed, TOOLS).map((t) => t.name);
  for (const t of ["disconnect_account", "set_account_agent"]) assert.ok(!names.includes(t), t);
  assert.ok(names.includes("read_message"));
  const { api, calls } = fakeApi();
  const s = scopedApi(api, ["gmail:g1"]);
  await assert.rejects(() => s.request("POST", "/api/accounts/g1/disconnect", { body: {} }), /limited to/);
  await assert.rejects(() => s.request("PUT", "/api/accounts/g1/agent", { body: { agent: "off" } }), /limited to/);
  assert.equal(calls.length, 0);
});

test("P-4: create_address takes a name as the route does, upper case included; the route explains a bad one", async () => {
  const { z } = await import("zod");
  const tool = TOOLS.find((t) => t.name === "create_address")!;
  const schema = z.object(tool.input as never);
  assert.equal(schema.safeParse({ localPart: "Support", domain: "owner.example" }).success, true);
  assert.equal(schema.safeParse({ localPart: "", domain: "owner.example" }).success, false);
});

test("N-9: a member's All inboxes leaves out an account the administrator hid, as the administrator's does; named, it is read", async () => {
  const read: string[] = [];
  const api = { request: async (_m: string, path: string, init: any = {}) => {
    if (path === "/api/inbox/hidden") return { status: 200, contentType: "application/json", data: { hidden: ["gmail:hid"] } };
    read.push(String(init.query?.account));
    return { status: 200, contentType: "application/json", data: { accounts: [{ id: init.query?.account }], messages: [], hasMore: false } };
  } };
  const s = scopedApi(api as never, ["cloudflare:me@owner.example", "gmail:hid"], "person");
  await s.request("GET", "/api/inbox", { query: {} });
  assert.deepEqual(read, ["cloudflare:me@owner.example"]);
  await s.request("GET", "/api/inbox", { query: { account: "gmail:hid" } });
  assert.deepEqual(read, ["cloudflare:me@owner.example", "gmail:hid"]);
});

test("P-3: the account routes and the agent protocol expect the same origin: Gmail's, else Outlook's, else the server's", async () => {
  const { expectedAccountOrigin } = await import("../workers/providers/app-origin");
  const outlookOnly = { MICROSOFT_CLIENT_ID: "id", MICROSOFT_CLIENT_SECRET: "s", PUBLIC_APP_URL: "https://mail.owner.example", MAIL_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64") } as never;
  assert.equal(expectedAccountOrigin(outlookOnly, "https://inbox.owner.example/mcp"), "https://mail.owner.example");
  assert.equal(expectedAccountOrigin({} as never, "https://inbox.owner.example/mcp"), "https://inbox.owner.example");
});
