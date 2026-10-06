import type { Email } from "~/types";
import type { Mail } from "~/services/fabric";
import type { Triage } from "../../../shared/mail/triage";
/** "cloudflare" (a mailbox on a served domain), "gmail" (Google sign-in) or "imap" (an app password). */
export type MailProvider = "cloudflare" | "gmail" | "imap";
/** Gmail and IMAP accounts: kept by the server's accounts object and reached at /api/accounts/<id>. */
export const isRemote = (provider: MailProvider | string) => provider === "gmail" || provider === "imap";
export type InboxAccount = {
  id: string;
  provider: MailProvider;
  email: string;
  name: string;
  status: string;
  error?: string;
  lastSyncAt?: number;
  unread?: number;
  /** Every message in its inbox, when known (the "With mail" filter). */
  total?: number;
  hidden?: boolean;
  /** Keeps mail for every other address on its domain. */
  catchAll?: boolean;
  /** Journal events that did not reach rules, agents or categories. */
  stuck?: { dead: number; retrying: number; lastError: string | null };
  /** Its counts could not be read just now; the ones shown are the last known. */
  countsStale?: boolean;
  /** A Gmail or IMAP account's first import in percent, while it runs. */
  importing?: number;
  /** "Gmail", "iCloud Mail", "Fastmail"… for Gmail and IMAP accounts. */
  providerName?: string;
  /** What a Gmail or IMAP account can do; the actions it cannot are not offered. */
  capabilities?: { archive: boolean; spam: boolean; trash: boolean; drafts: boolean; organization: "labels" | "folders" };
};
export type InboxMessage = {
  id: string;
  accountId: string;
  provider: MailProvider;
  providerMessageId: string;
  subject: string;
  sender: string;
  recipient: string;
  date: string;
  read: boolean;
  starred: boolean;
  snippet: string;
  threadId?: string;
  triage?: Triage;
  /** Screened categories this message is in, with why. */
  categories?: { id: string; name: string; reason: string }[];
  /** In a category's own view: why the message belongs there. */
  categoryReason?: string;
  spamReason?: string;
  /** Other inboxes that received this same email. */
  alsoIn?: string[];
};
export type InboxData = {
  accounts: InboxAccount[];
  messages: InboxMessage[];
  issues: { accountId?: string; provider: string; error: string }[];
  hasMore: boolean;
  cursor?: string;
  /** Present when the page is one category's view. */
  category?: import("~/services/categories").Category;
};
export type OpenMessage = {
  subject: string;
  from: string;
  to: string;
  date: string;
  text?: string;
  html?: string;
  read: boolean;
  threadId?: string;
  rfcMessageId?: string;
  references?: string;
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
  }[];
};
export const rawAccount = (id: string) => id.slice(id.indexOf(":") + 1);
export const messagePath = (message: InboxMessage) =>
  isRemote(message.provider)
    ? `/api/accounts/${encodeURIComponent(rawAccount(message.accountId))}/messages/${encodeURIComponent(message.providerMessageId)}`
    : `/api/v1/mailboxes/${encodeURIComponent(rawAccount(message.accountId))}/emails/${encodeURIComponent(message.providerMessageId)}`;
export const rulesPath = (account: InboxAccount) =>
  "/automation/" +
  encodeURIComponent(
    isRemote(account.provider) ? account.id : rawAccount(account.id),
  );
export const senderName = (sender: string) =>
  sender.replace(/\s*<[^>]+>/, "").replace(/^"|"$/g, "") || sender;
export function normalizeMessage(
  value: Email | Mail,
  provider: InboxMessage["provider"],
): OpenMessage {
  if (isRemote(provider)) {
    const m = value as Mail;
    return {
      subject: m.subject,
      from: m.from,
      to: m.to,
      date: m.date,
      text: m.text,
      html: m.html,
      read: m.read,
      threadId: m.threadId,
      rfcMessageId: m.rfcMessageId,
      references: m.references,
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.providerAttachmentId,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
    };
  }
  const m = value as Email;
  return {
    subject: m.subject,
    from: m.sender,
    to: m.recipient,
    date: m.date,
    html: m.body ?? undefined,
    read: m.read,
    threadId: m.thread_id ?? undefined,
    rfcMessageId: m.message_id ?? undefined,
    references: m.email_references ?? undefined,
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimetype,
      size: a.size,
    })),
  };
}
