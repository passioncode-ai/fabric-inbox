import { test } from "node:test";
import assert from "node:assert/strict";
import { identityMayUse, normaliseKeys, principalFor, updateAgentKeys, readAgentKeys, type AgentKey } from "../workers/mcp/keys";
import { AgentAccess, policyName } from "../workers/mcp/access";
import { CloudflareApi } from "../workers/routing/cloudflare-api";

const key = (over: Partial<AgentKey> = {}): AgentKey => ({
  id: "tok-1", clientId: "abc.access", name: "Support bot", level: "mail", send: "drafts", dailySendLimit: 50,
  createdAt: "2026-09-29T00:00:00.000Z", expiresAt: "2027-09-29T00:00:00.000Z", accounts: null, ...over,
});

test("a person signed in through Access is the owner, at every level (AP-1)", () => {
  assert.deepEqual(principalFor({ email: "owner@x.invalid" }, []), { kind: "owner", label: "owner@x.invalid", level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null });
});

test("a service token is an agent only while its key is registered and not expired (AP-1)", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(principalFor({ common_name: "other.access", sub: "" }, [key()], now), null, "a token made for another app gets nothing");
  assert.deepEqual(principalFor({ common_name: "abc.access", sub: "" }, [key()], now),
    { kind: "agent", label: "Support bot", level: "mail", send: "drafts", dailySendLimit: 50, keyId: "tok-1", accounts: null });
  assert.equal(principalFor({ common_name: "abc.access" }, [key({ expiresAt: "2026-09-30T00:00:00Z" })], now), null, "expired");
  assert.equal(principalFor({}, [key()], now), null, "no identity at all");
});

test("an agent's token opens /mcp only; the app's API and pages refuse it (AP-1)", () => {
  const agent = { common_name: "abc.access", sub: "" };
  assert.equal(identityMayUse(agent, "/mcp"), true);
  for (const path of ["/api/v1/mailboxes", "/api/agent-keys", "/api/spam/empty", "/", "/agents/x", "/mcp/", "/mcpx"]) assert.equal(identityMayUse(agent, path), false, path);
  assert.equal(identityMayUse({ email: "owner@x.invalid" }, "/api/agent-keys"), true);
});

test("a damaged key file reads as no keys, and odd fields fall back to the safest value", () => {
  assert.deepEqual(normaliseKeys(null), []);
  assert.deepEqual(normaliseKeys({ keys: [{ id: "", clientId: "x" }, 7] }), []);
  const [k] = normaliseKeys({ keys: [{ id: "t", clientId: "c", level: "root", send: "always", dailySendLimit: -3 }] });
  assert.equal(k!.level, "read");
  assert.equal(k!.send, "drafts");
  assert.equal(k!.dailySendLimit, 50);
});

/** R2 with etags and onlyIf, enough for conditional writes. */
function bucket() {
  const store = new Map<string, { body: string; etag: string }>();
  let n = 0;
  return {
    store,
    async get(k: string) { const v = store.get(k); return v ? { etag: v.etag, json: async () => JSON.parse(v.body), text: async () => v.body } : null; },
    async put(k: string, body: string, opts: { onlyIf?: { etagMatches?: string } | Headers } = {}) {
      const cur = store.get(k);
      const only = opts.onlyIf;
      if (only instanceof Headers) { if (only.get("If-None-Match") === "*" && cur) return null; }
      else if (only?.etagMatches && cur?.etag !== only.etagMatches) return null;
      store.set(k, { body, etag: `e${++n}` });
      return {};
    },
  };
}

test("two keys saved at once are both kept (conditional writes)", async () => {
  const b = bucket() as unknown as R2Bucket;
  await Promise.all([updateAgentKeys(b, (ks) => [...ks, key({ id: "a", clientId: "a" })]), updateAgentKeys(b, (ks) => [...ks, key({ id: "b", clientId: "b" })])]);
  assert.deepEqual((await readAgentKeys(b)).map((k) => k.id).sort(), ["a", "b"]);
});

