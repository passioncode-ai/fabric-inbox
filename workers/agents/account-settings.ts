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
