// A server with no credential key makes its own (SCN-053): POST /api/credential-key writes
// MAIL_CREDENTIAL_KEY into the Worker's settings with the server's Cloudflare token, inheriting every
// other binding; a key it has under either name is never replaced, and the value never leaves it.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { credentialKeyRouter } from "../workers/routes/credential-key";
import { fakeBucket } from "./fake-r2";
import { SETTINGS_LOCK_KEY } from "../workers/lib/settings-lock";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://fabric-inbox.owner.workers.dev";
const KEY = Buffer.alloc(32, 7).toString("base64url");
const env = () => ({ CLOUDFLARE_API_TOKEN: "t".repeat(40), CLOUDFLARE_ACCOUNT_ID: ACCOUNT, BUCKET: fakeBucket() });
const baseEnv = env();
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const cf = (result: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { success: true, errors: [], result } : { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }),
  { status, headers: { "Content-Type": "application/json" } });

function cloudflare(patch: "ok" | "forbidden" = "ok") {
  const calls: { method: string; url: string; body?: { bindings: { type: string; name: string; text?: string }[] } }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    const call: (typeof calls)[number] = { method, url: url.href };
    calls.push(call);
    if (url.pathname.endsWith("/settings") && method === "GET")
      return cf({ bindings: [{ type: "durable_object_namespace", name: "MAILBOX", class_name: "MailboxDO" }, { type: "secret_text", name: "CLOUDFLARE_API_TOKEN" }, { type: "plain_text", name: "DOMAINS", text: "example.com" }] });
    if (url.pathname.endsWith("/settings") && method === "PATCH") {
      call.body = JSON.parse(await ((init!.body as FormData).get("settings") as Blob).text());
      return patch === "forbidden" ? cf(null, 403) : cf({});
    }
    throw new Error("unexpected " + method + " " + url.href);
  }) as typeof fetch;
  return calls;
}
const post = (env: Record<string, unknown>) => credentialKeyRouter.request(ORIGIN + "/api/credential-key", { method: "POST" }, env as never);

