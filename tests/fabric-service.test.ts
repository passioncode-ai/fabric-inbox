import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { version } from "../package.json";
import { usageReport, providerOf, crossSite } from "../workers/routes/fabric-service";
import { identityMayUse } from "../workers/mcp/keys";

/**
 * B-87 part 4: Fabric Inbox as a fabric-service/0.1 service in the remote placement. The answers are
 * checked against the contract's own schemas (tests/fixtures/fabric-contract, pinned in its README).
 */
const dir = new URL("./fixtures/fabric-contract/", import.meta.url);
const ajv = new (Ajv2020 as unknown as typeof import("ajv").default)({ allErrors: true, strict: false });
(addFormats as unknown as (a: unknown) => void)(ajv);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) ajv.addSchema(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
const validate = (name: string, value: unknown) => {
  const v = ajv.getSchema(`https://fabric.passioncode.ai/agent-contract/0.1.0/schemas/${name}.schema.json`)!;
  assert.ok(v(value), `${name}: ${JSON.stringify(v.errors)}`);
};

const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { fabricServiceRouter } from './workers/routes/fabric-service';
      const app = new Hono();
      // Stands in for workers/app.ts: Access verified, its claims set from a test header.
      app.use('*', async (c, next) => { const h = c.req.header('x-test-claims'); if (h) c.set('access', JSON.parse(h)); await next(); });
      app.put('/r2', async (c) => { await c.env.BUCKET.put(c.req.query('key'), await c.req.text()); return c.json({ ok: true }); });
      app.route('/', fabricServiceRouter);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture(bindings: Record<string, string> = {}) {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["BUCKET"], bindings: { POLICY_AUD: "aud", TEAM_DOMAIN: "https://team.example.invalid", ...bindings },
  });
  await mf.dispatchFetch("http://localhost/r2?key=config/agent-keys.json", { method: "PUT",
    body: JSON.stringify({ keys: [{ id: "k1", clientId: "known.access", name: "Fabric Dashboards", level: "read", send: "none", dailySendLimit: null, createdAt: "2026-10-22T00:00:00Z", expiresAt: null }] }) });
  const get = async (path: string, claims?: Record<string, string>, extra: Record<string, string> = {}) => {
    const r = await mf.dispatchFetch("http://localhost" + path, { headers: { ...(claims ? { "x-test-claims": JSON.stringify(claims) } : {}), ...extra } });
    return { status: r.status, text: await r.text() };
  };
  return { mf, get };
}

test("B-87: a registered agent key or a person reads the well-known document; anyone else gets 401 with no body", async () => {
  const { mf, get } = await fixture({ CLOUDFLARE_API_TOKEN: "t", OPENROUTER_API_KEY: "k" });
  try {
    for (const claims of [undefined, { common_name: "other-app.access" }]) {
      const r = await get("/.well-known/fabric-service", claims);
      assert.deepEqual([r.status, r.text], [401, ""]);
    }
    const key = await get("/.well-known/fabric-service", { common_name: "known.access" });
    assert.equal(key.status, 200);
    const doc = JSON.parse(key.text);
    validate("service-well-known", doc);
    assert.deepEqual(doc.service.id, "fabric-inbox");
    assert.equal(doc.service.version, version);
    // The token and the model key are set; only the agent registry is absent in this fixture.
    assert.equal(doc.status, "degraded");
    assert.deepEqual(doc.degraded.map((d: any) => d.source), ["agents"]);
    assert.deepEqual(doc.surfaces.events, { path: "/fabric/v1/events" });
    assert.deepEqual(doc.surfaces.usage, { path: "/fabric/v1/usage" });
    // DEC-0061: with an OpenRouter key the reply agents' calls are signed in with an issued key.
    assert.deepEqual(doc.extensions["https://passioncode.ai/fabric-inbox/runner"], { credentialKind: "key" });
    assert.ok(doc.service.build.commit || doc.service.build.digest);
    assert.equal((await get("/.well-known/fabric-service", { email: "owner@owner.example" })).status, 200);
    assert.equal((await get("/fabric/v1/usage", { common_name: "other-app.access" })).status, 401);
    assert.equal((await get("/fabric/v1/events")).status, 401);
  } finally { await mf.dispose(); }
});

