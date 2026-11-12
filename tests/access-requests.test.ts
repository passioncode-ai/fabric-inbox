// B-246 W3 (D-4, SCN-100): an agent key asks for access; an administrator approves, narrows or refuses it once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessRequestsRouter } from "../workers/routes/access-requests";
import { inProcessActors } from "../workers/lib/audit";
import { AGENT_KEYS_KEY, principalFor } from "../workers/mcp/keys";
import { toolsFor } from "../workers/mcp/protocol";
import { TOOLS } from "../workers/mcp/tools";
import { GRANTS_KEY } from "../workers/mcp/grant-store";
import { memberGate } from "../workers/lib/member-gate";

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
async function call(env: unknown, method: string, path: string, body?: unknown, actor?: string) {
  const req = new Request(`https://inbox.acme.example${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (actor) inProcessActors.set(req, actor);
  const res = await accessRequestsRouter.fetch(req, env as never);
  return { status: res.status, body: await res.json() as any };
}
const ask = { mailboxes: ["sales@acme.example", "support@acme.example"], can: ["read", "send"], why: "outreach" };

async function setup() {
  const b = bucket();
  await b.put(AGENT_KEYS_KEY, JSON.stringify({ keys: [{ id: "k1", clientId: "c1", name: "Outreach", level: "read", accounts: [], requestOnly: true }] }));
  return { BUCKET: b };
}

test("a key asks; asking again answers the waiting request; a person cannot ask", async () => {
  const env = await setup();
  const first = await call(env, "POST", "/api/access-requests", ask, "key:k1");
  assert.equal(first.status, 201);
  assert.equal(first.body.request.state, "waiting");
  assert.deepEqual(first.body.request.mailboxes, ["cloudflare:sales@acme.example", "cloudflare:support@acme.example"]);
  const again = await call(env, "POST", "/api/access-requests", { ...ask, mailboxes: [...ask.mailboxes].reverse() }, "key:k1");
  assert.equal(again.status, 200);
  assert.equal(again.body.repeated, true);
  assert.equal(again.body.request.id, first.body.request.id);
  assert.equal((await call(env, "POST", "/api/access-requests", ask, "boss@acme.example")).status, 400);
  assert.equal((await call(env, "POST", "/api/access-requests", { ...ask, why: "" }, "key:k1")).status, 400);
});

test("ten waiting requests per key, then refused", async () => {
  const env = await setup();
  for (let i = 0; i < 10; i++) assert.equal((await call(env, "POST", "/api/access-requests", { ...ask, mailboxes: [`a${i}@acme.example`] }, "key:k1")).status, 201);
  assert.equal((await call(env, "POST", "/api/access-requests", { ...ask, mailboxes: ["more@acme.example"] }, "key:k1")).status, 429);
});

test("an approval narrows only within what was asked, makes one grant, and is taken once", async () => {
  const env = await setup();
  const { body } = await call(env, "POST", "/api/access-requests", ask, "key:k1");
  const id = body.request.id;
  assert.equal((await call(env, "POST", `/api/access-requests/${id}/decision`, { verdict: "approve", can: ["delete"] }, "boss@acme.example")).status, 400, "never more than asked");
  const ok = await call(env, "POST", `/api/access-requests/${id}/decision`, { verdict: "approve", mailboxes: ["sales@acme.example"], can: ["read"], note: "start with reading" }, "boss@acme.example");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.request.state, "approved");
  const grants = JSON.parse(env.BUCKET.objects.get(GRANTS_KEY)!.body).grants;
  assert.equal(grants.length, 1);
  assert.deepEqual([grants[0].holder, grants[0].mailboxes, grants[0].can], [{ kind: "key", id: "k1" }, ["cloudflare:sales@acme.example"], ["read"]]);
  assert.equal((await call(env, "POST", `/api/access-requests/${id}/decision`, { verdict: "refuse" }, "admin@acme.example")).status, 409, "decided once");
  const mine = await call(env, "GET", "/api/my-access", undefined, "key:k1");
  assert.equal(mine.body.key.requestOnly, true);
  assert.equal(mine.body.grants.length, 1);
  assert.equal(mine.body.requests[0].decision.note, "start with reading");
  assert.equal((await call(env, "GET", "/api/my-access", undefined, "boss@acme.example")).status, 400);
});

test("a refusal makes no grant; an unknown request is 404", async () => {
  const env = await setup();
  const { body } = await call(env, "POST", "/api/access-requests", ask, "key:k1");
  const r = await call(env, "POST", `/api/access-requests/${body.request.id}/decision`, { verdict: "refuse", note: "not now" }, "boss@acme.example");
  assert.equal(r.body.request.state, "refused");
  assert.equal(r.body.grant, null);
  assert.equal(env.BUCKET.objects.get(GRANTS_KEY), undefined);
  assert.equal((await call(env, "POST", "/api/access-requests/req-unknown1/decision", { verdict: "refuse" }, "boss@acme.example")).status, 404);
  const listed = await call(env, "GET", "/api/access-requests", undefined, "boss@acme.example");
  assert.equal(listed.body.requests[0].keyName, "Outreach");
});

test("a requester key sees only request_access and list_my_access; other empty keys see nothing; members never decide", () => {
  const keys = [{ id: "k1", clientId: "c1", name: "Outreach", level: "read" as const, send: "drafts" as const, dailySendLimit: 50, createdAt: "", expiresAt: null, accounts: [], requestOnly: true as const },
    { id: "k2", clientId: "c2", name: "Empty", level: "read" as const, send: "drafts" as const, dailySendLimit: 50, createdAt: "", expiresAt: null, accounts: [] }];
  const requester = principalFor({ common_name: "c1" }, keys)!;
  assert.deepEqual(toolsFor(requester, TOOLS).map((t) => t.name).sort(), ["list_my_access", "request_access"]);
  assert.deepEqual(toolsFor(principalFor({ common_name: "c2" }, keys)!, TOOLS), []);
  for (const [m, p] of [["GET", "/api/access-requests"], ["POST", "/api/access-requests/req-x/decision"]] as const)
    assert.equal(memberGate(m, p, ["cloudflare:a@acme.example"]), "refuse", `${m} ${p}`);
});
