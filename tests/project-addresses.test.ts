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
function cloudflare(state: { zone?: boolean; enabled?: boolean; status?: string; rules?: Json[]; catchAll?: Json; fail?: string; failRule?: string;
  /** Called when a rule is created, before Cloudflare answers (to see what exists at that moment, or to wait). */
  onRule?: (to: string) => void | Promise<void> }) {
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
    if (path === "/zones/zone1/email/routing/rules" && method === "POST" && state.failRule)
      return new Response(JSON.stringify({ success: false, errors: [{ message: state.failRule }] }), { status: 400 });
    if (path === "/zones/zone1/email/routing/rules" && method === "POST") {
      const rule = { id: `new${(state.rules ?? []).length}`, ...JSON.parse(String(init!.body)) };
      await state.onRule?.(rule.matchers[0].value);
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

test("a domain-level problem says so, so the panel offers the domain's Receive mail here, not a rule re-POST (B14-01)", async () => {
  const a = "support@project.invalid";
  const off = await cloudflare({ enabled: false }).client.status(a);
  assert.deepEqual([off.state, off.domainProblem], ["missing", true], "Email Routing off is the domain's problem");
  const misconfigured = await cloudflare({ status: "misconfigured" }).client.status(a);
  assert.deepEqual([misconfigured.state, misconfigured.domainProblem], ["missing", true], "unready records are the domain's problem");
  const noRule = await cloudflare({}).client.status(a);
  assert.equal(noRule.domainProblem, undefined, "no rule is the address's problem: Fix it makes the rule");
  const disabled = await cloudflare({ rules: [literal(a, toWorker, false)] }).client.status(a);
  assert.equal(disabled.domainProblem, undefined, "a disabled rule is the address's problem");
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
function environment(options: { token?: boolean; agents?: string[]; policy?: string; received?: { subject: string; folder_id: string; date: string }[]; sendStatus?: string } = {}) {
  const objects = new Map<string, string>();
  const versions = new Map<string, number>();
  const bucket = {
    async head(key: string) { return objects.has(key) ? {} : null; },
    // Like R2: an etag per version, and a conditional put that answers null when it does not hold.
    async get(key: string) { const v = objects.get(key); return v === undefined ? null : { etag: String(versions.get(key) ?? 0), json: async () => JSON.parse(v), text: async () => v }; },
    async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string } | Headers }) {
      const onlyIf = options?.onlyIf;
      // R2 takes the condition as fields or as headers; If-None-Match: * writes only a key that does not exist.
      if (onlyIf instanceof Headers ? onlyIf.get("If-None-Match") === "*" && objects.has(key) : false) return null;
      if (onlyIf && !(onlyIf instanceof Headers) && onlyIf.etagMatches !== undefined && onlyIf.etagMatches !== String(versions.get(key) ?? 0)) return null;
      objects.set(key, value); versions.set(key, (versions.get(key) ?? 0) + 1);
      return { etag: String(versions.get(key)) };
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
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
    UNKNOWN_ADDRESS_POLICY: options.policy,
    MAILBOX: { idFromName: (n: string) => n, get: () => ({
      getFolders: async () => [],
      purge: async () => [],
      sendMail: async (c: unknown) => { sends.push(c); return { id: "o", status: options.sendStatus ?? "accepted", errorCode: options.sendStatus === "failed" ? "E_REFUSED" : null }; },
      getOutboxAction: async () => null,
      // The mailbox's search: the sent copy and, once routing delivered it, the received one. Like the
      // real search, the subject matches anywhere in a message's subject (SQL LIKE %subject%).
      searchEmails: async ({ subject }: { subject: string }) => (options.received ?? []).filter((r) => r.subject.includes(subject)),
    }) },
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
  assert.equal(settings.fromName, "Support", "other settings survive the assignment (the display name defaults to the name, capitalised)");
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

// ── WS7 (0.12): check before creating, steps, several at once, the test watched until it arrives ──

const withFetch = async (fetcher: typeof fetch, fn: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { await fn(); } finally { globalThis.fetch = original; }
};
const byName = (body: any) => Object.fromEntries(body.names.map((n: any) => [n.localPart, n]));

test("check without a token: invalid, existing, role and recent names are told apart, and the domain says no rule can be made (SCN-061)", async () => {
  const h = environment({ policy: JSON.stringify({ "project.invalid": "catch_all:hello@project.invalid" }) });
  await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid" });
  h.objects.set(unknownKey("sales@project.invalid"), JSON.stringify({ address: "sales@project.invalid", domain: "project.invalid", action: "catch_all", count: 2, lastSeen: "2026-10-06T08:00:00Z" }));
  const r = await h.call("GET", "/api/project-addresses/check?domain=Project.invalid&names=support,sales,bad%20name,postmaster");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "no_token");
  assert.equal(r.body.rule.canMake, false);
  assert.match(r.body.rule.detail, /no Cloudflare token yet/);
  assert.equal(r.body.sendTestDefault, false);
  assert.deepEqual(r.body.catchAll, { mailbox: "hello@project.invalid", source: "deployment" });
  const n = byName(r.body);
  assert.equal(n.support.status, "exists");
  assert.equal(n.sales.status, "available");
  assert.ok(n.sales.notes.some((x: string) => /2 messages arrived for it recently/.test(x)), JSON.stringify(n.sales.notes));
  assert.equal(n["bad name"].status, "invalid");
  assert.match(n["bad name"].detail, /Spaces are not allowed/);
  assert.equal(n.postmaster.status, "available");
  assert.ok(n.postmaster.notes.some((x: string) => /RFC 5321/.test(x)));
  assert.equal((await h.call("GET", "/api/project-addresses/check?domain=nope&names=a")).status, 400);
  const tooMany = Array.from({ length: 51 }, (_, i) => `n${i}`).join(",");
  assert.equal((await h.call("GET", `/api/project-addresses/check?domain=project.invalid&names=${tooMany}`)).status, 400);
});

test("check with a token reads Cloudflare once: a rule elsewhere, a rule here, the catch-all and the domain's state (SCN-061, SCN-063)", async () => {
  const h = environment({ token: true });
  const cf = cloudflare({
    rules: [literal("sales@project.invalid", { type: "forward", value: ["me@gmail.invalid"] }), { ...literal("hello@project.invalid", toWorker), id: "r2" }],
    catchAll: { enabled: true, actions: [{ type: "forward", value: ["all@gmail.invalid"] }] },
  });
  await withFetch(cf.fetcher, async () => {
    const r = await h.call("GET", "/api/project-addresses/check?domain=project.invalid&names=sales,hello,new");
    assert.equal(r.body.state, "receiving", JSON.stringify(r.body));
    assert.equal(r.body.rule.canMake, true);
    assert.equal(r.body.sendTestDefault, true);
    const n = byName(r.body);
    assert.equal(n.sales.status, "elsewhere");
    assert.match(n.sales.detail, /forwards sales@project\.invalid to me@gmail\.invalid/);
    assert.equal(n.hello.status, "available");
    assert.match(n.hello.notes[0], /already sends it here; until it exists, its mail is refused/);
    assert.match(n.new.notes[0], /catch-all forwards new@project\.invalid to all@gmail\.invalid/);
    assert.equal(cf.calls.filter((c) => c.path.startsWith("/zones/zone1/email/routing/rules?")).length, 1, "the rules are read once for every name");
    // A domain of the account that does not receive here yet can, once received.
    const other = await h.call("GET", "/api/project-addresses/check?domain=stranger.invalid&names=hi");
    assert.equal(other.body.state, "can_receive");
    assert.match(other.body.detail, /first receives its mail here/);
  });
  await withFetch(cloudflare({ status: "misconfigured" }).fetcher, async () => {
    const r = await h.call("GET", "/api/project-addresses/check?domain=project.invalid&names=a");
    assert.equal(r.body.state, "needs_fix");
    assert.match(r.body.detail, /misconfigured/);
  });
  await withFetch(cloudflare({ zone: false }).fetcher, async () => {
    const r = await h.call("GET", "/api/project-addresses/check?domain=project.invalid&names=a");
    assert.equal(r.body.state, "not_visible");
    assert.equal(r.body.rule.canMake, false);
    assert.equal((await h.call("GET", "/api/project-addresses/check?domain=stranger.invalid&names=a")).body.state, "unavailable");
  });
  await withFetch(cloudflare({ fail: "Authentication error" }).fetcher, async () => {
    const r = await h.call("GET", "/api/project-addresses/check?domain=project.invalid&names=a");
    assert.equal(r.body.state, "unknown", "Cloudflare that cannot be read is unknown, never receiving");
    assert.equal(byName(r.body).a.status, "available", "and it does not block creating");
  });
});

test("created addresses carry their steps; with auto a refused rule keeps the address and says how to fix it (SCN-062, SCN-065)", async () => {
  const h = environment({ token: true });
  await withFetch(cloudflare({}).fetcher, async () => {
    const r = await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: "auto",
      signature: { enabled: true, text: "Support team\nAcme" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.steps.map((s: any) => [s.id, s.outcome]), [["address", "done"], ["rule", "done"]]);
    const settings = JSON.parse(h.objects.get(mailboxKey("support@project.invalid"))!);
    assert.equal(settings.fromName, "Support", "the display name defaults to the name, capitalised");
    assert.deepEqual(settings.signature, { enabled: true, text: "Support team\nAcme" });
  });
  await withFetch(cloudflare({ failRule: "Rule limit reached" }).fetcher, async () => {
    const r = await h.call("POST", "/api/project-addresses", { localPart: "sales", domain: "project.invalid", createRoute: "auto", name: "Sales desk" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rule = r.body.steps.find((s: any) => s.id === "rule");
    assert.equal(rule.outcome, "failed");
    assert.match(rule.detail, /Rule limit reached\. The address was kept/);
    assert.deepEqual(rule.fix, { action: "route_here", label: "Fix it" });
    assert.equal(JSON.parse(h.objects.get(mailboxKey("sales@project.invalid"))!).fromName, "Sales desk");
    const required = await h.call("POST", "/api/project-addresses", { localPart: "billing", domain: "project.invalid", createRoute: true });
    assert.equal(required.status, 502, "a required rule that is refused still leaves no address");
    assert.equal(h.objects.has(mailboxKey("billing@project.invalid")), false);
  });
  const noToken = environment();
  const skipped = await noToken.call("POST", "/api/project-addresses", { localPart: "hello", domain: "project.invalid", createRoute: "auto" });
  assert.deepEqual(skipped.body.steps[1].fix, { action: "connect_cloudflare", label: "Connect Cloudflare" });
  assert.equal(skipped.body.steps[1].outcome, "skipped");
  const dots = await noToken.call("POST", "/api/project-addresses", { localPart: "first..last", domain: "project.invalid" });
  assert.equal(dots.status, 400);
  assert.match(dots.body.error, /Two dots in a row/);
});

test("a rule made while Email Routing is off or broken for the domain says Not receiving yet with its fix, never done (SCN-062, SCN-065)", async () => {
  const h = environment({ token: true });
  for (const [state, pattern] of [[{ enabled: false }, /Email Routing is off/], [{ status: "misconfigured" }, /misconfigured/]] as const) {
    const cf = cloudflare(state);
    await withFetch(cf.fetcher, async () => {
      const local = "enabled" in state ? "support" : "sales";
      const r = await h.call("POST", "/api/project-addresses", { localPart: local, domain: "project.invalid", createRoute: "auto" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const rule = r.body.steps.find((s: any) => s.id === "rule");
      assert.equal(rule.outcome, "not_receiving", JSON.stringify(rule));
      assert.match(rule.detail, pattern);
      assert.deepEqual(rule.fix, { action: "open_domain", label: "Fix it" });
      assert.ok(cf.calls.some((c) => c.method === "POST" && c.path === "/zones/zone1/email/routing/rules"), "the rule itself was made");
    });
  }
  // A rule that already existed and receives is still "already", with no fix.
  await withFetch(cloudflare({ rules: [literal("hello@project.invalid", toWorker)] }).fetcher, async () => {
    const r = await h.call("POST", "/api/project-addresses", { localPart: "hello", domain: "project.invalid", createRoute: "auto" });
    const rule = r.body.steps.find((s: any) => s.id === "rule");
    assert.deepEqual([rule.outcome, rule.fix], ["already", undefined]);
  });
});

test("several addresses are created one by one, each with its own result; a bad name never stops the others (SCN-064)", async () => {
  const h = environment();
  await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid" });
  const r = await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: ["Sales", "support", "bad name", "hello", "sales"],
    agent: { id: "support" }, signature: { enabled: true, text: "Acme" }, createRoute: "auto" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x: any) => [x.email, x.status]), [
    ["sales@project.invalid", 201], ["support@project.invalid", 409], ["bad name@project.invalid", 400], ["hello@project.invalid", 201],
  ], "a repeated name is made once");
  assert.equal(r.body.created, 2);
  assert.equal(r.body.failed, 2);
  const hello = JSON.parse(h.objects.get(mailboxKey("hello@project.invalid"))!);
  assert.deepEqual([hello.fromName, hello.agent, hello.signature.text], ["Hello", { id: "support" }, "Acme"], "each address its own name, the rest shared");
  assert.equal((await h.call("POST", "/api/project-addresses/batch", { domain: "stranger.invalid", localParts: ["a"] })).status, 400);
  assert.equal((await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: [] })).status, 400);
  assert.equal((await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: ["a"], agent: { id: "ghost" } })).status, 400);
});

