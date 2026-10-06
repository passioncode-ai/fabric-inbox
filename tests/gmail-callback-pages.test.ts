import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { accountsRouter } from "../workers/routes/accounts";
import { resultPage } from "../workers/gmail-setup/result-page";
import { ProviderError } from "../workers/providers/gmail-client";
import { createT } from "../shared/i18n";

/**
 * SCN-002 / SCN-003: the end of connecting Gmail is a page in the app's style for success and for
 * every failure, with the one next step — never raw JSON in the browser (audit: routes/accounts.ts
 * returned the error handler's JSON from the callback). Google is a fake.
 */
const ORIGIN = "https://fabric-inbox.owner.workers.dev";
const config = {
  GOOGLE_CLIENT_ID: "123456789012-abcdefghijklmnop" + ".apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-test",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  PUBLIC_APP_URL: ORIGIN,
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function callbackEnv(outcome: () => Promise<unknown>) {
  return { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ callback: outcome }) } };
}
async function callback(outcome: () => Promise<unknown>, query = "state=s&code=c") {
  const response = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/callback?${query}`,
    { headers: { Cookie: "__Host-fabric-gmail-state=b" } }, callbackEnv(outcome) as never);
  return { response, html: await response.text() };
}
const fail = (code: string) => async () => { throw new ProviderError(code); };
// Over Durable Object RPC an error arrives as a plain Error whose message is the code.
const failRpc = (code: string) => async () => { throw new Error(code); };

test("every outcome is a branded HTML page that can run nothing, never JSON", async () => {
  for (const outcome of ["connected", "oauth_denied", "insufficient_scope", "gmail_api_disabled", "redirect_uri_mismatch", "google_client_rejected",
    "invalid_state", "oauth_failed", "invalid_profile", "not_configured", "invalid_origin", "too_many_connections", "provider_unavailable", "something_new"]) {
    const response = resultPage({ outcome, email: "a@example.invalid" });
    const html = await response.text();
    assert.match(response.headers.get("Content-Type")!, /^text\/html; charset=utf-8/, outcome);
    assert.match(response.headers.get("Content-Security-Policy")!, /default-src 'none'/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /Fabric Inbox · Gmail/);
    assert.ok(!/<script/i.test(html), outcome);
    assert.ok(!html.trim().startsWith("{"), outcome);
  }
});

test("a connected account's page names it and says to go back to the app", async () => {
  const { response, html } = await callback(async () => ({ id: "g1", email: "me@example.invalid", status: "connected" }));
  assert.equal(response.status, 200);
  assert.match(html, /Gmail is connected/);
  assert.match(html, /me@example\.invalid/);
  assert.match(html, /go back to Fabric Inbox/);
  assert.ok(!/only until/.test(html), "no expiry warning when Google gave no end date");
});

test("access Google limited to 7 days (a Testing app) is warned about on the spot, with where to publish", async () => {
  const until = Date.UTC(2026, 9, 13, 12);
  const { html } = await callback(async () => ({ id: "g1", email: "me@example.invalid", status: "connected", accessUntil: until }));
  assert.match(html, /only until Tue, 13 Oct 2026 12:00:00 GMT/);
  assert.match(html, /Publish app/);
  assert.match(html, /https:\/\/console\.cloud\.google\.com\/auth\/audience/);
});

test("Cancel on Google's page says nothing was saved, and how to get past Testing's gate", async () => {
  const { response, html } = await callback(fail("oauth_denied"), "state=s&error=access_denied");
  assert.equal(response.status, 400);
  assert.match(html, /Gmail was not connected/);
  assert.match(html, /nothing was saved/);
  assert.match(html, /Test users/);
  assert.match(html, /\/api\/accounts\/gmail\/connect/, "one action: connect again");
});

test("another refusal from Google is named, and a name that is not one is never echoed", async () => {
  const named = await callback(fail("oauth_denied"), "state=s&error=admin_policy_enforced");
  assert.match(named.html, /Google stopped the sign-in/);
  assert.match(named.html, /admin_policy_enforced/);
  const injected = await callback(fail("oauth_denied"), "state=s&error=" + encodeURIComponent("<script>alert(1)</script>"));
  assert.ok(!injected.html.includes("alert(1)"));
  assert.match(injected.html, /unknown_error/);
});

test("an unticked Gmail box says to tick it", async () => {
  const { response, html } = await callback(failRpc("insufficient_scope"));
  assert.equal(response.status, 403);
  assert.match(html, /The Gmail box was not ticked/);
  assert.match(html, /tick the box/);
});

test("the Gmail API switched off links to the project's own Gmail API page", async () => {
  const { html } = await callback(failRpc("gmail_api_disabled"));
  assert.match(html, /The Gmail API is off/);
  assert.match(html, /gmail\.googleapis\.com\/overview\?project=123456789012/);
});

test("a redirect URI Google does not know shows the exact URI to add", async () => {
  const { html } = await callback(failRpc("redirect_uri_mismatch"));
  assert.match(html, /<code>https:\/\/fabric-inbox\.owner\.workers\.dev\/api\/accounts\/gmail\/callback<\/code>/);
  assert.match(html, /Authorized redirect URIs/);
});

test("each other failure has its own words", async () => {
  const cases: [string, RegExp, number][] = [
    ["invalid_state", /This sign-in has expired/, 403],
    ["oauth_failed", /Google did not finish the sign-in/, 400],
    ["invalid_profile", /did not say which Gmail account/, 502],
    ["google_client_rejected", /refused this server&#39;s OAuth client/, 502],
    ["too_many_connections", /Too many sign-ins/, 429],
    ["provider_unavailable", /Google could not be reached/, 503],
    ["account_service_unavailable", /could not finish connecting \(account_service_unavailable\)/, 502],
  ];
  for (const [code, pattern, status] of cases) {
    const { response, html } = await callback(failRpc(code));
    assert.match(html, pattern, code);
    assert.equal(response.status, status, code);
  }
});

test("the callback clears the state cookie whatever the outcome", async () => {
  for (const outcome of [async () => ({ id: "g", email: "a@b.invalid", status: "connected" }), fail("invalid_state")]) {
    const { response } = await callback(outcome);
    assert.match(response.headers.get("Set-Cookie") ?? "", /__Host-fabric-gmail-state=;.*Max-Age=0/);
  }
});

test("Gmail not set up, or the wrong address, is a page too", async () => {
  const off = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/callback?state=s`, {}, {} as never);
  assert.match(await off.text(), /Gmail is not set up on this server/);
  const elsewhere = await accountsRouter.request(`https://other.example/api/accounts/gmail/connect`, {}, callbackEnv(async () => ({})) as never);
  assert.equal(elsewhere.status, 403);
  assert.match(await elsewhere.text(), /Gmail is set up for https:\/\/fabric-inbox\.owner\.workers\.dev/);
});

