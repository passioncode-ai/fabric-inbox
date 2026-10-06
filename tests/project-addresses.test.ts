import { test } from "node:test";
import assert from "node:assert/strict";
import { EmailRoutingClient } from "../workers/routing/email-routing";
import { agentsRouter } from "../workers/routes/agents";

/** R2 keys as the Worker writes them. */
const mailboxKey = (address: string) => `mailboxes/${address}.json`;
const unknownKey = (address: string) => `unknown-recipients/${address.slice(address.indexOf("@") + 1)}/${address}.json`;

// REQ-P5 / SCN-021: routing is read in three states and a rule is created only
// once; addresses are created with their agent, and a failed rule leaves no
// mailbox. Cloudflare API responses are recorded fakes of the v4 envelope.
type Json = Record<string, unknown>;
function cloudflare(state: { zone?: boolean; enabled?: boolean; status?: string; rules?: Json[]; catchAll?: Json; fail?: string }) {
  const calls: { method: string; path: string; body?: Json }[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "") + url.search;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (state.fail) return new Response(JSON.stringify({ success: false, errors: [{ message: state.fail }] }), { status: 403 });
    // Every real token can list its account; the server's account is decided from it.
    if (path.startsWith("/accounts?")) return ok([{ id: "acc1", name: "Test account" }]);
    if (path.startsWith("/zones?name=")) return ok(state.zone === false ? [] : [{ id: "zone1", name: url.searchParams.get("name") }]);
    if (path === "/zones/zone1/email/routing") return ok({ enabled: state.enabled ?? true, status: state.status ?? "ready", name: "project.invalid" });
    if (path.startsWith("/zones/zone1/email/routing/rules?")) return ok(state.rules ?? []);
    if (path === "/zones/zone1/email/routing/rules/catch_all") return ok(state.catchAll ?? { enabled: false, actions: [{ type: "drop" }] });
    if (path === "/zones/zone1/email/routing/rules" && method === "POST") {
      const rule = { id: "new", ...JSON.parse(String(init!.body)) };
      (state.rules ??= []).push(rule);
      return ok(rule);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, client: new EmailRoutingClient("token", "fabric-inbox", fetcher), fetcher };
}
const literal = (to: string, action: Json, enabled = true) => ({ id: "r1", enabled, matchers: [{ type: "literal", field: "to", value: to }], actions: [action] });
const toWorker = { type: "worker", value: ["fabric-inbox"] };

test("routing status: rule, catch-all, missing, disabled, elsewhere and unreadable are distinct", async () => {
  const a = "support@project.invalid";
  assert.equal((await cloudflare({ rules: [literal(a, toWorker)] }).client.status(a)).state, "verified");
  const viaCatchAll = await cloudflare({ catchAll: { enabled: true, actions: [toWorker] } }).client.status(a);
  assert.deepEqual([viaCatchAll.state, viaCatchAll.via], ["verified", "catch_all"]);
  assert.equal((await cloudflare({}).client.status(a)).state, "missing");
  assert.match((await cloudflare({ rules: [literal(a, toWorker, false)] }).client.status(a)).detail, /disabled/);
  assert.match((await cloudflare({ rules: [literal(a, { type: "forward", value: ["me@gmail.invalid"] })] }).client.status(a)).detail, /somewhere else/);
  const disabledForward = await cloudflare({ rules: [literal(a, { type: "forward", value: ["me@gmail.invalid"] }, false)], catchAll: { enabled: true, actions: [toWorker] } }).client.status(a);
  assert.deepEqual([disabledForward.state, disabledForward.via], ["verified", "catch_all"], "a disabled rule matches nothing; the catch-all decides");
  assert.match(disabledForward.detail, /its own rule is disabled/);
  assert.match((await cloudflare({ enabled: false }).client.status(a)).detail, /Email Routing is off/);
  assert.match((await cloudflare({ status: "misconfigured" }).client.status(a)).detail, /misconfigured/);
  const invisible = await cloudflare({ zone: false }).client.status(a);
  assert.equal(invisible.state, "unknown");
  const denied = await cloudflare({ fail: "Authentication error" }).client.status(a);
  assert.equal(denied.state, "unknown");
  assert.match(denied.detail, /Authentication error/);
});