test("Send again in the same minute sends a new message, and only that message arriving after it counts (review 14, SCN-062)", async () => {
  const received: { subject: string; folder_id: string; date: string }[] = [];
  const h = environment({ received, sendStatus: "failed" });
  await h.call("POST", "/api/project-addresses", { localPart: "help", domain: "project.invalid" });
  const first = await h.call("POST", "/api/project-addresses/help@project.invalid/test");
  const second = await h.call("POST", "/api/project-addresses/help@project.invalid/test");
  assert.equal(h.sends.length, 2, "the second click sends, although it is the same minute");
  const [a, b] = h.sends as any[];
  assert.notEqual(a.idempotencyKey, b.idempotencyKey, "each click has its own key: the old failed send is not returned");
  assert.notEqual(first.body.subject, second.body.subject, "each test has its own subject");
  assert.match(second.body.subject, /^Fabric Inbox routing test \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · [0-9a-f]{8}$/);

  const ok = environment({ received });
  await ok.call("POST", "/api/project-addresses", { localPart: "help", domain: "project.invalid" });
  const sent = await ok.call("POST", "/api/project-addresses/help@project.invalid/test");
  const subject: string = sent.body.subject;
  const record = JSON.parse(ok.objects.get("routing-tests/help@project.invalid.json")!);
  const after = new Date(Date.parse(record.sentAt) + 10_000).toISOString();
  const state = async () => (await ok.call("GET", "/api/project-addresses/help@project.invalid/test")).body.test.state;
  // An earlier test of the same minute (its subject a prefix of this one, as before the fix), a reply,
  // and this subject dated before the send: none of them is this test arriving.
  received.push({ subject: subject.replace(/ · [0-9a-f]{8}$/, ""), folder_id: "inbox", date: after });
  received.push({ subject: `Re: ${subject}`, folder_id: "inbox", date: after });
  received.push({ subject, folder_id: "inbox", date: new Date(Date.parse(record.sentAt) - 60_000).toISOString() });
  assert.equal(await state(), "waiting");
  received.push({ subject, folder_id: "inbox", date: after });
  assert.equal(await state(), "arrived");
});

