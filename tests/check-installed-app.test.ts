import { test } from "node:test";
import assert from "node:assert/strict";
import { workerOptions, accessStandIn, mcpBody } from "../scripts/check-installed-app.mjs";

// scripts/check-installed-app.mjs serves the server an installed app carries (docs/release.md,
// step 6). These hold the parts a release check depends on.
const manifest = {
  format: "fabric-inbox-server/1", version: "9.9.9", revision: "abc",
  worker: { main_module: "index.js", compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"] },
  modules: [{ name: "index.js", file: "worker/index.js" }, { name: "assets/x.js", file: "worker/assets/x.js" }],
  durableObjects: [{ name: "MAILBOX", class_name: "MailboxDO" }, { name: "EMAIL_MCP", class_name: "EmailMCP" }],
  r2Buckets: [{ binding: "BUCKET", bucket_name: "fabric-inbox" }],
  assets: { config: {}, files: {} },
};

test("the bundle runs as Cloudflare runs it: the Worker behind the assets, every object and bucket bound", () => {
  const o = workerOptions(manifest, "/b", { aud: "a", team: "http://t.invalid" }, () => "src") as any;
  // Without has_user_worker the assets router answers 404 for /mcp and the Worker never runs
  // (seen on the first run of this check, 2026-09-30).
  assert.equal(o.assets.routerConfig.has_user_worker, true);
  assert.equal(o.assets.directory, "/b/static");
  assert.deepEqual(o.modules.map((m: any) => m.path), ["/b/worker/index.js", "/b/worker/assets/x.js"]);
  assert.equal(o.modules[0].type, "ESModule");
  assert.deepEqual(Object.keys(o.durableObjects), ["MAILBOX", "EMAIL_MCP"]);
  assert.equal(o.durableObjects.MAILBOX.className, "MailboxDO");
  assert.deepEqual(o.r2Buckets, ["BUCKET"]);
  assert.equal(o.bindings.POLICY_AUD, "a");
  assert.equal(o.bindings.TEAM_DOMAIN, "http://t.invalid");
  assert.equal(o.host, "127.0.0.1");
  assert.equal(o.compatibilityDate, "2026-09-01");
});

test("the Access stand-in signs an owner's assertion its own key set verifies, and nothing else leaves", async () => {
  const jose = await import("jose");
  const access = await accessStandIn({ team: "http://t.invalid", aud: "a" });
  const certs = await access.outbound(new Request("http://t.invalid/cdn-cgi/access/certs"));
  const jwks = jose.createLocalJWKSet(await certs.json());
  const { payload } = await jose.jwtVerify(access.assertion, jwks, { issuer: "http://t.invalid", audience: "a" });
  assert.equal(payload.email, "owner@example.com");
  assert.equal((await access.outbound(new Request("https://api.cloudflare.com/client/v4/accounts"))).status, 503);
  assert.deepEqual(access.requested, ["http://t.invalid/cdn-cgi/access/certs", "https://api.cloudflare.com/client/v4/accounts"]);
});

test("an MCP answer is read whether it comes as JSON or as one server-sent event", () => {
  assert.deepEqual(mcpBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.deepEqual(mcpBody('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n'), { jsonrpc: "2.0", id: 2, result: {} });
  assert.throws(() => mcpBody("Not Found"), /not an MCP answer/);
});
