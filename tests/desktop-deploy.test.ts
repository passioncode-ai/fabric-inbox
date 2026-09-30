import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetHash, buildServerBundle } from "../scripts/server-bundle.mjs";
import { TOKEN_PERMISSIONS } from "../workers/routing/cloudflare-api";

const require = createRequire(import.meta.url);
const deployer = require("../desktop/cloudflare-deploy.cjs");
const TOKEN = "tok_" + "x".repeat(36);

/** A tiny build as react-router + the Cloudflare plugin would leave it. */
function fixtureBundle() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fabric-bundle-"));
  mkdirSync(path.join(dir, "build/server/assets"), { recursive: true });
  mkdirSync(path.join(dir, "build/client/assets"), { recursive: true });
  writeFileSync(path.join(dir, "build/server/index.js"), "import './assets/chunk.js'; export default { fetch() { return new Response('ok'); } };");
  writeFileSync(path.join(dir, "build/server/assets/chunk.js"), "export const x = 1;");
  writeFileSync(path.join(dir, "build/server/assets/style.css"), "body{}");
  writeFileSync(path.join(dir, "build/client/assets/app.js"), "console.log(1)");
  writeFileSync(path.join(dir, "build/client/favicon.svg"), "<svg/>");
  writeFileSync(path.join(dir, "build/client/.assetsignore"), "wrangler.json");
  writeFileSync(path.join(dir, "build/server/wrangler.json"), JSON.stringify({
    name: "fabric-inbox", main: "index.js", no_bundle: true, account_id: "owner-account", compatibility_date: "2025-11-28",
    compatibility_flags: ["nodejs_compat"], vars: { POLICY_AUD: "owner-aud", DOMAINS: "owner.example" },
    durable_objects: { bindings: [{ name: "MAILBOX", class_name: "MailboxDO" }, { name: "AGENTS", class_name: "AgentRegistryDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["MailboxDO"] }, { tag: "v2", new_sqlite_classes: ["AgentRegistryDO"] }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: "fabric-inbox" }], send_email: [{ name: "EMAIL", remote: false }], ai: { binding: "AI" },
    assets: { directory: "../client" }, observability: { enabled: true },
  }));
  const out = path.join(dir, "bundle");
  const manifest = buildServerBundle({ buildDir: path.join(dir, "build"), outDir: out, version: "9.9.9", revision: "abc" });
  return { out, manifest };
}

interface FakeOptions { subdomain?: string | null; org?: string | null; script?: { migration_tag: string; domains?: string; vars?: Record<string, string> } | null; deny?: RegExp; r2Disabled?: boolean }

function fakeCloudflare(o: FakeOptions = {}) {
  const state = {
    subdomain: o.subdomain ?? null as string | null, org: o.org ?? null as string | null, bucket: false,
    idps: [] as { type: string }[], apps: [] as { domain: string; aud: string }[],
    script: o.script ?? null as FakeOptions["script"], uploads: [] as Record<string, string>[], put: null as null | { metadata: any; parts: Record<string, { type: string; text: string }> },
    workersDev: false,
  };
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const fail = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
  const fetchImpl = async (url: string, init: { method?: string; headers: Record<string, string>; body?: any }) => {
    const u = new URL(url);
    const route = u.pathname.replace("/client/v4", "");
    const method = init.method ?? "GET";
    if (o.deny?.test(`${method} ${route}`)) return fail(403, 10000, "Authentication error");
    const auth = init.headers.Authorization;
    if (route === "/accounts/acc/workers/assets/upload") {
      if (auth !== "Bearer upload-jwt") return fail(401, 10000, "bad jwt");
      const form = init.body as FormData; const got: Record<string, string> = {};
      for (const [k, v] of form.entries()) got[k] = await (v as File).text();
      state.uploads.push(got);
      return ok({ jwt: "completion-jwt" });
    }
    if (auth !== `Bearer ${TOKEN}`) return fail(403, 9109, "Invalid access token");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const page = Number(u.searchParams.get("page") ?? 1);
    const paged = (list: unknown[]) => ok(page > 1 ? [] : list);
    switch (`${method} ${route}`) {
      case "GET /accounts": return paged([{ id: "acc", name: "Someone's account" }]);
      case "GET /accounts/acc/workers/subdomain": return state.subdomain ? ok({ subdomain: state.subdomain }) : fail(404, 10007, "no subdomain");
      case "PUT /accounts/acc/workers/subdomain": state.subdomain = body.subdomain; return ok({ subdomain: body.subdomain });
      case "GET /accounts/acc/r2/buckets/fabric-inbox": return state.bucket ? ok({ name: "fabric-inbox" }) : fail(404, 10006, "The specified bucket does not exist.");
      case "POST /accounts/acc/r2/buckets": if (o.r2Disabled) return fail(403, 10042, "Please enable R2 through the Cloudflare Dashboard."); state.bucket = true; return ok({ name: body.name });
      case "GET /accounts/acc/access/organizations": return state.org ? ok({ auth_domain: state.org }) : fail(404, 12130, "access.api.error.not_found");
      case "POST /accounts/acc/access/organizations": state.org = body.auth_domain; return ok({ auth_domain: body.auth_domain });
      case "GET /accounts/acc/access/identity_providers": return paged(state.idps);
      case "POST /accounts/acc/access/identity_providers": state.idps.push({ type: body.type }); return ok(body);
      case "GET /accounts/acc/access/apps": return paged(state.apps);
      case "POST /accounts/acc/access/apps": { const app = { ...body, aud: "new-aud" }; state.apps.push(app); return ok(app); }
      case "POST /accounts/acc/workers/scripts/fabric-inbox/assets-upload-session": {
        const known = state.uploads.flatMap((u) => Object.keys(u));
        const missing = Object.values(body.manifest as Record<string, { hash: string }>).map((f) => f.hash).filter((h) => !known.includes(h));
        return ok({ jwt: missing.length ? "upload-jwt" : "completion-jwt", buckets: missing.length ? [missing] : [] });
      }
      case "GET /accounts/acc/workers/scripts": return paged(state.script ? [{ id: "fabric-inbox", migration_tag: state.script.migration_tag }] : []);
      case "GET /accounts/acc/workers/scripts/fabric-inbox/settings":
        return ok({ bindings: [{ type: "plain_text", name: "DOMAINS", text: state.script?.domains ?? "" },
          ...Object.entries(state.script?.vars ?? {}).map(([name, text]) => ({ type: "plain_text", name, text }))] });
      case "PUT /accounts/acc/workers/scripts/fabric-inbox": {
        const form = init.body as FormData; const parts: Record<string, { type: string; text: string }> = {};
        for (const [k, v] of form.entries()) if (k !== "metadata") parts[k] = { type: (v as File).type, text: await (v as File).text() };
        const metadata = JSON.parse(form.get("metadata") as string);
        state.put = { metadata, parts };
        state.script = { migration_tag: metadata.migrations?.new_tag ?? state.script?.migration_tag, domains: metadata.bindings.find((b: any) => b.name === "DOMAINS")?.text };
        return ok({ id: "fabric-inbox" });
      }
      case "POST /accounts/acc/workers/scripts/fabric-inbox/subdomain": state.workersDev = body.enabled; return ok(body);
    }
    return fail(404, 7003, `Fake has no ${method} ${route}`);
  };
  return { state, fetchImpl };
}

const run = (fake: ReturnType<typeof fakeCloudflare>, bundle: string, extra: Record<string, unknown> = {}) => {
  const steps: { id: string; outcome: string; detail: string }[] = [];
  return deployer.deploy({ token: TOKEN, accountId: "acc", email: "Me@Example.com", subdomain: "someone", team: "someone-team",
    bundleDir: bundle, fetchImpl: fake.fetchImpl, onStep: (s: any) => steps.push(s), ...extra }).then((r: any) => ({ ...r, steps }), (e: any) => ({ error: e, steps }));
};

test("the server bundle carries modules, bindings and hashed assets, and nothing of the build's deployment", () => {
  const { out, manifest } = fixtureBundle();
  assert.deepEqual(manifest.modules.map((m: any) => m.name), ["index.js", "assets/chunk.js"], "index.js first; CSS is not a module");
  assert.deepEqual(Object.keys(manifest.assets.files).sort(), ["/assets/app.js", "/favicon.svg"], ".assetsignore stays out");
  assert.equal(manifest.assets.files["/favicon.svg"].hash, assetHash(Buffer.from("<svg/>"), "favicon.svg"));
  assert.equal(manifest.assets.files["/favicon.svg"].contentType, "image/svg+xml");
  assert.deepEqual(manifest.migrations.map((m: any) => m.tag), ["v1", "v2"]);
  const text = readFileSync(path.join(out, "manifest.json"), "utf8");
  for (const leaked of ["owner-account", "owner-aud", "owner.example"]) assert.ok(!text.includes(leaked), `${leaked} is not in the bundle`);
});

test("asset hashes are wrangler's: blake3 of base64 content plus extension, 32 hex characters", () => {
  // Checked against Cloudflare on 2026-09-28: an upload session with these hashes asked for nothing already deployed.
  assert.equal(assetHash(Buffer.from("abc"), "x.js"), assetHash(Buffer.from("abc"), "y.js"));
  assert.notEqual(assetHash(Buffer.from("abc"), "x.js"), assetHash(Buffer.from("abc"), "x.css"));
  assert.match(assetHash(Buffer.from("abc"), "x.js"), /^[0-9a-f]{32}$/);
});

test("a new account gets a web address, storage, sign-in, protection and a running server", async () => {
  const { out, manifest } = fixtureBundle();
  const fake = fakeCloudflare();
  const r = await run(fake, out);
  assert.ifError(r.error);
  assert.equal(r.origin, "https://fabric-inbox.someone.workers.dev");
  assert.equal(r.accessOrigin, "https://someone-team.cloudflareaccess.com");
  assert.deepEqual(r.steps.map((s: any) => `${s.id}:${s.outcome}`), ["subdomain:done", "storage:done", "team:done", "otp:done", "access:done", "files:done", "server:done", "address:done"]);
  assert.deepEqual(fake.state.apps[0].policies[0].include, [{ email: { email: "me@example.com" } }]);
  assert.equal(fake.state.apps[0].domain, "fabric-inbox.someone.workers.dev");
  const upload = fake.state.uploads[0];
  assert.equal(Buffer.from(upload[manifest.assets.files["/favicon.svg"].hash], "base64").toString(), "<svg/>");

  const { metadata, parts } = fake.state.put!;
  const binding = (name: string) => metadata.bindings.find((b: any) => b.name === name);
  assert.equal(binding("POLICY_AUD").text, "new-aud");
  assert.equal(binding("TEAM_DOMAIN").text, "https://someone-team.cloudflareaccess.com");
  assert.deepEqual(binding("CLOUDFLARE_API_TOKEN"), { type: "secret_text", name: "CLOUDFLARE_API_TOKEN", text: TOKEN });
  assert.equal(binding("DOMAINS").text, "");
  assert.equal(binding("BUCKET").bucket_name, "fabric-inbox");
  assert.deepEqual(metadata.migrations, { new_tag: "v2", steps: [{ new_sqlite_classes: ["MailboxDO"] }, { new_sqlite_classes: ["AgentRegistryDO"] }] });
  assert.equal(metadata.assets.jwt, "completion-jwt");
  assert.equal(metadata.keep_bindings, undefined);
  assert.equal(parts["index.js"].type, "application/javascript+module");
  assert.match(parts["assets/chunk.js"].text, /export const x/);
  assert.equal(fake.state.workersDev, true);
  assert.ok(!JSON.stringify(r.steps).includes(TOKEN), "no step shows the token");
});

test("running it again updates the server in place and keeps its domains, secrets and sign-in rules", async () => {
  const { out } = fixtureBundle();
  const fake = fakeCloudflare();
  await run(fake, out);
  fake.state.script!.domains = "mine.example";
  const again = await run(fake, out, { subdomain: undefined, team: undefined, email: undefined });
  assert.ifError(again.error);
  assert.deepEqual(again.steps.map((s: any) => `${s.id}:${s.outcome}`), ["subdomain:already", "storage:already", "team:already", "otp:already", "access:already", "files:already", "server:done", "address:done"]);
  const { metadata } = fake.state.put!;
  assert.equal(metadata.migrations, undefined, "no storage change when the tags match");
  assert.deepEqual(metadata.keep_bindings, ["secret_text", "secret_key", "plain_text", "json"]);
  assert.equal(metadata.bindings.find((b: any) => b.name === "DOMAINS").text, "mine.example");
  assert.equal(fake.state.apps.length, 1);
});

test("an older server gets only the storage steps it lacks; a newer one is refused", async () => {
  const { out } = fixtureBundle();
  const older = fakeCloudflare({ subdomain: "someone", org: "t.cloudflareaccess.com", script: { migration_tag: "v1" } });
  await run(older, out);
  assert.deepEqual(older.state.put!.metadata.migrations, { old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["AgentRegistryDO"] }] });
  const newer = fakeCloudflare({ subdomain: "someone", org: "t.cloudflareaccess.com", script: { migration_tag: "v9" } });
  const r = await run(newer, out);
  assert.match(r.error.message, /newer than this app/);
  assert.equal(r.steps.at(-1).outcome, "failed");
  assert.equal(newer.state.put, null, "nothing was uploaded");
});

