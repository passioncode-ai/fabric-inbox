import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ARCHITECT_ROLE_PARENT, delegationHolds, grantsOfPrincipal, type StoredGrant } from "../workers/mcp/grants";
import { AGENT_KEYS_KEY, type Principal } from "../workers/mcp/keys";
import { GRANTS_KEY } from "../workers/mcp/grant-store";
import { MEMBERS_KEY } from "../workers/lib/members";
import { agentKeysRouter } from "../workers/routes/agent-keys";
import { grantsRouter } from "../workers/routes/grants";
import { membersRouter } from "../workers/routes/members";

/**
 * B-246 W4b (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md, D-3a, Delegation): an architect gives the agent
 * keys they made access within the role. The grant names the role as its parent and holds only while its grantor's
 * role does, read at every use.
 */

const ARCH = "arch@owner.example";
const grant = (over: Partial<StoredGrant> = {}): StoredGrant => ({
  schema: "grant/1", id: "grant-00000001", holder: { kind: "key", id: "k-arch" }, mailboxes: ["*"], can: ["read", "agents"],
  limits: { sendMode: "drafts", dailySendLimit: null, ownerApproval: false }, expiresAt: null, parent: ARCHITECT_ROLE_PARENT,
  grantedBy: ARCH, grantedAt: "2026-11-13T00:00:00Z", why: "set up the support agent", ...over,
});

test("a grant an architect gave holds while the grantor is an architect or an administrator, inside the preset", () => {
  const role = (r: string | null) => () => r;
  assert.equal(delegationHolds(grant(), role("architect")), true);
  assert.equal(delegationHolds(grant(), role("admin")), true, "an architect made administrator keeps what they gave");
  for (const r of ["member", "none", null]) assert.equal(delegationHolds(grant(), role(r)), false, `grantor ${r}`);
  assert.equal(delegationHolds(grant({ can: ["read", "send"] }), role("architect")), false, "a grant wider than the role gives nothing");
  assert.equal(delegationHolds(grant({ parent: undefined, grantedBy: "boss@owner.example" }), role(null)), true, "an administrator's grant is not a delegation");
});

test("the caller's grants leave out a delegation that no longer holds", () => {
  const p = { kind: "agent", keyId: "k-arch", level: "read", send: "drafts", dailySendLimit: 50, accounts: [], approval: "agent", requestOnly: true } as unknown as Principal;
  const stored = [grant(), grant({ id: "grant-00000002", can: ["read", "organize"], grantedBy: "gone@owner.example" })];
  const held = grantsOfPrincipal(p, stored, (g) => delegationHolds(g, (email) => (email === ARCH ? "architect" : "none")));
  assert.deepEqual(held.map((g) => g.can), [["read", "agents"]]);
  assert.equal(grantsOfPrincipal(p, stored).length, 2, "without a check every stored grant counts, as before");
});

/** An R2 bucket as the routes use it: get, put with an etag condition, and a listing for the audit. */
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
const key = (id: string, createdBy?: string, extra: Record<string, unknown> = {}) => ({ id, clientId: `${id}.access`, name: id, level: "read", send: "drafts", dailySendLimit: 50,
  createdAt: "2026-11-13T00:00:00Z", expiresAt: null, accounts: [], requestOnly: true, ...(createdBy ? { createdBy } : {}), ...extra });

function appAs(standing: unknown, bucket: R2Bucket) {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: { standing?: unknown; access?: unknown } }>();
  app.use("*", async (c, next) => { c.set("standing", standing); c.set("access", { email: (standing as { email: string }).email }); await next(); });
  app.route("/", agentKeysRouter as unknown as Hono);
  app.route("/", grantsRouter as unknown as Hono);
  app.route("/", membersRouter as unknown as Hono);
  const ledger = { acquireLock: async () => true, releaseLock: async () => {} };
  const env = { BUCKET: bucket, EMAIL_MCP: { getByName: () => ledger }, ROLE_GRANTS: "on" };
  return async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
    return { status: r.status, data: await r.json() as any };
  };
}

