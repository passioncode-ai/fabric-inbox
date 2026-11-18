// B-293 (U4, SCN-105; docs/ux/plans/2026-11-18-ui-fixes/README.md): a signed-in person reads their own access: role,
// mailboxes with each one's level, and the grants given to them as a person. An agent key's answer is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { accessRequestsRouter } from "../workers/routes/access-requests";
import { inProcessActors } from "../workers/lib/audit";
import { GRANTS_KEY } from "../workers/mcp/grant-store";
import { memberGate, SELF_ROUTES } from "../workers/lib/member-gate";
import { architectGate } from "../workers/lib/role-gate";
import type { Standing } from "../workers/lib/members";

function bucket(objects: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(objects).map(([k, v]) => [k, JSON.stringify(v)]));
  return { async get(k: string) { const b = store.get(k); return b === undefined ? null : { etag: "1", json: async () => JSON.parse(b), text: async () => b } }, async put() { return { etag: "2" }; } };
}
const grant = (email: string, id: string) => ({ schema: "grant/1", id: id + "-0000000", limits: { sendMode: "drafts", dailySendLimit: null, ownerApproval: false }, holder: { kind: "person", email }, mailboxes: ["cloudflare:sales@acme.example"], can: ["read", "draft"],
  expiresAt: null, grantedBy: "boss@acme.example", grantedAt: "2026-11-18T10:00:00.000Z", why: "covering sales" });
async function asPerson(standing: Standing | undefined, env: unknown, actor?: string) {
  const app = new Hono<{ Variables: { standing?: Standing } }>();
  app.use("*", async (c, next) => { if (standing) c.set("standing", standing); await next(); });
  app.route("/", accessRequestsRouter as never);
  const req = new Request("https://inbox.acme.example/api/my-access");
  if (actor) inProcessActors.set(req, actor);
  const res = await app.fetch(req, env as never);
  return { status: res.status, body: await res.json() as any };
}

test("a member reads their role, each shared mailbox with its level, and the grants given to them by name", async () => {
  const env = { BUCKET: bucket({ [GRANTS_KEY]: { grants: [grant("Ann@Acme.example", "g1"), grant("bob@acme.example", "g2")] } }) };
  const member: Standing = { role: "member", email: "ann@acme.example", accounts: ["cloudflare:sales@acme.example", "cloudflare:help@acme.example"], levels: { "cloudflare:help@acme.example": "read" } };
  const out = await asPerson(member, env);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.person, { email: "ann@acme.example", role: "member", mailboxes: [
    { id: "cloudflare:sales@acme.example", level: "send" }, { id: "cloudflare:help@acme.example", level: "read" }] });
  assert.deepEqual(out.body.grants.map((g: { id: string }) => g.id), ["g1-0000000"], "only their own grants, matched without case");
  assert.equal(out.body.decides, false);
});

test("an administrator reads that they reach everything (no mailbox list); a person with no standing still gets 400", async () => {
  const env = { BUCKET: bucket() };
  const admin = await asPerson({ role: "admin", email: "boss@acme.example", listed: true }, env);
  assert.deepEqual(admin.body.person, { email: "boss@acme.example", role: "admin", mailboxes: null });
  assert.deepEqual(admin.body.grants, []);
  assert.equal((await asPerson(undefined, env, "boss@acme.example")).status, 400);
});

test("with no Access and no caller (local development) the person is the administrator, as GET /api/me says", async () => {
  const out = await asPerson(undefined, { BUCKET: bucket() });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.person, { email: null, role: "admin", mailboxes: null });
});

test("an agent key (no person's standing) still reads its key's access", async () => {
  const env = { BUCKET: bucket({ "agent-keys.json": { keys: [] } }) };
  const out = await asPerson(undefined, env, "key:k1");
  assert.equal(out.status, 200);
  assert.ok("key" in out.body && !("person" in out.body));
});

test("a member and an architect may read it: it is one of the routes about themselves", () => {
  assert.ok(SELF_ROUTES.has("GET /api/my-access"));
  assert.equal(memberGate("GET", "/api/my-access", [], [], []), "pass");
  assert.equal(architectGate("GET", "/api/my-access"), "pass");
});
