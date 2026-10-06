/**
 * Microsoft sign-in for Outlook accounts: the authorization code flow with PKCE on the `common`
 * endpoint (work or school and personal accounts), through the owner's own Microsoft Entra app
 * registration. Server-only; no token, secret or Microsoft error text reaches a response or a log.
 *
 * Contract (Microsoft identity platform, read 2026-10-06,
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow):
 *  GET  /common/oauth2/v2.0/authorize  client_id, response_type=code, redirect_uri, response_mode=query,
 *                                      scope, state, prompt, code_challenge, code_challenge_method=S256
 *       errors on the redirect: error (access_denied, consent_required, interaction_required, …), error_description
 *  POST /common/oauth2/v2.0/token      grant_type=authorization_code|refresh_token, client_id, client_secret,
 *                                      code + redirect_uri + code_verifier | refresh_token, scope
 *       answers access_token, expires_in, scope, refresh_token (only with offline_access; a refresh may
 *       return a new one, which replaces the old: "Replace the old refresh token with this newly
 *       acquired refresh token"); errors: invalid_grant, interaction_required, consent_required,
 *       invalid_client, unauthorized_client, temporarily_unavailable, …
 *
 * Which `error` a request gets decides what happens. Microsoft asks apps not to depend on the
 * AADSTS numbers in `error_description` (they change); they are read here only to choose a more
 * specific page — an expired secret (AADSTS7000222), an administrator's approval (AADSTS90094,
 * AADSTS90095, AADSTS65001), a redirect URI Microsoft does not know (AADSTS50011) — and a number
 * that is gone falls back to the `error` field's own page
 * (https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes).
 */
import { hasCredentialKey, type CredentialEnvironment } from "../credentials";
import { b64url, pkceChallenge, randomToken, type OAuthState, type Store } from "../google-oauth";
import { ProviderError, type Fetcher } from "../gmail-client";
import { MICROSOFT_AUTHORITY, MICROSOFT_CALLBACK_PATH, MICROSOFT_SCOPES } from "../../../shared/mail/microsoft-setup";
import type { OutlookCredentials } from "./types";

export interface MicrosoftEnvironment extends CredentialEnvironment {
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** The client secret's end date as Microsoft Entra shows it (YYYY-MM-DD): Settings warns 30 days ahead. */
  MICROSOFT_CLIENT_SECRET_EXPIRES?: string;
  PUBLIC_APP_URL?: string;
}
export interface MicrosoftConfig {
  status: "configured";
  clientId: string;
  clientSecret: string;
  origin: string;
  redirectUri: string;
}

/** The server's HTTPS origin from PUBLIC_APP_URL, or null when it is not one (the same rule as Gmail's). */
export function publicOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Whether Outlook can be connected on this server, and what is missing when it cannot. */
export function microsoftConfiguration(env: MicrosoftEnvironment): MicrosoftConfig | { status: "not_configured"; required: string[] } {
  const required = (["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"] as const).filter((k) => !env[k]?.trim());
  const origin = publicOrigin(env.PUBLIC_APP_URL);
  if (!origin) required.push("PUBLIC_APP_URL" as never);
  if (!hasCredentialKey(env)) required.push("MAIL_CREDENTIAL_KEY" as never);
  if (required.length || !origin) return { status: "not_configured", required };
  return { status: "configured", clientId: env.MICROSOFT_CLIENT_ID!.trim(), clientSecret: env.MICROSOFT_CLIENT_SECRET!.trim(), origin,
    redirectUri: origin + MICROSOFT_CALLBACK_PATH };
}

/**
 * Starts a sign-in: a state bound to this browser (by the hash of a token kept in a cookie) and a
 * PKCE verifier, kept ten minutes under `oauth:` as Gmail's are, marked as Outlook's.
 */
