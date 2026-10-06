import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { hasCredentialKey } from "../providers/credentials";
import { microsoftConfiguration } from "../providers/outlook/oauth";
import { CloudflareAccounts } from "../routing/accounts";
import { CloudflareApiError } from "../routing/cloudflare-api";
import { newCredentialKey, writeWorkerSettings } from "../gmail-setup/server-settings";
import type { GmailAccountsDO } from "../providers/accounts-do";
import { msg } from "../../shared/i18n";
import {
  MICROSOFT_CLIENT_ID_PATTERN, MICROSOFT_ENTRA, MICROSOFT_HELP, MICROSOFT_PERMISSIONS, MICROSOFT_SECRET_PATTERN,
  adminConsentUrl, microsoftSetupValues, secretExpiry, secretExpiryProblem,
} from "../../shared/mail/microsoft-setup";

/**
 * Setting up Outlook on this server from the app (SCN-057, Settings → Accounts → Outlook). The owner
 * registers an app in Microsoft Entra with the values this answers — a human step: Microsoft gives no
 * way to register one for them — pastes its Application (client) ID, a client secret's Value and the
 * date that secret ends, and the server writes its own settings with its Cloudflare token (the
 * writer the Gmail setup uses). The client secret is a secret: never echoed, logged or returned.
 *
 * The self-test asks Microsoft with a real request — one connected Outlook account's token renewed —
 * because Microsoft checks a sign-in code's shape before the client (a made-up code is refused with
 * AADSTS9002313 whatever the client and secret; observed 2026-10-06), so nothing proves a client ID
 * and secret before the first account connects. Until then the check says so instead of guessing.
 */
export const microsoftSetupRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const NO_TOKEN = msg("This server has no Cloudflare API token of its own, so it cannot change its own settings. Set the Outlook settings with wrangler instead (docs/desktop-mail/setup.md → Outlook).");
const NOT_HTTPS = msg("Outlook needs this server's HTTPS address. Open the app at its https:// address and set up Outlook there.");

const originOf = (c: C) => new URL(c.req.url).origin;
const httpsOrigin = (c: C) => new URL(c.req.url).protocol === "https:";

export interface MicrosoftCheck {
  id: "client_id" | "client_secret" | "secret_expiry" | "redirect_uri" | "client";
  status: "ok" | "failed" | "unknown";
  message: string;
  fix?: string;
  link?: string;
}

