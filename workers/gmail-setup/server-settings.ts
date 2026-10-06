/**
 * The server writes its own Gmail settings (SCN-051), with the Cloudflare API token it already
 * holds (`CLOUDFLARE_API_TOKEN`, written by Create my server). One change to the Worker's settings:
 *
 *   GOOGLE_CLIENT_ID, PUBLIC_APP_URL                 plain text variables
 *   GOOGLE_CLIENT_SECRET, MAIL_CREDENTIAL_KEY        secrets (the key only when the server has none)
 *
 * Every other binding is carried over unchanged as `{ type: "inherit", name }`, so the change
 * neither drops nor rewrites anything else whether Cloudflare reads the list as the whole set or as
 * a patch. Contract (Cloudflare API v4, read 2026-10-06):
 *  GET   /accounts/{a}/workers/scripts/{s}/settings   the bindings, secrets without their values
 *  PATCH /accounts/{a}/workers/scripts/{s}/settings   multipart, part "settings": { bindings }
 *  The `inherit` binding: { type: "inherit", name } keeps the binding of the latest version.
 *
 * The credential key is never replaced once it is valid: every connected account's access is
 * sealed with it, and a new key would leave them all unreadable.
 */
import { b64url, fromB64 } from "../providers/google-oauth";
import type { CloudflareApi } from "../routing/cloudflare-api";

export const GMAIL_SETTING_NAMES = ["GOOGLE_CLIENT_ID", "PUBLIC_APP_URL", "GOOGLE_CLIENT_SECRET", "MAIL_CREDENTIAL_KEY"] as const;
const WHAT_READ = "read your server's settings (Workers Scripts: Edit)";
const WHAT_WRITE = "change your server's settings (Workers Scripts: Edit)";

/** True when the value is a key the server can use: base64url of exactly 32 bytes. */
export function validCredentialKey(value: string | undefined): boolean {
  if (!value) return false;
  try { return fromB64(value).length === 32; } catch { return false; }
}

/** A new credential key: 32 random bytes, base64url, as MAIL_CREDENTIAL_KEY expects (workers/providers/credentials.ts). */
export function newCredentialKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

type Binding = { name: string; type: string; text?: string };

/**
 * Writes the Gmail settings in one change. `credentialKey` is set only when the server makes a new
 * key; otherwise the one the Worker has is inherited untouched.
 */
export async function writeGmailSettings(api: CloudflareApi, target: { accountId: string; script: string }, values: {
  clientId: string; clientSecret: string; publicAppUrl: string; credentialKey?: string;
}): Promise<void> {
  const path = `/accounts/${target.accountId}/workers/scripts/${encodeURIComponent(target.script)}/settings`;
  const settings = await api.call<{ bindings?: Binding[] }>(path, { what: WHAT_READ });
  const replaced = new Set<string>(["GOOGLE_CLIENT_ID", "PUBLIC_APP_URL", "GOOGLE_CLIENT_SECRET", ...(values.credentialKey ? ["MAIL_CREDENTIAL_KEY"] : [])]);
  const bindings: Binding[] = (settings.bindings ?? [])
    .filter((b) => typeof b?.name === "string" && !replaced.has(b.name))
    .map((b) => ({ type: "inherit", name: b.name }));
  bindings.push(
    { type: "plain_text", name: "GOOGLE_CLIENT_ID", text: values.clientId },
    { type: "plain_text", name: "PUBLIC_APP_URL", text: values.publicAppUrl },
    { type: "secret_text", name: "GOOGLE_CLIENT_SECRET", text: values.clientSecret },
    ...(values.credentialKey ? [{ type: "secret_text", name: "MAIL_CREDENTIAL_KEY", text: values.credentialKey }] : []),
  );
  const form = new FormData();
  form.set("settings", new Blob([JSON.stringify({ bindings })], { type: "application/json" }));
  await api.call(path, { method: "PATCH", form, what: WHAT_WRITE });
}