// ── Review F2 (0.12.0): a batch fits one request's Cloudflare budget, resumes, and never orphans a rule ──

const names = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
const external = (cf: { calls: unknown[] }) => cf.calls.length;

test("check says a name this server would refuse (EMAIL_ADDRESSES) cannot be created, as creating does (review 20)", async () => {
  const h = environment();
  (h.env as any).EMAIL_ADDRESSES = ["support@project.invalid"];
  const r = await h.call("GET", "/api/project-addresses/check?domain=project.invalid&names=support,sales");
  const n = byName(r.body);
  assert.equal(n.support.status, "available");
  assert.equal(n.sales.status, "restricted");
  assert.match(n.sales.detail, /only the addresses listed in EMAIL_ADDRESSES/);
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "sales", domain: "project.invalid" })).status, 403, "and creating refuses it");
});

test("check takes the names as a JSON array, so a name with a comma is checked as one name, not split (review 20)", async () => {
  const h = environment();
  const q = encodeURIComponent(JSON.stringify(["a,b", "hello"]));
  const r = await h.call("GET", `/api/project-addresses/check?domain=project.invalid&names=${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.names.map((x: any) => [x.localPart, x.status]), [["a,b", "invalid"], ["hello", "available"]]);
  assert.match(r.body.names[0].detail, /“,” is not allowed/);
  for (const bad of ["[1,2]", "[\"a\"", JSON.stringify(Array.from({ length: 51 }, (_, i) => `n${i}`)), JSON.stringify(["x".repeat(321)])])
    assert.equal((await h.call("GET", `/api/project-addresses/check?domain=project.invalid&names=${encodeURIComponent(bad)}`)).status, 400, bad.slice(0, 20));
  // The dialog's comma list of names it already checked still works.
  assert.equal((await h.call("GET", "/api/project-addresses/check?domain=project.invalid&names=a,b")).body.names.length, 2);
});

test("a batch reads the zone, Email Routing and the rules once, then costs one Cloudflare call per address (SCN-064)", async () => {
  const h = environment({ token: true });
  const cf = cloudflare({});
  await withFetch(cf.fetcher, async () => {
    const r = await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: names(5), createRoute: "auto" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, 5);
    assert.deepEqual(r.body.remaining, []);
    assert.equal(r.body.complete, true);
  });
  const count = (p: (c: { method: string; path: string }) => boolean) => cf.calls.filter(p).length;
  assert.equal(count((c) => c.method === "POST"), 5, "one rule per address");
  assert.equal(count((c) => c.path.startsWith("/zones/zone1/email/routing/rules?")), 1, "the rules are read once for the batch");
  assert.equal(count((c) => c.path === "/zones/zone1/email/routing"), 1, "Email Routing's state is read once");
  assert.ok(count((c) => c.path.startsWith("/zones?name=")) <= 2, "the zone is looked up once per client, not once per address");
  assert.ok(external(cf) <= 12, `${external(cf)} Cloudflare calls for 5 addresses`);
});

test("a batch larger than one request's Cloudflare budget stops in time and hands back the rest, which a second call finishes (SCN-064)", async () => {
  const h = environment({ token: true });
  const cf = cloudflare({});
  await withFetch(cf.fetcher, async () => {
    const first = await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: names(50), createRoute: "auto" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(external(cf) <= 45, `${external(cf)} Cloudflare calls in one request: within the free plan's 50 subrequests`);
    assert.equal(first.body.complete, false);
    const done = first.body.results.map((x: any) => x.email.split("@")[0]);
    assert.ok(done.length >= 20, `${done.length} rows done in the first request`);
    assert.deepEqual([...done, ...first.body.remaining], names(50), "every name is either done or handed back, in order, never both");
    assert.match(first.body.note, new RegExp(`${first.body.remaining.length} of the 50 names were not started`));
    const before = external(cf);
    const second = await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: first.body.remaining, createRoute: "auto" });
    assert.equal(second.body.complete, true, JSON.stringify(second.body));
    assert.ok(external(cf) - before <= 45);
    assert.equal(first.body.created + second.body.created, 50);
  });
  for (const n of names(50)) assert.ok(h.objects.has(mailboxKey(`${n}@project.invalid`)), n);
});

