import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { readMembers, standingOf, updateMembers, MembersError, MEMBERS_KEY, type Member } from "../workers/lib/members";
import { memberBody, memberGate } from "../workers/lib/member-gate";
import { membersRouter } from "../workers/routes/members";
import { scopedApi } from "../workers/mcp/scope";

/** An R2 bucket as far as the list uses it: get, and put with an etag condition. */
function fakeBucket(initial?: string) {
  const store = new Map<string, { text: string; etag: string }>();
  let n = 0;
  if (initial !== undefined) store.set(MEMBERS_KEY, { text: initial, etag: `e${++n}` });
  const bucket = {
    async get(key: string) {
      const o = store.get(key);
      return o ? { etag: o.etag, text: async () => o.text, json: async () => JSON.parse(o.text) } : null;
    },
    async put(key: string, text: string, opts?: { onlyIf?: { etagMatches?: string } | Headers }) {
      const cur = store.get(key);
      const cond = opts?.onlyIf;
      if (cond instanceof Headers ? cur : cond?.etagMatches !== undefined && cur?.etag !== cond.etagMatches) return null;
      store.set(key, { text, etag: `e${++n}` });
      return {};
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}
const member = (email: string, role: Member["role"], accounts: string[] | null = null): Member => ({ email, role, accounts, addedAt: "2026-10-23T00:00:00Z" });

test("B-149: with nobody listed everyone is an administrator; once listed, a member reaches their mailboxes and anyone else nothing", () => {
  assert.deepEqual(standingOf([], "Owner@Owner.example"), { role: "admin", email: "owner@owner.example", listed: false });
  const list = [member("owner@owner.example", "admin"), member("ann@owner.example", "member", ["cloudflare:sales@owner.example"])];
  assert.equal(standingOf(list, "owner@owner.example").role, "admin");
  assert.deepEqual(standingOf(list, "ANN@owner.example"), { role: "member", email: "ann@owner.example", accounts: ["cloudflare:sales@owner.example"] });
  assert.deepEqual(standingOf(list, "bob@owner.example"), { role: "none", email: "bob@owner.example" });
});

test("B-149: the first change a person makes lists them as administrator; the list always keeps one and never empties", async () => {
  const { bucket } = fakeBucket();
  const saved = await updateMembers(bucket, (l) => [...l, member("ann@owner.example", "member", ["cloudflare:sales@owner.example"])], "Owner@owner.example");
  assert.deepEqual(saved.map((m) => [m.email, m.role]), [["owner@owner.example", "admin"], ["ann@owner.example", "member"]]);
  await assert.rejects(updateMembers(bucket, (l) => l.filter((m) => m.role !== "admin"), null), (e: unknown) => e instanceof MembersError && e.status === 409);
  await assert.rejects(updateMembers(bucket, () => [], null), /last administrator/);
  // An agent's change (no person) to an empty list must bring its own administrator.
  const empty = fakeBucket();
  await assert.rejects(updateMembers(empty.bucket, () => [member("ann@owner.example", "member", ["cloudflare:a@owner.example"])], null), /administrator/);
});

test("B-149: a list that is there but cannot be read lets nobody in; damaged entries are dropped", async () => {
  await assert.rejects(readMembers(fakeBucket("{not json").bucket), (e: unknown) => e instanceof MembersError && e.status === 503);
  await assert.rejects(readMembers(fakeBucket(JSON.stringify({ people: [] })).bucket), /cannot be read/);
  const list = await readMembers(fakeBucket(JSON.stringify({ members: [{ email: "x" }, { email: "A@b.example", role: "boss" }, { email: "a@b.example", role: "admin" }] })).bucket);
  assert.deepEqual(list.map((m) => [m.email, m.role, m.accounts]), [["a@b.example", "member", []]], "an unknown role is a member with nothing; a duplicate keeps the first");
});

test("B-149: a member reaches their mailboxes' mail and the feed, never settings, a mailbox's own settings, agents or the agent protocol", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1"];
  const pass = [["GET", "/"], ["GET", "/assets/app.js"], ["GET", "/api/me"], ["GET", "/api/v1/mailboxes/sales%40owner.example/emails"],
    ["POST", "/api/v1/mailboxes/sales@owner.example/emails/m1/reply"], ["GET", "/api/accounts/g1/messages"], ["POST", "/api/accounts/g1/send"]];
  for (const [m, p] of pass) assert.equal(memberGate(m!, p!, mine), "pass", `${m} ${p}`);
  for (const p of ["/api/inbox", "/api/accounts", "/api/inbox/hidden"]) assert.equal(memberGate("GET", p, mine), "feed", p);
  const refuse = [["GET", "/api/v1/mailboxes/other@owner.example/emails"], ["PUT", "/api/v1/mailboxes/sales@owner.example"], ["DELETE", "/api/v1/mailboxes/sales@owner.example"],
    ["POST", "/api/accounts/g1/disconnect"], ["PUT", "/api/accounts/g1/password"], ["GET", "/api/agents"], ["GET", "/api/members"], ["GET", "/api/agent-keys"],
    ["GET", "/api/domains"], ["POST", "/mcp"], ["GET", "/agents/chat/x"], ["GET", "/fabric/v1/usage"], ["GET", "/.well-known/fabric-service"], ["GET", "/api/accounts/g2/messages"]];
  for (const [m, p] of refuse) assert.equal(memberGate(m!, p!, mine), "refuse", `${m} ${p}`);
});

test("B-149: the routes list, save and remove people, and a member's mailboxes are required", async () => {
  const { bucket } = fakeBucket();
  const app = new Hono<{ Bindings: { BUCKET: R2Bucket }; Variables: { standing?: unknown } }>();
  app.use("*", async (c, next) => { c.set("standing", { role: "admin", email: "owner@owner.example", listed: false }); await next(); });
  app.route("/", membersRouter as unknown as Hono);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, { BUCKET: bucket });
    return { status: r.status, data: await r.json() as any };
  };
  assert.deepEqual((await call("GET", "/api/members")).data.open, true);
  assert.equal((await call("PUT", "/api/members/ann%40owner.example", { role: "member" })).status, 400, "a member needs a mailbox");
  assert.equal((await call("PUT", "/api/members/not-an-email", { role: "admin" })).status, 400);
  const saved = await call("PUT", "/api/members/ann%40owner.example", { role: "member", accounts: ["Sales@Owner.example", "bad/one"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.members.map((m: Member) => [m.email, m.role, m.accounts]), [["owner@owner.example", "admin", null], ["ann@owner.example", "member", ["cloudflare:sales@owner.example"]]]);
  assert.equal((await call("DELETE", "/api/members/bob%40owner.example")).status, 404);
  assert.equal((await call("DELETE", "/api/members/owner%40owner.example")).status, 409, "the only administrator stays");
  assert.equal((await call("DELETE", "/api/members/ann%40owner.example")).status, 200);
  assert.deepEqual((await call("GET", "/api/me")).data, { role: "admin", email: "owner@owner.example", accounts: null, listed: false });
});

test("B-149: a member's refusals from the scoped feed speak to the person, not to a key", async () => {
  const api = { request: async () => ({ status: 200, contentType: "application/json", data: {} }) };
  await assert.rejects(scopedApi(api, ["cloudflare:sales@owner.example"], "person").request("GET", "/api/v1/mailboxes/other@owner.example/emails"), /You reach only sales@owner.example/);
  await assert.rejects(scopedApi(api, ["cloudflare:sales@owner.example"]).request("GET", "/api/v1/mailboxes/other@owner.example/emails"), /This key is limited/);
});

test("B-149: a member empties Spam and brings back discarded mail in their own mailboxes only, never taking back a shared rule", () => {
  const mine = ["cloudflare:sales@owner.example", "gmail:g1"];
  assert.equal(memberGate("POST", "/api/spam/empty", mine), "body");
  assert.equal(memberGate("POST", "/api/discard/restore", mine), "body");
  assert.equal(memberGate("DELETE", "/api/discard/rules/l-0000aaaa", mine), "refuse");
  assert.deepEqual(memberBody("POST /api/spam/empty", {}, mine), { body: { addresses: ["sales@owner.example"] } });
  const restore = { messages: [{ accountId: "gmail:g1", providerMessageId: "m1" }], unlearn: true };
  assert.deepEqual(memberBody("POST /api/discard/restore", restore, mine), { body: { ...restore, unlearn: false } });
  assert.deepEqual(memberBody("POST /api/discard/restore", { messages: [{ accountId: "gmail:other", providerMessageId: "m1" }] }, mine), { refuse: true });
  assert.deepEqual(memberBody("POST /api/discard/restore", { messages: [] }, mine), { refuse: true });
});

test("B-36: a member names mailboxes only; a whole-domain entry is not kept", async () => {
  const { normaliseMembers } = await import("../workers/lib/members");
  const read = normaliseMembers({ members: [{ email: "m@owner.example", role: "member", accounts: ["domain:owner.example", "cloudflare:m@owner.example"] }] });
  assert.deepEqual(read[0]?.accounts, ["cloudflare:m@owner.example"]);
});
