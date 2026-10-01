import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * A stateful fake of the Cloudflare API across several accounts (MA-2…MA-9), for
 * tests/cloudflare-accounts.test.ts and tests/cloudflare-relay.test.ts. Each token is account-owned
 * and sees only its own account, as the Observatory door's tokens do; `user-token` sees two, as a
 * token made under My Profile can. Responses use the v4 envelope; refusals use the bodies Cloudflare
 * sends (10000 "Authentication error", 10007 for a missing script, 1004 for the apex `name`).
 */
export const S = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"; // the server's account
export const B = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"; // another account with mail
export const C = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"; // another account without mail
export const D = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"; // an account connected during a test

interface Rule { id: string; name: string; enabled: boolean; priority: number; matchers: unknown[]; actions: { type: string; value?: string[] }[] }
export interface FakeZone {
  id: string; name: string; account: string;
  /** "pending": added to the account but not in use; Cloudflare allows it while the name is active elsewhere. */
  status?: "active" | "pending";
  routing: { enabled: boolean; status: string };
  rules: Rule[];
  catchAll: Omit<Rule, "id" | "priority">;
  dns: { id: string; type: string; name: string; content: string }[];
  sending: { name: string; enabled: boolean }[];
}
export interface FakeScript { bindings: { type: string; name: string; text?: string }[]; module?: string }
export interface ServiceToken { id: string; client_id: string; client_secret: string; name: string; duration: string }