microsoftSetupRouter.use("/api/microsoft-setup*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

/** What is set, what is missing, the values to copy into Microsoft Entra, and when the secret ends. */
microsoftSetupRouter.get("/api/microsoft-setup", (c) => {
  const config = microsoftConfiguration(c.env);
  const origin = originOf(c);
  const clientId = c.env.MICROSOFT_CLIENT_ID?.trim() || null;
  const canWrite = new CloudflareAccounts(c.env).primary() !== null;
  const values = microsoftSetupValues(origin);
  return c.json({
    configured: config.status === "configured",
    missing: config.status === "configured" ? [] : config.required,
    values,
    permissions: MICROSOFT_PERMISSIONS,
    clientId,
    secretExpiry: secretExpiry(c.env.MICROSOFT_CLIENT_SECRET_EXPIRES),
    credentialKey: hasCredentialKey(c.env) ? "present" : "missing",
    publicAppUrl: c.env.PUBLIC_APP_URL?.trim() || null,
    // Connecting works only at the address the server was set up with (the redirect URI's origin).
    addressMatches: config.status === "configured" ? config.origin === origin : null,
    canSave: canWrite && httpsOrigin(c),
    ...(!canWrite ? { cannotSave: NO_TOKEN } : !httpsOrigin(c) ? { cannotSave: NOT_HTTPS } : {}),
    // The link an organization's administrator opens to allow the app for everyone in it.
    ...(config.status === "configured" ? { adminConsentUrl: adminConsentUrl(config.clientId, config.redirectUri) } : {}),
    links: MICROSOFT_ENTRA,
    help: MICROSOFT_HELP,
  });
});

export const MicrosoftSetupInput = z.object({
  clientId: z.string().trim().min(1).max(100),
  clientSecret: z.string().trim().min(1).max(200),
  secretExpires: z.string().trim().min(1).max(20),
}).strict();

/** Checks of what was pasted that need no request: the shapes, and the secret's end date. */
export function pastedChecks(input: { clientId: string; clientSecret: string; secretExpires: string }, now = Date.now()): MicrosoftCheck[] {
  const checks: MicrosoftCheck[] = [];
  if (!MICROSOFT_CLIENT_ID_PATTERN.test(input.clientId))
    checks.push({ id: "client_id", status: "failed", message: msg("This is not an Application (client) ID."),
      fix: msg("Copy it from the Overview page of the app registration: it looks like 1a2b3c4d-… (a GUID)."), link: MICROSOFT_ENTRA.appRegistrations });
  if (MICROSOFT_CLIENT_ID_PATTERN.test(input.clientSecret))
    checks.push({ id: "client_secret", status: "failed", message: msg("This is the client secret's Secret ID, not its Value."),
      fix: msg("Copy the Value column of the client secret. Microsoft shows it only once: if it is hidden now, make a new client secret."), link: MICROSOFT_ENTRA.appRegistrations });
  else if (!MICROSOFT_SECRET_PATTERN.test(input.clientSecret))
    checks.push({ id: "client_secret", status: "failed", message: msg("This is not a client secret's Value."),
      fix: msg("Copy the Value column of the client secret in Certificates & secrets."), link: MICROSOFT_ENTRA.appRegistrations });
  const problem = secretExpiryProblem(input.secretExpires, now);
  if (problem) checks.push({ id: "secret_expiry", status: "failed", message: problem });
  return checks;
}

/** Keeps the client (and a credential key if the server has none) in the server's own settings. */
microsoftSetupRouter.put("/api/microsoft-setup", async (c) => {
  const parsed = MicrosoftSetupInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Paste the Application (client) ID, the client secret's Value and the date it expires.") }, 400);
  if (!httpsOrigin(c)) return c.json({ error: NOT_HTTPS }, 400);
  const checks = pastedChecks(parsed.data);
  if (checks.length) {
    console.warn(JSON.stringify({ event: "microsoft_setup_refused", checks: checks.map((x) => x.id) }));
    return c.json({ error: checks.map((x) => `${x.message} ${x.fix ?? ""}`.trim()).join(" "), checks }, 400);
  }
  const accounts = new CloudflareAccounts(c.env);
  const api = accounts.primary();
  if (!api) return c.json({ error: NO_TOKEN }, 503);
  // The server's credential key (MAIL_CREDENTIAL_KEY, or the older GMAIL_TOKEN_ENCRYPTION_KEY) is never replaced.
  const credentialKey = hasCredentialKey(c.env) ? undefined : newCredentialKey();
  try {
    const accountId = await accounts.serverAccountId();
    await writeWorkerSettings(api, { accountId, script: accounts.script }, {
      plain: { MICROSOFT_CLIENT_ID: parsed.data.clientId.toLowerCase(), MICROSOFT_CLIENT_SECRET_EXPIRES: parsed.data.secretExpires, PUBLIC_APP_URL: originOf(c) },
      secret: { MICROSOFT_CLIENT_SECRET: parsed.data.clientSecret, ...(credentialKey ? { MAIL_CREDENTIAL_KEY: credentialKey } : {}) },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "microsoft_setup_write_failed", error: (error as Error).message }));
    if (error instanceof CloudflareApiError)
      return c.json({ error: msg("{error} Nothing was changed on your server.", { error: error.message }) }, error.isPermission ? 403 : 502);
    return c.json({ error: msg("Your server could not save the Outlook settings. Nothing was changed; try again.") }, 502);
  }
  console.log(JSON.stringify({ event: "microsoft_setup_saved", keyCreated: !!credentialKey }));
  return c.json({
    saved: true,
    keyCreated: !!credentialKey,
    secretExpiry: secretExpiry(parsed.data.secretExpires),
    note: msg("Your server starts using the Outlook settings within a few seconds. Microsoft checks the client ID and secret when the first account connects."),
  }, 202);
});

