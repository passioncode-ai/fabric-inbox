/**
 * The server writes its own Gmail settings (SCN-051) and Outlook settings (SCN-057), with the
 * Cloudflare API token it already holds (`CLOUDFLARE_API_TOKEN`, written by Create my server). One
 * change to the Worker's settings each:
 *
 *   Gmail:   GOOGLE_CLIENT_ID, PUBLIC_APP_URL             plain text variables
 *            GOOGLE_CLIENT_SECRET, MAIL_CREDENTIAL_KEY    secrets (the key only when the server has none)
 *   Outlook: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET_EXPIRES, PUBLIC_APP_URL   plain text variables
 *            MICROSOFT_CLIENT_SECRET, MAIL_CREDENTIAL_KEY                          secrets (the key as above)
 *
 * Every other binding is carried over unchanged as `{ type: "inherit", name }`, so the change
 * neither drops nor rewrites anything else whether Cloudflare reads the list as the whole set or as
 * a patch. Contract (Cloudflare API v4, read 2026-10-06):
 *  GET   /accounts/{a}/workers/scripts/{s}/settings   the bindings, secrets without their values
 *  PATCH /accounts/{a}/workers/scripts/{s}/settings   multipart, part "settings": { bindings }
 *  The `inherit` binding: { type: "inherit", name } keeps the binding of the latest version.
 *
 * The credential key is never replaced once it is valid: every connected account's access is
 * sealed with it, and a new key would leave them all unreadable. The running Worker's own
 * environment is not enough to know whether one exists — a key written a moment ago is not in it
 * until the new version runs — so every change here runs under one lock (workers/lib/settings-lock.ts)
 * and reads the live bindings just before it writes: a key already bound, under either name, is
 * inherited, never written again. Two requests at once (a person in Settings, an agent through
 * create_credential_key) therefore make exactly one key.
 */
import { msg } from "../../shared/i18n";
import { b64url, fromB64 } from "../providers/google-oauth";
import type { CloudflareApi } from "../routing/cloudflare-api";
import { withSettingsLock, type LockOptions } from "../lib/settings-lock";

export const GMAIL_SETTING_NAMES = ["GOOGLE_CLIENT_ID", "PUBLIC_APP_URL", "GOOGLE_CLIENT_SECRET", "MAIL_CREDENTIAL_KEY"] as const;
const WHAT_READ = msg("read your server's settings (Workers Scripts: Edit)");
const WHAT_WRITE = msg("change your server's settings (Workers Scripts: Edit)");

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

/** The names the credential key is bound under: today's, and the only one before 0.11. */
export const CREDENTIAL_KEY_NAMES = ["MAIL_CREDENTIAL_KEY", "GMAIL_TOKEN_ENCRYPTION_KEY"] as const;
/** When this server last wrote a credential key (no value): a key written this recently is never replaced. */
export const CREDENTIAL_KEY_RECORD = "config/credential-key.json";
/** Longer than a new version of the Worker takes to start running with what was written. */
export const CREDENTIAL_KEY_SETTLE_MS = 10 * 60_000;

export interface SettingsGuard {
  /** Where the lock and the credential key's record live (the Worker's own bucket). */
  bucket: R2Bucket;
  /**
   * The running Worker holds a MAIL_CREDENTIAL_KEY that is set but not a usable key (set by hand):
   * then a bound key may be replaced — unless this server wrote one in the last 10 minutes, which
   * is the usable key on its way in.
   */
  unusableKey?: boolean;
  lock?: LockOptions;
}

/** What a change wrote, and what it was asked to write but kept as it is (a credential key already bound). */
export interface SettingsWrite { written: string[]; kept: string[] }

/**
 * Writes some of the Worker's own settings in one change: `plain` as plain text variables, `secret`
 * as secrets; every other binding is inherited unchanged. The credential key setup, and the Gmail
 * and Outlook setups, all use it. Runs under the settings lock; a credential key in `secret` is
 * written only when the live bindings hold none (see the guard), else it is kept and said so.
 * Throws SettingsBusy when another change held the lock for longer than it waits.
 */
export async function writeWorkerSettings(api: CloudflareApi, target: { accountId: string; script: string }, values: {
  plain: Record<string, string>; secret: Record<string, string>;
}, guard: SettingsGuard): Promise<SettingsWrite> {
  const path = `/accounts/${target.accountId}/workers/scripts/${encodeURIComponent(target.script)}/settings`;
  return withSettingsLock(guard.bucket, async () => {
    const settings = await api.call<{ bindings?: Binding[] }>(path, { what: WHAT_READ });
    const live = (settings.bindings ?? []).filter((b) => typeof b?.name === "string");
    const secret = { ...values.secret };
    const kept: string[] = [];
    if (secret.MAIL_CREDENTIAL_KEY !== undefined && live.some((b) => (CREDENTIAL_KEY_NAMES as readonly string[]).includes(b.name))) {
      const record = await (await guard.bucket.get(CREDENTIAL_KEY_RECORD))?.json<{ createdAt?: number }>().catch(() => null);
      const recent = typeof record?.createdAt === "number" && Date.now() - record.createdAt < CREDENTIAL_KEY_SETTLE_MS;
      if (!guard.unusableKey || recent) { delete secret.MAIL_CREDENTIAL_KEY; kept.push("MAIL_CREDENTIAL_KEY"); }
    }
    const written = [...Object.keys(values.plain), ...Object.keys(secret)];
    if (!written.length) return { written, kept };
    const replaced = new Set(written);
    const bindings: Binding[] = live.filter((b) => !replaced.has(b.name)).map((b) => ({ type: "inherit", name: b.name }));
    bindings.push(
      ...Object.entries(values.plain).map(([name, text]) => ({ type: "plain_text", name, text })),
      ...Object.entries(secret).map(([name, text]) => ({ type: "secret_text", name, text })),
    );
    const form = new FormData();
    form.set("settings", new Blob([JSON.stringify({ bindings })], { type: "application/json" }));
    await api.call(path, { method: "PATCH", form, what: WHAT_WRITE });
    if (secret.MAIL_CREDENTIAL_KEY !== undefined) {
      await guard.bucket.put(CREDENTIAL_KEY_RECORD, JSON.stringify({ createdAt: Date.now() }), { httpMetadata: { contentType: "application/json" } })
        .catch((error: unknown) => console.error(JSON.stringify({ event: "credential_key_record_failed", error: (error as Error).message })));
    }
    return { written, kept };
  }, guard.lock);
}

/**
 * Writes the Gmail settings in one change. `credentialKey` is set only when the server makes a new
 * key; otherwise the one the Worker has is inherited untouched.
 */
export async function writeGmailSettings(api: CloudflareApi, target: { accountId: string; script: string }, values: {
  clientId: string; clientSecret: string; publicAppUrl: string; credentialKey?: string;
}, guard: SettingsGuard): Promise<SettingsWrite> {
  return writeWorkerSettings(api, target, {
    plain: { GOOGLE_CLIENT_ID: values.clientId, PUBLIC_APP_URL: values.publicAppUrl },
    secret: { GOOGLE_CLIENT_SECRET: values.clientSecret, ...(values.credentialKey ? { MAIL_CREDENTIAL_KEY: values.credentialKey } : {}) },
  }, guard);
}
