/**
 * The self-test of a Google OAuth client (SCN-051): before the server keeps a client, and whenever
 * the person asks, it checks with Google itself that
 *
 *  1. the client ID has the shape Google issues,
 *  2. Google's token endpoint accepts the client ID and secret together, and
 *  3. Google knows this server's redirect URI for the client.
 *
 * (2) sends a code that cannot be valid: Google authenticates the client first, so `invalid_grant`
 * means the pair is right and `invalid_client` that it is not (the token endpoint's errors are
 * documented in RFC 6749 §5.2 and https://developers.google.com/identity/protocols/oauth2/web-server).
 *
 * (3) opens the authorization address without following it. Google answers a client and redirect
 * URI it knows with a redirect to its sign-in page, and a problem with a redirect to its error page
 * whose `authError` parameter carries the error's name (redirect_uri_mismatch, invalid_client,
 * deleted_client…). That page is Google's interface, not a documented API (observed 2026-10-06):
 * when it cannot be read the check says "unknown", never "ok".
 *
 * Nothing here is stored or logged with a secret in it. The sentences are English marked with msg();
 * Settings shows them in its language with t.text() (shared/i18n).
 */
import { msg } from "../../shared/i18n";
import { CLIENT_ID_PATTERN, CLIENT_SECRET_PATTERN, GMAIL_SCOPE, GOOGLE_CONSOLE } from "../../shared/mail/gmail-setup";

export type CheckId = "client_id" | "client_secret" | "token_endpoint" | "redirect_uri";
export interface Check {
  id: CheckId;
  status: "ok" | "failed" | "unknown";
  /** What was found, in a sentence. */
  message: string;
  /** What to do, when it is not ok. */
  fix?: string;
  /** Where in Google Cloud to do it. */
  link?: string;
}
export interface ClientCheck {
  /** Every check passed. */
  ok: boolean;
  /** A check failed: the values cannot work as they are. */
  failed: boolean;
  checks: Check[];
}
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Error names Google's error page carries, longest first so a prefix never shadows a longer name. */
const AUTH_ERRORS = ["redirect_uri_mismatch", "unauthorized_client", "admin_policy_enforced", "invalid_request", "deleted_client",
  "disabled_client", "invalid_client", "org_internal", "access_denied"];

