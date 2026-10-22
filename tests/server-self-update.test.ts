import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { version } from "../package.json";
import { compareVersions, pendingMigrations, checkManifest } from "../workers/lib/self-update";

/**
 * B-44: the server updates itself from the bundle the person's app sends, with its own token, in
 * workerd against a fake Cloudflare that records what was uploaded.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { serverUpdateRouter } from './workers/routes/server-update';
      const app = new Hono();
      app.route('/', serverUpdateRouter);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

const ACCOUNT = "acc-test";
const next = (v: string) => { const [a, b] = v.split("-")[0]!.split(".").map(Number); return `${a}.${(b ?? 0) + 1}.0`; };

function fakeCloudflare(options: { deny?: RegExp; buckets?: string[][]; tag?: string | null } = {}) {
  const writes: string[] = [];
  let put: { metadata: any; modules: Record<string, string> } | null = null;
  const uploaded: Record<string, string> = {};
  const accessApp: Record<string, unknown> = { id: "app-1", uid: "u", aud: "aud-1", name: "Fabric Inbox", domain: "mail.example.invalid", type: "self_hosted",
    session_duration: "720h", created_at: "x", updated_at: "y", policies: [{ id: "p1" }] };
  let accessPut: any = null;
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { headers: { "content-type": "application/json" } });
  const fail = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "api.cloudflare.com") return new Response("no network", { status: 503 });
    const path = url.pathname.replace("/client/v4", "");
    const auth = request.headers.get("authorization");
    if (options.deny?.test(`${request.method} ${path}`)) return fail(403, 10000, "Authentication error");
    if (request.method !== "GET") writes.push(`${request.method} ${path}`);
    const a = `/accounts/${ACCOUNT}`;
    if (path === `${a}/workers/assets/upload`) {
      if (auth !== "Bearer session-jwt") return fail(401, 10000, "Authentication error");
      const form = await request.formData();
      for (const [k, v] of form) uploaded[k] = await (v as File).text();
      return ok({ jwt: "completion-jwt" });
    }
    if (auth !== "Bearer server-token") return fail(401, 10000, "Authentication error");
    if (path === `${a}/access/apps` && request.method === "GET") return ok(url.searchParams.get("page") === "1" ? [{ ...accessApp }] : []);
    if (path === `${a}/access/apps/app-1` && request.method === "PUT") { accessPut = await request.json(); Object.assign(accessApp, accessPut); return ok(accessApp); }
    if (path === "/accounts") return ok(url.searchParams.get("page") === "1" ? [{ id: ACCOUNT, name: "Owner" }] : []);
    if (path === `${a}/workers/scripts`) return ok(url.searchParams.get("page") === "1" ? [{ id: "fabric-inbox", ...(options.tag === null ? {} : { migration_tag: options.tag ?? "v1" }) }] : []);
    if (path === `${a}/workers/scripts/fabric-inbox/settings`) return ok({ bindings: [{ type: "r2_bucket", name: "BUCKET", bucket_name: "owner-mail" }, { type: "secret_text", name: "CLOUDFLARE_API_TOKEN" }] });
    if (path === `${a}/workers/scripts/fabric-inbox/assets-upload-session`) return ok({ jwt: "session-jwt", buckets: options.buckets ?? [["hash-a"]] });
    if (path === `${a}/workers/scripts/fabric-inbox` && request.method === "PUT") {
      const form = await request.formData();
      const modules: Record<string, string> = {};
      for (const [k, v] of form) if (k !== "metadata") modules[k] = await (v as File).text();
      put = { metadata: JSON.parse(String(form.get("metadata"))), modules };
      return ok({ id: "fabric-inbox" });
    }
    return fail(404, 1003, `Fake has no ${request.method} ${path}`);
  }
  return { handle, writes, uploaded, accessApp, get put() { return put; }, get accessPut() { return accessPut; } };
}

function manifest(over: Record<string, unknown> = {}) {
  return {
    format: "fabric-inbox-server/1", version: next(version), revision: "abc",
    worker: { main_module: "index.js", compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"], observability: { enabled: true } },
    modules: [{ name: "index.js", file: "worker/index.js" }, { name: "assets/chunk.js", file: "worker/assets/chunk.js" }],
    durableObjects: [{ name: "MAILBOX", class_name: "MailboxDO" }],
    migrations: [{ tag: "v1", new_sqlite_classes: ["MailboxDO"] }, { tag: "v2", new_sqlite_classes: ["KnowledgeDO"] }],
    r2Buckets: [{ binding: "BUCKET", bucket_name: "fabric-inbox" }],
    sendEmail: [{ name: "EMAIL" }], ai: { binding: "AI" },
    assets: { config: { not_found_handling: "single-page-application" }, files: { "/app.css": { hash: "hash-a", size: 4, contentType: "text/css" }, "/b.js": { hash: "hash-b", size: 2, contentType: "text/javascript" } } },
    ...over,
  };
}

async function fixture(options: Parameters<typeof fakeCloudflare>[0] & { bindings?: Record<string, string> } = {}) {
  const cf = fakeCloudflare(options);
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    bindings: options.bindings ?? { CLOUDFLARE_API_TOKEN: "server-token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    outboundService: (request) => cf.handle(request),
  });
  const send = async (m: unknown, parts: Record<string, string> = { "module:index.js": "export default {}", "module:assets/chunk.js": "export const x = 1", "asset:hash-a": "body", "asset:hash-b": "js" }) => {
    const form = new FormData();
    form.set("manifest", typeof m === "string" ? m : JSON.stringify(m));
    for (const [k, v] of Object.entries(parts)) form.set(k, new File([v], k));
    const encoded = new Response(form);
    const r = await mf.dispatchFetch("http://localhost/api/server/self-update", { method: "POST", body: new Uint8Array(await encoded.arrayBuffer()),
      headers: { "content-type": encoded.headers.get("content-type")! } });
    return { status: r.status, body: await r.json() as any };
  };
  return { mf, cf, send };
}

test("B-44: versions compare as the app's deploy does, and storage steps run from the server's tag", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.27.0-rc.1", "0.27.0") < 0);
  assert.equal(compareVersions("0.26.0", "0.26.0"), 0);
  const m = checkManifest(manifest(), "0.1.0");
  assert.deepEqual(pendingMigrations(m, "v1"), { old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["KnowledgeDO"] }] });
  assert.equal(pendingMigrations(m, "v2"), null);
  assert.deepEqual(pendingMigrations(m, null)?.new_tag, "v2");
  assert.throws(() => pendingMigrations(m, "v9"), /not in this bundle/);
});

test("B-44: GET /api/server names the version and whether it can update itself", async () => {
  const { mf } = await fixture();
  const without = await fixture({ bindings: {} });
  try {
    const r = await (await mf.dispatchFetch("http://localhost/api/server")).json() as any;
    assert.deepEqual(r, { version, selfUpdate: { available: true } });
    const w = await (await without.mf.dispatchFetch("http://localhost/api/server")).json() as any;
    assert.equal(w.selfUpdate.available, false);
    assert.match(w.selfUpdate.reason, /no Cloudflare token/);
  } finally { await mf.dispose(); await without.mf.dispose(); }
});

test("B-44: a newer bundle is uploaded with the server's own token, keeping its bucket, settings and secrets", async () => {
  const { mf, cf, send } = await fixture();
  try {
    const r = await send(manifest());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Without POLICY_AUD (a server without Access) there is no application to change.
    assert.deepEqual(r.body, { updated: true, from: version, to: next(version), accessHeader: "no_app" });
    assert.deepEqual(cf.uploaded, { "hash-a": Buffer.from("body").toString("base64") }, "only the file Cloudflare asked for, base64 as the API wants");
    const meta = cf.put!.metadata;
    assert.deepEqual(meta.keep_bindings, ["secret_text", "secret_key", "plain_text", "json"]);
    assert.equal(meta.assets.jwt, "completion-jwt");
    assert.deepEqual(meta.migrations, { old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["KnowledgeDO"] }] });
    assert.deepEqual(meta.bindings.find((b: any) => b.type === "r2_bucket"), { type: "r2_bucket", name: "BUCKET", bucket_name: "owner-mail" });
    assert.deepEqual(meta.bindings.find((b: any) => b.name === "FABRIC_SERVER_VERSION"), { type: "plain_text", name: "FABRIC_SERVER_VERSION", text: next(version) });
    assert.ok(!meta.bindings.some((b: any) => b.type === "secret_text" || b.name === "DOMAINS"), "secrets and DOMAINS stay as the running server has them");
    assert.deepEqual(Object.keys(cf.put!.modules).sort(), ["assets/chunk.js", "index.js"]);
  } finally { await mf.dispose(); }
});

test("B-44: an older or equal bundle, a bad body, a missing module and a storage step that deletes are refused before Cloudflare is written", async () => {
  const { mf, cf, send } = await fixture();
  try {
    assert.equal((await send(manifest({ version }))).status, 409);
    assert.equal((await send(manifest({ version: "0.0.1" }))).body.code, "refused");
    assert.equal((await send("not json")).status, 400);
    assert.equal((await send({ format: "other" })).status, 400);
    const unsafe = await send(manifest({ migrations: [{ tag: "v1", new_sqlite_classes: ["A"] }, { tag: "v2", deleted_classes: ["A"] }] }));
    assert.equal(unsafe.status, 400);
    assert.match(unsafe.body.error, /delete or move/);
    const missing = await send(manifest(), { "module:index.js": "x", "asset:hash-a": "body" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /assets\/chunk\.js/);
    assert.deepEqual(cf.writes, [], "nothing was written to Cloudflare");
    const raw = await mf.dispatchFetch("http://localhost/api/server/self-update", { method: "POST", body: "plain", headers: { "content-type": "text/plain" } });
    assert.equal(raw.status, 400);
  } finally { await mf.dispose(); }
});

test("B-44: a token without Workers Scripts is named; a server without a token says to use the app's token", async () => {
  const denied = await fixture({ deny: /assets-upload-session$/ });
  const bare = await fixture({ bindings: {} });
  try {
    const r = await denied.send(manifest());
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "permission");
    assert.match(r.body.error, /Workers Scripts: Edit/);
    assert.equal(denied.cf.put, null);
    const b = await bare.send(manifest());
    assert.deepEqual([b.status, b.body.code], [409, "not_configured"]);
  } finally { await denied.mf.dispose(); await bare.mf.dispose(); }
});

test("B-44: a server deployed with wrangler (no CLOUDFLARE_ACCOUNT_ID) finds its account from its token and updates itself", async () => {
  const { mf, cf, send } = await fixture({ bindings: { CLOUDFLARE_API_TOKEN: "server-token" } });
  try {
    const r = await (await mf.dispatchFetch("http://localhost/api/server")).json() as any;
    assert.deepEqual(r.selfUpdate, { available: true });
    const u = await send(manifest());
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.ok(cf.put, "uploaded into the account the token showed");
  } finally { await mf.dispose(); }
});

test("B-148: an update lets agent keys in one header on the server's own Access application, once, keeping its other fields", async () => {
  const { mf, cf, send } = await fixture({ bindings: { CLOUDFLARE_API_TOKEN: "server-token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, POLICY_AUD: "aud-1" } });
  try {
    const r = await send(manifest());
    assert.equal(r.body.accessHeader, "set");
    assert.equal(cf.accessPut.read_service_tokens_from_header, "Authorization");
    assert.deepEqual([cf.accessPut.name, cf.accessPut.domain, cf.accessPut.session_duration], ["Fabric Inbox", "mail.example.invalid", "720h"]);
    for (const k of ["id", "uid", "aud", "created_at", "updated_at", "policies"]) assert.ok(!(k in cf.accessPut), k);
    const { ensureAccessHeader } = await import("../workers/lib/self-update");
    assert.equal(await ensureAccessHeader({ list: async () => [{ id: "x", aud: "aud-1", read_service_tokens_from_header: "Authorization" }] } as never, ACCOUNT, "aud-1"), "already");
    assert.match(await ensureAccessHeader({ list: async () => { throw new Error("refused"); } } as never, ACCOUNT, "aud-1"), /^failed: refused/);
    assert.equal(await ensureAccessHeader({ list: async () => [{ id: "x", aud: "other" }] } as never, ACCOUNT, "aud-1"), "no_app");
  } finally { await mf.dispose(); }
});
