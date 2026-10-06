/** Server-only Google OAuth primitives. No token or upstream error reaches a response. */
import { hasCredentialKey } from "./credentials";
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: {
    prefix?: string;
    limit?: number;
    startAfter?: string;
  }): Promise<Map<string, T>>;
  transaction<T>(callback: (store: Store) => Promise<T>): Promise<T>;
}
export interface GmailEnvironment {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** The credential key (credentials.ts); before 0.11 the only key, GMAIL_TOKEN_ENCRYPTION_KEY. */
  MAIL_CREDENTIAL_KEY?: string;
  MAIL_CREDENTIAL_KEY_PREVIOUS?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  PUBLIC_APP_URL?: string;
  GMAIL_POLL_SECONDS?: string;
}
export interface Config {
  status: "configured";
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  origin: string;
  redirectUri: string;
  pollMs: number;
}
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
export function configuration(
  env: GmailEnvironment,
): Config | { status: "not_configured"; required: string[] } {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "PUBLIC_APP_URL",
  ].filter((k) => !env[k as keyof GmailEnvironment]);
  // Tokens are sealed with the server's credential key: MAIL_CREDENTIAL_KEY, or the older name.
  if (!hasCredentialKey(env)) required.push("MAIL_CREDENTIAL_KEY");
  let origin = "";
  try {
    const url = new URL(env.PUBLIC_APP_URL!);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    origin = url.origin;
  } catch {
    if (!required.includes("PUBLIC_APP_URL")) required.push("PUBLIC_APP_URL");
  }
  if (required.length) return { status: "not_configured", required };
  const seconds = Number(env.GMAIL_POLL_SECONDS || 300);
  return {
    status: "configured",
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    encryptionKey: env.MAIL_CREDENTIAL_KEY || env.GMAIL_TOKEN_ENCRYPTION_KEY!,
    origin,
    redirectUri: origin + "/api/accounts/gmail/callback",
    pollMs:
      Math.max(60, Math.min(3600, Number.isFinite(seconds) ? seconds : 300)) *
      1000,
  };
}
export function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function pkceChallenge(verifier: string) {
  return b64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}
export type Envelope = { version: 1; iv: string; ciphertext: string };
async function key(secret: string) {
  const bytes = fromB64(secret);
  if (bytes.length !== 32) throw new Error("not_configured");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(
  secret: string,
  context: string,
  value: unknown,
): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    version: 1,
    iv: b64url(iv),
    ciphertext: b64url(new Uint8Array(ciphertext)),
  };
}
export async function unseal<T>(
  secret: string,
  context: string,
  envelope: Envelope,
): Promise<T> {
  if (envelope.version !== 1) throw new Error("credential_store_unavailable");
  const bytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromB64(envelope.iv),
      additionalData: new TextEncoder().encode(context),
    },
    await key(secret),
    fromB64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
export interface OAuthState {
  verifier: string;
  browserHash: string;
  expiresAt: number;
  /** Whose sign-in it is ("outlook"); absent is Gmail's, as every state before 0.11 was. */
  provider?: "gmail" | "outlook";
}
export async function createAuthorization(
  store: Store,
  config: Config,
  now = Date.now(),
) {
  const state = randomToken(),
    verifier = randomToken(),
    browserToken = randomToken();
  // Keep bounded, short-lived authorization attempts; tokens are never in the cookie.
  for (const [id, old] of await store.list<OAuthState>({ prefix: "oauth:" }))
    if (old.expiresAt <= now) await store.delete(id);
  if ((await store.list({ prefix: "oauth:", limit: 101 })).size >= 100)
    throw new Error("too_many_connections");
  await store.put<OAuthState>("oauth:" + state, {
    verifier,
    browserHash: await pkceChallenge(browserToken),
    expiresAt: now + 600000,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return { authorizationUrl: url.toString(), browserToken };
}
export async function consumeState(
  store: Store,
  state: string,
  browserToken: string,
  now = Date.now(),
  /** A state of another provider's sign-in is refused (and used up). */
  provider: "gmail" | "outlook" = "gmail",
): Promise<OAuthState> {
  if (
    !state ||
    !browserToken ||
    state.length > 128 ||
    browserToken.length > 128
  )
    throw new Error("invalid_state");
  const browserHash = await pkceChallenge(browserToken);
  return store
    .transaction(async (tx) => {
      const saved = await tx.get<OAuthState>("oauth:" + state);
      if (!saved || saved.browserHash !== browserHash)
        throw new Error("invalid_state");
      await tx.delete("oauth:" + state);
      // Return expired marker outside the transaction so consumption remains committed.
      return saved;
    })
    .then((saved) => {
      if (saved.expiresAt <= now || (saved.provider ?? "gmail") !== provider) throw new Error("invalid_state");
      return saved;
    });
}