/** The error name inside Google's `authError` value (base64 of a small binary record). */
export function authErrorName(location: string): string | null {
  let value: string | null;
  try { value = new URL(location).searchParams.get("authError"); } catch { return null; }
  if (!value) return null;
  let text = "";
  try { text = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")); } catch { return null; }
  return AUTH_ERRORS.find((name) => text.includes(name)) ?? null;
}

/**
 * Before sending a person to Google, asks Google's sign-in page whether it would only show an error
 * for this client and redirect URI. Returns the server-side problem by its public code, or null when
 * Google would show its sign-in (or did not answer in time: the person then sees Google's own page).
 */
export async function authorizationProblem(authorizationUrl: string, http: Fetcher = fetch, timeoutMs = 5_000):
  Promise<"redirect_uri_mismatch" | "google_client_rejected" | null> {
  try {
    const response = await http(authorizationUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const location = response.headers.get("Location") ?? "";
    if (!(response.status >= 300 && response.status < 400 && /\/signin\/oauth\/error/.test(location))) return null;
    const name = authErrorName(location);
    if (name === "redirect_uri_mismatch") return "redirect_uri_mismatch";
    if (name === "invalid_client" || name === "deleted_client" || name === "disabled_client") return "google_client_rejected";
    return null;
  } catch {
    return null;
  }
}

async function tokenCheck(clientId: string, clientSecret: string, redirectUri: string, http: Fetcher): Promise<Check[]> {
  let response: Response;
  try {
    response = await http(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "fabric-inbox-self-test", redirect_uri: redirectUri,
        client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return [{ id: "token_endpoint", status: "unknown", message: msg("Google's token service did not answer."), fix: msg("Check again in a minute.") }];
  }
  let data: { error?: string; error_description?: string } = {};
  try { data = (await response.json()) as typeof data; } catch { /* a page, not JSON */ }
  if (data.error === "invalid_grant")
    return [{ id: "token_endpoint", status: "ok", message: msg("Google accepts this client ID and secret together.") }];
  if (data.error === "invalid_client") {
    // Google says "The OAuth client was not found." for an unknown ID and "Unauthorized" for a wrong secret.
    return /not found/i.test(data.error_description ?? "")
      ? [{ id: "client_id", status: "failed", message: msg("Google does not know this client ID."),
          fix: msg("Copy the client ID again from Google Auth Platform → Clients; the client may also have been deleted."), link: GOOGLE_CONSOLE.clients }]
      : [{ id: "client_secret", status: "failed", message: msg("Google does not accept this client secret for this client ID."),
          fix: msg("Open the client in Google Auth Platform → Clients, add a new secret, and paste it here."), link: GOOGLE_CONSOLE.clients }];
  }
  if (data.error === "unauthorized_client")
    return [{ id: "client_id", status: "failed", message: msg("This client cannot sign in to a web server."),
      fix: msg("Create a client of the type Web application and use its ID and secret."), link: GOOGLE_CONSOLE.createClient }];
  if (data.error === "redirect_uri_mismatch")
    return [{ id: "redirect_uri", status: "failed", message: msg("Google does not have this server's redirect URI for the client."),
      fix: msg("Add the redirect URI shown above under Authorized redirect URIs of the client."), link: GOOGLE_CONSOLE.clients }];
  return [{ id: "token_endpoint", status: "unknown",
    message: response.status >= 500 ? msg("Google's token service is having problems.") : msg("Google answered {answer}.", { answer: data.error ?? "HTTP " + response.status }),
    fix: msg("Check again in a minute.") }];
}

async function redirectCheck(clientId: string, redirectUri: string, http: Fetcher): Promise<Check> {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: GMAIL_SCOPE,
    access_type: "offline", prompt: "consent", state: "fabric-inbox-self-test" }).toString();
  let response: Response;
  try {
    response = await http(url.href, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    return { id: "redirect_uri", status: "unknown", message: msg("Google's sign-in page did not answer, so the redirect URI was not checked."), fix: msg("Check again in a minute.") };
  }
  const location = response.headers.get("Location") ?? "";
  const failure = response.status >= 300 && response.status < 400 && /\/signin\/oauth\/error/.test(location) ? authErrorName(location) : null;
  if (failure === "redirect_uri_mismatch")
    return { id: "redirect_uri", status: "failed", message: msg("Google does not have this server's redirect URI for the client."),
      fix: msg("Add the redirect URI shown above under Authorized redirect URIs of the client. Google can take a few minutes to apply it."), link: GOOGLE_CONSOLE.clients };
  if (failure === "invalid_client" || failure === "deleted_client" || failure === "disabled_client")
    return { id: "client_id", status: "failed", message: failure === "invalid_client" ? msg("Google does not know this client ID.") : failure === "deleted_client" ? msg("Google says this client is deleted.") : msg("Google says this client is disabled."),
      fix: msg("Create a Web application client in Google Auth Platform → Clients and use its ID and secret."), link: GOOGLE_CONSOLE.clients };
  if (failure)
    return { id: "redirect_uri", status: "unknown", message: msg("Google's sign-in page answered {answer}.", { answer: failure }), fix: msg("Connect an account to see Google's own page.") };
  // Google sends a request it can serve on to its sign-in page (accounts.google.com).
  if (response.status >= 300 && response.status < 400 && /^https:\/\/accounts\.google\.com\//.test(location))
    return { id: "redirect_uri", status: "ok", message: msg("Google knows this server's redirect URI for the client.") };
  return { id: "redirect_uri", status: "unknown", message: msg("Google's sign-in page answered in a way this check cannot read."), fix: msg("Connect an account to see Google's own page.") };
}

/** Runs every check; a malformed client ID or secret stops before anything is sent to Google. */
export async function checkGoogleClient(input: { clientId: string; clientSecret: string; redirectUri: string }, http: Fetcher = fetch): Promise<ClientCheck> {
  const clientId = input.clientId.trim(), clientSecret = input.clientSecret.trim();
  const checks: Check[] = [];
  if (!CLIENT_ID_PATTERN.test(clientId))
    checks.push({ id: "client_id", status: "failed", message: msg("This is not an OAuth client ID."),
      fix: msg("Copy the client ID from Google Auth Platform → Clients: it ends in .apps.googleusercontent.com."), link: GOOGLE_CONSOLE.clients });
  if (!CLIENT_SECRET_PATTERN.test(clientSecret))
    checks.push({ id: "client_secret", status: "failed", message: msg("This is not an OAuth client secret."),
      fix: msg("Copy the secret from the client in Google Auth Platform → Clients (it starts with GOCSPX-)."), link: GOOGLE_CONSOLE.clients });
  if (!checks.length) {
    const [token, redirect] = await Promise.all([tokenCheck(clientId, clientSecret, input.redirectUri, http), redirectCheck(clientId, input.redirectUri, http)]);
    checks.push(...token);
    // One answer per check: the token endpoint's verdict on the client wins over the sign-in page's.
    if (!checks.some((c) => c.id === redirect.id)) checks.push(redirect);
  }
  return { ok: checks.every((c) => c.status === "ok"), failed: checks.some((c) => c.status === "failed"), checks };
}