export function fakeCloudflareAccounts() {
  let n = 0;
  const id = () => `id${++n}`;
  const names: Record<string, string> = { [S]: "Personal", [B]: "Studio", [C]: "Archive", [D]: "Later" };
  const tokens: Record<string, string[]> = {
    "server-token": [S], "b-token": [B], "c-token": [C], "d-token": [D], "user-token": [S, B],
  };
  const rule = (to: string, action: Rule["actions"][number], enabled = true): Rule =>
    ({ id: id(), name: to, enabled, priority: 0, matchers: [{ type: "literal", field: "to", value: to }], actions: [action] });
  const off = { name: "Catch-all", enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] };
  const zones: FakeZone[] = [
    { id: "z-base", name: "base.test", account: S, routing: { enabled: true, status: "ready" }, rules: [], catchAll: off,
      dns: [{ id: id(), type: "MX", name: "base.test", content: "route1.mx.cloudflare.net" }], sending: [{ name: "base.test", enabled: true }] },
    { id: "z-apex", name: "apex.invalid", account: S, routing: { enabled: false, status: "unconfigured" }, rules: [], catchAll: off, dns: [], sending: [] },
    { id: "z-studio", name: "studio.invalid", account: B, routing: { enabled: true, status: "ready" },
      rules: [rule("support@studio.invalid", { type: "forward", value: ["owner@gmail.test"] })], catchAll: off,
      dns: [{ id: id(), type: "MX", name: "studio.invalid", content: "route1.mx.cloudflare.net" }], sending: [] },
    { id: "z-studio2", name: "second.invalid", account: B, routing: { enabled: true, status: "ready" },
      rules: [rule("hello@second.invalid", { type: "forward", value: ["owner@gmail.test"] })], catchAll: off,
      dns: [{ id: id(), type: "MX", name: "second.invalid", content: "route1.mx.cloudflare.net" }], sending: [] },
    { id: "z-archive", name: "archive.invalid", account: C, routing: { enabled: false, status: "unconfigured" }, rules: [], catchAll: off, dns: [], sending: [] },
    { id: "z-later", name: "later.invalid", account: D, routing: { enabled: false, status: "unconfigured" }, rules: [], catchAll: off, dns: [], sending: [] },
  ];
  const destinations: Record<string, { id: string; email: string; verified: string | null; status: string }[]> = {
    [S]: [], [B]: [{ id: id(), email: "owner@gmail.test", verified: "2026-01-01T00:00:00Z", status: "verified" }], [C]: [], [D]: [],
  };
  const scripts: Record<string, Record<string, FakeScript>> = { [S]: { "fabric-inbox": { bindings: [] } }, [B]: {}, [C]: {}, [D]: {} };
  const secrets: Record<string, string> = {};
  const serviceTokens: ServiceToken[] = [];
  const app = { id: "app-1", aud: "aud-1", name: "Fabric Inbox", domain: "server.test", policies: [{ id: "owner-policy", precedence: 1 }] };
  const policies: { id: string; name: string; decision: string; include: Record<string, unknown>[] }[] = [
    { id: "owner-policy", name: "Owner", decision: "allow", include: [{ email: { email: "owner@gmail.test" } }] },
  ];
  const sent: { account: string; body: any }[] = [];
  const writes: string[] = [];
  const options = { deny: null as RegExp | null, sendStatus: 200, sendError: "Sender domain is not onboarded", uploadFails: false,
    /** The upload applies, then Cloudflare answers 502: the caller cannot know it worked. */
    uploadAppliesThen502: false, suppressAll: false };

  const ok = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status, headers: { "content-type": "application/json" } });
  const fail = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [] }), { status });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "api.cloudflare.com") return new Response("External network disabled for tests", { status: 503 });
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const sees = tokens[token];
    if (!sees) return fail(401, 1000, "Invalid API Token");
    const path = url.pathname.replace("/client/v4", "");
    const method = request.method;
    if (options.deny?.test(`${method} ${path}`)) return fail(403, 10000, "Authentication error");
    let body: any = null;
    const type = request.headers.get("content-type") ?? "";
    if (method !== "GET" && method !== "DELETE") {
      if (type.startsWith("multipart/form-data")) body = await request.formData();
      else body = await request.json().catch(() => null);
    }
    if (method !== "GET") writes.push(`${method} ${path}`);
    const page = Number(url.searchParams.get("page") ?? 1);
    const paged = <T>(list: T[]) => ok(page > 1 ? [] : list);
    if (path === "/accounts") return paged(sees.map((a) => ({ id: a, name: names[a] })));
    if (path === "/zones") {
      const name = url.searchParams.get("name"), account = url.searchParams.get("account.id"), status = url.searchParams.get("status");
      return paged(zones.filter((z) => sees.includes(z.account) && (!name || z.name === name) && (!account || z.account === account) && (!status || (z.status ?? "active") === status))
        .map((z) => ({ id: z.id, name: z.name, status: z.status ?? "active", account: { id: z.account, name: names[z.account] } })));
    }
    const acct = path.match(/^\/accounts\/([^/]+)(\/.*)$/);
    if (acct) {
      const [, a, rest] = acct;
      if (!sees.includes(a)) return fail(403, 10000, "Authentication error");
      if (rest === "/email/routing/rules") {
        const enabled = url.searchParams.get("enabled") === "true";
        return paged(zones.filter((z) => z.account === a).flatMap((z) => z.rules).filter((r) => !enabled || r.enabled));
      }
      if (rest === "/email/routing/addresses") {
        if (method === "GET") return paged(destinations[a]);
        const d = { id: id(), email: body.email, verified: null, status: "pending" };
        destinations[a].push(d); return ok(d);
      }
      if (rest === "/email/sending/send" && method === "POST") {
        sent.push({ account: a, body });
        const fromDomain = String(typeof body.from === "string" ? body.from : body.from.address).split("@").pop();
        // As Cloudflare: an account sends only from its own active domains (code null, like the spec's 403s).
        if (!zones.some((z) => z.account === a && z.name === fromDomain && (z.status ?? "active") === "active"))
          return new Response(JSON.stringify({ success: false, errors: [{ code: null, message: "email.sending.error.sender_not_configured" }], messages: [] }), { status: 403 });
        if (options.sendStatus !== 200) return fail(options.sendStatus, 2001, options.sendError);
        if (options.suppressAll) return ok({ delivered: [], queued: [], permanent_bounces: [], suppressed_recipients: [].concat(body.to), message_id: `<${id()}@${a}.send>` });
        return ok({ delivered: [].concat(body.to), message_id: `<${id()}@${a}.send>` });
      }
      const script = rest.match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/);
      if (script) {
        const [, name, sub] = script;
        const all = scripts[a];
        if (!sub && method === "PUT") {
          if (options.uploadFails) return fail(400, 10021, "Uncaught SyntaxError");
          const form = body as FormData;
          const metadata = JSON.parse(String(form.get("metadata")));
          const file = form.get(metadata.main_module) as File | null;
          all[name] = { bindings: metadata.bindings, module: file ? await file.text() : undefined };
          if (options.uploadAppliesThen502) return fail(502, 10013, "Bad gateway");
          return ok({ id: name });
        }
        if (!sub && method === "DELETE") { if (!all[name]) return fail(404, 10007, "workers.api.error.script_not_found"); delete all[name]; return ok(null); }
        if (!all[name]) return fail(404, 10007, "workers.api.error.script_not_found");
        // As Cloudflare: plain bindings with their text, secrets by name only.
        if (sub === "/settings") return ok({ bindings: all[name].bindings.map((b) => (b.type === "plain_text" ? { type: b.type, name: b.name, text: b.text } : { type: b.type, name: b.name })) });
        if (sub === "/secrets" && method === "PUT") { secrets[`${a}/${name}/${body.name}`] = body.text; return ok({ name: body.name, type: body.type }); }
        const secret = sub?.match(/^\/secrets\/([^/]+)$/);
        if (secret && method === "DELETE") {
          const key = `${a}/${name}/${secret[1]}`;
          if (!(key in secrets)) return fail(404, 10056, "Secret not found");
          delete secrets[key]; return ok(null);
        }
      }
      if (a === S && rest === "/access/apps") return paged([app]);
      if (a === S && rest === `/access/apps/${app.id}`) {
        if (method === "PUT") app.policies = body.policies;
        return ok(app);
      }
      if (a === S && rest === "/access/policies") {
        if (method === "GET") return paged(policies);
        const p = { id: id(), ...body }; policies.push(p); return ok(p);
      }
      const pol = rest.match(/^\/access\/policies\/([^/]+)$/);
      if (a === S && pol) {
        const i = policies.findIndex((p) => p.id === pol[1]);
        if (method === "PUT") { policies[i] = { ...policies[i], ...body }; return ok(policies[i]); }
        if (method === "DELETE") { policies.splice(i, 1); return ok({ id: pol[1] }); }
      }
      if (a === S && rest === "/access/service_tokens" && method === "POST") {
        const t = { id: id(), client_id: `client-${n}.access`, client_secret: `secret-${n}`, name: body.name, duration: body.duration };
        serviceTokens.push(t); return ok(t);
      }
      const st = rest.match(/^\/access\/service_tokens\/([^/]+)$/);
      if (a === S && st && method === "DELETE") {
        const i = serviceTokens.findIndex((t) => t.id === st[1]);
        if (i < 0) return fail(404, 12130, "service token not found");
        serviceTokens.splice(i, 1); return ok({ id: st[1] });
      }
      return fail(404, 1003, `Fake has no ${method} ${path}`);
    }
    const m = path.match(/^\/zones\/([^/]+)(\/.*)$/);
    const zone = zones.find((z) => z.id === m?.[1]);
    if (!zone || !m || !sees.includes(zone.account)) return fail(404, 1001, "Not found");
    const rest = m[2];
    if (rest === "/email/routing") return ok({ enabled: zone.routing.enabled, status: zone.routing.status, name: zone.name });
    if (rest === "/email/routing/dns" && method === "POST") {
      if (body?.name !== undefined && !String(body.name).endsWith("." + zone.name))
        return fail(400, 1004, `Invalid Input: must be a subdomains of ${zone.name}`);
      zone.routing = { enabled: true, status: "ready" };
      zone.dns.push({ id: id(), type: "MX", name: zone.name, content: "route1.mx.cloudflare.net" });
      return ok([]);
    }
    if (rest === "/email/routing/rules" && method === "GET") return paged(zone.rules);
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
      const t = url.searchParams.get("type"); const name = url.searchParams.get("name");
      return paged(zone.dns.filter((x) => (!t || x.type === t) && (!name || x.name === name)));
    }
    return fail(404, 1003, `Fake has no ${method} ${path}`);
  }
  return {
    /** A token as long as a real one (the connect form checks the length) that sees what `as` sees. */
    alias: (token: string, as: string) => { tokens[token] = tokens[as]; },
    /** The token stops working at Cloudflare (revoked or deleted). */
    revoke: (token: string) => { delete tokens[token]; },
    handle, zones, destinations, scripts, secrets, serviceTokens, policies, app, sent, writes, options,
    zone: (name: string) => zones.find((z) => z.name === name)!,
  };
}


