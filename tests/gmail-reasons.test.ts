import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory-store";
import { AccountService, accountProblem, grantEndReason, type AccountRecord } from "../workers/providers/account-service";
import { seal, unseal, configuration } from "../workers/providers/google-oauth";
import { ProviderError, exchangeCode, forbidden, GmailClient } from "../workers/providers/gmail-client";
import { accountsRouter } from "../workers/routes/accounts";
import { GMAIL_REASONS, GMAIL_REASON_TEXT, gmailApiUrl, gmailReason, projectNumberOf } from "../shared/mail/gmail-reasons";

/**
 * WS6 (0.11.0): a Gmail account that stops working says why — on the account, after a sync and
 * after a write — and each cause has its own words and its own next action (SCN-003).
 */
const configEnv = {
  GOOGLE_CLIENT_ID: "123456789012-abc" + ".apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-secret",
  PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const DAY = 86_400_000;
const apiDisabled = {
  error: {
    code: 403, status: "PERMISSION_DENIED",
    message: "Gmail API has not been used in project 123456789012 before or it is disabled.",
    errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
  },
};
const scopeMissing = {
  error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.",
    errors: [{ reason: "insufficientPermissions" }], details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
};

async function fixture(http: typeof fetch, extra: Partial<AccountRecord> = {}, expiresAt = Date.now() + 3_600_000) {
  const store = new MemoryStore();
  const config = configuration(configEnv);
  if (config.status !== "configured") throw new Error();
  await store.put<AccountRecord>("account:a", {
    id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "access", refreshToken: "refresh", expiresAt }),
    sync: { mode: "history", historyId: "10" }, ...extra,
  });
  return { store, service: new AccountService(store, configEnv, http) };
}
const saved = async (store: MemoryStore) => (await store.get<AccountRecord>("account:a"))!;

// ── Each cause, in words ─────────────────────────────────────────────────────────

test("every reason has a short line, an explanation and one next action", () => {
  for (const reason of GMAIL_REASONS) {
    const text = GMAIL_REASON_TEXT[reason];
    assert.ok(text.short && text.explain && text.fix, reason);
    assert.ok(["reconnect", "setup", "enable_api"].includes(text.action), reason);
  }
  assert.match(GMAIL_REASON_TEXT.testing_expiry.fix, /Publish app/);
  assert.match(GMAIL_REASON_TEXT.insufficient_scope.fix, /tick the Gmail box/);
  assert.equal(gmailReason({ reason: "made_up" }), null, "an unknown reason is not shown as one");
  assert.equal(gmailReason({ reason: "gmail_api_disabled" })?.action, "enable_api");
});

test("the Gmail API link names the project the client belongs to, as Google's own error does", () => {
  assert.equal(projectNumberOf("123456789012-abc" + ".apps.googleusercontent.com"), "123456789012");
  assert.equal(projectNumberOf("not-a-client"), null);
  assert.equal(gmailApiUrl("123456789012"), "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123456789012");
  assert.equal(gmailApiUrl(null), "https://console.cloud.google.com/apis/library/gmail.googleapis.com");
});

test("a Gmail 403 is read by its reason: API off, scope missing, quota, or a plain failure", () => {
  assert.equal(forbidden(["accessNotConfigured"]).code, "gmail_api_disabled");
  assert.equal(forbidden(["SERVICE_DISABLED"]).code, "gmail_api_disabled");
  assert.equal(forbidden(["insufficientPermissions"]).code, "insufficient_scope");
  assert.equal(forbidden(["userRateLimitExceeded"]).code, "rate_limited");
  assert.equal(forbidden(["userRateLimitExceeded"]).status, 429);
  assert.equal(forbidden([]).code, "provider_failed");
});

test("a grant that ends about 7 days after it was given is a Testing app's; otherwise it was removed", () => {
  const now = 100 * DAY;
  assert.equal(grantEndReason({ connectedAt: now - 7 * DAY - 3_600_000 }, now), "testing_expiry");
  assert.equal(grantEndReason({ connectedAt: now - 7 * DAY + 3_600_000 }, now), "testing_expiry", "the first refresh after expiry may be within the hour");
  assert.equal(grantEndReason({ connectedAt: now - 30 * DAY }, now), "access_revoked");
  assert.equal(grantEndReason({ connectedAt: now - 2 * DAY }, now), "access_revoked");
  assert.equal(grantEndReason({}, now), "access_revoked", "an account connected before connectedAt was kept says nothing it cannot know");
  assert.equal(grantEndReason({ connectedAt: now - DAY, accessUntil: now - 1000 }, now), "testing_expiry", "Google's own end date decides");
});

test("only causes about the account itself are kept on it", () => {
  assert.equal(accountProblem(new ProviderError("not_found", 404), {}), null);
  assert.equal(accountProblem(new ProviderError("rate_limited", 429), {}), null);
  assert.equal(accountProblem(new Error("x"), {}), null);
  assert.deepEqual(accountProblem(new ProviderError("insufficient_scope", 403), {}),
    { status: "reconnect_required", error: "reconnect_required", reason: "insufficient_scope" });
  assert.deepEqual(accountProblem(new ProviderError("gmail_api_disabled", 403), {}),
    { status: "error", error: "gmail_api_disabled", reason: "gmail_api_disabled" });
  assert.deepEqual(accountProblem(new ProviderError("google_client_rejected", 502, "client_rejected"), {}),
    { status: "error", error: "google_client_rejected", reason: "client_rejected" });
});

