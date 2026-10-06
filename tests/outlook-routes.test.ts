import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { accountsRouter } from "../workers/routes/accounts";
import { microsoftSetupRouter, pastedChecks } from "../workers/routes/microsoft-setup";
import { outlookResultPage } from "../workers/microsoft-setup/result-page";
import { ProviderError } from "../workers/providers/gmail-client";
import { adminConsentUrl, microsoftSetupValues, parseSecretExpiry, secretExpiry, secretExpiryProblem } from "../shared/mail/microsoft-setup";

/**
 * SCN-057…SCN-060: connecting Outlook in the browser ends on a page for success and for every
 * failure (an organization that needs its administrator, a refused consent, a wrong redirect URI, an
 * expired client secret…), never raw JSON; the owner's setup is written by the server itself and
 * checked with Microsoft. Microsoft and Cloudflare are fakes.
 */
const ORIGIN = "https://fabric-inbox.owner.workers.dev";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = ["made", "up", "secret", "value", "for", "tests"].join("_");
const KEY = Buffer.alloc(32, 7).toString("base64url");
const config = { MICROSOFT_CLIENT_ID: CLIENT_ID, MICROSOFT_CLIENT_SECRET: SECRET, MAIL_CREDENTIAL_KEY: KEY, PUBLIC_APP_URL: ORIGIN };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const DAY = 86_400_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

type Stub = Partial<Record<"beginOutlookConnect" | "outlookCallback" | "checkMicrosoftClient" | "listAccounts", (...a: unknown[]) => Promise<unknown>>>;
const env = (stub: Stub = {}, extra: Record<string, unknown> = {}) => ({ ...config, ...extra, GMAIL_ACCOUNTS: { getByName: () => stub } });
async function callback(query: string, stub: Stub, cookie = "__Host-fabric-outlook-state=b") {
  const response = await accountsRouter.request(`${ORIGIN}/api/accounts/outlook/callback?${query}`, { headers: { Cookie: cookie } }, env(stub) as never);
  return { response, html: await response.text() };
}
const fail = (code: string) => async () => { throw new ProviderError(code); };

// ── Pages ────────────────────────────────────────────────────────────────────────

test("every outcome is a branded HTML page that can run nothing, never JSON", async () => {
  for (const outcome of ["connected", "admin_consented", "admin_consent_declined", "oauth_denied", "admin_consent_required", "redirect_uri_mismatch",
    "microsoft_secret_expired", "microsoft_client_rejected", "microsoft_account_type", "signin_incomplete", "insufficient_scope", "mailbox_unavailable",
    "already_connected", "invalid_state", "oauth_failed", "invalid_profile", "not_configured", "invalid_origin", "too_many_connections", "provider_unavailable", "something_new"]) {
    const response = outlookResultPage({ outcome, email: "a@example.invalid", clientId: CLIENT_ID, redirectUri: ORIGIN + "/api/accounts/outlook/callback" });
    const html = await response.text();
    assert.match(response.headers.get("Content-Type")!, /^text\/html; charset=utf-8/, outcome);
    assert.match(response.headers.get("Content-Security-Policy")!, /default-src 'none'/);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /Fabric Inbox · Outlook/);
    assert.ok(!/<script/i.test(html), outcome);
  }
});

test("a connected account's page names it; the browser's cookie is cleared; the state, cookie and code reach the server", async () => {
  let args: unknown[] = [];
  const { response, html } = await callback("state=s&code=c", { outlookCallback: async (...a) => { args = a; return { id: "o1", email: "me@outlook.example" }; } });
  assert.equal(response.status, 200);
  assert.match(html, /Outlook is connected/);
  assert.match(html, /me@outlook\.example/);
  assert.match(response.headers.get("Set-Cookie")!, /__Host-fabric-outlook-state=;/);
  assert.deepEqual(args, ["s", "b", "c", undefined]);
});

test("an organization that lets only administrators allow apps gets the approval link to forward, and its return says to connect", async () => {
  let outcome: unknown;
  const { response, html } = await callback("state=s&error=access_denied&error_description=" + encodeURIComponent("AADSTS90094: Admin consent is required."),
    { outlookCallback: async (...a) => { outcome = a[3]; throw new ProviderError(String(a[3])); } });
  assert.equal(outcome, "admin_consent_required", "Microsoft's word is read into the page's outcome");
  assert.equal(response.status, 403);
  assert.match(html, /administrator must allow Fabric Inbox/);
  const link = adminConsentUrl(CLIENT_ID, ORIGIN + "/api/accounts/outlook/callback");
  assert.ok(html.includes(link.replace(/&/g, "&amp;")), "the approval link, escaped");
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/organizations/v2.0/adminconsent");
  assert.equal(url.searchParams.get("scope"), "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read");
  assert.ok(!html.includes("AADSTS"), "Microsoft's own text is never shown");
  // The administrator's approval comes back with no code and nothing to keep.
  const approved = await callback("admin_consent=True&tenant=whatever&state=admin-consent", { outlookCallback: fail("should_not_be_called") });
  assert.match(approved.html, /Your organization allows Fabric Inbox now/);
  const declined = await callback("admin_consent=True&error=access_denied&state=admin-consent", { outlookCallback: fail("should_not_be_called") });
  assert.match(declined.html, /did not allow Fabric Inbox/);
});