export async function createMicrosoftAuthorization(store: Store, config: MicrosoftConfig, now = Date.now()) {
  const state = randomToken(), verifier = randomToken(), browserToken = randomToken();
  for (const [id, old] of await store.list<OAuthState>({ prefix: "oauth:" }))
    if (old.expiresAt <= now) await store.delete(id);
  if ((await store.list({ prefix: "oauth:", limit: 101 })).size >= 100) throw new ProviderError("too_many_connections", 429);
  await store.put<OAuthState>("oauth:" + state, { verifier, browserHash: await pkceChallenge(browserToken), expiresAt: now + 600_000, provider: "outlook" });
  const url = new URL(MICROSOFT_AUTHORITY + "/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state,
    // The account picker every time: connecting a second mailbox should not silently reuse the first.
    prompt: "select_account",
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { authorizationUrl: url.toString(), browserToken };
}

/** The AADSTS number in an error description, when there is one. */
function aadsts(description: unknown): number | null {
  const match = /AADSTS(\d{4,8})/.exec(typeof description === "string" ? description : "");
  return match ? Number(match[1]) : null;
}

/**
 * What the person sees when Microsoft sent them back with an error instead of a code: one of the
 * result page's outcomes. `error_description` is read for its AADSTS number only, never shown.
 */
export function authorizeOutcome(error: string, description?: string): string {
  const code = aadsts(description);
  if (code === 90094 || code === 90095 || code === 65001) return "admin_consent_required";
  if (code === 50011) return "redirect_uri_mismatch";
  if (code === 65004) return "oauth_denied";
  switch (error) {
    case "access_denied": return "oauth_denied";
    // An organization that lets no one but an administrator allow apps answers consent_required.
    case "consent_required": return "admin_consent_required";
    case "interaction_required": case "login_required": return "signin_incomplete";
    case "unauthorized_client": case "invalid_client": case "invalid_resource": return "microsoft_account_type";
    case "server_error": case "temporarily_unavailable": return "provider_unavailable";
    default: return "oauth_failed";
  }
}

interface TokenAnswer { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }

async function tokenRequest(config: MicrosoftConfig, body: Record<string, string>, http: Fetcher): Promise<{ response: Response; data: TokenAnswer }> {
  let response: Response;
  try {
    response = await http(MICROSOFT_AUTHORITY + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, scope: MICROSOFT_SCOPES.join(" "), ...body }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ProviderError("provider_unavailable", 503);
  }
  let data: TokenAnswer = {};
  // Microsoft answers an outage with a page, not JSON: the status decides then.
  try { data = (await response.json()) as TokenAnswer; } catch { /* below */ }
  return { response, data };
}

/** A refusal of this server's own app registration: an expired or changed secret, a deleted app. */
function clientRefusal(data: TokenAnswer): ProviderError | null {
  if (data.error !== "invalid_client" && data.error !== "unauthorized_client") return null;
  return aadsts(data.error_description) === 7000222
    ? new ProviderError("microsoft_secret_expired", 502, "microsoft_secret_expired")
    : new ProviderError("microsoft_client_rejected", 502, "microsoft_client_rejected");
}

/** Every permission the server needs is in what Microsoft granted (it answers full Graph URIs). */
export function grantedAll(scope: string | undefined): boolean {
  const granted = new Set((scope ?? "").split(/\s+/).map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase()));
  return ["mail.readwrite", "mail.send"].every((s) => granted.has(s));
}

/** Redeems the code of a sign-in for tokens; each refusal names what to change. */
export async function exchangeMicrosoftCode(config: MicrosoftConfig, code: string, verifier: string, http: Fetcher = fetch): Promise<OutlookCredentials> {
  const { response, data } = await tokenRequest(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier }, http);
  if (!response.ok) {
    const refused = clientRefusal(data);
    if (refused) throw refused;
    if (aadsts(data.error_description) === 50011) throw new ProviderError("redirect_uri_mismatch", 400);
    if (data.error === "consent_required" || data.error === "interaction_required") throw new ProviderError("admin_consent_required", 403);
    if (response.status >= 500 || data.error === "temporarily_unavailable") throw new ProviderError("provider_unavailable", 503);
    // invalid_grant here is a code used twice or too late (codes last about a minute): start again.
    throw new ProviderError("oauth_failed", 400);
  }
  if (!data.access_token || !data.expires_in) throw new ProviderError("oauth_failed", 400);
  // No refresh token: offline_access was not granted, so the access would end within the hour.
  if (!data.refresh_token || !grantedAll(data.scope)) throw new ProviderError("insufficient_scope", 403, "insufficient_scope");
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

/**
 * A new access token for an account. The refresh token Microsoft returns replaces the old one (it
 * may rotate it). Only a grant that is gone (`invalid_grant`) or that needs the person
 * (`interaction_required`, `consent_required`) asks for a reconnect; the server's own client refused
 * is the setup's to fix; anything else is Microsoft being busy, and the account waits and retries.
 */
export async function refreshMicrosoftToken(config: MicrosoftConfig, credentials: OutlookCredentials, http: Fetcher = fetch): Promise<OutlookCredentials> {
  if (!credentials.refreshToken) throw new ProviderError("reconnect_required", 401, "microsoft_access_revoked");
  const { response, data } = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: credentials.refreshToken }, http);
  if (!response.ok) {
    if (data.error === "invalid_grant") throw new ProviderError("reconnect_required", 401, "microsoft_access_revoked");
    if (data.error === "interaction_required" || data.error === "consent_required") throw new ProviderError("reconnect_required", 401, "microsoft_signin_required");
    const refused = clientRefusal(data);
    if (refused) throw refused;
    if (response.status === 429) throw new ProviderError("rate_limited", 429, undefined, retryAfter(response));
    if (response.status >= 500 || data.error === "temporarily_unavailable" || data.error === "server_error") throw new ProviderError("provider_unavailable", 503);
    throw new ProviderError("oauth_failed", 502);
  }
  if (!data.access_token || !data.expires_in) throw new ProviderError("oauth_failed", 502);
  return { accessToken: data.access_token, refreshToken: data.refresh_token || credentials.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
}

/** When a throttled answer says to come back (Retry-After: seconds or an HTTP date), as epoch ms. */
export function retryAfter(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  // Bounded: at least a second, at most an hour, whatever the header says.
  return Math.min(Math.max(at, now + 1000), now + 3_600_000);
}

/** A short random id (for a folder's import generation). */
export const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(9)));