test("a missing permission is named and the run stops there; R2 not turned on says where to turn it on", async () => {
  const { out } = fixtureBundle();
  const denied = await run(fakeCloudflare({ deny: /^POST \/accounts\/acc\/access\/apps$/ }), out);
  assert.match(denied.error.message, /Access: Apps and Policies: Edit/);
  assert.deepEqual(denied.steps.map((s: any) => s.outcome), ["done", "done", "done", "done", "failed"]);
  const r2 = await run(fakeCloudflare({ r2Disabled: true }), out);
  assert.match(r2.steps.at(-1).detail, /Open R2 in the Cloudflare dashboard once/);
});

test("inputs are checked before anything is sent", async () => {
  const { out } = fixtureBundle();
  await assert.rejects(() => deployer.accounts("not a token"), /does not look like a Cloudflare API token/);
  const bad = await run(fakeCloudflare(), out, { subdomain: "Not Valid!" });
  assert.match(bad.steps[0].detail, /letters, digits and dashes/);
  await assert.rejects(() => deployer.accounts("tok_" + "y".repeat(36), fakeCloudflare().fetchImpl), /does not accept this token/);
  const accounts = await deployer.accounts(TOKEN, fakeCloudflare().fetchImpl);
  assert.deepEqual(accounts, [{ id: "acc", name: "Someone's account" }]);
  const seen = await deployer.inspect({ token: TOKEN, accountId: "acc", fetchImpl: fakeCloudflare({ subdomain: "s", org: "t.cloudflareaccess.com" }).fetchImpl });
  assert.deepEqual(seen, { subdomain: "s", team: "t.cloudflareaccess.com", existing: null });
});