/**
 * The server's routes in workerd against the fake. `x-test-common-name` stands in for what Access
 * puts in its JWT for a service token (the relay's Client ID); nothing else sets an identity.
 */
const serverBundle = build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { MailboxDO } from './workers/durableObject/index';
      import { domainsRouter } from './workers/routes/domains';
      import { cloudflareAccountsRouter } from './workers/routes/cloudflare-accounts';
      import { agentsRouter } from './workers/routes/agents';
      import { handleRelayIncoming, handleRelayForwarded } from './workers/relay/ingress';
      import { app as mailApp } from './workers/index';
      export { EmailMCP } from './workers/mcp/ledger';
      const forbidden = () => { throw new Error('The send_email binding and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        // The binding refuses as it does for a domain outside the server's account.
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send: async () => { throw Object.assign(new Error('Sender domain not available to this binding (test)'), { code: 'E_SENDER_DOMAIN_NOT_AVAILABLE' }); }}}); }
      }
      const claims = (c) => { const n = c.req.header('x-test-common-name'); return n ? { common_name: n } : null; };
      const app = new Hono();
      app.get('/r2', async (c) => { const o = await c.env.BUCKET.get(c.req.query('key')); return new Response(o ? await o.text() : 'null'); });
      app.put('/r2put', async (c) => { await c.env.BUCKET.put(c.req.query('key'), await c.req.text()); return c.json({ ok: true }); });
      app.get('/owed', async (c) => Response.json(await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(c.req.query('mailbox'))).forwardOwed(c.req.query('id'))));
      app.get('/inbox', async (c) => { const box = c.env.MAILBOX.getByName(c.req.query('mailbox')); return Response.json(await box.getEmails({ folder: 'inbox' })); });
      app.all('/relay/incoming', (c) => handleRelayIncoming(c.req.raw, c.env, c.executionCtx, claims(c)));
      app.all('/relay/forwarded', (c) => handleRelayForwarded(c.req.raw, c.env, claims(c)));
      app.route('/', domainsRouter);
      app.route('/', cloudflareAccountsRouter);
      app.route('/', agentsRouter);
      app.route('/', mailApp);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

export async function serverFixture(cf: ReturnType<typeof fakeCloudflareAccounts>, bindings: Record<string, string>) {
  const mf = new Miniflare({
    modules: true, script: (await serverBundle).outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true }, EMAIL_MCP: { className: "EmailMCP", useSQLite: true } }, r2Buckets: ["BUCKET"],
    bindings: { DOMAINS: "base.test", POLICY_AUD: "aud-1", ...bindings },
    outboundService: (request) => cf.handle(request),
  });
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await mf.dispatchFetch("https://server.test" + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed };
  };
  const r2 = async (key: string) => JSON.parse(await (await mf.dispatchFetch("https://server.test/r2?key=" + encodeURIComponent(key))).text());
  return { mf, call, r2 };
}
