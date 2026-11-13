// B-246 W2c, the cut-over: with GRANTS_DECIDE=on the grants decide an agent key's tools and the mailboxes each call
// reaches (workers/mcp/grant-scope.ts). Off, nothing changes; on, a key with no stored grant reaches exactly what it
// reaches today, and an approved request widens the key in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GrantSchema, grantScope, grantsOfPrincipal, mailboxesFor } from "../workers/mcp/grants";
import { scopeFromGrants } from "../workers/mcp/grant-scope";
import { toolsFor, type Api } from "../workers/mcp/protocol";
import { TOOLS } from "../workers/mcp/tools";
import { TOOL_NEEDS } from "../workers/mcp/tool-capabilities";
import type { Principal } from "../workers/mcp/keys";
import { sendFor } from "../workers/routes/agent-keys";

const A = "cloudflare:sales@acme.example";
const B = "cloudflare:support@acme.example";
const stored = (over: Record<string, unknown> = {}) => GrantSchema.parse({ schema: "grant/1", id: "grant-0001", holder: { kind: "key", id: "k1" }, mailboxes: ["support@acme.example"],
  can: ["read"], limits: { sendMode: "send", dailySendLimit: 10, ownerApproval: false }, expiresAt: null, grantedBy: "owner@acme.example", grantedAt: "2026-11-12T00:00:00Z", why: "test", ...over });
const key = (over: Partial<Extract<Principal, { kind: "agent" }>> = {}): Principal =>
  ({ kind: "agent", label: "bot", level: "read", send: "drafts", dailySendLimit: 5, keyId: "k1", accounts: [A], ...over }) as Principal;
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

test("W2c: with no stored grant, the grants give every key exactly the tools today's checks give", () => {
  const keys: Principal[] = [];
  // The keys that exist: a read key never sends and an admin key always does (agent-keys.ts sendFor), and an admin key
  // limited to mailboxes reaches nothing (keys.ts normaliseKey: its accounts become []).
  for (const level of ["read", "mail", "admin"] as const)
    for (const send of ["drafts", "send"] as const)
      for (const accounts of [null, [A], [A, B]]) keys.push(key({ level, send: sendFor(level, send), accounts: level === "admin" && accounts ? [] : accounts }));
  keys.push(key({ accounts: [], requestOnly: true }));
  // handler.ts refuses a key limited to no mailbox at the door (unless it only asks for access); it never reaches a tool.
  const atTheDoor = (p: Principal) => !(p.kind === "agent" && p.accounts && !p.accounts.length && !p.requestOnly);
  const differ: string[] = [];
  for (const p of keys.filter(atTheDoor)) {
    const grants = grantsOfPrincipal(p);
    for (const t of TOOLS) {
      const today = toolsFor(p, [t]).length > 0;
      const decided = grantScope(t, grants).allowed && (TOOL_NEEDS[t.name] === "self" || grantScope(t, grants).accounts === null || grantScope(t, grants).accounts!.length > 0);
      if (today !== decided) differ.push(`${p.kind === "agent" ? `${p.level}/${p.send}/${JSON.stringify(p.accounts)}` : "owner"} ${t.name}: today ${today}, grants ${decided}`);
    }
  }
  assert.deepEqual(differ, []);
});

test("W2c: an approved request widens a requester key to the granted mailbox and capabilities only", () => {
  const requester = key({ accounts: [], requestOnly: true });
  const grants = grantsOfPrincipal(requester, [stored({ can: ["read", "draft", "campaign"] })]);
  assert.deepEqual(grantScope(tool("list_messages"), grants), { allowed: true, accounts: [B] });
  // B-259: a campaign is its sender mailbox's, so a key limited to mailboxes keeps its campaigns to them.
  assert.deepEqual(grantScope(tool("save_campaign"), grants), { allowed: true, accounts: [B] });
  assert.equal(grantScope(tool("launch_campaign"), grants).allowed, true, "the grant's send mode is send");
  assert.equal(grantScope(tool("send_email"), grants).allowed, false, "no send was granted");
  assert.equal(grantScope(tool("delete_message"), grants).allowed, false);
  assert.equal(grantScope(tool("request_access"), grants).allowed, true, "it can still ask for more");
  assert.equal(grantScope(tool("save_member"), grants).allowed, false, "nothing on the whole server");
});