test("creating a rule points the literal address at the Worker once, and refuses to override another rule", async () => {
  const cf = cloudflare({});
  const created = await cf.client.createRule("Support@Project.invalid");
  assert.equal(created.state, "verified");
  const posts = cf.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body!.matchers, [{ type: "literal", field: "to", value: "support@project.invalid" }]);
  assert.deepEqual(posts[0].body!.actions, [toWorker]);
  await cf.client.createRule("support@project.invalid");
  assert.equal(cf.calls.filter((c) => c.method === "POST").length, 1, "an existing rule is not duplicated");
  const other = cloudflare({ rules: [literal("support@project.invalid", { type: "forward", value: ["x@y.invalid"] })] });
  await assert.rejects(other.client.createRule("support@project.invalid"), /sends mail elsewhere/);
});

// ── Routes over in-memory R2, registry and mailbox fakes ────────────
function environment(options: { token?: boolean; agents?: string[] } = {}) {
  const objects = new Map<string, string>();
  const versions = new Map<string, number>();
  const bucket = {
    async head(key: string) { return objects.has(key) ? {} : null; },
    // Like R2: an etag per version, and a conditional put that answers null when it does not hold.
    async get(key: string) { const v = objects.get(key); return v === undefined ? null : { etag: String(versions.get(key) ?? 0), json: async () => JSON.parse(v), text: async () => v }; },
    async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string } }) {
      if (options?.onlyIf?.etagMatches !== undefined && options.onlyIf.etagMatches !== String(versions.get(key) ?? 0)) return null;
      objects.set(key, value); versions.set(key, (versions.get(key) ?? 0) + 1);
      return { etag: String(versions.get(key)) };
    },
    async list({ prefix }: { prefix: string }) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }; },
  };
  const agents = new Set(options.agents ?? ["support"]);
  const sends: unknown[] = [];
  const env = {
    DOMAINS: "project.invalid, other.invalid",
    EMAIL_ADDRESSES: [],
    BUCKET: bucket,
    CLOUDFLARE_EMAIL_ROUTING_TOKEN: options.token ? "token" : undefined,
    AGENT_REGISTRY: { getByName: () => ({
      getAgent: async (id: string) => agents.has(id) ? { id, name: id[0].toUpperCase() + id.slice(1), version: 1 } : null,
      listAgents: async () => [...agents].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), version: 1 })),
    }) },
    MAILBOX: { idFromName: (n: string) => n, get: () => ({ getFolders: async () => [], sendMail: async (c: unknown) => { sends.push(c); return { id: "o", status: "accepted", errorCode: null }; } }) },
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await agentsRouter.request("https://inbox.test" + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env as never);
    return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as any) };
  };
  return { objects, env, call, sends };
}

test("an address is created on a served domain with its agent; duplicates and unknown agents are refused (SCN-021, SCN-023)", async () => {
  const h = environment();
  const created = await h.call("POST", "/api/project-addresses", { localPart: "Support", domain: "project.invalid", agent: { id: "support" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.email, "support@project.invalid");
  assert.deepEqual(JSON.parse(h.objects.get(mailboxKey("support@project.invalid"))!).agent, { id: "support" });
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid" })).status, 409);
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "sales", domain: "project.invalid", agent: { id: "ghost" } })).status, 400);
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "sales", domain: "stranger.test" })).status, 400);
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "bad address", domain: "project.invalid" })).status, 400);
  const second = await h.call("POST", "/api/project-addresses", { localPart: "help", domain: "other.invalid", agent: { id: "support" } });
  assert.equal(second.status, 201, "a space-and-comma DOMAINS list serves both domains");
  const list = await h.call("GET", "/api/project-addresses");
  assert.deepEqual(list.body.domains.map((d: any) => d.domain), ["project.invalid", "other.invalid"]);
  assert.deepEqual(list.body.addresses.map((a: any) => [a.email, a.agentName]), [["help@other.invalid", "Support"], ["support@project.invalid", "Support"]]);
  assert.equal(list.body.routingConfigured, false);
});

test("without a routing token the status is unknown and creating a rule is refused before any mailbox exists", async () => {
  const h = environment();
  const status = await h.call("GET", "/api/project-addresses/support@project.invalid/routing");
  assert.equal(status.body.state, "unknown");
  assert.match(status.body.detail, /no Cloudflare token yet/);
  const refused = await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: true });
  assert.equal(refused.status, 503);
  assert.equal(h.objects.has(mailboxKey("support@project.invalid")), false, "a failed rule leaves no half-configured address");
});