test("a batch also stops when its time is up, after at least one address (SCN-064)", async () => {
  const { createAddresses } = await import("../workers/lib/address-ops");
  const h = environment();
  const r = await createAddresses(h.env as never, { domain: "project.invalid", localParts: ["a", "b", "c"], createRoute: false }, null, { timeBudgetMs: 0 });
  assert.deepEqual((r.body.results as any[]).map((x) => x.email), ["a@project.invalid"], "the first address always runs: every call makes progress");
  assert.deepEqual(r.body.remaining, ["b", "c"]);
});

test("the mailbox is saved before its rule is made, so a request cut off between them never leaves a rule without a mailbox", async () => {
  const h = environment({ token: true });
  const seen: boolean[] = [];
  await withFetch(cloudflare({ onRule: (to) => { seen.push(h.objects.has(mailboxKey(to))); } }).fetcher, async () => {
    assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: "auto" })).status, 201);
    assert.equal((await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: ["a", "b"], createRoute: "auto" })).status, 200);
  });
  assert.deepEqual(seen, [true, true, true], "the mailbox existed when each rule was made");
});

test("two creates of the same address at once: one wins, the other is told it exists and never touches the winner's rule", async () => {
  const h = environment({ token: true });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const cf = cloudflare({ onRule: () => gate });
  await withFetch(cf.fetcher, async () => {
    const a = h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: "auto" });
    const b = h.call("POST", "/api/project-addresses", { localPart: "support", domain: "project.invalid", createRoute: "auto" });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409]);
  });
  assert.equal(cf.calls.filter((c) => c.method === "DELETE").length, 0, "no rule is deleted");
  assert.equal(cf.calls.filter((c) => c.method === "POST").length, 1, "one rule");
});