/** Cloudflare's Access API as far as AgentAccess uses it. */
function fakeCloudflare(opts: { failPolicy?: boolean; dropOwnerOnPut?: boolean } = {}) {
  const state = {
    apps: [{ id: "app1", aud: "aud-123456789012345", name: "fabric-inbox", domain: "x.workers.dev", type: "self_hosted", session_duration: "24h",
      policies: [{ id: "owner-policy", precedence: 1, name: "Owner" }] as { id: string; precedence: number; name?: string }[] }],
    policies: [] as { id: string; name: string; decision: string; include: Record<string, unknown>[] }[],
    tokens: [] as { id: string; client_id: string }[],
    appPuts: [] as Record<string, unknown>[],
  };
  let n = 0;
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/accounts/acc/access/apps" && method === "GET") return ok(state.apps);
    if (path === "/accounts/acc/access/policies" && method === "GET") return ok(state.policies);
    if (path === "/accounts/acc/access/service_tokens" && method === "POST") { const t = { id: `tok${++n}`, client_id: `cid${n}.access`, client_secret: `secret${n}`, name: body.name, expires_at: "2027-01-01T00:00:00Z" }; state.tokens.push(t); return ok(t); }
    if (path.startsWith("/accounts/acc/access/service_tokens/") && method === "DELETE") { const id = path.split("/").pop(); state.tokens = state.tokens.filter((t) => t.id !== id); return ok({ id }); }
    if (path === "/accounts/acc/access/policies" && method === "POST") { if (opts.failPolicy) return new Response(JSON.stringify({ success: false, errors: [{ code: 12130, message: "policy refused" }] }), { status: 400 }); const p = { id: `pol${++n}`, ...body }; state.policies.push(p); return ok(p); }
    if (path.startsWith("/accounts/acc/access/policies/") && method === "PUT") { const id = path.split("/").pop(); const p = state.policies.find((x) => x.id === id)!; Object.assign(p, body); return ok(p); }
    if (path.startsWith("/accounts/acc/access/policies/") && method === "DELETE") { const id = path.split("/").pop(); state.policies = state.policies.filter((x) => x.id !== id); return ok({ id }); }
    if (path === "/accounts/acc/access/apps/app1" && method === "GET") return ok(state.apps[0]);
    if (path === "/accounts/acc/access/apps/app1" && method === "PUT") {
      state.appPuts.push(body);
      state.apps[0]!.policies = opts.dropOwnerOnPut && state.appPuts.length === 1 ? body.policies.filter((p: { id: string }) => p.id !== "owner-policy") : body.policies;
      return ok(state.apps[0]);
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${method} ${path}` }] }), { status: 404 });
  };
  return { state, access: new AgentAccess(new CloudflareApi("t", fetcher as typeof fetch), { CLOUDFLARE_ACCOUNT_ID: "acc", POLICY_AUD: "aud-123456789012345" }) };
}

test("a key's token is let through by one Service Auth policy on the server's own app, keeping its other policies and settings (AP-7)", async () => {
  const { state, access } = fakeCloudflare();
  const first = await access.create("Support bot", "1y");
  const second = await access.create("Sales bot", "30d");
  assert.equal(state.policies.length, 1, "one policy for every agent of this server");
  const policy = state.policies[0]!;
  assert.equal(policy.name, policyName("aud-123456789012345"));
  assert.equal(policy.decision, "non_identity");
  assert.deepEqual(policy.include, [{ service_token: { token_id: first.id } }, { service_token: { token_id: second.id } }]);
  assert.equal(state.appPuts.length, 1, "the app is changed once, when the policy is first attached");
  assert.deepEqual(state.apps[0]!.policies, [{ id: "owner-policy", precedence: 1 }, { id: policy.id, precedence: 2 }]);
  const put = state.appPuts[0]!;
  assert.equal(put.domain, "x.workers.dev");
  assert.equal(put.session_duration, "24h");
  assert.equal("aud" in put || "id" in put, false, "read-only fields are not sent back");
});

test("revoking takes the token out of the policy and deletes it; the last one takes the policy off the app (AP-7)", async () => {
  const { state, access } = fakeCloudflare();
  const a = await access.create("A", "1y");
  const b = await access.create("B", "1y");
  await access.revoke(a.id);
  assert.deepEqual(state.policies[0]!.include, [{ service_token: { token_id: b.id } }]);
  assert.deepEqual(state.tokens.map((t) => t.id), [b.id]);
  await access.revoke(b.id);
  assert.deepEqual(state.policies, []);
  assert.deepEqual(state.apps[0]!.policies, [{ id: "owner-policy", precedence: 1 }], "the owner's own sign-in is untouched");
  assert.deepEqual(state.tokens, []);
});

test("a token that could not be let through is deleted again, so no credential exists the server does not know (AP-7)", async () => {
  const { state, access } = fakeCloudflare({ failPolicy: true });
  await assert.rejects(access.create("A", "1y"), /policy refused/);
  assert.deepEqual(state.tokens, []);
});

test("an admin key always sends: Drafts only would not hold for rules and reply agents it can make (review 2)", () => {
  assert.equal(principalFor({ common_name: "abc.access" }, [key({ level: "admin", send: "drafts" })])!.send, "send");
  assert.equal(principalFor({ common_name: "abc.access" }, [key({ level: "mail", send: "drafts" })])!.send, "drafts");
});

test("anything Access admits without a person — not only a service token — is limited to /mcp (review 8)", () => {
  assert.equal(identityMayUse({ sub: "" }, "/api/v1/mailboxes"), false);
  assert.equal(identityMayUse({}, "/"), false);
  assert.equal(identityMayUse({}, "/mcp"), true);
});

test("changing the Access app is refused when it has no sign-in of its own, and a key that could not be attached leaves nothing behind (review 5, 6)", async () => {
  const bare = fakeCloudflare();
  bare.state.apps[0]!.policies = [];
  await assert.rejects(bare.access.create("A", "1y"), /no sign-in policy of its own/);
  assert.deepEqual(bare.state.tokens, [], "the token is deleted again");
  assert.deepEqual(bare.state.policies.flatMap((p) => p.include), [], "and it is not left in the agents' policy");
});

test("if Cloudflare drops the owner's policy on the update, it is put back and the key fails (review 5)", async () => {
  const { state, access } = fakeCloudflare({ dropOwnerOnPut: true });
  await assert.rejects(access.create("A", "1y"), /put back/);
  assert.ok(state.apps[0]!.policies.some((p) => p.id === "owner-policy"), "the owner's sign-in is back");
  assert.deepEqual(state.tokens, []);
});

test("a bare 403 from Cloudflare names the permission to add, not just the status (live, 2026-09-29)", async () => {
  const api = new CloudflareApi("t", (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 12006 }] }), { status: 403 })) as typeof fetch);
  await assert.rejects(api.call("/accounts/a/access/service_tokens", { method: "POST", what: "manage agent keys (Access: Service Tokens: Edit)" }),
    /not allowed to manage agent keys \(Access: Service Tokens: Edit\).*code 12006/);
});
