import { Hono } from "hono";
import type { Env } from "../types";
import { hasCredentialKey, unusableCredentialKey } from "../providers/credentials";
import { CloudflareAccounts } from "../routing/accounts";
import { CloudflareApiError } from "../routing/cloudflare-api";
import { newCredentialKey, writeWorkerSettings } from "../gmail-setup/server-settings";
import { msg } from "../../shared/i18n";
import { SettingsBusy } from "../lib/settings-lock";

/**
 * The server's credential key from the app (SCN-053): an IMAP account's app password, and Gmail's
 * and Outlook's tokens, are kept sealed with `MAIL_CREDENTIAL_KEY` (workers/providers/credentials.ts).
 * A server created before 0.11 by hand may have none; instead of asking the person to update the
 * server from the Mac app, the server makes one and writes it into its own settings with its own
 * Cloudflare token, inheriting every other binding. A key it already has (under either name) is never
 * replaced, and the value is never returned or logged. A key written moments ago is not yet in this
 * Worker's environment, so the write runs under the settings lock and reads the live bindings first
 * (writeWorkerSettings): two requests at once — a person here, an agent through create_credential_key
 * — make exactly one key; the second is told the server has one.
 */
export const credentialKeyRouter = new Hono<{ Bindings: Env }>();

const NO_TOKEN = msg("This server has no Cloudflare API token of its own, so it cannot change its own settings. Update the server from the Mac app (it adds the key), or set MAIL_CREDENTIAL_KEY with wrangler (docs/desktop-mail/setup.md → The credential key).");

credentialKeyRouter.post("/api/credential-key", async (c) => {
  c.header("Cache-Control", "no-store");
  if (hasCredentialKey(c.env)) return c.json({ created: false, present: true });
  const accounts = new CloudflareAccounts(c.env);
  const api = accounts.primary();
  if (!api) return c.json({ error: NO_TOKEN }, 503);
  let written: string[];
  try {
    const accountId = await accounts.serverAccountId();
    ({ written } = await writeWorkerSettings(api, { accountId, script: accounts.script }, { plain: {}, secret: { MAIL_CREDENTIAL_KEY: newCredentialKey() } },
      { bucket: c.env.BUCKET, unusableKey: unusableCredentialKey(c.env) }));
  } catch (error) {
    console.error(JSON.stringify({ event: "credential_key_write_failed", error: (error as Error).message }));
    if (error instanceof SettingsBusy) return c.json({ error: error.message }, 409);
    if (error instanceof CloudflareApiError)
      return c.json({ error: msg("{error} Nothing was changed on your server.", { error: error.message }) }, error.isPermission ? 403 : 502);
    return c.json({ error: msg("Your server could not save its credential key. Nothing was changed; try again.") }, 502);
  }
  if (!written.includes("MAIL_CREDENTIAL_KEY")) {
    console.log(JSON.stringify({ event: "credential_key_already_bound" }));
    return c.json({ created: false, present: true, note: "Your server already has a credential key; it is in use within a few seconds." });
  }
  console.log(JSON.stringify({ event: "credential_key_created" }));
  return c.json({ created: true, present: true, note: msg("Your server starts using its new key within a few seconds.") }, 202);
});
