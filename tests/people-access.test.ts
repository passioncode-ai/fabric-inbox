// B-215: the listed people can sign in with nothing done in Cloudflare by hand: the server keeps its own Access
// policy of the listed emails on its application, and leaves the organization's own policies as they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudflareApi } from "../workers/routing/cloudflare-api";
import { emailsOf, peoplePolicyName, readSignIn, signInOf, syncSignIn, SIGN_IN_KEY } from "../workers/lib/people-access";

const AUD = "aud1234567890abcdef";
const ACC = "acc1";

/** A fake Cloudflare: one Access application with the organization's own policy, and the policies kept by id. */
function cloudflare(over: { failPolicyWrite?: boolean } = {}) {
  const policies = new Map<string, { id: string; name: string; decision: string; include: unknown[] }>([["own", { id: "own", name: "Administrators", decision: "allow", include: [{ group: { id: "g1" } }] }]]);
  let app = { id: "app1", aud: AUD, name: "Fabric Inbox", domain: "inbox.example", policies: [{ id: "own", precedence: 1 }] as { id: string; precedence: number }[] };
  const calls: string[] = [];
  let n = 0;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const answer = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 1, message: "refused" }] }), { status });
    if (path === `/accounts/${ACC}/access/apps` && method === "GET") return answer([app]);
    if (path === `/accounts/${ACC}/access/apps/app1` && method === "GET") return answer(app);
    if (path === `/accounts/${ACC}/access/apps/app1` && method === "PUT") { app = { ...app, ...body, id: "app1", aud: AUD }; return answer(app); }
    if (path === `/accounts/${ACC}/access/policies` && method === "GET") return answer([...policies.values()]);
    if (path === `/accounts/${ACC}/access/policies` && method === "POST") {
      if (over.failPolicyWrite) return answer(null, 400);
      const p = { id: `p${++n}`, ...body }; policies.set(p.id, p); return answer(p);
    }
    const one = path.match(new RegExp(`^/accounts/${ACC}/access/policies/(.+)$`));
    if (one && method === "PUT") { const p = { ...policies.get(one[1])!, ...body }; policies.set(one[1], p); return answer(p); }
    if (one && method === "DELETE") { policies.delete(one[1]); return answer({ id: one[1] }); }
    return answer(null, 404);
  };
  return { api: new CloudflareApi("t", fetcher as typeof fetch), calls, policies, app: () => app };
}

function bucket() {
  const store = new Map<string, string>();
  return { store, put: async (k: string, v: string) => { store.set(k, v); return {}; }, get: async (k: string) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)!) } : null) } as unknown as R2Bucket & { store: Map<string, string> };
}
const env = (b: R2Bucket) => ({ POLICY_AUD: AUD, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: ACC, BUCKET: b });

test("B-215: the listed emails get the server's own policy on its application; the organization's policy stays", async () => {
  const cf = cloudflare();
  const b = bucket();
  const emails = emailsOf([{ email: "Ann@Acme.example", role: "member", accounts: ["cloudflare:support@shop.invalid"], addedAt: "" }, { email: "boss@acme.example", role: "admin", accounts: null, addedAt: "" }]);
  assert.deepEqual(emails, ["ann@acme.example", "boss@acme.example"]);
  const state = await syncSignIn(env(b), emails, cf.api);
  assert.equal(state.state, "ok");
  const ours = [...cf.policies.values()].find((p) => p.name === peoplePolicyName(AUD))!;
  assert.deepEqual([ours.decision, ours.include], ["allow", [{ email: { email: "ann@acme.example" } }, { email: { email: "boss@acme.example" } }]]);
  assert.deepEqual(cf.app().policies.map((p) => p.id), ["own", ours.id], "attached after the organization's own, which is kept");
  assert.deepEqual(cf.policies.get("own")!.include, [{ group: { id: "g1" } }], "the organization's group is never changed");
  assert.deepEqual(signInOf(await readSignIn(b), "ANN@acme.example"), { canSignIn: true });
  assert.equal(signInOf(await readSignIn(b), "eve@acme.example").canSignIn, false);
  // The same list again changes nothing; a shorter one rewrites the policy; an empty one takes it off and deletes it.
  cf.calls.length = 0;
  await syncSignIn(env(b), emails, cf.api);
  assert.ok(!cf.calls.some((c) => !c.startsWith("GET")), "nothing to write");
  await syncSignIn(env(b), ["boss@acme.example"], cf.api);
  assert.deepEqual(cf.policies.get(ours.id)!.include, [{ email: { email: "boss@acme.example" } }]);
  await syncSignIn(env(b), [], cf.api);
  assert.equal(cf.policies.has(ours.id), false);
  assert.deepEqual(cf.app().policies.map((p) => p.id), ["own"]);
});

test("B-215: a refusal keeps the reason and says nobody new can sign in yet; a server without Access says it is not set up", async () => {
  const b = bucket();
  const failed = await syncSignIn(env(b), ["ann@acme.example"], cloudflare({ failPolicyWrite: true }).api);
  assert.equal(failed.state, "failed");
  assert.match(String(failed.reason), /refused/);
  const read = await readSignIn(b);
  assert.deepEqual([read?.state, signInOf(read, "ann@acme.example").canSignIn], ["failed", false]);
  assert.match(String(signInOf(read, "ann@acme.example").reason), /refused/);
  const none = await syncSignIn({ BUCKET: b }, ["ann@acme.example"]);
  assert.equal(none.state, "not_set_up");
  assert.equal(signInOf(none, "ann@acme.example").canSignIn, null);
  assert.ok(JSON.parse((b as unknown as { store: Map<string, string> }).store.get(SIGN_IN_KEY)!).at);
});
