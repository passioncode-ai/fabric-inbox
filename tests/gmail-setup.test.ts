import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { gmailSetupRouter } from "../workers/routes/gmail-setup";
import { authErrorName, checkGoogleClient } from "../workers/gmail-setup/google-check";
import { validCredentialKey, writeGmailSettings } from "../workers/gmail-setup/server-settings";
import { CloudflareApi } from "../workers/routing/cloudflare-api";
import { GMAIL_SCOPE as SERVER_SCOPE, fromB64 } from "../workers/providers/google-oauth";
import { GMAIL_SCOPE, authorizedDomainOf, gmailSetupValues } from "../shared/mail/gmail-setup";

/**
 * SCN-051: the Gmail setup wizard's server side. The server checks a Google OAuth client with Google
 * and writes its own settings with the Cloudflare token it holds; Google and Cloudflare are fakes
 * here, answering as their documented (and, for Google's error page, observed) contracts do.
 */
const ORIGIN = "https://fabric-inbox.owner.workers.dev";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CLIENT_ID = "123456789012-abcdefghijklmnop" + ".apps.googleusercontent.com";
const SECRET = "GOCSPX" + "-abcdefghijklmnopqrstuvwxyz12";
const KEY = Buffer.alloc(32, 3).toString("base64url");
// Observed 2026-10-06 from accounts.google.com for an unknown client: base64 of "\n\x0einvalid_client\x12\x1fThe OAuth client was not found. \x91\x03".
const INVALID_CLIENT_ERROR = "Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw";
const errorPage = (name: string) => `https://accounts.google.com/signin/oauth/error?authError=${Buffer.from(`\n\x15${name}\x12\x10some description`, "latin1").toString("base64url")}&client_id=x`;

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const cf = (result: unknown, status = 200) => json(status < 300 ? { success: true, errors: [], result } : { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }, status);

interface Google { token?: "good" | "unknown-client" | "wrong-secret" | "down"; auth?: "known" | "mismatch" | "invalid-client" | "unreadable" }
interface Recorded { method: string; url: string; body?: unknown }
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Google and Cloudflare as one fake network; every request is recorded (bodies of PATCH parsed). */
function network(google: Google = {}, cloudflare: { settings?: "ok" | "forbidden"; patch?: "ok" | "forbidden" } = {}) {
  const calls: Recorded[] = [];
  const handler = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const record: Recorded = { method, url: url.href };
    calls.push(record);
    if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body));
      record.body = Object.fromEntries(body);
      switch (google.token ?? "good") {
        case "good": return json({ error: "invalid_grant", error_description: "Malformed auth code." }, 400);
        case "unknown-client": return json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401);
        case "wrong-secret": return json({ error: "invalid_client", error_description: "Unauthorized" }, 401);
        case "down": throw new TypeError("network");
      }
    }
    if (url.hostname === "accounts.google.com") {
      assert.equal(init?.redirect, "manual", "Google's page is read, never followed");
      switch (google.auth ?? "known") {
        case "known": return new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/v3/signin/identifier?continue=x" } });
        case "mismatch": return new Response(null, { status: 302, headers: { Location: errorPage("redirect_uri_mismatch") } });
        case "invalid-client": return new Response(null, { status: 302, headers: { Location: `https://accounts.google.com/signin/oauth/error?authError=${INVALID_CLIENT_ERROR}&client_id=x` } });
        case "unreadable": return new Response("<html>", { status: 200 });
      }
    }
    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname.endsWith("/settings") && method === "GET")
        return cloudflare.settings === "forbidden" ? cf(null, 403) : cf({ bindings: [
          { type: "durable_object_namespace", name: "MAILBOX", class_name: "MailboxDO" },
          { type: "plain_text", name: "DOMAINS", text: "example.com" },
          { type: "secret_text", name: "CLOUDFLARE_API_TOKEN" },
          { type: "plain_text", name: "GOOGLE_CLIENT_ID", text: "old-client" },
          { type: "secret_text", name: "GMAIL_TOKEN_ENCRYPTION_KEY" },
          { type: "r2_bucket", name: "BUCKET", bucket_name: "fabric-inbox" },
        ] });
      if (url.pathname.endsWith("/settings") && method === "PATCH") {
        const form = init?.body as FormData;
        record.body = JSON.parse(await (form.get("settings") as Blob).text());
        return cloudflare.patch === "forbidden" ? cf(null, 403) : cf({});
      }
    }
    throw new Error("unexpected request " + method + " " + url.href);
  };
  globalThis.fetch = handler as typeof fetch;
  return { calls, handler };
}