test("a test message is kept and watched: waiting, arrived (not the sent copy), not arrived after 3 minutes, refused (SCN-062)", async () => {
  const received: { subject: string; folder_id: string; date: string }[] = [];
  const h = environment({ received });
  await h.call("POST", "/api/project-addresses", { localPart: "help", domain: "project.invalid" });
  assert.deepEqual((await h.call("GET", "/api/project-addresses/help@project.invalid/test")).body, { email: "help@project.invalid", test: null });
  const sent = await h.call("POST", "/api/project-addresses/help@project.invalid/test");
  assert.equal(sent.status, 200);
  assert.equal(sent.body.test.state, "waiting");
  const later = new Date(Date.now() + 20_000).toISOString();
  received.push({ subject: sent.body.subject, folder_id: "sent", date: later });
  assert.equal((await h.call("GET", "/api/project-addresses/help@project.invalid/test")).body.test.state, "waiting", "the sent copy is not an arrival");
  received.push({ subject: sent.body.subject, folder_id: "inbox", date: later });
  const arrived = (await h.call("GET", "/api/project-addresses/help@project.invalid/test")).body.test;
  assert.deepEqual([arrived.state, arrived.folder, arrived.arrivedAt], ["arrived", "inbox", later]);

  const late = environment();
  await late.call("POST", "/api/project-addresses", { localPart: "late", domain: "project.invalid" });
  await late.call("POST", "/api/project-addresses/late@project.invalid/test");
  const record = JSON.parse(late.objects.get("routing-tests/late@project.invalid.json")!);
  late.objects.set("routing-tests/late@project.invalid.json", JSON.stringify({ ...record, sentAt: new Date(Date.now() - 4 * 60_000).toISOString() }));
  const status = (await late.call("GET", "/api/project-addresses/late@project.invalid/test")).body.test;
  assert.equal(status.state, "not_arrived");
  assert.match(status.detail, /not arrived after 3 minutes/);

  const refused = environment({ sendStatus: "failed" });
  await refused.call("POST", "/api/project-addresses", { localPart: "x", domain: "project.invalid" });
  const r = await refused.call("POST", "/api/project-addresses/x@project.invalid/test");
  assert.equal(r.body.test.state, "failed");
  assert.match(r.body.test.detail, /E_REFUSED/);
  assert.equal((await refused.call("GET", "/api/project-addresses/none@project.invalid/test")).status, 404);
});