test("Cancel on Microsoft's page, an expired secret and a wrong redirect URI each say what to change", async () => {
  const pass = { outlookCallback: async (...a: unknown[]) => { throw new ProviderError(String(a[3] ?? "unexpected")); } };
  const denied = await callback("state=s&error=access_denied&error_description=" + encodeURIComponent("AADSTS65004: User declined to consent"), pass);
  assert.equal(denied.response.status, 400);
  assert.match(denied.html, /Outlook was not connected/);
  const expired = await callback("state=s&code=c", { outlookCallback: fail("microsoft_secret_expired") });
  assert.match(expired.html, /client secret on your server has expired/);
  assert.match(expired.html, /Certificates &amp; secrets/);
  assert.match(expired.html, /\/settings\/accounts\?connect=microsoft/);
  const mismatch = await callback("state=s&code=c", { outlookCallback: fail("redirect_uri_mismatch") });
  assert.match(mismatch.html, new RegExp(ORIGIN.replace(/\./g, "\\.") + "/api/accounts/outlook/callback"));
  // Over Durable Object RPC an error arrives as a plain Error whose message is the code.
  const rpc = await callback("state=s&code=c", { outlookCallback: async () => { throw new Error("mailbox_unavailable"); } });
  assert.match(rpc.html, /no Outlook mailbox/);
});

