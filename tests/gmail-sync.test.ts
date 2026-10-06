import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory-store";
import { AccountService, type AccountRecord } from "../workers/providers/account-service";
import { seal, configuration } from "../workers/providers/google-oauth";
import { ProviderError } from "../workers/providers/gmail-client";

const configEnv = {
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  PUBLIC_APP_URL: "https://mail.example.invalid",
  GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });

async function fixture(http: typeof fetch, sync: AccountRecord["sync"] = { mode: "history", historyId: "10" }, expiresAt = Date.now() + 3600000) {
  const store = new MemoryStore();
  const config = configuration(configEnv);
  if (config.status !== "configured") throw new Error();
  await store.put<AccountRecord>("account:a", {
    id: "a", provider: "gmail", email: "a@example.invalid", runtime: "cloud", status: "connected", createdAt: 1,
    credentials: await seal(config.encryptionKey, "a", { accessToken: "access", refreshToken: "refresh", expiresAt }),
    sync,
  });
  return { store, service: new AccountService(store, configEnv, http) };
}

// ── P2-9: only a revoked grant disconnects; everything else backs off ─────────────

test("a Gmail 401 that a fresh token does not cure backs off; it does not disconnect the account (P2-9)", async () => {
  let tokenCalls = 0;
  const { service, store } = await fixture(async (input) => {
    const u = new URL(String(input));
    if (u.hostname === "oauth2.googleapis.com") { tokenCalls++; return json({ access_token: "fresh", expires_in: 3600 }); }
    return json({ error: { code: 401 } }, 401);
  });
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "provider_auth_failed");
  const account = (await store.get<AccountRecord>("account:a"))!;
  assert.equal(tokenCalls, 1, "one forced refresh, then the request is retried once");
  assert.equal(account.status, "error");
  assert.equal(account.error, "provider_auth_failed");
  assert.ok(account.retryAt && account.retryAt > Date.now(), "it waits and tries again");
});

test("only invalid_grant from Google's token endpoint asks for a reconnect (P2-9)", async () => {
  const { service, store } = await fixture(async () => json({ error: "invalid_grant" }, 400), undefined, 0);
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "reconnect_required");
  assert.equal((await store.get<AccountRecord>("account:a"))!.status, "reconnect_required");
});

test("a token endpoint answering 5xx with an HTML page is a transient outage, not sync_failed (P2-9)", async () => {
  const { service, store } = await fixture(async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }), undefined, 0);
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "provider_unavailable");
  const account = (await store.get<AccountRecord>("account:a"))!;
  assert.equal(account.status, "error");
  assert.equal(account.error, "provider_unavailable");
});

test("a Gmail answer that is not JSON is a provider failure with its own code (P2-9)", async () => {
  const { service, store } = await fixture(async () => new Response("<html>oops</html>", { status: 200 }));
  await assert.rejects(service.sync("a"), (e: ProviderError) => e.code === "provider_failed");
  assert.equal((await store.get<AccountRecord>("account:a"))!.error, "provider_failed");
});