const baseEnv = { CLOUDFLARE_API_TOKEN: "t".repeat(40), CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const request = (path: string, env: Record<string, unknown>, init: RequestInit = {}, origin = ORIGIN) =>
  gmailSetupRouter.request(origin + path, init, env as never);
const put = (env: Record<string, unknown>, body: unknown, origin = ORIGIN) =>
  request("/api/gmail-setup", env, { method: "PUT", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }, origin);

// ── The values to copy ──────────────────────────────────────────────────────────

test("the wizard's values are computed from the server's own address", () => {
  assert.equal(GMAIL_SCOPE, SERVER_SCOPE, "one scope, asked for and shown");
  assert.deepEqual(gmailSetupValues(ORIGIN), {
    appName: "Fabric Inbox", origin: ORIGIN, redirectUri: ORIGIN + "/api/accounts/gmail/callback",
    authorizedDomain: "owner.workers.dev", scope: "https://www.googleapis.com/auth/gmail.modify",
  });
  assert.equal(authorizedDomainOf("mail.example.com"), "example.com");
  assert.equal(authorizedDomainOf("inbox.shop.co.uk"), "shop.co.uk");
});

test("GET /api/gmail-setup says what is missing, what to copy and whether the server can save it", async () => {
  const response = await request("/api/gmail-setup", baseEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.configured, false);
  assert.deepEqual(body.missing.sort(), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MAIL_CREDENTIAL_KEY", "PUBLIC_APP_URL"]);
  assert.equal(body.values.redirectUri, ORIGIN + "/api/accounts/gmail/callback");
  assert.equal(body.canSave, true);
  assert.equal(body.credentialKey, "missing");
  assert.match(body.links.createClient, /^https:\/\/console\.cloud\.google\.com\/auth\/clients\/create$/);

  const configured = { ...baseEnv, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: SECRET, GMAIL_TOKEN_ENCRYPTION_KEY: KEY, PUBLIC_APP_URL: ORIGIN };
  const done = (await (await request("/api/gmail-setup", configured)).json()) as Record<string, any>;
  assert.equal(done.configured, true);
  assert.equal(done.projectNumber, "123456789012");
  assert.equal(done.addressMatches, true);
  assert.match(done.links.gmailApi, /project=123456789012/);
  assert.ok(!JSON.stringify(done).includes(SECRET), "the client secret is never returned");
  assert.ok(!JSON.stringify(done).includes(KEY), "nor the credential key");
});

test("without its own Cloudflare token the server says it cannot save, and how to set Gmail up instead", async () => {
  const body = (await (await request("/api/gmail-setup", {})).json()) as Record<string, any>;
  assert.equal(body.canSave, false);
  assert.match(body.cannotSave, /no Cloudflare API token/);
  const response = await put({}, { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.equal(response.status, 503);
});

// ── Saving ──────────────────────────────────────────────────────────────────────

test("PUT checks the client with Google, makes a credential key, and writes the four settings in one change", async () => {
  const { calls } = network();
  const response = await put(baseEnv, { clientId: ` ${CLIENT_ID} `, clientSecret: SECRET });
  assert.equal(response.status, 202, await response.clone().text());
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.saved, true);
  assert.equal(body.keyCreated, true);
  assert.ok(!JSON.stringify(body).includes(SECRET));
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/fabric-inbox/settings`);
  const bindings = (patch.body as { bindings: { type: string; name: string; text?: string }[] }).bindings;
  const by = Object.fromEntries(bindings.map((b) => [b.name, b]));
  // Everything else is kept as it is.
  for (const name of ["MAILBOX", "DOMAINS", "CLOUDFLARE_API_TOKEN", "BUCKET"]) assert.deepEqual(by[name], { type: "inherit", name });
  assert.deepEqual(by.GOOGLE_CLIENT_ID, { type: "plain_text", name: "GOOGLE_CLIENT_ID", text: CLIENT_ID });
  assert.deepEqual(by.PUBLIC_APP_URL, { type: "plain_text", name: "PUBLIC_APP_URL", text: ORIGIN });
  assert.deepEqual(by.GOOGLE_CLIENT_SECRET, { type: "secret_text", name: "GOOGLE_CLIENT_SECRET", text: SECRET });
  assert.equal(by.MAIL_CREDENTIAL_KEY.type, "secret_text");
  assert.equal(fromB64(by.MAIL_CREDENTIAL_KEY.text!).length, 32, "a 32-byte key, base64url");
  assert.equal(bindings.filter((b) => b.name === "GOOGLE_CLIENT_ID").length, 1, "the old client ID is replaced, not doubled");
  // Google was asked with this server's redirect URI.
  const token = calls.find((c) => c.url.startsWith("https://oauth2.googleapis.com"))!;
  assert.equal((token.body as Record<string, string>).redirect_uri, ORIGIN + "/api/accounts/gmail/callback");
});

test("a credential key the server already has is never replaced: every account's access is sealed with it", async () => {
  const { calls } = network();
  const response = await put({ ...baseEnv, GMAIL_TOKEN_ENCRYPTION_KEY: KEY }, { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.equal(response.status, 202);
  assert.equal(((await response.json()) as { keyCreated: boolean }).keyCreated, false);
  const bindings = (calls.find((c) => c.method === "PATCH")!.body as { bindings: { type: string; name: string }[] }).bindings;
  assert.deepEqual(bindings.find((b) => b.name === "GMAIL_TOKEN_ENCRYPTION_KEY"), { type: "inherit", name: "GMAIL_TOKEN_ENCRYPTION_KEY" });
  assert.equal(validCredentialKey(KEY), true);
  assert.equal(validCredentialKey("short"), false);
  assert.equal(validCredentialKey(undefined), false);
});

test("a client Google does not know, or a wrong secret, is refused before anything is written", async () => {
  for (const [token, pattern] of [["unknown-client", /does not know this client ID/], ["wrong-secret", /does not accept this client secret/]] as const) {
    const { calls } = network({ token });
    const response = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; checks: unknown[] };
    assert.match(body.error, pattern);
    assert.ok(!calls.some((c) => c.url.includes("api.cloudflare.com")), "nothing reached Cloudflare");
  }
});

test("a malformed client ID or secret is refused without asking Google", async () => {
  const { calls } = network();
  const response = await put(baseEnv, { clientId: "my-project", clientSecret: "has spaces in it" });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; checks: { id: string; status: string }[] };
  assert.match(body.error, /not an OAuth client ID/);
  assert.deepEqual(body.checks.map((c) => `${c.id}:${c.status}`), ["client_id:failed", "client_secret:failed"]);
  assert.equal(calls.length, 0);
});

test("a token not allowed to change the server's settings says which permission, and nothing changes", async () => {
  network({}, { settings: "forbidden" });
  const response = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.equal(response.status, 403);
  assert.match(((await response.json()) as { error: string }).error, /not allowed to read your server's settings \(Workers Scripts: Edit\).*Nothing was changed/);
  const { calls } = network({}, { patch: "forbidden" });
  const refused = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { error: string }).error, /not allowed to change your server's settings/);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1, "one attempt; no retry of a refused write");
});

test("a redirect URI Google does not know yet is saved anyway, and said: Google can take minutes to apply it", async () => {
  const { calls } = network({ auth: "mismatch" });
  const response = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.equal(response.status, 202, "the client itself is right, so it is kept");
  const body = (await response.json()) as { warning: string; checks: { id: string; status: string; fix?: string }[] };
  assert.match(body.warning, /does not have this server's redirect URI.*few minutes/);
  assert.match(body.checks.find((c) => c.id === "redirect_uri")!.fix!, /Authorized redirect URIs/);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
});

test("Google out of reach does not block saving; the checks say unknown", async () => {
  network({ token: "down", auth: "unreadable" });
  const response = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.equal(response.status, 202);
  const body = (await response.json()) as { checks: { id: string; status: string }[] };
  assert.deepEqual(body.checks.map((c) => `${c.id}:${c.status}`), ["token_endpoint:unknown", "redirect_uri:unknown"]);
});

test("Gmail is set up only at an HTTPS address, and only with both values", async () => {
  network();
  assert.equal((await put(baseEnv, { clientId: CLIENT_ID }, ORIGIN)).status, 400);
  assert.equal((await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET, extra: 1 }, ORIGIN)).status, 400);
  const local = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET }, "http://localhost:5173");
  assert.equal(local.status, 400);
  assert.match(((await local.json()) as { error: string }).error, /HTTPS address/);
});

// ── The self-test ───────────────────────────────────────────────────────────────

test("GET /api/gmail-setup/check checks the saved client with Google and the address in use", async () => {
  const configured = { ...baseEnv, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: SECRET, GMAIL_TOKEN_ENCRYPTION_KEY: KEY, PUBLIC_APP_URL: ORIGIN };
  network();
  const good = (await (await request("/api/gmail-setup/check", configured)).json()) as { ok: boolean; checks: { id: string; status: string }[] };
  assert.equal(good.ok, true);
  assert.deepEqual(good.checks.map((c) => `${c.id}:${c.status}`), ["token_endpoint:ok", "redirect_uri:ok"]);
  network();
  const elsewhere = (await (await request("/api/gmail-setup/check", configured, {}, "https://inbox.example.com")).json()) as { ok: boolean; checks: { message: string; status: string }[] };
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.checks.at(-1)!.message, /set up for https:\/\/fabric-inbox\.owner\.workers\.dev, but this app is open at https:\/\/inbox\.example\.com/);
  const off = (await (await request("/api/gmail-setup/check", baseEnv)).json()) as { configured: boolean; ok: boolean };
  assert.deepEqual([off.configured, off.ok], [false, false]);
});

test("Google's error page is read by the error's name; a deleted client is said as such", async () => {
  assert.equal(authErrorName(`https://accounts.google.com/signin/oauth/error?authError=${INVALID_CLIENT_ERROR}`), "invalid_client");
  assert.equal(authErrorName(errorPage("redirect_uri_mismatch")), "redirect_uri_mismatch");
  assert.equal(authErrorName("https://accounts.google.com/signin/oauth/error"), null);
  assert.equal(authErrorName("not a url"), null);
  const { handler } = network({ auth: "invalid-client" });
  const result = await checkGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUri: ORIGIN + "/cb" }, handler);
  assert.equal(result.failed, true);
  assert.deepEqual(result.checks.map((c) => `${c.id}:${c.status}`), ["token_endpoint:ok", "client_id:failed"]);
});

test("writeGmailSettings sends one multipart change and inherits everything it does not set", async () => {
  const { calls, handler } = network();
  await writeGmailSettings(new CloudflareApi("t".repeat(40), handler as typeof fetch), { accountId: ACCOUNT, script: "fabric-inbox" },
    { clientId: CLIENT_ID, clientSecret: SECRET, publicAppUrl: ORIGIN });
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH"]);
});