test("creating an address records when it was made, and the inbox's account list carries it; an older address has none (2026-10-08)", async () => {
  const { inboxSources } = await import("../workers/lib/inbox-sources");
  const { CREATED_KEY } = await import("../workers/lib/address-created");
  const h = environment();
  // An address made before the server recorded creation times: no entry, so it reads as old.
  h.objects.set(mailboxKey("old@project.invalid"), JSON.stringify({ agent: "off" }));
  const before = Date.now();
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "j1", domain: "project.invalid" })).status, 201);
  const batch = await h.call("POST", "/api/project-addresses/batch", { domain: "project.invalid", localParts: ["b1", "b2"] });
  assert.equal(batch.body.created, 2, JSON.stringify(batch.body));
  const after = Date.now();
  const created = JSON.parse(h.objects.get(CREATED_KEY)!).created as Record<string, number>;
  assert.deepEqual(Object.keys(created).sort(), ["b1@project.invalid", "b2@project.invalid", "j1@project.invalid"], "every way of creating records it, one entry each");
  for (const at of Object.values(created)) assert.ok(at >= before && at <= after, "the time is the moment of creation");

  const accounts = await inboxSources(h.env as never).cloudflareAccounts();
  const byEmail = new Map(accounts.map((a) => [a.email, a]));
  assert.equal(byEmail.get("j1@project.invalid")?.createdAt, created["j1@project.invalid"]);
  assert.equal(byEmail.get("old@project.invalid")?.createdAt, undefined, "a legacy address carries no time");

  assert.equal((await h.call("DELETE", "/api/project-addresses/j1@project.invalid")).status, 200);
  assert.ok(!("j1@project.invalid" in JSON.parse(h.objects.get(CREATED_KEY)!).created), "a deleted address is forgotten");
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "j1", domain: "project.invalid" })).status, 201);
  assert.ok(JSON.parse(h.objects.get(CREATED_KEY)!).created["j1@project.invalid"] >= created["j1@project.invalid"], "made again, it is new again");
});