test("B-87: what does not work is named in degraded, a missing setup marked as setup", async () => {
  const { mf, get } = await fixture();
  try {
    const doc = JSON.parse((await get("/.well-known/fabric-service", { common_name: "known.access" })).text);
    validate("service-well-known", doc);
    assert.equal(doc.status, "degraded");
    assert.deepEqual(doc.degraded.map((d: any) => [d.source, d.setup === true]), [["cloudflare", true], ["agents", false], ["models", true]]);
    // Without one they still answer, on the deployment's own Workers AI: platform-metered, and unchecked.
    assert.match(doc.degraded[2].reason, /Workers AI/);
    assert.deepEqual(doc.extensions["https://passioncode.ai/fabric-inbox/runner"], { credentialKind: "platform-metered" });
    // Without agents the events page is empty and keeps the cursor it was given.
    const events = JSON.parse((await get("/fabric/v1/events?after=41", { common_name: "known.access" })).text);
    validate("service-events-page", events);
    assert.deepEqual(events, { events: [], cursor: "41" });
    const usage = JSON.parse((await get("/fabric/v1/usage", { common_name: "known.access" })).text);
    validate("service-usage", usage);
    assert.deepEqual(usage.days, []);
  } finally { await mf.dispose(); }
});

test("B-87: a run without receipts is counted per day and model, unpriced and unmeasured, never 0 USD", () => {
  const row = (day: string, model: string, calls: number) => ({ day, model, calls, unpricedCalls: calls, unmeasuredCalls: calls, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const report = usageReport([row("2026-10-21", "xiaomi/mimo-v2.6-pro", 3), row("2026-10-21", "deepseek/deepseek-v4.1-flash", 1),
    row("2026-10-22", "@cf/meta/llama", 2), row("2026-10-22", "unknown", 0)], "default", new Date("2026-10-22T12:00:00Z"));
  validate("service-usage", report);
  assert.deepEqual(report.days.map((d) => [d.date, d.calls, d.unpricedCalls, d.unmeasuredCalls, d.costUsd]), [["2026-10-21", 4, 4, 4, null], ["2026-10-22", 2, 2, 2, null]]);
  assert.deepEqual(report.days[1]!.byModel.map((m) => [m.provider, m.route, m.costBasis]), [["workers-ai", "platform-metered", "unknown"]]);
  assert.deepEqual(providerOf("qwen/qwen3.8-flash"), { provider: "openrouter", route: "key" });
  const priced = usageReport([{ day: "2026-10-22", model: "x/a", calls: 2, unpricedCalls: 0, unmeasuredCalls: 0, inputTokens: 10, outputTokens: 2, costUsd: 0.01 }], "default");
  validate("service-usage", priced);
});

test("B-87: an agent key reaches the three fabric-service reads besides /mcp, and nothing else of the app", () => {
  const key = { common_name: "known.access" };
  for (const p of ["/.well-known/fabric-service", "/fabric/v1/events", "/fabric/v1/usage", "/mcp"]) assert.equal(identityMayUse(key, p), true, p);
  for (const p of ["/api/inbox", "/fabric/v1/login-code", "/settings"]) assert.equal(identityMayUse(key, p), false, p);
});

test("B-87: the registration writes the remote descriptor the contract accepts and a 0600 token file, the key from stdin only", async () => {
  const { mkdtempSync, statSync, readFileSync: read } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { register, tokenFromKey, descriptorFor } = await import("../scripts/register-fabric-service.mjs");
  const root = mkdtempSync(path.join(os.tmpdir(), "fi-register-"));
  const env = { FABRIC_SERVICES_DIR: path.join(root, "services") };
  const out = register({ origin: "https://mail.example.invalid", key: JSON.stringify({ key: { clientId: "abc.access" }, clientSecret: "s".repeat(32) }), env, version: "0.28.0" });
  const descriptor = JSON.parse(read(out.descriptor, "utf8"));
  validate("service-descriptor", descriptor);
  assert.deepEqual([descriptor.placement, descriptor.origin, descriptor.auth.header, descriptor.auth.scheme], ["remote", "https://mail.example.invalid", "Authorization", "none"]);
  assert.deepEqual(JSON.parse(read(out.tokenFile, "utf8")), { "cf-access-client-id": "abc.access", "cf-access-client-secret": "s".repeat(32) });
  for (const f of [out.descriptor, out.tokenFile]) assert.equal(statSync(f).mode & 0o777, 0o600, f);
  assert.ok(!JSON.stringify(descriptor).includes("s".repeat(32)), "the secret is only in the token file");
  assert.throws(() => tokenFromKey("{}"), /clientId/);
  for (const origin of ["http://mail.example.invalid", "https://mail.example.invalid/app", "https://10.0.0.1"]) assert.throws(() => descriptorFor({ origin, tokenFile: "/t", version: "1" }), /origin/);
});

test("B-87 part 5: the descriptor names the server's runner, and an offered server its peer, as the contract accepts", async () => {
  const { descriptorFor, runnerFrom, peerFor, readWellKnown, RUNNER_EXTENSION } = await import("../scripts/register-fabric-service.mjs");
  const origin = "https://mail.example.com";
  const runner = runnerFrom({ extensions: { [RUNNER_EXTENSION]: { credentialKind: "platform-metered" } } });
  const peer = peerFor({ origin, custody: "organization-managed", residency: "DE, EU,DE", maxDataClass: "confidential" });
  assert.deepEqual(peer, { endpoint: "https://mail.example.com/mcp", custody: "organization-managed", residency: ["DE", "EU"], maxDataClass: "confidential" });
  const descriptor = descriptorFor({ origin, tokenFile: "/t", version: "0.29.2", runner, peer });
  validate("service-descriptor", descriptor);
  assert.deepEqual(descriptor.runner, { credentialKind: "platform-metered" });
  validate("service-descriptor", descriptorFor({ origin, tokenFile: "/t", version: "0.29.2", runner: { credentialKind: "key" } }));
  // A server before 0.29.2 names no runner: its descriptor stays as before, and it cannot be offered.
  assert.equal(runnerFrom({ extensions: {} }), null);
  assert.equal("runner" in descriptorFor({ origin, tokenFile: "/t", version: "1" }), false);
  assert.throws(() => descriptorFor({ origin, tokenFile: "/t", version: "1", peer }), /runner/);
  assert.throws(() => runnerFrom({ extensions: { [RUNNER_EXTENSION]: { credentialKind: "subscription" } } }), /unknown credential kind/);
  for (const bad of [{ custody: "mine" }, { maxDataClass: "Confidential" }, { residency: "" }, { residency: "de" }, { residency: "XA" }, { residency: "QM,DE" }])
    assert.throws(() => peerFor({ origin, custody: "personal", residency: "DE", maxDataClass: "internal", ...bad }), /--/);
  // The well-known document is read with the descriptor's own one-header key, never a query string.
  let seen: any;
  const doc = await readWellKnown(`${origin}/`, "{\"cf-access-client-id\":\"a.access\"}", async (url: string, init: any) => {
    seen = { url, init };
    return new Response(JSON.stringify({ extensions: {} }), { status: 200 });
  });
  assert.deepEqual(doc, { extensions: {} });
  assert.equal(seen.url, "https://mail.example.com/.well-known/fabric-service");
  assert.equal(seen.init.headers.Authorization, "{\"cf-access-client-id\":\"a.access\"}");
  await assert.rejects(readWellKnown(origin, "x", async () => new Response("", { status: 401 })), /HTTP 401/);
});

test("B-87: a request from another site or origin is refused with 403 on all three routes, even with a key", async () => {
  const { mf, get } = await fixture({ CLOUDFLARE_API_TOKEN: "t", OPENROUTER_API_KEY: "k" });
  const key = { common_name: "known.access" };
  try {
    for (const p of ["/.well-known/fabric-service", "/fabric/v1/events", "/fabric/v1/usage"]) {
      assert.equal((await get(p, key, { Origin: "https://evil.example" })).status, 403, p);
      assert.equal((await get(p, key, { "Sec-Fetch-Site": "cross-site" })).status, 403, p);
      // The server's own pages and a host (no Origin) still read it.
      assert.equal((await get(p, key, { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" })).status, 200, p);
      assert.equal((await get(p, key)).status, 200, p);
    }
  } finally { await mf.dispose(); }
  assert.equal(crossSite("https://a.example/x", "https://a.example", "same-origin"), null);
  assert.match(crossSite("https://a.example/x", "https://a.example:8443", undefined)!, /origin/);
});