test("the app and the server ask for the same token permissions", () => {
  const key = (p: { scope: string; name: string; level: string }) => `${p.scope}/${p.name}/${p.level}`;
  assert.deepEqual(deployer.PERMISSIONS.map(key), TOKEN_PERMISSIONS.map(key));
});

test("an update keeps every setting on the Worker, records the version, and refuses to put an older server over a newer one (deploy audit H1, M1)", async () => {
  const { out } = fixtureBundle();
  const kept = fakeCloudflare({ subdomain: "someone", org: "t.cloudflareaccess.com",
    script: { migration_tag: "v2", vars: { UNKNOWN_ADDRESS_POLICY: '{"a.invalid":"catch_all:x@a.invalid"}', GOOGLE_CLIENT_ID: "g", FABRIC_SERVER_VERSION: "9.9.8" } } });
  const r = await run(kept, out);
  assert.ifError(r.error);
  const { metadata } = kept.state.put!;
  assert.ok(metadata.keep_bindings.includes("plain_text") && metadata.keep_bindings.includes("json"), "vars the app does not set are kept by Cloudflare");
  assert.equal(metadata.bindings.some((b: any) => b.name === "UNKNOWN_ADDRESS_POLICY"), false, "and not overwritten");
  assert.deepEqual(metadata.bindings.find((b: any) => b.name === "FABRIC_SERVER_VERSION"), { type: "plain_text", name: "FABRIC_SERVER_VERSION", text: "9.9.9" });

  const newer = fakeCloudflare({ subdomain: "someone", org: "t.cloudflareaccess.com", script: { migration_tag: "v2", vars: { FABRIC_SERVER_VERSION: "10.0.0" } } });
  const refused = await run(newer, out);
  assert.match(refused.error.message, /version 10\.0\.0.*newer than this app's 9\.9\.9/);
  assert.equal(newer.state.put, null, "nothing was uploaded");
  const allowed = await run(newer, out, { allowDowngrade: true });
  assert.ifError(allowed.error);
});

test("a storage step that would delete or move data is never sent (deploy audit M2)", async () => {
  const { out } = fixtureBundle();
  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.migrations.push({ tag: "v3", deleted_classes: ["AgentRegistryDO"] });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const fake = fakeCloudflare({ subdomain: "someone", org: "t.cloudflareaccess.com", script: { migration_tag: "v2" } });
  const r = await run(fake, out);
  assert.match(r.error.message, /would delete or move stored data/);
  assert.equal(fake.state.put, null);
});

test("a server signed in on its own domain keeps that sign-in: no second Access app, POLICY_AUD untouched (deploy audit M3)", async () => {
  const { out } = fixtureBundle();
  const fake = fakeCloudflare({ subdomain: "someone", org: "t.cloudflareaccess.com", script: { migration_tag: "v2", vars: { POLICY_AUD: "custom-domain-aud" } } });
  const r = await run(fake, out, { email: undefined });
  assert.ifError(r.error);
  assert.equal(fake.state.apps.length, 0, "no Access app was created for workers.dev");
  assert.equal(fake.state.put!.metadata.bindings.find((b: any) => b.name === "POLICY_AUD").text, "custom-domain-aud");
  assert.match(r.steps.find((s: any) => s.id === "access").detail, /keeps the sign-in it already has/);
});
