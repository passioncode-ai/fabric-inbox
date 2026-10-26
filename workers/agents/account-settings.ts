/**
 * B-171: a reply agent on a Gmail, IMAP or Outlook account. Its run's mailbox id is the account's
 * `<provider>:<id>`, which never holds an "@" but always a colon, so the registry tells it from an
 * address; its settings (the agent, a signature) live in R2 `accounts/<that id>.json`, shaped like
 * a Cloudflare address's `mailboxes/<address>.json`.
 */
export const ACCOUNT_MAILBOX = /^(gmail|imap|outlook):[a-z0-9_-]{1,128}$/;

export function isAccountMailbox(mailboxId: string): boolean {
  return ACCOUNT_MAILBOX.test(mailboxId.toLowerCase());
}

export function accountSettingsKey(accountId: string): string {
  return `accounts/${accountId.toLowerCase()}.json`;
}

/** The account's own id, as GmailAccountsDO takes it (the part after the provider). */
export function accountIdOf(mailboxId: string): string {
  return mailboxId.slice(mailboxId.indexOf(":") + 1);
}

/**
 * Changes an account's settings conditionally on the version read (B-171 phase 2), as
 * `updateSettings` does for an address; the first write succeeds only while nothing is there, so two
 * screens choosing an agent at once never lose one choice.
 */
export async function updateAccountSettings(
  bucket: R2Bucket,
  accountId: string,
  change: (settings: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const key = accountSettingsKey(accountId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(key);
    const next = change(object ? await object.json<Record<string, unknown>>() : {});
    const written = await bucket.put(key, JSON.stringify(next), {
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new Error("The account's settings changed several times at once; try again");
}