/**
 * The self-test of what the server holds now: the address in use, the secret's end date, and — when
 * an Outlook account is connected — Microsoft renewing that account's token, which it does only for
 * a client ID and secret it accepts.
 */
microsoftSetupRouter.get("/api/microsoft-setup/check", async (c) => {
  const config = microsoftConfiguration(c.env);
  if (config.status !== "configured") return c.json({ configured: false, missing: config.required, ok: false, checks: [] });
  const checks: MicrosoftCheck[] = [];
  const origin = originOf(c);
  checks.push(config.origin === origin
    ? { id: "redirect_uri", status: "ok", message: msg("Microsoft sends sign-ins back to {uri}, this app's own address.", { uri: config.redirectUri }) }
    : { id: "redirect_uri", status: "failed", message: msg("Outlook is set up for {origin}, but this app is open at {current}; connecting works only at the address Outlook was set up for.", { origin: config.origin, current: origin }),
        fix: msg("Open the app at that address, or save the Outlook setup again from here (and add this address's redirect URI to the app registration).") });
  const expiry = secretExpiry(c.env.MICROSOFT_CLIENT_SECRET_EXPIRES);
  checks.push(!expiry
    ? { id: "secret_expiry", status: "unknown", message: msg("The date the client secret ends is not saved, so no warning comes before it does."), fix: msg("Save the setup again with the date from the Expires column.") }
    : expiry.state === "expired"
      ? { id: "secret_expiry", status: "failed", message: msg("The client secret ended on {date}.", { date: expiry.date }), fix: msg("Add a new client secret in Certificates & secrets and save it here."), link: MICROSOFT_ENTRA.appRegistrations }
      : expiry.state === "soon"
        ? { id: "secret_expiry", status: "failed", message: expiry.daysLeft === 1
            ? msg("The client secret ends on {date}, in 1 day.", { date: expiry.date })
            : msg("The client secret ends on {date}, in {days} days.", { date: expiry.date, days: expiry.daysLeft }),
            fix: msg("Add a new client secret in Certificates & secrets now and save it here; Outlook accounts stop syncing the day it ends."), link: MICROSOFT_ENTRA.appRegistrations }
        : { id: "secret_expiry", status: "ok", message: msg("The client secret ends on {date}.", { date: expiry.date }) });
  const accounts = (c.env as unknown as { GMAIL_ACCOUNTS?: DurableObjectNamespace<GmailAccountsDO> }).GMAIL_ACCOUNTS;
  let client: { status: "ok" | "failed" | "unknown"; code?: string; email?: string } = { status: "unknown", code: "no_account" };
  if (accounts) {
    try { client = await accounts.getByName("workspace").checkMicrosoftClient(); }
    catch { client = { status: "unknown", code: "account_service_unavailable" }; }
  }
  checks.push(client.status === "ok"
    ? { id: "client", status: "ok", message: msg("Microsoft accepts this server's client ID and secret (checked with {email}).", { email: client.email ?? "" }) }
    : client.code === "no_account"
      ? { id: "client", status: "unknown", message: msg("Microsoft checks the client ID and secret when the first Outlook account connects."), fix: msg("Connect an account to check them.") }
      : client.code === "microsoft_secret_expired"
        ? { id: "client", status: "failed", message: msg("Microsoft says the client secret has expired."), fix: msg("Add a new client secret in Certificates & secrets and save it here."), link: MICROSOFT_ENTRA.appRegistrations }
        : client.code === "microsoft_client_rejected"
          ? { id: "client", status: "failed", message: msg("Microsoft refuses this client ID or secret."), fix: msg("Check the app registration still exists, then save its client ID and a new client secret here."), link: MICROSOFT_ENTRA.appRegistrations }
          : { id: "client", status: "unknown", message: msg("Microsoft could not be asked just now."), fix: msg("Check again in a minute.") });
  const ok = checks.every((x) => x.status === "ok");
  console.log(JSON.stringify({ event: "microsoft_setup_checked", ok, checks: checks.map((x) => `${x.id}:${x.status}`) }));
  return c.json({ configured: true, ok, checks });
});