test("createRoute auto makes the rule when the server has a routing token, and says so when it has none (parity: create_address)", async () => {
  const without = environment();
  const made = await without.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: "auto" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.routing, null);
  assert.match(made.body.warning, /no Cloudflare token for Email Routing, so no rule was made/);
  assert.equal(without.objects.has(mailboxKey("support@project.invalid")), true);

  const original = globalThis.fetch;
  try {
    const withToken = environment({ token: true });
    const cf = cloudflare({});
    globalThis.fetch = cf.fetcher;
    const routed = await withToken.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: "auto" });
    assert.equal(routed.status, 201);
    assert.equal(routed.body.routing.state, "verified");
    assert.ok(cf.calls.some((c) => c.method === "POST" && c.path === "/zones/zone1/email/routing/rules"), "the rule was made");
    // A served domain whose zone this token cannot see still gets its address, with a warning.
    globalThis.fetch = cloudflare({ zone: false }).fetcher;
    const invisible = await withToken.call("POST", "/api/project-addresses", { localPart: "sales", domain: "project.invalid", createRoute: "auto" });
    assert.equal(invisible.status, 201, JSON.stringify(invisible.body));
    assert.match(invisible.body.warning, /no routing rule was made/);
  } finally { globalThis.fetch = original; }
});

test("a rule refused by Cloudflare leaves no mailbox; an accepted one creates both", async () => {
  const original = globalThis.fetch;
  try {
    const h = environment({ token: true });
    globalThis.fetch = cloudflare({ fail: "Authentication error" }).fetcher;
    const failed = await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: true });
    assert.equal(failed.status, 502);
    // The refusal names the permission to add (it used to echo Cloudflare's "Authentication error").
    assert.match(failed.body.error, /not allowed to read the domain \(Zone: Read\)/);
    assert.equal(h.objects.has(mailboxKey("support@project.invalid")), false);
    globalThis.fetch = cloudflare({}).fetcher;
    const created = await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: true });
    assert.equal(created.status, 201);
    assert.equal(created.body.routing.state, "verified");
  } finally { globalThis.fetch = original; }
});

test("assigning Off or another agent is saved; a missing agent or address is refused", async () => {
  const h = environment({ agents: ["support", "sales"] });
  await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", agent: { id: "support" } });
  assert.equal((await h.call("PUT", "/api/project-addresses/support@project.invalid/agent", { agent: "off" })).status, 200);
  assert.equal(JSON.parse(h.objects.get(mailboxKey("support@project.invalid"))!).agent, "off");
  assert.equal((await h.call("PUT", "/api/project-addresses/support@project.invalid/agent", { agent: { id: "sales" } })).status, 200);
  assert.equal((await h.call("PUT", "/api/project-addresses/support@project.invalid/agent", { agent: { id: "ghost" } })).status, 400);
  assert.equal((await h.call("PUT", "/api/project-addresses/none@project.invalid/agent", { agent: "off" })).status, 404);
  const settings = JSON.parse(h.objects.get(mailboxKey("support@project.invalid"))!);
  assert.deepEqual(settings.agent, { id: "sales" });
  assert.equal(settings.fromName, "support", "other settings survive the assignment");
});

test("unknown recipients are listed without addresses that now exist, and a test message goes out from the address", async () => {
  const h = environment();
  h.objects.set(unknownKey("sales@project.invalid"), JSON.stringify({ address: "sales@project.invalid", domain: "project.invalid", action: "rejected", count: 3, lastSeen: "2026-09-28T10:00:00Z" }));
  h.objects.set(unknownKey("help@project.invalid"), JSON.stringify({ address: "help@project.invalid", domain: "project.invalid", action: "rejected", count: 1, lastSeen: "2026-09-28T09:00:00Z" }));
  await h.call("POST", "/api/project-addresses", { localPart: "help", domain: "project.invalid" });
  const list = await h.call("GET", "/api/project-addresses");
  assert.deepEqual(list.body.unknownRecipients.map((u: any) => u.address), ["sales@project.invalid"]);
  const sent = await h.call("POST", "/api/project-addresses/help@project.invalid/test");
  assert.equal(sent.status, 200);
  const command = h.sends[0] as any;
  assert.equal(command.request.from, "help@project.invalid");
  assert.equal(command.request.to, "help@project.invalid");
});
