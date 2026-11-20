/**
 * B-310 (owner, 2026-11-20, relayed by CEO Fabric: «мы спам сохраняем, какое-то время чистим»): how long a Cloudflare
 * mailbox keeps its Spam, and how much of it. Spam stays SPAM_RETENTION_DAYS (default 30, 1 to 365) from the moment it
 * entered Spam (`emails.spam_at`), so a message sent there by mistake can be taken back ("Not spam") until then; the
 * mailbox's alarm then deletes it with its files (MailboxDO.purgeSpam). Growth is bounded by count too: past
 * SPAM_MAX_MESSAGES (default 10,000, 100 to 1,000,000) in one mailbox, the oldest in Spam go first on the next pass,
 * so a flood fills no mailbox. Gmail, IMAP and Outlook keep their own Spam.
 */
export const SPAM_RETENTION_DAYS_DEFAULT = 30;
export const SPAM_RETENTION_DAYS_MAX = 365;
export const SPAM_MAX_MESSAGES_DEFAULT = 10_000;

/** SPAM_RETENTION_DAYS as whole days within 1 and 365; anything else the default. */
export function spamRetentionDays(raw: unknown): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 1 && n <= SPAM_RETENTION_DAYS_MAX ? n : SPAM_RETENTION_DAYS_DEFAULT;
}
export const spamRetentionMs = (raw: unknown) => spamRetentionDays(raw) * 86_400_000;

/** SPAM_MAX_MESSAGES within 100 and 1,000,000; anything else the default. */
export function spamMaxMessages(raw: unknown): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 100 && n <= 1_000_000 ? n : SPAM_MAX_MESSAGES_DEFAULT;
}
