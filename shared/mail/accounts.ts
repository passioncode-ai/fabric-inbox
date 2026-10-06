/**
 * How an account is named across the app, the API and the agent protocol.
 *
 * - `cloudflare:<address>` — a mailbox on one of the workspace's Cloudflare domains (MailboxDO).
 * - `<provider>:<id>` — an account kept by the server's accounts object (GmailAccountsDO, named
 *   for its first provider): `gmail:<id>` (Google OAuth), `imap:<id>` (IMAP and SMTP with an
 *   app password) and `outlook:<id>` (Outlook.com and Microsoft 365 through Microsoft Graph).
 *   `<id>` is the account's own id in that object, unique across its providers, and
 *   is what the `/api/accounts/:accountId/…` routes take.
 *
 * Plain module: the Worker, the app and the tests read it.
 */
export const REMOTE_PROVIDERS = ["gmail", "imap", "outlook"] as const;
export type RemoteProvider = (typeof REMOTE_PROVIDERS)[number];
export type MailProviderId = "cloudflare" | RemoteProvider;

/** A remote account's own id: what the accounts object keys it by. */
export const REMOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** `gmail:<id>`, `imap:<id>` or `outlook:<id>`. */
export const REMOTE_ACCOUNT = /^(gmail|imap|outlook):[A-Za-z0-9_-]{1,128}$/;

export function isRemoteProvider(provider: unknown): provider is RemoteProvider {
  return typeof provider === "string" && (REMOTE_PROVIDERS as readonly string[]).includes(provider);
}

/** `{ provider, id }` of a remote account id such as `imap:3f…`, or null for anything else. */
export function parseRemoteAccount(accountId: string): { provider: RemoteProvider; id: string } | null {
  const at = accountId.indexOf(":");
  if (at < 0) return null;
  const provider = accountId.slice(0, at), id = accountId.slice(at + 1);
  return isRemoteProvider(provider) && REMOTE_ID.test(id) ? { provider, id } : null;
}

export const remoteAccountId = (provider: RemoteProvider, id: string) => `${provider}:${id}`;

/** How each provider is named to a person, where no preset gives a better name. */
export const PROVIDER_LABEL: Record<MailProviderId, string> = { cloudflare: "Cloudflare", gmail: "Gmail", imap: "IMAP", outlook: "Outlook" };
