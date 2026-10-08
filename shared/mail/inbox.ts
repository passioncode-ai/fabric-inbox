import type { Triage } from "./triage";
export const INBOX_FOLDERS = ["inbox", "sent", "archive", "trash", "starred", "spam", "discarded"] as const;
export type InboxFolder = (typeof INBOX_FOLDERS)[number];
export type InboxProvider = "cloudflare" | "gmail" | "imap" | "outlook";
export interface InboxAccount {
  id: string;
  provider: InboxProvider;
  email: string;
  name: string;
  status: string;
  error?: string;
  /** Why a Gmail account stopped working (shared/mail/gmail-reasons.ts); absent while it works. */
  reason?: string;
  lastSyncAt?: number;
  /** When the address was created or the account connected (epoch ms); absent for a Cloudflare address made before 2026-10-08, which reads as old. */
  createdAt?: number;
  /** A Gmail, IMAP or Outlook account waiting out a failure or the provider's request to slow down: when it tries again. */
  retryAt?: number;
  /** Unread messages in this account's inbox; sent with the first page only. */
  unread?: number;
  /** Every message in its inbox (first page only): the sidebar's "With mail" filter. */
  total?: number;
  /** Its counts could not be read just now: `unread` and `total` are the last ones known (P2-11). */
  countsStale?: boolean;
  /** A Gmail or IMAP account's first import, in percent, while it runs (status "syncing"); absent when unknown. */
  importing?: number;
  /** How a person knows a Gmail or IMAP account's provider: "Gmail", "iCloud Mail", "Fastmail"… */
  providerName?: string;
  /** What a Gmail or IMAP account can do (workers/providers/provider.ts): the app offers only that. */
  capabilities?: { archive: boolean; spam: boolean; trash: boolean; drafts: boolean; organization: "labels" | "folders" };
  /** Hidden by the operator: left out of All inboxes, domains and totals; still receiving. */
  hidden?: boolean;
  /** Keeps mail for every other address on its domain. */
  catchAll?: boolean;
  /** Journal events of this inbox that did not reach its rules, agents or categories. */
  stuck?: { dead: number; retrying: number; lastError: string | null };
}
export interface InboxMessage {
  /** Collision-free UI identity; providerMessageId is used by provider actions. */
  id: string;
  accountId: string;
  provider: InboxProvider;
  providerMessageId: string;
  subject: string;
  sender: string;
  recipient: string;
  date: string;
  timestamp: number;
  read: boolean;
  starred: boolean;
  snippet: string;
  threadId?: string;
  /** The RFC Message-ID, when known: the same email received in two inboxes shares it. */
  rfcMessageId?: string;
  /** Other inboxes that received this same email; the row stands for all of them. */
  alsoIn?: string[];
  /** Deterministic group and importance (shared/mail/triage.ts), computed by the server. */
  triage?: Triage;
  /** Screened categories this message is in (CAT-5), with why. */
  categories?: { id: string; name: string; reason: string }[];
  /** In a category's own view: why this message belongs there. */
  categoryReason?: string;
  /** Why it is in Spam (SP-4): a rule, the model, the operator, or Gmail. */
  spamReason?: string;
  /** Why it is in Discarded: the person discarded it, or a discard rule did on arrival (shared/mail/discard.ts). */
  discardReason?: string;
}
export interface InboxIssue {
  accountId?: string;
  provider: InboxProvider;
  error: string;
  /** The account's own reason, when it has one (shared/mail/gmail-reasons.ts). */
  reason?: string;
}
export interface InboxResponse {
  accounts: InboxAccount[];
  messages: InboxMessage[];
  issues: InboxIssue[];
  /** More rows in the successfully read accounts' local stores, not provider totals. */
  hasMore: boolean;
  cursor?: string;
}
export interface InboxPosition {
  timestamp: number;
  accountId: string;
  providerMessageId: string;
}
export interface InboxReadOptions {
  folder: InboxFolder;
  query: string;
  limit: number;
  before?: InboxPosition;
  /** Only unread messages; applied by each source so paging stays complete. */
  unread?: boolean;
  /** Domains this workspace serves, for triage (mail from them is the workspace's own). */
  ownDomains?: string[];
}
export function compareInbox(a: InboxPosition, b: InboxPosition) {
  return b.timestamp - a.timestamp || compareText(a.accountId, b.accountId) || compareText(a.providerMessageId, b.providerMessageId);
}
function compareText(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
export function inboxIdentity(accountId: string, providerMessageId: string) {
  return JSON.stringify([accountId, providerMessageId]);
}
export function inboxPosition(message: InboxPosition): InboxPosition {
  return { timestamp: message.timestamp, accountId: message.accountId, providerMessageId: message.providerMessageId };
}
export function inboxPage(messages: InboxMessage[], options: InboxReadOptions) {
  return messages.filter(m => !options.before || compareInbox(m, options.before) > 0)
    .sort(compareInbox).slice(0, options.limit + 1);
}
