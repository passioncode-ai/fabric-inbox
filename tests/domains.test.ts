import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/** R2 keys as the Worker writes them. */
const mailboxKey = (address: string) => `mailboxes/${address}.json`;

/**
 * Domains & addresses (CF-2/CF-3) in workerd against a fake Cloudflare API
 * that keeps state, so each test reads back what the server changed.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { MailboxDO } from './workers/durableObject/index';
      import { domainsRouter } from './workers/routes/domains';
      import { agentsRouter } from './workers/routes/agents';
      import { app as mailApp } from './workers/index';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
      }
      const app = new Hono();
      app.get('/r2', async (c) => { const o = await c.env.BUCKET.get(c.req.query('key')); return new Response(o ? await o.text() : 'null'); });
      app.put('/r2', async (c) => { await c.env.BUCKET.put(c.req.query('key'), await c.req.text()); return c.json({ ok: true }); });
      app.route('/', domainsRouter);
      app.route('/', agentsRouter);
      app.route('/', mailApp);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

interface Rule { id: string; name: string; enabled: boolean; priority: number; matchers: unknown[]; actions: { type: string; value?: string[] }[] }
interface ZoneState {
  id: string; name: string;
  routing: { enabled: boolean; status: string };
  rules: Rule[];
  catchAll: Omit<Rule, "id" | "priority">;
  dns: { id: string; type: string; name: string; content: string }[];
  sending: { name: string; enabled: boolean }[];
}

function fakeCloudflare(options: { deny?: RegExp } = {}) {
  let n = 0;
  const id = () => `id${++n}`;
  const rule = (to: string, action: Rule["actions"][number], enabled = true): Rule =>
    ({ id: id(), name: to, enabled, priority: 0, matchers: [{ type: "literal", field: "to", value: to }], actions: [action] });
  const zones: ZoneState[] = [
    { id: "z-product", name: "product.invalid", routing: { enabled: true, status: "ready" },
      rules: [rule("support@product.invalid", { type: "forward", value: ["owner@gmail.invalid"] }), rule("spam@product.invalid", { type: "drop" }),
        rule("old@product.invalid", { type: "forward", value: ["owner@gmail.invalid"] }, false)],
      catchAll: { name: "Catch-all", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["owner@gmail.invalid"] }] },
      dns: [{ id: id(), type: "MX", name: "product.invalid", content: "route1.mx.cloudflare.net" }], sending: [] },
    { id: "z-namecheap", name: "namecheap.invalid", routing: { enabled: false, status: "unconfigured" }, rules: [],
      catchAll: { name: "Catch-all", enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
      dns: [{ id: id(), type: "MX", name: "namecheap.invalid", content: "eforward1.registrar-servers.com" },
        { id: id(), type: "TXT", name: "_dmarc.namecheap.invalid", content: "\"v=DMARC1; p=reject;\"" }], sending: [] },
  ];
  const destinations = [
    { id: id(), email: "owner@gmail.invalid", verified: "2026-01-01T00:00:00Z", status: "verified" },
    { id: id(), email: "pending@gmail.invalid", verified: null, status: "pending" },
  ];
  const writes: string[] = [];
  const ok = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, errors: [], result }), { status, headers: { "content-type": "application/json" } });
  const fail = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "api.cloudflare.com") return new Response("External network disabled for tests", { status: 503 });
    if (request.headers.get("authorization") !== "Bearer test-token") return fail(401, 10000, "Authentication error");
    const path = url.pathname.replace("/client/v4", "");
    const method = request.method;
    if (options.deny?.test(`${method} ${path}`)) return fail(403, 10000, "Authentication error");
    const body = method === "GET" || method === "DELETE" ? null : await request.json().catch(() => null) as any;
    if (method !== "GET") writes.push(`${method} ${path}`);
    const page = Number(url.searchParams.get("page") ?? 1);
    if (path === "/zones") {
      const name = url.searchParams.get("name");
      const list = zones.filter((z) => !name || z.name === name).map((z) => ({ id: z.id, name: z.name, status: "active", account: { id: "acc-1", name: "Test account" } }));
      return ok(page > 1 ? [] : list);
    }
    if (path === "/accounts/acc-1/email/routing/addresses") {
      if (method === "GET") return ok(page > 1 ? [] : destinations);
      const d = { id: id(), email: body.email, verified: null, status: "pending" };
      destinations.push(d);
      return ok(d);
    }
    const m = path.match(/^\/zones\/([^/]+)(\/.*)$/);
    const zone = zones.find((z) => z.id === m?.[1]);
    if (!zone || !m) return fail(404, 1001, "Not found");
    const rest = m[2];
    if (rest === "/email/routing") return ok({ enabled: zone.routing.enabled, status: zone.routing.status, name: zone.name });
    if (rest === "/email/routing/dns" && method === "POST") {
      // Cloudflare's own answer (2026-09-30, on an owner domain): `name` may only name a subdomain.
      if (body?.name !== undefined && !String(body.name).endsWith("." + zone.name))
        return fail(400, 1004, `Invalid Input: must be a subdomains of ${zone.name}`);
      if (zone.dns.some((r) => r.type === "MX" && !r.content.endsWith("mx.cloudflare.net")))
        return fail(400, 2004, "MX records of another provider are in the way");
      zone.routing = { enabled: true, status: "ready" };
      zone.dns.push({ id: id(), type: "MX", name: zone.name, content: "route1.mx.cloudflare.net" });
      return ok([]);
    }
    if (rest === "/email/routing/rules" && method === "GET") return ok(page > 1 ? [] : zone.rules);
    if (rest === "/email/routing/rules" && method === "POST") { const r = { id: id(), priority: 0, ...body }; zone.rules.push(r); return ok(r); }
    if (rest === "/email/routing/rules/catch_all") {
      if (method === "PUT") zone.catchAll = { ...zone.catchAll, ...body };
      return ok(zone.catchAll);
    }
    const r = rest.match(/^\/email\/routing\/rules\/([^/]+)$/);
    if (r) {
      const index = zone.rules.findIndex((x) => x.id === r[1]);
      if (index < 0) return fail(404, 1002, "Rule not found");
      if (method === "PUT") { zone.rules[index] = { ...zone.rules[index], ...body, id: r[1] }; return ok(zone.rules[index]); }
      if (method === "DELETE") { const [gone] = zone.rules.splice(index, 1); return ok(gone); }
      return ok(zone.rules[index]);
    }
    if (rest === "/email/sending/subdomains") {
      if (method === "POST") { zone.sending.push({ name: body.name, enabled: true }); return ok({ name: body.name, enabled: true }); }
      return ok(zone.sending);
    }
    if (rest === "/dns_records") {
      if (method === "POST") { const rec = { id: id(), ...body }; zone.dns.push(rec); return ok(rec); }
      const type = url.searchParams.get("type"); const name = url.searchParams.get("name");
      return ok(page > 1 ? [] : zone.dns.filter((x) => (!type || x.type === type) && (!name || x.name === name)));
    }
    const d = rest.match(/^\/dns_records\/([^/]+)$/);
    if (d && method === "DELETE") { zone.dns = zone.dns.filter((x) => x.id !== d[1]); return ok({ id: d[1] }); }
    return fail(404, 1003, `Fake has no ${method} ${path}`);
  }
  return { zones, destinations, writes, handle, zone: (name: string) => zones.find((z) => z.name === name)! };
}

async function fixture(options: { token?: boolean; deny?: RegExp; bindings?: Record<string, string> } = {}) {
  const cf = fakeCloudflare({ deny: options.deny });
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"],
    bindings: { DOMAINS: "base.invalid", ...(options.token === false ? {} : { CLOUDFLARE_API_TOKEN: "test-token" }), ...(options.bindings ?? {}) },
    outboundService: (request) => cf.handle(request),
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await mf.dispatchFetch("http://localhost" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const r2 = async (key: string) => JSON.parse(await (await mf.dispatchFetch("http://localhost/r2?key=" + encodeURIComponent(key))).text());
  const putR2 = async (key: string, value: unknown) => mf.dispatchFetch("http://localhost/r2?key=" + encodeURIComponent(key), { method: "PUT", body: JSON.stringify(value) });
  return { mf, cf, call, r2, putR2 };
}

const outcomes = (steps: { id: string; outcome: string }[]) => Object.fromEntries(steps.map((s) => [s.id, s.outcome]));

test("without a token the Domains screen says what to create, and nothing claims Cloudflare state", async () => {
  const { mf, call } = await fixture({ token: false });
  try {
    const list = await call("/api/domains");
    assert.equal(list.body.connected, false);
    assert.match(list.body.problem, /CLOUDFLARE_API_TOKEN/);
    assert.ok(list.body.permissions.some((p: any) => p.name === "Email Routing Rules" && p.level === "Edit"));
    assert.deepEqual(list.body.domains.map((d: any) => [d.domain, d.served, d.fixed]), [["base.invalid", true, true]]);
    assert.equal((await call("/api/domains/product.invalid/connect", "POST", {})).status, 503);
  } finally { await mf.dispose(); }
});

test("the domain list shows every zone, served ones first, and one domain in detail", async () => {
  const { mf, call } = await fixture();
  try {
    const list = await call("/api/domains");
    assert.equal(list.body.connected, true);
    assert.equal(list.body.account, "Test account");
    assert.deepEqual(list.body.domains.map((d: any) => [d.domain, d.served]), [["base.invalid", true], ["namecheap.invalid", false], ["product.invalid", false]]);
    const detail = (await call("/api/domains/namecheap.invalid")).body;
    assert.deepEqual(detail.foreignMx, ["eforward1.registrar-servers.com"]);
    assert.equal(detail.routing.enabled, false);
    assert.equal(detail.dmarc, "v=DMARC1; p=reject;");
    assert.equal((await call("/api/domains/missing.test")).status, 404);
    assert.equal((await call("/api/domains/not_a_domain")).status, 400);
  } finally { await mf.dispose(); }
});

test("connecting a domain keeps every old destination as a copy and moves the rules here; again changes nothing", async () => {
  const { mf, cf, call, r2 } = await fixture();
  try {
    const first = await call("/api/domains/product.invalid/connect", "POST", {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(outcomes(first.body.steps), { routing: "already", serve: "done", addresses: "done", rules: "done", sending: "done", dmarc: "done" });
    const support = await r2(mailboxKey("support@product.invalid"));
    assert.deepEqual(support.forwarding, { enabled: true, email: "owner@gmail.invalid" });
    assert.equal((await r2(mailboxKey("catch-all@product.invalid"))).forwarding.email, "owner@gmail.invalid");
    assert.equal(await r2(mailboxKey("spam@product.invalid")), null, "a drop rule creates nothing");
    assert.equal(await r2(mailboxKey("old@product.invalid")), null, "a disabled rule creates nothing");
    const z = cf.zone("product.invalid");
    assert.deepEqual(z.rules.find((r) => r.name === "support@product.invalid")!.actions, [{ type: "worker", value: ["fabric-inbox"] }]);
    assert.deepEqual(z.rules.find((r) => r.name === "spam@product.invalid")!.actions, [{ type: "drop" }]);
    assert.equal(z.rules.find((r) => r.name === "old@product.invalid")!.enabled, false);
    assert.deepEqual(z.catchAll.actions, [{ type: "worker", value: ["fabric-inbox"] }]);
    assert.deepEqual(await r2("config/catch-all.json"), { "product.invalid": "catch-all@product.invalid" });
    assert.deepEqual(z.sending, [{ name: "product.invalid", enabled: true }]);
    assert.ok(z.dns.some((r) => r.name === "_dmarc.product.invalid" && /p=none/.test(r.content)));

    const writes = cf.writes.length;
    const again = await call("/api/domains/product.invalid/connect", "POST", {});
    assert.deepEqual(outcomes(again.body.steps), { routing: "already", serve: "already", addresses: "already", rules: "already", sending: "already", dmarc: "already" });
    assert.equal(cf.writes.length, writes, "a second run writes nothing to Cloudflare");
  } finally { await mf.dispose(); }
});

test("another provider's MX is replaced only after the operator confirms it", async () => {
  const { mf, cf, call } = await fixture();
  try {
    const ask = await call("/api/domains/namecheap.invalid/connect", "POST", {});
    assert.equal(ask.status, 409);
    assert.deepEqual(ask.body.needsConfirmation, { foreignMx: ["eforward1.registrar-servers.com"] });
    assert.deepEqual(cf.writes, [], "nothing changes before the confirmation");
    assert.equal((await call("/api/domains")).body.domains.find((d: any) => d.domain === "namecheap.invalid").served, false);

    const done = await call("/api/domains/namecheap.invalid/connect", "POST", { replaceMx: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(outcomes(done.body.steps).routing, "done");
    assert.match(done.body.steps[0].detail, /eforward1\.registrar-servers\.com were replaced/);
    assert.equal(outcomes(done.body.steps).addresses, "skipped", "a fresh domain has no address yet");
    assert.equal(outcomes(done.body.steps).dmarc, "already", "an existing DMARC policy is left alone");
    const z = cf.zone("namecheap.invalid");
    assert.ok(!z.dns.some((r) => r.content.includes("registrar-servers")));
    assert.equal(z.routing.enabled, true);
  } finally { await mf.dispose(); }
});

test("a permission the token lacks is named, and receiving still completes", async () => {
  const { mf, call } = await fixture({ deny: /^POST \/zones\/[^/]+\/email\/sending/ });
  try {
    const r = await call("/api/domains/product.invalid/connect", "POST", {});
    assert.equal(r.status, 200, "sending is not needed to receive");
    const sending = r.body.steps.find((s: any) => s.id === "sending");
    assert.equal(sending.outcome, "failed");
    assert.match(sending.detail, /Email Sending: Edit/);
    assert.equal(outcomes(r.body.steps).rules, "done");
  } finally { await mf.dispose(); }
});

test("releasing a domain sends each address back to its copy and keeps the mail", async () => {
  const { mf, cf, call, r2 } = await fixture();
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    const r = await call("/api/domains/product.invalid/release", "POST");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const z = cf.zone("product.invalid");
    assert.deepEqual(z.rules.find((x) => x.name === "support@product.invalid")!.actions, [{ type: "forward", value: ["owner@gmail.invalid"] }]);
    assert.deepEqual(z.catchAll.actions, [{ type: "forward", value: ["owner@gmail.invalid"] }]);
    assert.equal((await call("/api/domains")).body.domains.find((d: any) => d.domain === "product.invalid").served, false);
    assert.notEqual(await r2(mailboxKey("support@product.invalid")), null, "mailboxes stay");
    assert.deepEqual(await r2("config/catch-all.json"), {});
    const fixed = await call("/api/domains/base.invalid/release", "POST");
    assert.equal(fixed.status, 502);
    assert.match(fixed.body.steps[0].detail, /DOMAINS/);
  } finally { await mf.dispose(); }
});

test("addresses: a copy needs a confirmed destination; removing one takes its rule and mail, never the catch-all", async () => {
  const { mf, cf, call, r2 } = await fixture();
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    const pending = await call("/api/project-addresses", "POST", { localPart: "sales", domain: "product.invalid", createRoute: true, forwardTo: "pending@gmail.invalid" });
    assert.equal(pending.status, 400);
    assert.match(pending.body.error, /has not confirmed yet/);
    const unknown = await call("/api/project-addresses", "POST", { localPart: "sales", domain: "product.invalid", forwardTo: "someone@else.test" });
    assert.match(unknown.body.error, /not a forwarding destination yet/);
    const loop = await call("/api/project-addresses", "POST", { localPart: "sales", domain: "product.invalid", forwardTo: "x@base.invalid" });
    assert.match(loop.body.error, /come straight back/);
    assert.equal(cf.zone("product.invalid").rules.some((x) => x.name.includes("sales")), false, "a refused address creates no rule");

    const created = await call("/api/project-addresses", "POST", { localPart: "sales", domain: "product.invalid", createRoute: true, forwardTo: "owner@gmail.invalid" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual((await r2(mailboxKey("sales@product.invalid"))).forwarding, { enabled: true, email: "owner@gmail.invalid" });
    assert.ok(cf.zone("product.invalid").rules.some((x) => (x.matchers[0] as any).value === "sales@product.invalid"));

    const removed = await call("/api/project-addresses/sales@product.invalid", "DELETE");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.match(removed.body.afterwards, /catch-all@product\.invalid/);
    assert.equal(await r2(mailboxKey("sales@product.invalid")), null);
    assert.ok(!cf.zone("product.invalid").rules.some((x) => (x.matchers[0] as any).value === "sales@product.invalid"));

    const guarded = await call("/api/project-addresses/catch-all@product.invalid", "DELETE");
    assert.equal(guarded.status, 409);
    assert.equal((await call("/api/project-addresses/nobody@product.invalid", "DELETE")).status, 404);
  } finally { await mf.dispose(); }
});

test("catch-all: choosing a mailbox points Cloudflare's catch-all here; none refuses other addresses", async () => {
  const { mf, cf, call, r2 } = await fixture();
  try {
    await call("/api/domains/namecheap.invalid/connect", "POST", { replaceMx: true });
    await call("/api/project-addresses", "POST", { localPart: "hello", domain: "namecheap.invalid", createRoute: true });
    assert.equal((await call("/api/domains/namecheap.invalid/catch-all", "PUT", { mailbox: "hello@product.invalid" })).status, 400, "only an address on this domain");
    const set = await call("/api/domains/namecheap.invalid/catch-all", "PUT", { mailbox: "hello@namecheap.invalid" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(cf.zone("namecheap.invalid").catchAll.actions, [{ type: "worker", value: ["fabric-inbox"] }]);
    assert.equal(cf.zone("namecheap.invalid").catchAll.enabled, true);
    assert.equal((await r2("config/catch-all.json"))["namecheap.invalid"], "hello@namecheap.invalid");
    await call("/api/domains/namecheap.invalid/catch-all", "PUT", { mailbox: null });
    assert.equal((await r2("config/catch-all.json"))["namecheap.invalid"], undefined);
  } finally { await mf.dispose(); }
});

test("forwarding destinations are listed and added; Cloudflare sends the confirmation", async () => {
  const { mf, call } = await fixture();
  try {
    const list = await call("/api/domains/destinations");
    assert.deepEqual(list.body.destinations.map((d: any) => [d.email, !!d.verified]), [["owner@gmail.invalid", true], ["pending@gmail.invalid", false]]);
    const added = await call("/api/domains/destinations", "POST", { email: "New@Gmail.invalid" });
    assert.equal(added.status, 201);
    assert.equal(added.body.destination.email, "new@gmail.invalid");
    assert.equal((await call("/api/domains/destinations", "POST", { email: "new@gmail.invalid" })).body.created, false);
    assert.equal((await call("/api/domains/destinations", "POST", { email: "me@base.invalid" })).status, 400);
  } finally { await mf.dispose(); }
});

// ── Audit of mailbox management (spam-and-mailboxes brief, MB-1…MB-4) ──────────

const worker = (name: string) => ({ type: "worker", value: [name] });
const literal = (to: string, action: { type: string; value?: string[] }, enabled = true) =>
  ({ id: `r-${to}`, name: to, enabled, priority: 0, matchers: [{ type: "literal", field: "to", value: to }], actions: [action] });

test("connecting again keeps each address's agent and the catch-all the operator chose, and counts updates as work (finding 1)", async () => {
  const { mf, cf, call, r2, putR2 } = await fixture();
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    const support = await r2(mailboxKey("support@product.invalid"));
    await putR2(mailboxKey("support@product.invalid"), { ...support, agent: { id: "agent-1" } });
    await call("/api/domains/product.invalid/catch-all", "PUT", { mailbox: "support@product.invalid" });
    cf.zone("product.invalid").rules.push(literal("new@product.invalid", { type: "forward", value: ["owner@gmail.invalid"] }));
    const again = await call("/api/domains/product.invalid/connect", "POST", {});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(outcomes(again.body.steps).addresses, "done");
    assert.deepEqual((await r2(mailboxKey("support@product.invalid"))).agent, { id: "agent-1" }, "the agent is kept");
    assert.equal((await r2("config/catch-all.json"))["product.invalid"], "support@product.invalid", "the chosen catch-all is kept");
    assert.equal((await r2(mailboxKey("new@product.invalid"))).agent, "off", "a new address starts Off");
  } finally { await mf.dispose(); }
});

test("release keeps serving when the zone cannot be looked up, and asks before giving up a zone the token cannot see (finding 2)", async () => {
  const lookup = await fixture({ deny: /^GET \/zones$/ });
  try {
    await lookup.putR2("config/domains.json", ["product.invalid"]);
    const r = await lookup.call("/api/domains/product.invalid/release", "POST", {});
    assert.equal(r.status, 502);
    assert.match(r.body.error, /still served here/);
    assert.deepEqual(await lookup.r2("config/domains.json"), ["product.invalid"]);
  } finally { await lookup.mf.dispose(); }
  const { mf, call, r2, putR2 } = await fixture();
  try {
    await putR2("config/domains.json", ["ghost.test"]);
    const ask = await call("/api/domains/ghost.test/release", "POST", {});
    assert.equal(ask.status, 409);
    assert.deepEqual(ask.body.needsConfirmation, { zoneNotVisible: true });
    assert.deepEqual(await r2("config/domains.json"), ["ghost.test"], "nothing changes before the confirmation");
    const forced = await call("/api/domains/ghost.test/release", "POST", { force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.deepEqual(await r2("config/domains.json"), []);
  } finally { await mf.dispose(); }
});

test("rules that send mail to another Worker are left alone by connect and release (finding 3)", async () => {
  const { mf, cf, call, r2 } = await fixture();
  try {
    const z = cf.zone("product.invalid");
    z.rules.push(literal("tickets@product.invalid", worker("ticketing")));
    const connect = await call("/api/domains/product.invalid/connect", "POST", {});
    assert.match(connect.body.steps.find((s: any) => s.id === "addresses").detail, /Left as they are.*tickets@product\.invalid/);
    assert.deepEqual(z.rules.find((r) => r.name === "tickets@product.invalid")!.actions, [worker("ticketing")]);
    assert.equal(await r2(mailboxKey("tickets@product.invalid")), null);
    await call("/api/domains/product.invalid/release", "POST", {});
    assert.deepEqual(z.rules.find((r) => r.name === "tickets@product.invalid")!.actions, [worker("ticketing")]);
  } finally { await mf.dispose(); }
});

test("adding an address: a disabled rule pointing here is switched on; a zone the token cannot see still works; a refused address leaves no rule (findings 5, 6, 9)", async () => {
  const { mf, cf, call } = await fixture({ bindings: { EMAIL_ADDRESSES: "[\"hello@product.invalid\",\"sales@product.invalid\",\"x@base.invalid\"]" } });
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    const z = cf.zone("product.invalid");
    z.rules.push(literal("sales@product.invalid", worker("fabric-inbox"), false));
    const sales = await call("/api/project-addresses", "POST", { localPart: "sales", domain: "product.invalid", createRoute: true });
    assert.equal(sales.status, 201, JSON.stringify(sales.body));
    assert.equal(z.rules.find((r) => r.name === "sales@product.invalid")!.enabled, true);
    const invisible = await call("/api/project-addresses", "POST", { localPart: "x", domain: "base.invalid", createRoute: true });
    assert.equal(invisible.status, 201, JSON.stringify(invisible.body));
    assert.match(invisible.body.warning, /cannot see the zone base\.invalid/);
    const refused = await call("/api/project-addresses", "POST", { localPart: "nope", domain: "product.invalid", createRoute: true });
    assert.equal(refused.status, 403);
    assert.equal(z.rules.some((r) => r.name.includes("nope")), false, "checked before Cloudflare was touched");
  } finally { await mf.dispose(); }
});

test("choosing a catch-all keeps the old forward as a copy, and leaves another Worker's catch-all alone (finding 7)", async () => {
  const { mf, cf, call, r2 } = await fixture();
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    await call("/api/project-addresses", "POST", { localPart: "hello", domain: "product.invalid", createRoute: true });
    const z = cf.zone("product.invalid");
    z.catchAll = { name: "Catch-all", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["boss@gmail.invalid"] }] };
    const set = await call("/api/domains/product.invalid/catch-all", "PUT", { mailbox: "hello@product.invalid" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual((await r2(mailboxKey("hello@product.invalid"))).forwarding, { enabled: true, email: "boss@gmail.invalid" });
    assert.deepEqual(z.catchAll.actions, [worker("fabric-inbox")]);
    z.catchAll = { name: "Catch-all", enabled: true, matchers: [{ type: "all" }], actions: [worker("ticketing")] };
    const other = await call("/api/domains/product.invalid/catch-all", "PUT", { mailbox: "support@product.invalid" });
    assert.equal(other.status, 502);
    assert.match(other.body.error, /Worker ticketing; it was left as it is/);
    assert.deepEqual(z.catchAll.actions, [worker("ticketing")]);
    assert.equal((await r2("config/catch-all.json"))["product.invalid"], "hello@product.invalid", "the stored choice did not change either");
  } finally { await mf.dispose(); }
});

test("a catch-all set by the deployment is shown with its source and guarded like a chosen one (finding 8)", async () => {
  const { mf, call } = await fixture({ bindings: { UNKNOWN_ADDRESS_POLICY: JSON.stringify({ "product.invalid": "catch_all:support@product.invalid" }) } });
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    const list = await call("/api/project-addresses");
    assert.deepEqual(list.body.domains.find((d: any) => d.domain === "product.invalid").catchAll, { mailbox: "support@product.invalid", source: "deployment" });
    const del = await call("/api/project-addresses/support@product.invalid", "DELETE");
    assert.equal(del.status, 409);
    assert.match(del.body.error, /UNKNOWN_ADDRESS_POLICY/);
    assert.equal((await call("/api/domains/product.invalid/catch-all", "PUT", { mailbox: null })).status, 409);
  } finally { await mf.dispose(); }
});

test("the Mailboxes screen creates and removes through the same path: the rule is made and taken away, the catch-all is guarded (MB-1)", async () => {
  const { mf, cf, call, r2 } = await fixture();
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    const made = await call("/api/v1/mailboxes", "POST", { email: "Team@product.invalid", name: "Team" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const z = cf.zone("product.invalid");
    assert.ok(z.rules.some((r) => (r.matchers[0] as any).value === "team@product.invalid"), "its routing rule was made");
    assert.equal((await r2(mailboxKey("team@product.invalid"))).agent, "off");
    assert.deepEqual((await call("/api/v1/mailboxes")).body.find((m: any) => m.email === "team@product.invalid"), { id: "team@product.invalid", email: "team@product.invalid", name: "Team" });
    assert.equal((await call("/api/v1/mailboxes/catch-all@product.invalid", "DELETE")).status, 409, "the catch-all is guarded here too");
    const gone = await call("/api/v1/mailboxes/team@product.invalid", "DELETE");
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.ok(!z.rules.some((r) => (r.matchers[0] as any).value === "team@product.invalid"), "and taken away");
    assert.match(gone.body.afterwards, /catch-all@product\.invalid/);
    assert.equal((await call("/api/v1/mailboxes", "POST", { email: "x@elsewhere.invalid", name: "X" })).status, 400);
  } finally { await mf.dispose(); }
});

test("Settings save only what they edit, merged on the server; a blank name is refused (MB-2)", async () => {
  const { mf, call, r2, putR2 } = await fixture();
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    const before = await r2(mailboxKey("support@product.invalid"));
    await putR2(mailboxKey("support@product.invalid"), { ...before, agent: { id: "agent-1" } });
    const saved = await call("/api/v1/mailboxes/support@product.invalid", "PUT", { settings: { fromName: "Acme support", signature: { enabled: true, text: " — Acme team " }, agentSystemPrompt: "" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const after = await r2(mailboxKey("support@product.invalid"));
    assert.deepEqual([after.fromName, after.signature, after.agent, after.forwarding.email], ["Acme support", { enabled: true, text: "— Acme team" }, { id: "agent-1" }, "owner@gmail.invalid"]);
    assert.equal("agentSystemPrompt" in after, false);
    assert.equal((await call("/api/v1/mailboxes/support@product.invalid", "PUT", { settings: { fromName: " " } })).status, 400);
    assert.equal((await call("/api/v1/mailboxes/support@product.invalid", "PUT", { settings: { agent: "off" } })).status, 400, "nothing else can be written here");
    assert.equal((await call("/api/v1/mailboxes/support@product.invalid")).body.name, "Acme support");
  } finally { await mf.dispose(); }
});

test("an address's forwarding copy can be changed or removed, with the checks creating one has (MB-3)", async () => {
  const { mf, call, r2 } = await fixture();
  try {
    await call("/api/domains/product.invalid/connect", "POST", {});
    assert.equal((await call("/api/project-addresses/support@product.invalid/copy", "PUT", { forwardTo: "pending@gmail.invalid" })).status, 400);
    assert.equal((await call("/api/project-addresses/support@product.invalid/copy", "PUT", { forwardTo: "x@base.invalid" })).status, 400);
    const none = await call("/api/project-addresses/support@product.invalid/copy", "PUT", { forwardTo: null });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual((await r2(mailboxKey("support@product.invalid"))).forwarding, { enabled: false, email: "" });
    const back = await call("/api/project-addresses/support@product.invalid/copy", "PUT", { forwardTo: "owner@gmail.invalid" });
    assert.equal(back.status, 200);
    assert.deepEqual((await r2(mailboxKey("support@product.invalid"))).forwarding, { enabled: true, email: "owner@gmail.invalid" });
    assert.equal((await call("/api/project-addresses/nobody@product.invalid/copy", "PUT", { forwardTo: null })).status, 404);
  } finally { await mf.dispose(); }
});
