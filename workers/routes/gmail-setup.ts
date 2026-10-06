import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { configuration } from "../providers/google-oauth";
import { CloudflareAccounts } from "../routing/accounts";
import { CloudflareApiError } from "../routing/cloudflare-api";
import { checkGoogleClient, type Check } from "../gmail-setup/google-check";
import { newCredentialKey, validCredentialKey, writeGmailSettings } from "../gmail-setup/server-settings";
import { GOOGLE_CONSOLE, GOOGLE_HELP, gmailSetupValues } from "../../shared/mail/gmail-setup";
import { gmailApiUrl, projectNumberOf } from "../../shared/mail/gmail-reasons";

/**
 * Setting up Gmail on this server from the app (SCN-051, Settings → Accounts → Gmail). The person
 * creates an OAuth client in Google Cloud with the values this answers, pastes its ID and secret,
 * and the server checks them with Google and writes its own settings with its Cloudflare token.
 * The client secret is a secret: it is never echoed, logged or returned.
 */
export const gmailSetupRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const NO_TOKEN = "This server has no Cloudflare API token of its own, so it cannot change its own settings. Set the Gmail settings with wrangler instead (docs/desktop-mail/setup.md → Gmail).";
const NOT_HTTPS = "Gmail needs this server's HTTPS address. Open the app at its https:// address and set up Gmail there.";

const originOf = (c: C) => new URL(c.req.url).origin;
const httpsOrigin = (c: C) => new URL(c.req.url).protocol === "https:";

gmailSetupRouter.use("/api/gmail-setup*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

/** What is set, what is missing, and the values to copy into Google Cloud. */
gmailSetupRouter.get("/api/gmail-setup", (c) => {
  const config = configuration(c.env);
  const origin = originOf(c);
  const clientId = c.env.GOOGLE_CLIENT_ID?.trim() || null;
  const projectNumber = projectNumberOf(clientId);
  const canWrite = new CloudflareAccounts(c.env).primary() !== null;
  return c.json({
    configured: config.status === "configured",
    missing: config.status === "configured" ? [] : config.required,
    values: gmailSetupValues(origin),
    clientId,
    projectNumber,
    credentialKey: validCredentialKey(c.env.GMAIL_TOKEN_ENCRYPTION_KEY) ? "present" : "missing",
    publicAppUrl: c.env.PUBLIC_APP_URL?.trim() || null,
    // Connecting works only at the address the server was set up with (the redirect URI's origin).
    addressMatches: config.status === "configured" ? config.origin === origin : null,
    canSave: canWrite && httpsOrigin(c),
    ...(!canWrite ? { cannotSave: NO_TOKEN } : !httpsOrigin(c) ? { cannotSave: NOT_HTTPS } : {}),
    links: { ...GOOGLE_CONSOLE, gmailApi: gmailApiUrl(projectNumber) },
    help: GOOGLE_HELP,
  });
});

export const GmailSetupInput = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(200),
}).strict();

/** Checks the client with Google, then keeps it (and a credential key if the server has none). */
gmailSetupRouter.put("/api/gmail-setup", async (c) => {
  const parsed = GmailSetupInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Paste the client ID and the client secret of your Google OAuth client." }, 400);
  if (!httpsOrigin(c)) return c.json({ error: NOT_HTTPS }, 400);
  const accounts = new CloudflareAccounts(c.env);
  const api = accounts.primary();
  if (!api) return c.json({ error: NO_TOKEN }, 503);
  const { redirectUri } = gmailSetupValues(originOf(c));
  const check = await checkGoogleClient({ ...parsed.data, redirectUri });
  // A client ID or secret Google refuses cannot work: nothing is written. A redirect URI Google does
  // not know yet is kept and said, since Google can take minutes to apply one just added.
  const refused = check.checks.find((x) => x.status === "failed" && (x.id === "client_id" || x.id === "client_secret"));
  if (refused) {
    console.warn(JSON.stringify({ event: "gmail_setup_refused", checks: summary(check.checks) }));
    return c.json({ error: `${refused.message} ${refused.fix ?? ""}`.trim(), checks: check.checks }, 400);
  }
  const pending = check.checks.find((x) => x.status === "failed");
  const credentialKey = validCredentialKey(c.env.GMAIL_TOKEN_ENCRYPTION_KEY) ? undefined : newCredentialKey();
  try {
    const accountId = await accounts.serverAccountId();
    await writeGmailSettings(api, { accountId, script: accounts.script }, {
      clientId: parsed.data.clientId, clientSecret: parsed.data.clientSecret, publicAppUrl: originOf(c), credentialKey });
  } catch (error) {
    console.error(JSON.stringify({ event: "gmail_setup_write_failed", error: (error as Error).message }));
    if (error instanceof CloudflareApiError)
      return c.json({ error: `${error.message} Nothing was changed on your server.` }, error.isPermission ? 403 : 502);
    return c.json({ error: "Your server could not save the Gmail settings. Nothing was changed; try again." }, 502);
  }
  console.log(JSON.stringify({ event: "gmail_setup_saved", keyCreated: !!credentialKey, checks: summary(check.checks) }));
  return c.json({
    saved: true,
    keyCreated: !!credentialKey,
    checks: check.checks,
    note: "Your server starts using the Gmail settings within a few seconds.",
    ...(pending ? { warning: `${pending.message} ${pending.fix ?? ""}`.trim() } : {}),
  }, 202);
});

/** The self-test of what the server holds now: its client with Google, and the address in use. */
gmailSetupRouter.get("/api/gmail-setup/check", async (c) => {
  const config = configuration(c.env);
  if (config.status !== "configured")
    return c.json({ configured: false, missing: config.required, ok: false, checks: [] });
  const check = await checkGoogleClient({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri });
  const checks: Check[] = [...check.checks];
  if (config.origin !== originOf(c))
    checks.push({ id: "redirect_uri", status: "failed",
      message: `Gmail is set up for ${config.origin}, but this app is open at ${originOf(c)}; connecting works only at the address Gmail was set up for.`,
      fix: "Open the app at that address, or save the Gmail setup again from here (and add this address's redirect URI to the client)." });
  const ok = checks.every((x) => x.status === "ok");
  console.log(JSON.stringify({ event: "gmail_setup_checked", ok, checks: summary(checks) }));
  return c.json({ configured: true, ok, checks });
});

const summary = (checks: Check[]) => checks.map((x) => `${x.id}:${x.status}`);
