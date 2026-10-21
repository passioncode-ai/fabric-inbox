import type { Email } from "~/types";
import type { Mail } from "~/services/fabric";
import { displaySender } from "../../../shared/mail/sender";
import type { Triage } from "../../../shared/mail/triage";
import { rewriteInlineImages, type InlineAttachments } from "../../lib/mail-image-policy";
import { bareContentId, inlinePictureType } from "../../../shared/mail/inline";
/** "cloudflare" (a mailbox on a served domain), "gmail" (Google sign-in), "imap" (an app password) or "outlook" (Microsoft sign-in). */
export type MailProvider = "cloudflare" | "gmail" | "imap" | "outlook";
/** Gmail, IMAP and Outlook accounts: kept by the server's accounts object and reached at /api/accounts/<id>. */
export const isRemote = (provider: MailProvider | string) => provider === "gmail" || provider === "imap" || provider === "outlook";
export type InboxAccount = {
  id: string;
  provider: MailProvider;
  email: string;
  name: string;
  status: string;
  error?: string;
  lastSyncAt?: number;
  /** When a Gmail, IMAP or Outlook account tries again after a failure or a request to slow down. */
  retryAt?: number;
  /** Why an OAuth account stopped working (shared/mail/gmail-reasons.ts). */
  reason?: string;
  unread?: number;
  /** Every message in its inbox, when known (the "With mail" filter). */
  total?: number;
  /** When the address was created or the account connected (epoch ms); unknown for older addresses. */
  createdAt?: number;
  hidden?: boolean;
  /** Keeps mail for every other address on its domain. */
  catchAll?: boolean;
  /** Journal events that did not reach rules, agents or categories. */
  stuck?: { dead: number; retrying: number; lastError: string | null };
  /** Its counts could not be read just now; the ones shown are the last known. */
  countsStale?: boolean;
  /** A Gmail, IMAP or Outlook account's first import in percent, while it runs. */
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
  /** How many messages its conversation holds, when more than one (B-114; trash, spam and discarded left out). */
  threadCount?: number;
  triage?: Triage;
  /** Screened categories this message is in, with why. */
  categories?: { id: string; name: string; reason: string }[];
  /** A reply agent's run on this message (B-115): what it did, so the list can mark it and the reader show it. */
  agentRun?: { id: string; status: string; agentId?: string; agentVersion?: number; draftId?: string };
  /** B-138: where its conversation stands, on an address whose reply status is shown. */
  agentState?: import("../../../shared/mail/agent-state").AgentState;
  /** In a category's own view: why the message belongs there. */
  categoryReason?: string;
  spamReason?: string;
  /** Why it is in Discarded: the person discarded it, or a discard rule did on arrival. */
  discardReason?: string;
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
  /** B-138: in the reply-status view, conversations per state before the filter. */
  replyCounts?: Partial<Record<import("../../../shared/mail/agent-state").AgentState, number>>;
};
export type OpenMessage = {
  subject: string;
  from: string;
  to: string;
  cc?: string;
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
    /** Cloudflare mail: an inline part (an embedded picture) and its Content-ID. */
    disposition?: string;
    contentId?: string;
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
    // The server sends cc (absent on messages cached before 2026-10-05); the Mail type predates it.
    const m = value as Mail & { cc?: string };
    return {
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
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
        ...(a.inline !== undefined ? { disposition: a.inline ? "inline" : "attachment" } : {}),
        ...(a.contentId ? { contentId: a.contentId } : {}),
      })),
    };
  }
  const m = value as Email;
  return {
    subject: m.subject,
    from: displaySender(m.sender, m.sender_name, m.raw_headers),
    to: m.recipient,
    cc: m.cc ?? undefined,
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
      ...(a.disposition ? { disposition: a.disposition } : {}),
      ...(a.content_id ? { contentId: a.content_id } : {}),
    })),
  };
}

/**
 * What the reader shows (bug hunt 2026-10-12; B-89): a message's `cid:` pictures point at its inline
 * parts (and the frame's CSP allows those), and a part the HTML shows is not offered again as a
 * download. Cloudflare mail shows its inline parts; Gmail, IMAP and Outlook show each raster picture
 * whose Content-ID the HTML names, through the account's inline route (`shared/mail/inline.ts`).
 */
export function inlineView(open: OpenMessage, provider: InboxMessage["provider"], accountId: string, emailId: string):
  { html?: string; inline?: InlineAttachments; listed: OpenMessage["attachments"] } {
  if (!open.html) return { html: open.html, listed: open.attachments };
  const remote = isRemote(provider);
  const html = open.html.toLowerCase();
  const shown = open.attachments.filter((a) =>
    bareContentId(a.contentId) && html.includes(`cid:${bareContentId(a.contentId).toLowerCase()}`) &&
    (remote ? inlinePictureType(a.mimeType) !== null : a.disposition === "inline"));
  if (!shown.length) return { html: open.html, listed: open.attachments };
  const mailboxId = rawAccount(accountId);
  const rewritten = rewriteInlineImages(open.html, mailboxId, emailId, shown.map((a) => ({ id: a.id, disposition: "inline", content_id: a.contentId })), remote);
  const ids = new Set(shown.map((a) => a.id));
  return {
    html: rewritten,
    inline: { mailboxId, emailId, attachmentIds: [...ids], ...(remote ? { remote: true } : {}) },
    listed: open.attachments.filter((a) => !ids.has(a.id)),
  };
}