// ── The Gmail client maps Google's answers ──────────────────────────────────────

test("the Gmail API switched off is its own code, not a provider failure retried with no hint", async () => {
  const client = new GmailClient(configEnv, { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, async () => {},
    async () => json(apiDisabled, 403));
  await assert.rejects(client.profile(), (e: ProviderError) => e.code === "gmail_api_disabled" && e.status === 403);
});

test("a refresh Google refuses for the client (deleted, secret changed) is the server's setup, not a reconnect", async () => {
  const client = new GmailClient(configEnv, { accessToken: "a", refreshToken: "r", expiresAt: 0 }, async () => {},
    async () => json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401));
  await assert.rejects(client.profile(), (e: ProviderError) => e.code === "google_client_rejected" && e.reason === "client_rejected");
});

test("a write refused with 401 asks the token endpoint whether the grant is gone, and never repeats the write", async () => {
  let writes = 0;
  const http = (grant: "gone" | "fine") => async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth2.googleapis.com") return grant === "gone" ? json({ error: "invalid_grant" }, 400) : json({ access_token: "fresh", expires_in: 3600 });
    if (init?.method === "POST") { writes++; return json({ error: { code: 401 } }, 401); }
    return json({});
  };
  const gone = new GmailClient(configEnv, { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, async () => {}, http("gone"));
  await assert.rejects(gone.modify("m", [], ["UNREAD"]), (e: ProviderError) => e.code === "reconnect_required" && e.reason === "invalid_grant");
  let persisted = 0;
  const fine = new GmailClient(configEnv, { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, async () => { persisted++; }, http("fine"));
  await assert.rejects(fine.modify("m", [], ["UNREAD"]), (e: ProviderError) => e.code === "provider_auth_failed");
  assert.equal(writes, 2, "each write was sent once");
  assert.equal(persisted, 1, "the fresh token is kept for the next action");
});

test("the code exchange names a refused client, a redirect address Google does not know, and an unticked box", async () => {
  const answer = (body: unknown, status = 400) => async () => json(body, status);
  await assert.rejects(exchangeCode(configEnv, "c", "v", "https://x/cb", answer({ error: "invalid_client" }, 401)), (e: ProviderError) => e.code === "google_client_rejected");
  await assert.rejects(exchangeCode(configEnv, "c", "v", "https://x/cb", answer({ error: "redirect_uri_mismatch" })), (e: ProviderError) => e.code === "redirect_uri_mismatch");
  await assert.rejects(exchangeCode(configEnv, "c", "v", "https://x/cb", answer({ error: "invalid_grant" })), (e: ProviderError) => e.code === "oauth_failed");
  await assert.rejects(exchangeCode(configEnv, "c", "v", "https://x/cb", async () => new Response("<html>", { status: 502 })), (e: ProviderError) => e.code === "provider_unavailable");
  await assert.rejects(exchangeCode(configEnv, "c", "v", "https://x/cb", answer({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email" }, 200)),
    (e: ProviderError) => e.code === "insufficient_scope");
  const limited = await exchangeCode(configEnv, "c", "v", "https://x/cb", answer({ access_token: "a", refresh_token: "r", expires_in: 3600,
    refresh_token_expires_in: 604_799, scope: "https://www.googleapis.com/auth/gmail.modify" }, 200));
  assert.ok(limited.refreshExpiresAt && Math.abs(limited.refreshExpiresAt - (Date.now() + 604_799_000)) < 5000);
});

// ── Kept on the account, by a sync and by a write ───────────────────────────────

test("a sync that meets invalid_grant 7 days after connecting says the Testing app ended it", async () => {
  const { service, store } = await fixture(async () => json({ error: "invalid_grant" }, 400), { connectedAt: Date.now() - 7 * DAY - 600_000 }, 0);
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "reconnect_required");
  const account = await saved(store);
  assert.equal(account.status, "reconnect_required");
  assert.equal(account.error, "reconnect_required");
  assert.equal(account.reason, "testing_expiry");
  assert.ok(!("credentials" in (await service.listAccounts()).accounts[0]!));
  assert.equal((await service.listAccounts()).accounts[0]!.reason, "testing_expiry", "the reason is public; the credentials are not");
});

test("a sync that meets the Gmail API switched off keeps waiting and says why; a later good sync clears it", async () => {
  let off = true;
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (off) return json(apiDisabled, 403);
    if (u.pathname.includes("/history")) return json({ historyId: "11" });
    return json({ emailAddress: "a@example.invalid", historyId: "11" });
  });
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "gmail_api_disabled");
  let account = await saved(store);
  assert.equal(account.status, "error");
  assert.equal(account.reason, "gmail_api_disabled");
  assert.ok(account.retryAt && account.retryAt > Date.now(), "it backs off rather than hammering Google");
  off = false;
  await store.put("account:a", { ...account, retryAt: undefined });
  await service.sync("a", { historyOnly: true });
  account = await saved(store);
  assert.equal(account.status, "connected");
  assert.equal(account.reason, undefined);
  assert.equal(account.error, undefined);
});