test("W2c: a send reaches only the mailboxes a send grant names, and a drafts-only grant never sends", () => {
  const grants = grantsOfPrincipal(key({ level: "read", accounts: [A] }), [stored({ can: ["read", "send"] })]);
  assert.deepEqual(mailboxesFor("read", grants), [A, B]);
  assert.deepEqual(grantScope(tool("send_email"), grants), { allowed: true, accounts: [B] });
  const drafts = grantsOfPrincipal(key({ accounts: [A] }), [stored({ can: ["read", "send"], limits: { sendMode: "drafts", dailySendLimit: 10, ownerApproval: false } })]);
  assert.equal(grantScope(tool("send_email"), drafts).allowed, false);
  const expired = grantsOfPrincipal(key({ accounts: [A] }), [stored({ can: ["send"], expiresAt: "2026-01-01T00:00:00Z" })]);
  assert.equal(grantScope(tool("send_email"), expired).allowed, false, "an expired grant gives nothing");
});

test("W2c: each call's API is narrowed to the tool's mailboxes, a domain grant is today's addresses, a header narrows further", async () => {
  const seen: string[] = [];
  const base: Api = { request: async (method, path) => { seen.push(`${method} ${path}`); return { status: 200, data: {} } as never; } };
  const grants = grantsOfPrincipal(key({ accounts: [A] }), [stored({ mailboxes: ["domain:acme.example"], can: ["read", "send"] })]);
  const scope = await scopeFromGrants(grants, base, null, async () => ["sales@acme.example", "support@acme.example", "x@other.example"]);
  assert.equal(scope.allowed(tool("send_email")), true);
  const api = scope.api(tool("send_email"));
  await api.request("POST", "/api/v1/mailboxes/support@acme.example/emails", { body: {} });
  await assert.rejects(api.request("POST", "/api/v1/mailboxes/x@other.example/emails", { body: {} }), "another domain is out of reach");
  assert.deepEqual(seen, ["POST /api/v1/mailboxes/support@acme.example/emails"]);
  const narrowed = await scopeFromGrants(grants, base, "sales@acme.example", async () => []);
  await assert.rejects(narrowed.api(tool("send_email")).request("POST", "/api/v1/mailboxes/support@acme.example/emails", { body: {} }), "the header keeps it to sales");
  const nothing = await scopeFromGrants(grants, base, "x@other.example", async () => []);
  assert.equal(nothing.allowed(tool("send_email")), false, "no mailbox left after narrowing");
  assert.equal(nothing.allowed(tool("request_access")), true);
});

test("B-259: a limited key reaches only its own mailboxes' campaigns, by sender", async () => {
  const { scopedApi } = await import("../workers/mcp/scope");
  const G = "gmail:own1";
  const campaigns: Record<string, { id: string; sender: string }> = { c1: { id: "c1", sender: G }, c2: { id: "c2", sender: "gmail:other" } };
  const calls: string[] = [];
  const base: Api = { request: async (method, path, init) => {
    calls.push(`${method} ${path}`);
    if (path === "/api/campaigns" && method === "GET") return { status: 200, contentType: "application/json", data: { campaigns: Object.values(campaigns) } };
    const id = path.split("/")[3];
    if (method === "GET" && id && path === `/api/campaigns/${id}`) return campaigns[id] ? { status: 200, contentType: "application/json", data: campaigns[id] } : { status: 404, contentType: "application/json", data: { error: "No such campaign." } };
    return { status: 200, contentType: "application/json", data: { ok: true, body: init?.body ?? null } };
  } };
  const api = scopedApi(base, [G]);
  const listed = await api.request("GET", "/api/campaigns");
  assert.deepEqual((listed.data as { campaigns: { id: string }[] }).campaigns.map((c) => c.id), ["c1"], "another mailbox's campaign is not listed");
  assert.equal((await api.request("GET", "/api/campaigns/c1")).status, 200);
  await assert.rejects(api.request("GET", "/api/campaigns/c2"), "another mailbox's campaign reads as refused");
  await assert.rejects(api.request("GET", "/api/campaigns/nope"), "a missing one reads the same");
  await assert.rejects(api.request("POST", "/api/campaigns/c2/launch", { body: {} }));
  await assert.rejects(api.request("POST", "/api/campaigns", { body: { campaign: { sender: "gmail:other" } } }), "not made from another mailbox");
  await assert.rejects(api.request("PUT", "/api/campaigns/c1", { body: { campaign: { sender: "gmail:other" } } }), "not moved to another mailbox");
  assert.equal((await api.request("POST", "/api/campaigns", { body: { campaign: { sender: "GMAIL:own1" } } })).status, 200);
  assert.equal((await api.request("POST", "/api/campaigns/c1/launch", { body: {} })).status, 200);
  assert.equal(calls.includes("POST /api/campaigns/c2/launch"), false, "a refused call never reaches the server");
  await assert.rejects(api.request("GET", "/api/suppression"), "the suppression list stays the whole server's");
});
