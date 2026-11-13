import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { normaliseMembers, standingOf, MEMBERS_KEY, type Member } from "../workers/lib/members";
import { architectGate, routeNeed, ARCHITECT_CAN } from "../workers/lib/role-gate";
import { grantsOfMember, allows, ROLE_PRESETS } from "../workers/mcp/grants";
import { TOOLS, NOT_TOOLS } from "../workers/mcp/tools";
import { TOOL_NEEDS } from "../workers/mcp/tool-capabilities";
import { readsOnly } from "../workers/lib/member-gate";
import { membersRouter } from "../workers/routes/members";

/**
 * B-246 W4 (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md, D-3a): the architect role. It is read from the
 * server's own list only, gives the preset of the operator's decision of 2026-11-06 on every mailbox, and only where
 * ROLE_GRANTS is on; off, a listed architect reaches nothing.
 */

const architect: Member = { email: "arch@owner.example", role: "architect", accounts: null, addedAt: "2026-11-13T00:00:00Z" };
const admin: Member = { email: "boss@owner.example", role: "admin", accounts: null, addedAt: "2026-11-13T00:00:00Z" };

test("an architect is kept on the list as one, with no mailboxes of its own; an unknown role is still a member", () => {
  const list = normaliseMembers({ members: [admin, { ...architect, accounts: ["cloudflare:x@owner.example"] }, { email: "who@owner.example", role: "owner" }] });
  assert.equal(list[1]!.role, "architect");
  assert.equal(list[1]!.accounts, null, "an architect's reach is the preset, never a list of mailboxes");
  assert.equal(list[2]!.role, "member");
  assert.deepEqual(list[2]!.accounts, []);
});

test("without ROLE_GRANTS a listed architect reaches nothing; with it, they are an architect", () => {
  const list = [admin, architect];
  assert.deepEqual(standingOf(list, "ARCH@owner.example"), { role: "member", email: "arch@owner.example", accounts: [], levels: {} });
  assert.deepEqual(standingOf(list, "arch@owner.example", true), { role: "architect", email: "arch@owner.example" });
  assert.equal(standingOf(list, "boss@owner.example", true).role, "admin", "an administrator is unchanged");
});

test("the architect's grant is the preset on every mailbox: no send, draft, delete or campaign", () => {
  const grants = grantsOfMember(architect);
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0]!.mailboxes, ["*"]);
  assert.deepEqual(grants[0]!.can, [...ROLE_PRESETS.architect.can]);
  for (const c of ["read", "organize", "agents", "create", "remove"] as const) assert.ok(allows(grants, "cloudflare:a@owner.example", c), c);
  for (const c of ["send", "draft", "delete", "campaign"] as const) assert.ok(!allows(grants, "cloudflare:a@owner.example", c), c);
});

test("every tool route has one need: reads are read, and a change is made by tools of one capability", () => {
  const byRoute = new Map<string, Set<string>>();
  for (const t of TOOLS) for (const r of t.routes) byRoute.set(r, new Set([...(byRoute.get(r) ?? []), String(TOOL_NEEDS[t.name])]));
  const mixedChanges = [...byRoute].filter(([r, needs]) => {
    const [method, path] = [r.slice(0, r.indexOf(" ")), r.slice(r.indexOf(" ") + 1)];
    return needs.size > 1 && !readsOnly(method, path);
  }).map(([r]) => r);
  assert.deepEqual(mixedChanges, [], "a change two capabilities share would read as server and refuse an architect");
});

test("a route's need: the most literal route wins, reads are read, a route no tool calls has none", () => {
  assert.equal(routeNeed("GET", "/api/inbox"), "read");
  assert.equal(routeNeed("HEAD", "/api/inbox/hidden"), "read");
  assert.equal(routeNeed("POST", "/api/safety/lookup"), "read");
  assert.equal(routeNeed("DELETE", "/api/project-addresses/x%40owner.example"), "remove");
  assert.equal(routeNeed("PUT", "/api/members/x%40owner.example"), "server");
  assert.equal(routeNeed("GET", "/api/agent-keys/approvals"), null, "a NOT_TOOLS route");
  assert.equal(routeNeed("GET", "/api/no-such-route"), null);
});

