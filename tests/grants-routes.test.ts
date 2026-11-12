// B-246 W2c (SCN-101): the grants routes, their records and who reaches them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grantsRouter } from "../workers/routes/grants";
import { memberGate } from "../workers/lib/member-gate";
import { AGENT_KEYS_KEY } from "../workers/mcp/keys";

function bucket() {
  const objects = new Map<string, { body: string; etag: string }>();
  let n = 0;
  return {
    objects,
    async get(k: string) { const o = objects.get(k); return o ? { etag: o.etag, json: async () => JSON.parse(o.body), text: async () => o.body, arrayBuffer: async () => new TextEncoder().encode(o.body).buffer } : null; },
    async put(k: string, v: string, opts: { onlyIf?: { etagMatches?: string } | Headers } = {}) {
      const cur = objects.get(k);
      if (opts.onlyIf instanceof Headers ? !!cur : opts.onlyIf?.etagMatches !== undefined && opts.onlyIf.etagMatches !== cur?.etag) return null;
      objects.set(k, { body: v, etag: String(++n) }); return { etag: String(n) };
    },
  };
}
const call = (env: unknown, method: string, path: string, body?: unknown) =>
  grantsRouter.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env as never);

test("an administrator gives a grant to a key or a person; it is listed, audited, and decides nothing yet", async () => {
  const b = bucket();
  await b.put(AGENT_KEYS_KEY, JSON.stringify({ keys: [{ id: "k1", clientId: "c1", level: "read" }] }));
  const env = { BUCKET: b };
  const made = await call(env, "POST", "/api/grants", { holder: { kind: "key", id: "k1" }, mailboxes: ["Sales@acme.example", "domain:acme.example"], can: ["send", "read"], why: "outreach" });
  assert.equal(made.status, 201);
  const { grant, decides } = await made.json() as any;
  assert.equal(decides, false);
  assert.deepEqual(grant.mailboxes, ["cloudflare:sales@acme.example", "domain:acme.example"]);
  assert.deepEqual(grant.can, ["read", "send"]);
  assert.equal(grant.grantedBy, "local development");
  const listed = await (await call(env, "GET", "/api/grants")).json() as any;
  assert.deepEqual(listed.grants.map((g: any) => g.id), [grant.id]);
  assert.ok([...b.objects.keys()].some((k) => k.startsWith("audit/")), "the grant is in the audit record");
  assert.equal((await call(env, "POST", "/api/grants", { holder: { kind: "key", id: "nope" }, mailboxes: ["*"], can: ["read"], why: "x" })).status, 404, "an unknown key");
  assert.equal((await call(env, "POST", "/api/grants", { holder: { kind: "person", email: "a@acme.example" }, mailboxes: ["not a mailbox"], can: ["read"], why: "x" })).status, 400);
  assert.equal((await call(env, "POST", "/api/grants", { holder: { kind: "person", email: "a@acme.example" }, mailboxes: ["*"], can: [], why: "x" })).status, 400, "a grant gives something");
  assert.equal((await call(env, "POST", "/api/grants", { holder: { kind: "person", email: "a@acme.example" }, mailboxes: ["*"], can: ["read"] })).status, 400, "a grant says why");
});

test("revoking a grant takes every grant delegated from it; an unknown id is 404", async () => {
  const b = bucket();
  const g = (id: string, parent?: string) => ({ schema: "grant/1", id, holder: { kind: "person", email: "a@acme.example" }, mailboxes: ["*"], can: ["read"],
    limits: { sendMode: "send", dailySendLimit: null, ownerApproval: false }, expiresAt: null, grantedBy: "o@acme.example", grantedAt: "2026-11-12T00:00:00Z", why: "t", ...(parent ? { parent } : {}) });
  await b.put("config/grants.json", JSON.stringify({ grants: [g("grant-root1"), g("grant-child1", "grant-root1"), g("grant-grand1", "grant-child1"), g("grant-other1")] }));
  const env = { BUCKET: b };
  const r = await call(env, "DELETE", "/api/grants/grant-root1");
  assert.deepEqual((await r.json() as any).revoked.sort(), ["grant-child1", "grant-grand1", "grant-root1"]);
  assert.deepEqual((await (await call(env, "GET", "/api/grants")).json() as any).grants.map((x: any) => x.id), ["grant-other1"]);
  assert.equal((await call(env, "DELETE", "/api/grants/grant-root1")).status, 404);
});

test("a member never reaches the grants routes", () => {
  for (const [m, p] of [["GET", "/api/grants"], ["POST", "/api/grants"], ["DELETE", "/api/grants/grant-x"]] as const)
    assert.equal(memberGate(m, p, ["cloudflare:a@acme.example"]), "refuse", `${m} ${p}`);
});
