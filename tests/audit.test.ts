// B-156: a durable record of people changes and of what members send (consolidation report B3, Q12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { AUDIT_PREFIX, SEND_ROUTES, actorOf, inProcessActors, memberSent, readAudit, recordAudit, sendRouteOf } from "../workers/lib/audit";
import { membersRouter } from "../workers/routes/members";
import { memberGate } from "../workers/lib/member-gate";
import { TOOLS } from "../workers/mcp/tools";

/** An R2 bucket with what the list of people and the record use: get, conditional put, and a sorted list with a cursor. */
function fakeBucket() {
  const store = new Map<string, { text: string; etag: string }>();
  let n = 0;
  const bucket = {
    async get(key: string) { const o = store.get(key); return o ? { etag: o.etag, text: async () => o.text, json: async () => JSON.parse(o.text) } : null; },
    async put(key: string, text: string, opts?: { onlyIf?: { etagMatches?: string } | Headers }) {
      const cur = store.get(key);
      const cond = opts?.onlyIf;
      if (cond instanceof Headers ? cur : cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      store.set(key, { text, etag: `e${++n}` });
      return {};
    },
    async list({ prefix, limit = 1000, cursor }: { prefix: string; limit?: number; cursor?: string }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

test("entries are added, read newest first and paged; a damaged one is skipped", async () => {
  const { bucket, store } = fakeBucket();
  await recordAudit(bucket, "owner@owner.example", { kind: "member_removed", person: "a@owner.example", previous: { role: "member", mailboxes: [] } }, 1_000);
  await recordAudit(bucket, "owner@owner.example", { kind: "member_removed", person: "b@owner.example", previous: { role: "member", mailboxes: [] } }, 2_000);
  await recordAudit(bucket, null, { kind: "member_removed", person: "c@owner.example", previous: { role: "admin", mailboxes: null } }, 3_000);
  store.set(`${AUDIT_PREFIX}9999999999999-broken`, { text: "{not json", etag: "x" });
  const first = await readAudit(bucket, { limit: 2 });
  assert.deepEqual(first.entries.map((e) => "person" in e && e.person), ["c@owner.example", "b@owner.example"], "newest first");
  assert.equal(first.entries[0]!.at, new Date(3_000).toISOString());
  const rest = await readAudit(bucket, { limit: 2, cursor: first.cursor! });
  assert.deepEqual(rest.entries.map((e) => "person" in e && e.person), ["a@owner.example"], "the damaged entry (sorted last) is skipped");
  assert.equal(rest.cursor, null);
});

test("a record that cannot be written is logged and never undoes the act", async () => {
  const bucket = { put: async () => { throw new Error("R2 down"); } } as unknown as R2Bucket;
  assert.equal(await recordAudit(bucket, "x@owner.example", { kind: "keys_revoked", person: "x@owner.example", keys: ["k1"] }), null);
});

test("the actor is the signed-in person, or the agent behind a request the server made to itself; a header cannot claim it", () => {
  const own = new Request("https://inbox.example/api/members/a");
  assert.equal(actorOf(own, "owner@owner.example"), "owner@owner.example");
  inProcessActors.set(own, "key:k1");
  assert.equal(actorOf(own, undefined), "key:k1");
  assert.equal(actorOf(new Request("https://inbox.example/api/members/a", { headers: { "x-actor": "key:k1" } }), undefined), null);
  const handler = readFileSync(new URL("../workers/mcp/handler.ts", import.meta.url), "utf8");
  assert.match(handler, /if \(actor\) inProcessActors\.set\(request, actor\);/);
  assert.match(handler, /inProcessApi\(origin, env, ctx, callerId\(principal\)\)/);
});

test("people changes are kept with who, whom, and the role and mailboxes before and after; reading it is an administrator's", async () => {
  const { bucket } = fakeBucket();
  const app = new Hono<{ Bindings: { BUCKET: R2Bucket }; Variables: { standing?: unknown } }>();
  app.use("*", async (c, next) => { c.set("standing", { role: "admin", email: "owner@owner.example", listed: false }); await next(); });
  app.route("/", membersRouter as unknown as Hono);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, { BUCKET: bucket });
    return { status: r.status, data: await r.json() as any };
  };
  assert.equal((await call("PUT", "/api/members/ann%40owner.example", { role: "member", accounts: ["sales@owner.example"] })).status, 200);
  assert.equal((await call("PUT", "/api/members/ann%40owner.example", { role: "admin" })).status, 200);
  assert.equal((await call("DELETE", "/api/members/ann%40owner.example")).status, 200);
  assert.equal((await call("PUT", "/api/members/bad", { role: "admin" })).status, 400);
  const read = await call("GET", "/api/audit");
  assert.equal(read.status, 200);
  const kinds = read.data.entries.map((e: any) => [e.kind, e.person, e.actor]);
  assert.deepEqual(kinds, [["member_removed", "ann@owner.example", "owner@owner.example"], ["member_saved", "ann@owner.example", "owner@owner.example"],
    ["member_saved", "ann@owner.example", "owner@owner.example"]], "newest first; a refused change leaves nothing");
  const [removed, promoted, added] = read.data.entries;
  assert.deepEqual(added.previous, null);
  assert.deepEqual([added.role, added.mailboxes], ["member", ["cloudflare:sales@owner.example"]]);
  assert.deepEqual(promoted.previous, { role: "member", mailboxes: ["cloudflare:sales@owner.example"] });
  assert.deepEqual([promoted.role, promoted.mailboxes], ["admin", null]);
  assert.deepEqual(removed.previous, { role: "admin", mailboxes: null });
  assert.equal(memberGate("GET", "/api/audit", ["cloudflare:sales@owner.example"]), "refuse", "a member does not read the record");
});

test("a member's send is kept with its mailbox, recipients and subject, never its text", () => {
  assert.deepEqual(sendRouteOf("POST", "/api/v1/mailboxes/sales%40owner.example/emails"), { route: "POST /api/v1/mailboxes/:mailboxId/emails", mailbox: "sales@owner.example" });
  assert.deepEqual(sendRouteOf("POST", "/api/accounts/g1/drafts/d9/send"), { route: "POST /api/accounts/:accountId/drafts/:draftId/send", mailbox: "g1" });
  assert.equal(sendRouteOf("GET", "/api/accounts/g1/send"), null);
  assert.equal(sendRouteOf("POST", "/api/accounts/g1/messages"), null);
  const entry = memberSent({ route: "POST /api/accounts/:accountId/send", mailbox: "g1" },
    { to: ["Bob@Customer.invalid", { email: "eve@customer.invalid" }], cc: "carl@customer.invalid, bob@customer.invalid", subject: "Your order", text: "secret words", html: "<p>secret words</p>" },
    { id: "out-1" });
  assert.deepEqual(entry, { kind: "member_sent", mailbox: "g1", route: "POST /api/accounts/:accountId/send",
    to: ["bob@customer.invalid", "eve@customer.invalid", "carl@customer.invalid"], subject: "Your order", message: "out-1" });
  assert.ok(!JSON.stringify(entry).includes("secret"), "the text never reaches the record");
  assert.deepEqual(memberSent({ route: "POST /api/v1/mailboxes/:mailboxId/drafts/:id/send", mailbox: "sales@owner.example" }, null, null),
    { kind: "member_sent", mailbox: "sales@owner.example", route: "POST /api/v1/mailboxes/:mailboxId/drafts/:id/send", to: [], subject: null, message: null });
  const app = readFileSync(new URL("../workers/app.ts", import.meta.url), "utf8");
  assert.match(app, /const send = sendRouteOf\(c\.req\.method, path\);[\s\S]*await next\(\);\s*if \(c\.res\.ok\) await recordAudit\(c\.env\.BUCKET, standing\.email, memberSent\(/);
});

test("the routes kept as sends are the agent tools' mail sends; the others marked sends are not a member's mail", () => {
  const sends = new Set(TOOLS.filter((t) => t.sends).flatMap((t) => t.routes).filter((r) => r.startsWith("POST ")));
  const notMail = new Set(["POST /api/safety/lookup", "POST /api/project-addresses/:email/test", "POST /api/campaigns/:id/launch"]);
  assert.deepEqual([...sends].filter((r) => !notMail.has(r)).sort(), SEND_ROUTES.map((s) => s.route).sort());
});