test("the architect's gate: setting up mailboxes, addresses and agents passes; sending, deleting mail and settings do not", () => {
  // Pages pass; the agent protocol, the chat assistant and the relays stay an administrator's.
  assert.equal(architectGate("GET", "/inbox"), "pass");
  for (const p of ["/mcp", "/agents/chat/x", "/relay/x", "/fabric/x", "/.well-known/fabric-service"]) assert.equal(architectGate("GET", p), "refuse", p);
  assert.equal(architectGate("GET", "/api/me"), "pass");
  // Every tool route passes exactly when its need is in the architect's preset.
  for (const t of TOOLS) for (const r of t.routes) {
    const [method, path] = [r.slice(0, r.indexOf(" ")), r.slice(r.indexOf(" ") + 1).replace(/:[A-Za-z]+/g, "x%40owner.example")];
    const need = routeNeed(method, path);
    const want = need && need !== "self" && need !== "server" && ARCHITECT_CAN.has(need) ? "pass" : "refuse";
    assert.equal(architectGate(method, path), want, `${r} (${need})`);
  }
  // No route outside the tools reaches an architect.
  for (const r of Object.keys(NOT_TOOLS)) {
    const [method, path] = [r.slice(0, r.indexOf(" ")), r.slice(r.indexOf(" ") + 1).replace(/:[A-Za-z]+/g, "x")];
    if (`${method} ${path}` === "GET /api/me") continue;
    assert.equal(architectGate(method, path), "refuse", r);
  }
  // The acts the operator named, both ways.
  assert.equal(architectGate("POST", "/api/project-addresses"), "pass", "create an address");
  assert.equal(architectGate("PUT", "/api/agents/a1"), "pass", "save an agent");
  assert.equal(architectGate("POST", "/api/v1/mailboxes/x%40owner.example/send"), "refuse", "send");
  assert.equal(architectGate("PUT", "/api/members/x%40owner.example"), "refuse", "people");
  assert.equal(architectGate("POST", "/api/agent-keys"), "refuse", "keys, until delegation (W4b)");
});

/** An R2 bucket as far as the list uses it. */
function fakeBucket() {
  const store = new Map<string, { text: string; etag: string }>();
  let n = 0;
  const bucket = {
    async get(key: string) { const o = store.get(key); return o ? { etag: o.etag, text: async () => o.text, json: async () => JSON.parse(o.text) } : null; },
    async put(key: string, text: string, opts?: { onlyIf?: { etagMatches?: string } | Headers }) {
      const cur = store.get(key); const cond = opts?.onlyIf;
      if (cond instanceof Headers ? cur : cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      store.set(key, { text, etag: `e${++n}` }); return {};
    },
    async list() { return { objects: [], truncated: false }; },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

test("the list offers Architect and saves one only where ROLE_GRANTS is on", async () => {
  const run = async (roleGrants: string | undefined) => {
    const { bucket, store } = fakeBucket();
    store.set(MEMBERS_KEY, { text: JSON.stringify({ members: [admin] }), etag: "e0" });
    const app = new Hono<{ Bindings: { BUCKET: R2Bucket; ROLE_GRANTS?: string }; Variables: { standing?: unknown } }>();
    app.use("*", async (c, next) => { c.set("standing", { role: "admin", email: admin.email, listed: true }); await next(); });
    app.route("/", membersRouter as unknown as Hono);
    const env = { BUCKET: bucket, ...(roleGrants ? { ROLE_GRANTS: roleGrants } : {}) };
    const list = await (await app.request("/api/members", {}, env)).json() as { roles: string[] };
    const saved = await app.request("/api/members/arch%40owner.example", { method: "PUT", body: JSON.stringify({ role: "architect" }), headers: { "Content-Type": "application/json" } }, env);
    return { roles: list.roles, status: saved.status, stored: JSON.parse(store.get(MEMBERS_KEY)!.text).members as Member[] };
  };
  const off = await run(undefined);
  assert.deepEqual(off.roles, ["admin", "member"]);
  assert.equal(off.status, 400);
  assert.equal(off.stored.length, 1, "nothing saved");
  const on = await run("on");
  assert.deepEqual(on.roles, ["admin", "member", "architect"]);
  assert.equal(on.status, 200);
  assert.deepEqual(on.stored.map((m) => [m.email, m.role, m.accounts]), [[admin.email, "admin", null], [architect.email, "architect", null]]);
});