test("an address in the page is escaped", async () => {
  const { html } = await callback(async () => ({ id: "g", email: "<b>x</b>@example.invalid", status: "connected" }));
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;@example.invalid"));
});

// ── Before leaving for Google ───────────────────────────────────────────────────

function connectEnv() {
  return { ...config, GMAIL_ACCOUNTS: { getByName: () => ({ beginConnect: async () => ({
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s", browserToken: "opaque" }) }) } };
}
const googleAnswers = (location: string | null, fail = false) => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    if (fail) throw new TypeError("offline");
    return new Response(null, { status: 302, headers: location ? { Location: location } : {} });
  }) as typeof fetch;
};
const mismatch = "https://accounts.google.com/signin/oauth/error?authError=" + Buffer.from("\n\x15redirect_uri_mismatch\x12\x05x", "latin1").toString("base64url");
const unknownClient = "https://accounts.google.com/signin/oauth/error?authError=Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw";

test("a redirect URI Google would refuse is said here, before the person reaches Google's dead end", async () => {
  googleAnswers(mismatch);
  const response = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/connect`, {}, connectEnv() as never);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("Location"), null);
  assert.equal(response.headers.get("Set-Cookie"), null, "no sign-in was started in this browser");
  assert.match(await response.text(), /<code>https:\/\/fabric-inbox\.owner\.workers\.dev\/api\/accounts\/gmail\/callback<\/code>/);
});

test("a client Google does not know is said here too", async () => {
  googleAnswers(unknownClient);
  const response = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/connect`, {}, connectEnv() as never);
  assert.match(await response.text(), /refused this server&#39;s OAuth client/);
});

test("when Google's page cannot be asked, the person goes to Google as before", async () => {
  googleAnswers(null, true);
  const response = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/connect`, {}, connectEnv() as never);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Location")!, /^https:\/\/accounts\.google\.com\//);
  assert.match(response.headers.get("Set-Cookie")!, /__Host-fabric-gmail-state=opaque/);
});

// ── The person's language (L10N-01) ─────────────────────────────────────────────

test("a result page speaks Russian for a Russian sign-in and stays English otherwise, values still escaped", async () => {
  const ru = await resultPage({ outcome: "connected", email: "<b>x</b>@example.invalid" }, createT("ru")).text();
  assert.match(ru, /<html lang="ru">/);
  assert.match(ru, /Gmail подключён/);
  assert.match(ru, /Можно закрыть эту вкладку/);
  assert.ok(ru.includes("&lt;b&gt;x&lt;/b&gt;@example.invalid"), "the address is escaped in Russian too");
  const failed = await resultPage({ outcome: "invalid_state" }, createT("ru")).text();
  assert.match(failed, /href="\/api\/accounts\/gmail\/connect\?lang=ru"/, "connecting again keeps the language");
  assert.match(failed, /Ничего не сохранено\./);
  const en = await resultPage({ outcome: "invalid_state" }).text();
  assert.match(en, /<html lang="en">/);
  assert.match(en, /This sign-in has expired/);
  assert.match(en, /href="\/api\/accounts\/gmail\/connect"/, "English links stay bare");
});

test("connecting keeps the language it started in beside the sign-in's state, and the callback renders in it", async () => {
  googleAnswers(null, true);
  const ru = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/connect?lang=ru`, {}, connectEnv() as never);
  assert.equal(ru.status, 302, "an extra query changes nothing about connecting");
  assert.match(ru.headers.get("Set-Cookie")!, /__Host-fabric-gmail-lang=ru; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const byHeader = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/connect`, { headers: { "Accept-Language": "ru-RU,ru;q=0.9" } }, connectEnv() as never);
  assert.match(byHeader.headers.get("Set-Cookie")!, /__Host-fabric-gmail-lang=ru/, "without ?lang= the browser's language is kept");
  const unknown = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/connect?lang=xx`, {}, connectEnv() as never);
  assert.equal(unknown.status, 302);
  assert.match(unknown.headers.get("Set-Cookie")!, /__Host-fabric-gmail-lang=en/, "a language this app does not speak is English");

  const back = async (cookie: string, headers: Record<string, string> = {}) => {
    const response = await accountsRouter.request(`${ORIGIN}/api/accounts/gmail/callback?state=s&code=c`,
      { headers: { Cookie: cookie, ...headers } }, callbackEnv(async () => ({ id: "g1", email: "me@example.invalid", status: "connected" })) as never);
    return { response, html: await response.text() };
  };
  const kept = await back("__Host-fabric-gmail-state=b; __Host-fabric-gmail-lang=ru", { "Accept-Language": "en-US" });
  assert.match(kept.html, /<html lang="ru">/, "the kept language wins over the callback browser's");
  assert.match(kept.html, /Gmail подключён/);
  assert.match(kept.response.headers.get("Set-Cookie")!, /__Host-fabric-gmail-lang=;.*Max-Age=0/, "and is cleared with the state");
  const english = await back("__Host-fabric-gmail-state=b; __Host-fabric-gmail-lang=en", { "Accept-Language": "ru" });
  assert.match(english.html, /<html lang="en">/);
  assert.match(english.html, /Gmail is connected/);
  const lost = await back("__Host-fabric-gmail-state=b", { "Accept-Language": "ru-RU" });
  assert.match(lost.html, /<html lang="ru">/, "with no kept language, the callback request's own decides");
  const none = await back("__Host-fabric-gmail-state=b");
  assert.match(none.html, /<html lang="en">/);
  assert.match(none.html, /Gmail is connected/);
});
