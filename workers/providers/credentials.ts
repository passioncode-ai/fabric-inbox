/**
 * The server's credential store: every mail account's secret (a Gmail refresh token, an IMAP app
 * password) is sealed here with AES-256-GCM before it is written, bound to its account by the
 * additional data, and opened only inside the accounts object. No secret is logged or answered.
 *
 * Keys (Worker secrets, each 32 random bytes in base64 or base64url):
 *
 * - `MAIL_CREDENTIAL_KEY` seals. Before 0.11 the only key was `GMAIL_TOKEN_ENCRYPTION_KEY`; it is
 *   the key when `MAIL_CREDENTIAL_KEY` is absent, and an old key otherwise.
 * - `MAIL_CREDENTIAL_KEY_PREVIOUS` (commas or spaces) lists older keys that still open what they
 *   sealed. Rotating: set the new key as MAIL_CREDENTIAL_KEY and the old one here; each account is
 *   sealed again with the new key the next time it is used (every sync), after which the old key
 *   can go.
 *
 * Envelopes: version 1 (before 0.11) is `{ version: 1, iv, ciphertext }` with no key id, tried
 * against every key; version 2 adds `kid`, a fingerprint of the sealing key (the first 9 bytes of
 * its SHA-256), so the right key is chosen without trying and a rotation can be watched.
 */
import { b64url, fromB64, type Envelope as EnvelopeV1 } from "./google-oauth";

export interface EnvelopeV2 { version: 2; kid: string; iv: string; ciphertext: string }
export type CredentialEnvelope = EnvelopeV1 | EnvelopeV2;

export interface CredentialEnvironment {
  MAIL_CREDENTIAL_KEY?: string;
  MAIL_CREDENTIAL_KEY_PREVIOUS?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
}
export interface CredentialKey { secret: string; id: string }
export interface CredentialKeys { current: CredentialKey; previous: CredentialKey[] }

function keyBytes(secret: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = fromB64(secret.trim().replace(/=+$/, ""));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** The fingerprint a version 2 envelope names its key by. */
export async function keyId(secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", keyBytes(secret) ?? new TextEncoder().encode(secret)));
  return b64url(digest.slice(0, 9));
}

/** Whether this server holds a usable key: without one no account can be connected. */
export function hasCredentialKey(env: CredentialEnvironment): boolean {
  if (env.MAIL_CREDENTIAL_KEY !== undefined && env.MAIL_CREDENTIAL_KEY !== "" && !keyBytes(env.MAIL_CREDENTIAL_KEY)) return false;
  return !!keyBytes(env.MAIL_CREDENTIAL_KEY ?? "") || !!keyBytes(env.GMAIL_TOKEN_ENCRYPTION_KEY ?? "");
}

/** The keys this server holds, or null when it holds no usable key (no account can be connected). */
export async function credentialKeys(env: CredentialEnvironment): Promise<CredentialKeys | null> {
  const named = [env.MAIL_CREDENTIAL_KEY, env.GMAIL_TOKEN_ENCRYPTION_KEY, ...(env.MAIL_CREDENTIAL_KEY_PREVIOUS ?? "").split(/[\s,]+/)]
    .map((s) => (s ?? "").trim()).filter((s) => s && keyBytes(s));
  const unique = [...new Set(named)];
  // MAIL_CREDENTIAL_KEY when it is usable, else the Gmail key; a malformed MAIL_CREDENTIAL_KEY is no key at all,
  // so a typo never silently seals new credentials with the old key.
  if (env.MAIL_CREDENTIAL_KEY !== undefined && env.MAIL_CREDENTIAL_KEY !== "" && !keyBytes(env.MAIL_CREDENTIAL_KEY)) return null;
  if (!unique.length || !hasCredentialKey(env)) return null;
  const [current, ...previous] = await Promise.all(unique.map(async (secret) => ({ secret, id: await keyId(secret) })));
  return { current, previous };
}

async function aesKey(secret: string) {
  const bytes = keyBytes(secret);
  if (!bytes) throw new Error("credential_store_unavailable");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealCredentials(keys: CredentialKeys, context: string, value: unknown): Promise<EnvelopeV2> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await aesKey(keys.current.secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { version: 2, kid: keys.current.id, iv: b64url(iv), ciphertext: b64url(new Uint8Array(ciphertext)) };
}

async function decrypt<T>(secret: string, context: string, envelope: { iv: string; ciphertext: string }): Promise<T> {
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(envelope.iv), additionalData: new TextEncoder().encode(context) },
    await aesKey(secret),
    fromB64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Opens an envelope of either version. `stale` says it should be sealed again with the current key:
 * a version 1 envelope, or one sealed with a previous key. Any failure is `credential_store_unavailable`
 * (wrong key, tampered, another account's): the caller cannot tell which, and nothing leaks.
 */
export async function openCredentials<T>(keys: CredentialKeys, context: string, envelope: CredentialEnvelope): Promise<{ value: T; stale: boolean }> {
  const all = [keys.current, ...keys.previous];
  try {
    if (envelope?.version === 2) {
      const key = all.find((k) => k.id === envelope.kid);
      if (!key) throw new Error();
      return { value: await decrypt<T>(key.secret, context, envelope), stale: key !== keys.current };
    }
    if (envelope?.version === 1) {
      for (const key of all) {
        try { return { value: await decrypt<T>(key.secret, context, envelope), stale: true }; }
        catch { /* the next key */ }
      }
    }
  } catch { /* below */ }
  throw new Error("credential_store_unavailable");
}