test("an unreadable creation record never hides an address or fails its creation (2026-10-08)", async () => {
  const { inboxSources } = await import("../workers/lib/inbox-sources");
  const { CREATED_KEY } = await import("../workers/lib/address-created");
  const h = environment();
  h.objects.set(CREATED_KEY, "{not json");
  assert.equal((await h.call("POST", "/api/project-addresses", { localPart: "j2", domain: "project.invalid" })).status, 201);
  const accounts = await inboxSources(h.env as never).cloudflareAccounts();
  assert.deepEqual(accounts.map((a) => a.email), ["j2@project.invalid"]);
  assert.equal(typeof accounts[0].createdAt, "number", "an unreadable record is replaced by a good one on the next create");
  const broken = environment();
  broken.objects.set(mailboxKey("x@project.invalid"), "{}");
  const get = broken.env.BUCKET.get;
  broken.env.BUCKET.get = async (key: string) => { if (key === CREATED_KEY) throw new Error("R2 down"); return get(key); };
  const listed = await inboxSources(broken.env as never).cloudflareAccounts();
  assert.deepEqual(listed.map((a) => [a.email, a.createdAt]), [["x@project.invalid", undefined]], "listed without a time, never left out");
  assert.equal((await broken.call("POST", "/api/project-addresses", { localPart: "y", domain: "project.invalid" })).status, 201, "the address is made even when its time cannot be kept");
});