test("connecting opens Microsoft's sign-in with a browser cookie; at another address or unset, a page says why", async () => {
  const stub = { beginOutlookConnect: async () => ({ authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1", browserToken: "tok" }) };
  const response = await accountsRouter.request(`${ORIGIN}/api/accounts/outlook/connect`, {}, env(stub) as never);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Location")!, /^https:\/\/login\.microsoftonline\.com\//);
  assert.match(response.headers.get("Set-Cookie")!, /^__Host-fabric-outlook-state=tok; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const elsewhere = await accountsRouter.request(`https://other.example/api/accounts/outlook/connect`, {}, env(stub) as never);
  assert.match(await elsewhere.text(), /Open this from your server&#39;s own address/);
  const unset = await accountsRouter.request(`${ORIGIN}/api/accounts/outlook/connect`, {}, { GMAIL_ACCOUNTS: { getByName: () => stub } } as never);
  assert.equal(unset.status, 503);
  assert.match(await unset.text(), /Outlook is not set up on this server/);
  // The JSON form needs the app's own origin, as every browser mutation does.
  const post = await accountsRouter.request(`${ORIGIN}/api/accounts/outlook/connect`, { method: "POST", headers: { Origin: "https://evil.example" } }, env(stub) as never);
  assert.equal(post.status, 403);
  const own = await accountsRouter.request(`${ORIGIN}/api/accounts/outlook/connect`, { method: "POST", headers: { Origin: ORIGIN } }, env(stub) as never);
  assert.deepEqual(await own.json(), { authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1" });
});

test("the accounts list says where a person connects Outlook", async () => {
  const stub = { listAccounts: async () => ({ configuration: "not_configured", accounts: [], providers: [] }) };
  const body = (await (await accountsRouter.request(`${ORIGIN}/api/accounts`, {}, env(stub) as never)).json()) as Record<string, unknown>;
  assert.equal(body.outlookConnectUrl, ORIGIN + "/api/accounts/outlook/connect");
  assert.ok(!("connectUrl" in body), "Gmail is not set up here");
});

// ── The owner's setup ────────────────────────────────────────────────────────────

test("the values to copy into Microsoft Entra come from the server's own address", () => {
  assert.deepEqual(microsoftSetupValues(ORIGIN), {
    appName: "Fabric Inbox", origin: ORIGIN, redirectUri: ORIGIN + "/api/accounts/outlook/callback", platform: "Web",
    accountTypes: "Any Entra ID Tenant + Personal Microsoft accounts", permissions: ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
  });
});

test("a client secret's end date is read as Microsoft Entra shows it, and warned about 30 days ahead", () => {
  const now = Date.UTC(2026, 9, 6, 12);
  assert.equal(parseSecretExpiry("2027-04-04"), Date.UTC(2027, 3, 4));
  assert.equal(parseSecretExpiry("2027-02-30"), null);
  assert.equal(parseSecretExpiry("04/04/2027"), null);
  assert.deepEqual(secretExpiry("2027-04-04", now), { date: "2027-04-04", daysLeft: 180, state: "ok" });
  assert.equal(secretExpiry("2026-11-05", now)!.state, "soon");
  assert.equal(secretExpiry("2026-10-06", now)!.state, "soon", "the last day still works");
  assert.equal(secretExpiry("2026-10-05", now)!.state, "expired");
  assert.equal(secretExpiryProblem("2026-10-01", now)!.includes("has passed"), true);
  assert.match(secretExpiryProblem("2029-10-01", now)!, /24 months/);
  assert.equal(secretExpiryProblem("2027-10-01", now), null);
});

test("what was pasted is checked first: a client ID, a secret's Value (not its Secret ID), and a date", () => {
  const good = { clientId: CLIENT_ID, clientSecret: SECRET, secretExpires: isoDay(180) };
  assert.deepEqual(pastedChecks(good), []);
  assert.deepEqual(pastedChecks({ ...good, clientId: "not-a-guid" }).map((c) => c.id), ["client_id"]);
  const secretId = pastedChecks({ ...good, clientSecret: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  assert.match(secretId[0]!.message, /Secret ID, not its Value/);
  assert.deepEqual(pastedChecks({ ...good, clientSecret: "has spaces in it, no" }).map((c) => c.id), ["client_secret"]);
  assert.deepEqual(pastedChecks({ ...good, secretExpires: "soon" }).map((c) => c.id), ["secret_expiry"]);
});

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const cf = (result: unknown, status = 200) => json(status < 300 ? { success: true, errors: [], result } : { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }, status);
function cloudflare(patch: "ok" | "forbidden" = "ok") {
  const calls: { method: string; url: string; body?: { bindings: { type: string; name: string; text?: string }[] } }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const record: (typeof calls)[number] = { method, url: url.href };
    calls.push(record);
    if (url.hostname !== "api.cloudflare.com") throw new Error("unexpected " + url.href);
    if (method === "GET") return cf({ bindings: [{ type: "durable_object_namespace", name: "MAILBOX" }, { type: "secret_text", name: "CLOUDFLARE_API_TOKEN" },
      { type: "secret_text", name: "MICROSOFT_CLIENT_SECRET" }, { type: "plain_text", name: "GOOGLE_CLIENT_ID", text: "kept" }, { type: "secret_text", name: "MAIL_CREDENTIAL_KEY" }] });
    record.body = JSON.parse(await ((init?.body as FormData).get("settings") as Blob).text());
    return patch === "forbidden" ? cf(null, 403) : cf({});
  }) as typeof fetch;
  return calls;
}
const baseEnv = { CLOUDFLARE_API_TOKEN: "t".repeat(40), CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
const setup = (path: string, e: Record<string, unknown>, init: RequestInit = {}, origin = ORIGIN) => microsoftSetupRouter.request(origin + path, init, e as never);
const put = (e: Record<string, unknown>, body: unknown, origin = ORIGIN) =>
  setup("/api/microsoft-setup", e, { method: "PUT", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }, origin);

test("GET /api/microsoft-setup says what is missing, what to copy, and when the secret ends — never the secret", async () => {
  const empty = (await (await setup("/api/microsoft-setup", baseEnv)).json()) as Record<string, any>;
  assert.equal(empty.configured, false);
  assert.deepEqual(empty.missing.sort(), ["MAIL_CREDENTIAL_KEY", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "PUBLIC_APP_URL"]);
  assert.equal(empty.values.redirectUri, ORIGIN + "/api/accounts/outlook/callback");
  assert.equal(empty.canSave, true);
  assert.equal(empty.links.appRegistrations, "https://go.microsoft.com/fwlink/?linkid=2083908");
  const set = (await (await setup("/api/microsoft-setup", { ...baseEnv, ...config, MICROSOFT_CLIENT_SECRET_EXPIRES: isoDay(10) })).json()) as Record<string, any>;
  assert.equal(set.configured, true);
  assert.equal(set.addressMatches, true);
  assert.equal(set.secretExpiry.state, "soon");
  assert.match(set.adminConsentUrl, /^https:\/\/login\.microsoftonline\.com\/organizations\/v2\.0\/adminconsent\?client_id=/);
  assert.ok(!JSON.stringify(set).includes(SECRET) && !JSON.stringify(set).includes(KEY));
});

test("PUT writes the client, its secret's date and a credential key in one change; the secret goes in as a secret and never comes back", async () => {
  const calls = cloudflare();
  const response = await put(baseEnv, { clientId: CLIENT_ID.toUpperCase(), clientSecret: SECRET, secretExpires: isoDay(200) });
  assert.equal(response.status, 202, await response.clone().text());
  const body = (await response.json()) as Record<string, any>;
  assert.equal(body.keyCreated, true);
  assert.ok(!JSON.stringify(body).includes(SECRET));
  const patch = calls.find((c) => c.method === "PATCH")!.body!.bindings;
  const by = (name: string) => patch.find((b) => b.name === name);
  assert.deepEqual(by("MICROSOFT_CLIENT_ID"), { type: "plain_text", name: "MICROSOFT_CLIENT_ID", text: CLIENT_ID });
  assert.equal(by("MICROSOFT_CLIENT_SECRET")!.type, "secret_text");
  assert.equal(by("MICROSOFT_CLIENT_SECRET")!.text, SECRET);
  assert.equal(by("MICROSOFT_CLIENT_SECRET_EXPIRES")!.text, isoDay(200));
  assert.equal(by("PUBLIC_APP_URL")!.text, ORIGIN);
  assert.equal(by("MAIL_CREDENTIAL_KEY")!.type, "secret_text");
  assert.deepEqual(by("GOOGLE_CLIENT_ID"), { type: "inherit", name: "GOOGLE_CLIENT_ID" }, "Gmail's settings are kept as they are");
  assert.deepEqual(by("MAILBOX"), { type: "inherit", name: "MAILBOX" });
  // A server that has its key keeps it: no new key is ever written over it.
  const again = cloudflare();
  await put({ ...baseEnv, MAIL_CREDENTIAL_KEY: KEY }, { clientId: CLIENT_ID, clientSecret: SECRET, secretExpires: isoDay(200) });
  assert.equal(again.find((c) => c.method === "PATCH")!.body!.bindings.find((b) => b.name === "MAIL_CREDENTIAL_KEY")!.type, "inherit");
});

test("PUT refuses what cannot work before writing anything, and says Cloudflare's refusal plainly", async () => {
  const calls = cloudflare();
  const secretId = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", secretExpires: isoDay(100) });
  assert.equal(secretId.status, 400);
  assert.match(((await secretId.json()) as { error: string }).error, /Secret ID, not its Value/);
  const old = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET, secretExpires: isoDay(-3) });
  assert.equal(old.status, 400);
  assert.equal(calls.length, 0, "nothing was asked of Cloudflare");
  const plain = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET, secretExpires: isoDay(100) }, "http://localhost:5173");
  assert.equal(plain.status, 400);
  assert.equal((await put({}, { clientId: CLIENT_ID, clientSecret: SECRET, secretExpires: isoDay(100) })).status, 503);
  cloudflare("forbidden");
  const forbidden = await put(baseEnv, { clientId: CLIENT_ID, clientSecret: SECRET, secretExpires: isoDay(100) });
  assert.equal(forbidden.status, 403);
  assert.match(((await forbidden.json()) as { error: string }).error, /Nothing was changed/);
});

test("the self-test reports the address, the secret's date and Microsoft's own answer for a connected account", async () => {
  const check = async (client: unknown, extra: Record<string, unknown> = {}, origin = ORIGIN) =>
    (await (await setup("/api/microsoft-setup/check", env({ checkMicrosoftClient: async () => client }, { MICROSOFT_CLIENT_SECRET_EXPIRES: isoDay(90), ...extra }), {}, origin)).json()) as { ok: boolean; checks: { id: string; status: string; message: string }[] };
  const fine = await check({ status: "ok", email: "a@outlook.example" });
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.checks.map((c) => `${c.id}:${c.status}`), ["redirect_uri:ok", "secret_expiry:ok", "client:ok"]);
  const none = await check({ status: "unknown", code: "no_account" });
  assert.match(none.checks.find((c) => c.id === "client")!.message, /when the first Outlook account connects/);
  assert.equal(none.ok, false);
  const expired = await check({ status: "failed", code: "microsoft_secret_expired" });
  assert.match(expired.checks.find((c) => c.id === "client")!.message, /expired/);
  const soon = await check({ status: "ok", email: "a@outlook.example" }, { MICROSOFT_CLIENT_SECRET_EXPIRES: isoDay(5) });
  assert.match(soon.checks.find((c) => c.id === "secret_expiry")!.message, /in 5 days/);
  const elsewhere = await check({ status: "ok" }, {}, "https://other.example");
  assert.equal(elsewhere.checks.find((c) => c.id === "redirect_uri")!.status, "failed");
  const unset = (await (await setup("/api/microsoft-setup/check", {})).json()) as { configured: boolean };
  assert.equal(unset.configured, false);
});
