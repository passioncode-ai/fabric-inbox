// A server with no credential key makes its own (SCN-053): POST /api/credential-key writes
// MAIL_CREDENTIAL_KEY into the Worker's settings with the server's Cloudflare token, inheriting every
// other binding; a key it has under either name is never replaced, and the value never leaves it.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { credentialKeyRouter } from "../workers/routes/credential-key";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://fabric-inbox.owner.workers.dev";
const KEY = Buffer.alloc(32, 7).toString("base64url");
const baseEnv = { CLOUDFLARE_API_TOKEN: "t".repeat(40), CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
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
  const none = await post({});
  assert.equal(none.status, 503);
  assert.match(((await none.json()) as { error: string }).error, /no Cloudflare API token/);
  cloudflare("forbidden");
  const refused = await post(baseEnv);
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { error: string }).error, /Nothing was changed/);
});

test("agents can give the server its key, and the IMAP dialog offers it instead of sending the person to the Mac app", () => {
  const tools = readFileSync("workers/mcp/tools.ts", "utf8");
  assert.match(tools, /name: "create_credential_key"/);
  assert.match(readFileSync("app/components/settings/sections/AccountsSection.tsx", "utf8"), /<CreateCredentialKey onBack=/);
});