test("an architect lists, gives and revokes only their own keys and grants, inside the role", async () => {
  const { bucket, store } = fakeBucket();
  await bucket.put(AGENT_KEYS_KEY, JSON.stringify({ keys: [key("k-arch", ARCH), key("k-boss", "boss@owner.example", { level: "admin", requestOnly: undefined, accounts: null })] }));
  await bucket.put(GRANTS_KEY, JSON.stringify({ grants: [grant({ id: "grant-boss0001", holder: { kind: "key", id: "k-boss" }, parent: undefined, grantedBy: "boss@owner.example", can: ["read"] })] }));
  const call = appAs({ role: "architect", email: ARCH }, bucket);

  assert.deepEqual((await call("GET", "/api/agent-keys")).data.keys.map((k: any) => k.id), ["k-arch"], "only the keys they made");
  assert.equal((await call("POST", "/api/agent-keys", { name: "full", level: "mail" })).status, 403, "a key that reaches mail by itself is refused");

  const given = await call("POST", "/api/grants", { holder: { kind: "key", id: "k-arch" }, mailboxes: ["*"], can: ["read", "agents"], why: "set up the support agent" });
  assert.equal(given.status, 201);
  assert.equal(given.data.grant.parent, ARCHITECT_ROLE_PARENT);
  assert.equal(given.data.grant.grantedBy, ARCH);
  assert.equal((await call("POST", "/api/grants", { holder: { kind: "key", id: "k-arch" }, mailboxes: ["*"], can: ["send"], why: "x" })).status, 403, "beyond the role");
  assert.equal((await call("POST", "/api/grants", { holder: { kind: "key", id: "k-boss" }, mailboxes: ["*"], can: ["read"], why: "x" })).status, 403, "another person's key");
  assert.equal((await call("POST", "/api/grants", { holder: { kind: "person", email: "x@owner.example" }, mailboxes: ["*"], can: ["read"], why: "x" })).status, 403, "a person");

  assert.deepEqual((await call("GET", "/api/grants")).data.grants.map((g: any) => g.grantedBy), [ARCH], "only the grants they gave");
  assert.equal((await call("DELETE", "/api/grants/grant-boss0001")).status, 403);
  assert.equal(JSON.parse(store.get(GRANTS_KEY)!.text).grants.length, 2, "nothing removed");
  assert.equal((await call("DELETE", `/api/grants/${given.data.grant.id}`)).status, 200);
  assert.equal((await call("DELETE", "/api/agent-keys/k-boss")).status, 403);
  assert.deepEqual(JSON.parse(store.get(AGENT_KEYS_KEY)!.text).keys.map((k: any) => k.id), ["k-arch", "k-boss"], "the administrator's key stays");
  assert.equal((await call("DELETE", "/api/agent-keys/k-arch")).status, 200);
});

test("becoming an architect revokes the keys the person made before; saving an architect again keeps the ones they made as one", async () => {
  const { bucket, store } = fakeBucket();
  await bucket.put(MEMBERS_KEY, JSON.stringify({ members: [{ email: "boss@owner.example", role: "admin", accounts: null, addedAt: "2026-11-13T00:00:00Z" },
    { email: ARCH, role: "admin", accounts: null, addedAt: "2026-11-13T00:00:00Z" }] }));
  await bucket.put(AGENT_KEYS_KEY, JSON.stringify({ keys: [key("k-old", ARCH, { level: "admin", requestOnly: undefined, accounts: null })] }));
  const call = appAs({ role: "admin", email: "boss@owner.example", listed: true }, bucket);
  const became = await call("PUT", `/api/members/${encodeURIComponent(ARCH)}`, { role: "architect" });
  assert.deepEqual(became.data.revokedKeys, ["k-old"], "an administrator's key would reach beyond the role");
  await bucket.put(AGENT_KEYS_KEY, JSON.stringify({ keys: [key("k-arch", ARCH)] }));
  const again = await call("PUT", `/api/members/${encodeURIComponent(ARCH)}`, { role: "architect" });
  assert.equal(again.status, 200);
  assert.equal(again.data.revokedKeys, undefined);
  assert.deepEqual(JSON.parse(store.get(AGENT_KEYS_KEY)!.text).keys.map((k: any) => k.id), ["k-arch"]);
});