test("a server without a key makes one and writes only that, keeping every other setting", async () => {
  const calls = cloudflare();
  const response = await post(baseEnv);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual([body.created, body.present], [true, true]);
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/fabric-inbox/settings`);
  const by = Object.fromEntries(patch.body!.bindings.map((b) => [b.name, b]));
  for (const name of ["MAILBOX", "CLOUDFLARE_API_TOKEN", "DOMAINS"]) assert.deepEqual(by[name], { type: "inherit", name });
  assert.equal(by.MAIL_CREDENTIAL_KEY.type, "secret_text");
  assert.equal(Buffer.from(by.MAIL_CREDENTIAL_KEY.text!, "base64url").length, 32);
  assert.ok(!JSON.stringify(body).includes(by.MAIL_CREDENTIAL_KEY.text!), "the key is never returned");
});

test("a key the server has, under either name, is never replaced and nothing is written", async () => {
  for (const env of [{ ...baseEnv, MAIL_CREDENTIAL_KEY: KEY }, { ...baseEnv, GMAIL_TOKEN_ENCRYPTION_KEY: KEY }]) {
    const calls = cloudflare();
    const response = await post(env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { created: false, present: true });
    assert.equal(calls.length, 0);
  }
});

test("without its own Cloudflare token, or with one not allowed to change settings, nothing changes and the answer says why", async () => {
  const none = await post({ BUCKET: fakeBucket() });
  assert.equal(none.status, 503);
  assert.match(((await none.json()) as { error: string }).error, /no Cloudflare API token/);
  cloudflare("forbidden");
  const refused = await post(env());
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { error: string }).error, /Nothing was changed/);
});

/**
 * Cloudflare as it behaves: the settings read answers the bindings of the latest version, and a
 * PATCH (which takes a moment) makes a new version. The running Worker's environment does not change.
 */
function liveCloudflare(initial: { type: string; name: string }[] = [], patchMs = 30) {
  let bindings = [...initial];
  const keyWrites: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/settings") && method === "GET") return cf({ bindings });
    if (url.pathname.endsWith("/settings") && method === "PATCH") {
      const body = JSON.parse(await ((init!.body as FormData).get("settings") as Blob).text()) as { bindings: { type: string; name: string; text?: string }[] };
      await new Promise((r) => setTimeout(r, patchMs));
      for (const b of body.bindings) if (b.name === "MAIL_CREDENTIAL_KEY" && b.type === "secret_text") keyWrites.push(b.text!);
      bindings = body.bindings.map((b) => (b.type === "inherit" ? bindings.find((x) => x.name === b.name)! : { type: b.type, name: b.name }));
      return cf({});
    }
    throw new Error("unexpected " + method + " " + url.href);
  }) as typeof fetch;
  return { keyWrites, bindings: () => bindings };
}

test("two requests at once (a person in Settings, an agent) make exactly one key (L2)", async () => {
  const live = liveCloudflare([{ type: "durable_object_namespace", name: "MAILBOX" }]);
  const shared = env();
  const answers = await Promise.all([post(shared), post(shared), post(shared)]);
  assert.equal(live.keyWrites.length, 1, "one key written, so nothing sealed with it is lost");
  const bodies = (await Promise.all(answers.map((r) => r.json()))) as { created: boolean; present: boolean }[];
  assert.deepEqual(bodies.map((b) => b.created).sort(), [false, false, true]);
  assert.ok(bodies.every((b) => b.present));
  assert.ok(live.bindings().some((b) => b.name === "MAIL_CREDENTIAL_KEY"));
  assert.match(shared.BUCKET.objects.get(SETTINGS_LOCK_KEY)!.value, /"owner":null/, "the lock is released");
});

test("a key bound moments ago, not yet in this Worker's environment, is never written again (L2)", async () => {
  for (const name of ["MAIL_CREDENTIAL_KEY", "GMAIL_TOKEN_ENCRYPTION_KEY"]) {
    const live = liveCloudflare([{ type: "secret_text", name }]);
    const response = await post(env());
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { created: boolean }).created, false);
    assert.equal(live.keyWrites.length, 0, name);
  }
});

test("a key the server holds but cannot use (set by hand) is replaced once, not again while the new one arrives (L2)", async () => {
  const live = liveCloudflare([{ type: "secret_text", name: "MAIL_CREDENTIAL_KEY" }]);
  const broken = { ...env(), MAIL_CREDENTIAL_KEY: "not-a-key" };
  assert.equal((await post(broken)).status, 202);
  assert.equal((await post(broken)).status, 200, "the running Worker still holds the broken one, but a usable key was just written");
  assert.equal(live.keyWrites.length, 1);
});

test("a lock left by a request that died is taken over once stale; a fresh one makes the request wait, not write (L2)", async () => {
  const live = liveCloudflare();
  const stale = env();
  await stale.BUCKET.put(SETTINGS_LOCK_KEY, JSON.stringify({ owner: "dead", at: Date.now() - 10 * 60_000 }));
  assert.equal((await post(stale)).status, 202);
  assert.equal(live.keyWrites.length, 1);

  const { writeWorkerSettings } = await import("../workers/gmail-setup/server-settings");
  const busy = env();
  await busy.BUCKET.put(SETTINGS_LOCK_KEY, JSON.stringify({ owner: "other", at: Date.now() }));
  const { CloudflareApi } = await import("../workers/routing/cloudflare-api");
  await assert.rejects(writeWorkerSettings(new CloudflareApi("t".repeat(40)), { accountId: ACCOUNT, script: "fabric-inbox" }, { plain: {}, secret: { MAIL_CREDENTIAL_KEY: KEY } },
    { bucket: busy.BUCKET as never, lock: { attempts: 3, delayMs: 1 } }), /being changed by another request/);
  assert.equal(live.keyWrites.length, 1, "nothing written while another change holds the lock");
});

test("agents can give the server its key, and the IMAP dialog offers it instead of sending the person to the Mac app", () => {
  const tools = readFileSync("workers/mcp/tools.ts", "utf8");
  assert.match(tools, /name: "create_credential_key"/);
  assert.match(readFileSync("app/components/settings/sections/AccountsSection.tsx", "utf8"), /<CreateCredentialKey onBack=/);
});
