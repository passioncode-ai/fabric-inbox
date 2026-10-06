/**
 * Outlook messages in the cache's shape (`Message`, gmail-client.ts): a Graph message's folder,
 * read state and flag become the labels the cache, the feed and triage already read, the same way
 * IMAP folders do (imap/mime.ts), so one cache serves every provider.
 *
 * | Graph | here |
 * |---|---|
 * | the folder (`parentFolderId`): Inbox, Sent Items, Drafts, Deleted Items, Junk Email | INBOX, SENT, DRAFT, TRASH, SPAM |
 * | Archive | none (the feed's archive is "in no other folder") |
 * | `isRead: false` | UNREAD |
 * | `flag.flagStatus: "flagged"` | STARRED |
 * | `conversationId` | the thread id, hashed (`c` + 22 characters) |
 * | `id` (immutable, about 150 characters) | the message id here, hashed (`o` + 24 characters); the Graph id is kept as `remoteId` |
 *
 * Graph's ids are longer than a storage key may be (128 characters), so the ids here are hashes of
 * them; the hash is the same every time, so a message synced twice is one row.
 */
import PostalMime from "postal-mime";
import { signalsFromHeaders } from "../../../shared/mail/triage";
import { b64url } from "../google-oauth";
import type { Message } from "../gmail-client";
import type { OutlookRole } from "./types";

export interface GraphAddress { emailAddress?: { name?: string; address?: string } }
export interface GraphMessage {
  id: string;
  "@removed"?: { reason?: string };
  "@odata.type"?: string;
  conversationId?: string;
  parentFolderId?: string;
  subject?: string;
  from?: GraphAddress;
  sender?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  bccRecipients?: GraphAddress[];
  replyTo?: GraphAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
  hasAttachments?: boolean;
  internetMessageId?: string;
  bodyPreview?: string;
  changeKey?: string;
}
export interface GraphAttachment {
  id: string;
  "@odata.type"?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
}

/** The properties every read asks for: what the cache keeps of a message, without its body. */
export const MESSAGE_FIELDS = ["id", "conversationId", "parentFolderId", "subject", "from", "sender", "toRecipients", "ccRecipients", "bccRecipients",
  "replyTo", "receivedDateTime", "sentDateTime", "isRead", "isDraft", "flag", "hasAttachments", "internetMessageId", "bodyPreview", "changeKey"].join(",");

const ROLE_LABEL: Record<OutlookRole, string | null> = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT", trash: "TRASH", junk: "SPAM", archive: null };

export function labelsFor(role: OutlookRole, m: Pick<GraphMessage, "isRead" | "flag">): string[] {
  const labels: string[] = [];
  const own = ROLE_LABEL[role];
  if (own) labels.push(own);
  if (m.isRead === false) labels.push("UNREAD");
  if (m.flag?.flagStatus === "flagged") labels.push("STARRED");
  return labels;
}

/** The folder role a cached message's labels say it is in (archive when none of the others). */
export function roleOfLabels(labels: string[]): OutlookRole {
  for (const [role, label] of Object.entries(ROLE_LABEL) as [OutlookRole, string | null][]) if (label && labels.includes(label)) return role;
  return "archive";
}

async function hash(prefix: string, value: string, bytes: number) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return prefix + b64url(digest.slice(0, bytes));
}
/** The id a Graph message has here: `o` and 24 characters of its id's SHA-256. */
export const localId = (graphId: string) => hash("o", graphId, 18);
/** The thread id of a Graph conversation: `c` and 22 characters of its SHA-256. */
export const threadOf = (conversationId: string | undefined, graphId: string) => hash("c", conversationId || graphId, 16);

/** An attachment's Graph id as the attachment id here (base64url, so it is safe in a path). */
export const attachmentKey = (graphAttachmentId: string) => b64url(new TextEncoder().encode(graphAttachmentId));
export function attachmentFromKey(key: string): string | null {
  if (!/^[A-Za-z0-9_-]{4,2048}$/.test(key)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=")), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** One address as a header shows it: `Name <address>`, the name quoted when it must be. */
export function formatAddress(a: GraphAddress | undefined): string {
  const address = a?.emailAddress?.address?.trim() ?? "";
  const name = a?.emailAddress?.name?.trim() ?? "";
  if (!address) return name;
  if (!name || name.toLowerCase() === address.toLowerCase()) return address;
  return /[",;:<>@()[\]\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>` : `${name} <${address}>`;
}
const list = (a: GraphAddress[] | undefined) => (a ?? []).map(formatAddress).filter(Boolean).join(", ");
/** The bare addresses of a recipient list (what a draft's recipients are sent as). */
export const addresses = (a: GraphAddress[] | undefined) => (a ?? []).map((x) => x.emailAddress?.address?.trim() ?? "").filter(Boolean);

const time = (iso: string | undefined) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : 0; };

/**
 * A message from its Graph properties, without its body (`bodyless`: the body is read when the
 * message is first opened). References and In-Reply-To are only in the message's own headers, read
 * with its body.
 */
export async function messageFromGraph(accountId: string, m: GraphMessage, role: OutlookRole): Promise<Message> {
  const id = await localId(m.id);
  const labels = labelsFor(role, m);
  const sent = time(m.sentDateTime);
  return {
    id: accountId + ":" + id,
    accountId,
    providerMessageId: id,
    remoteId: m.id,
    threadId: await threadOf(m.conversationId, m.id),
    subject: m.subject ?? "",
    from: formatAddress(m.from ?? m.sender),
    to: list(m.toRecipients),
    cc: list(m.ccRecipients),
    replyTo: list(m.replyTo),
    bcc: list(m.bccRecipients),
    inReplyTo: "",
    date: sent ? new Date(sent).toUTCString() : "",
    rfcMessageId: m.internetMessageId ?? "",
    references: "",
    timestamp: time(m.receivedDateTime) || sent,
    snippet: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    text: "",
    html: "",
    read: !labels.includes("UNREAD"),
    archived: !labels.includes("INBOX"),
    labels,
    attachments: [],
  };
}

/**
 * The message whole: its Graph properties, the body and headers of its MIME source (`$value`), and
 * its attachments as Graph lists them (their ids are what a download names).
 */
export async function messageWithBody(accountId: string, m: GraphMessage, role: OutlookRole, mime: Uint8Array | null, attachments: GraphAttachment[]): Promise<Message> {
  const base = await messageFromGraph(accountId, m, role);
  const files = attachments
    .filter((a) => a["@odata.type"] !== "#microsoft.graph.referenceAttachment")
    .map((a) => ({ filename: a.name ?? "", mimeType: a.contentType || "application/octet-stream", size: a.size ?? 0, providerAttachmentId: attachmentKey(a.id) }));
  if (!mime) return { ...base, attachments: files };
  const parsed = await new PostalMime().parse(mime);
  const header = (name: string) => parsed.headers.find((h) => h.key === name)?.value;
  const text = parsed.text ?? "", html = parsed.html ?? "";
  return {
    ...base,
    inReplyTo: (header("in-reply-to") ?? "").trim(),
    references: (header("references") ?? "").replace(/\s+/g, " ").trim(),
    rfcMessageId: base.rfcMessageId || (header("message-id") ?? "").trim(),
    snippet: base.snippet || (text || html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200),
    text,
    html,
    signals: signalsFromHeaders(parsed.headers),
    attachments: files,
  };
}