test("a write whose grant is gone updates the account, as a sync would (audit: 401 on a write changed nothing)", async () => {
  const { service, store } = await fixture(async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth2.googleapis.com") return json({ error: "invalid_grant" }, 400);
    return init?.method === "POST" ? json({ error: { code: 401 } }, 401) : json({});
  }, { connectedAt: Date.now() - 40 * DAY });
  await assert.rejects(service.setRead("a", "m1", true), (e: ProviderError) => e.code === "reconnect_required");
  const account = await saved(store);
  assert.equal(account.status, "reconnect_required");
  assert.equal(account.reason, "access_revoked");
});

test("a send that meets the Gmail API switched off is an unknown outcome and the account says why", async () => {
  const { service, store } = await fixture(async () => json(apiDisabled, 403));
  const receipt = await service.send("a", { idempotencyKey: "k1", to: ["b@example.invalid"], subject: "s", text: "t" });
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.error, "gmail_api_disabled");
  assert.equal((await saved(store)).reason, "gmail_api_disabled");
});

test("a reply that meets an unticked scope says to reconnect with the box ticked", async () => {
  const { service, store } = await fixture(async () => json(scopeMissing, 403));
  await assert.rejects(service.archive("a", "m1"), (e: ProviderError) => e.code === "insufficient_scope");
  const account = await saved(store);
  assert.equal(account.status, "reconnect_required");
  assert.equal(account.reason, "insufficient_scope");
});

test("saved access the server's key cannot open asks for a reconnect, with its reason", async () => {
  const { service, store } = await fixture(async () => json({}));
  const other = await seal(Buffer.alloc(32, 1).toString("base64url"), "a", { accessToken: "x", refreshToken: "y", expiresAt: 0 });
  await store.put("account:a", { ...(await saved(store)), credentials: other });
  await assert.rejects(service.getAttachment("a", "m1", "att"), (e: ProviderError) => e.code === "reconnect_required");
  const account = await saved(store);
  assert.equal(account.status, "reconnect_required");
  assert.equal(account.reason, "credentials_unreadable");
});

test("a reconnect records when access was given and Google's end date, and clears the old reason", async () => {
  const { service, store } = await fixture(async (input) =>
    String(input).includes("/token")
      ? json({ access_token: "a2", refresh_token: "refresh-token-fixture-two", expires_in: 3600, refresh_token_expires_in: 604_799, scope: "https://www.googleapis.com/auth/gmail.modify" })
      : json({ emailAddress: "a@example.invalid", historyId: "10" }),
  { status: "reconnect_required", error: "reconnect_required", reason: "testing_expiry" });
  const flow = await service.connect();
  const before = Date.now();
  const account = await service.callback(new URL(flow.authorizationUrl).searchParams.get("state")!, flow.browserToken, "code");
  assert.equal(account.id, "a", "the same account, connected again");
  assert.equal(account.status, "connected");
  assert.equal(account.reason, undefined);
  assert.ok(account.connectedAt! >= before);
  assert.ok(account.accessUntil! > Date.now() + 6 * DAY, "Google's end date is kept so the app can warn about it");
  assert.ok(!JSON.stringify(await store.get("account:a")).includes("refresh-token-fixture-two"), "the refresh token stays sealed");
});

// ── The credential envelope ─────────────────────────────────────────────────────

test("envelopes sealed before 0.11 still open, and one carrying Google's end date round-trips", async () => {
  const key = configEnv.GMAIL_TOKEN_ENCRYPTION_KEY;
  // A version 1 envelope as 0.10 wrote it: no end date in the sealed value.
  const old = await seal(key, "a", { accessToken: "x", refreshToken: "y", expiresAt: 5 });
  assert.equal(old.version, 1);
  assert.deepEqual(await unseal(key, "a", old), { accessToken: "x", refreshToken: "y", expiresAt: 5 });
  const limited = await seal(key, "a", { accessToken: "x", refreshToken: "y", expiresAt: 5, refreshExpiresAt: 9 });
  assert.equal((await unseal<{ refreshExpiresAt?: number }>(key, "a", limited)).refreshExpiresAt, 9);
  await assert.rejects(unseal(key, "b", old), "an envelope opens only for the account it was sealed for");
});

// ── The HTTP answers ────────────────────────────────────────────────────────────

test("the routes answer each new cause with its own public code and status", async () => {
  const origin = configEnv.PUBLIC_APP_URL;
  for (const [code, status] of [["gmail_api_disabled", 403], ["google_client_rejected", 502], ["invalid_profile", 502], ["redirect_uri_mismatch", 400]] as const) {
    const env = { ...configEnv, GMAIL_ACCOUNTS: { getByName: () => ({ listMessages: async () => { throw new ProviderError(code); } }) } };
    const response = await accountsRouter.request(origin + "/api/accounts/a/messages", {}, env as never);
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code });
  }
});
