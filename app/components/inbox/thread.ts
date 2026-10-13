import { displaySender } from "../../../shared/mail/sender";
import { htmlToText } from "../../../shared/mail/text";
import { rawAccount, type InboxMessage } from "./model";

/**
 * One message of a conversation as the reader lists it (B-114): the message itself (enough to open
 * it, reply to it or forward it), whether it was received, sent by you or is a draft, and whether it
 * is the one open now.
 */
export interface ThreadRow {
  message: InboxMessage;
  kind: "received" | "sent" | "draft";
  open: boolean;
  /** When it was sent or received, for the order (ms). */
  at: number;
}

type Request = (url: string) => Promise<unknown>;

const SNIPPET = 160;
const snippetOf = (body: string | null | undefined) => htmlToText(String(body ?? "")).replace(/\s+/g, " ").trim().slice(0, SNIPPET);

/** A Cloudflare thread row (`GET /api/v1/mailboxes/:box/threads/:thread`) as a message of the open one's account. */
function fromCloudflare(open: InboxMessage, e: Record<string, unknown>): ThreadRow {
  const id = String(e.id);
  const folder = String(e.folder_id ?? "");
  return {
    message: {
      id: JSON.stringify([open.accountId, id]), accountId: open.accountId, provider: "cloudflare", providerMessageId: id,
      subject: String(e.subject ?? ""), sender: displaySender(e.sender as string, e.sender_name as string | null, e.raw_headers as string | null) || String(e.sender ?? ""),
      recipient: String(e.recipient ?? ""), date: String(e.date ?? ""),
      read: !!e.read, starred: !!e.starred, snippet: snippetOf(e.body as string), threadId: open.threadId,
    },
    kind: folder === "sent" ? "sent" : folder === "draft" ? "draft" : "received",
    open: id === open.providerMessageId,
    at: Date.parse(String(e.date ?? "")) || 0,
  };
}

/** A Gmail, IMAP or Outlook cached message with this thread id, as a message of the open one's account. */
function fromRemote(open: InboxMessage, m: Record<string, unknown>): ThreadRow {
  const id = String(m.providerMessageId ?? m.id);
  const labels = Array.isArray(m.labels) ? (m.labels as string[]) : [];
  return {
    message: {
      id: JSON.stringify([open.accountId, id]), accountId: open.accountId, provider: open.provider, providerMessageId: id,
      subject: String(m.subject ?? ""), sender: String(m.from ?? ""), recipient: String(m.to ?? ""),
      date: String(m.date ?? ""), read: !!m.read, starred: labels.includes("STARRED"),
      snippet: String(m.snippet ?? "").slice(0, SNIPPET), threadId: String(m.threadId ?? open.threadId ?? ""),
    },
    kind: labels.includes("DRAFT") ? "draft" : labels.includes("SENT") ? "sent" : "received",
    open: id === open.providerMessageId,
    at: Number(m.timestamp) > 0 ? Number(m.timestamp) : Date.parse(String(m.date ?? "")) || 0,
  };
}

/**
 * The open message's whole conversation, oldest first (B-114). A message with no thread, or a thread
 * the server cannot read now, is shown alone: the reader never loses the message it opened.
 */
export async function loadConversation(open: InboxMessage, request: Request): Promise<ThreadRow[]> {
  const alone: ThreadRow[] = [{ message: open, kind: "received", open: true, at: Date.parse(open.date) || 0 }];
  if (!open.threadId) return alone;
  let rows: ThreadRow[];
  try {
    const box = encodeURIComponent(rawAccount(open.accountId));
    if (open.provider === "cloudflare") {
      const data = await request(`/api/v1/mailboxes/${box}/threads/${encodeURIComponent(open.threadId)}`);
      rows = (Array.isArray(data) ? data : []).map((e) => fromCloudflare(open, e as Record<string, unknown>));
    } else {
      const data = (await request(`/api/accounts/${box}/messages?threadId=${encodeURIComponent(open.threadId)}&limit=100`)) as { messages?: unknown[] } | null;
      rows = (data?.messages ?? []).map((m) => fromRemote(open, m as Record<string, unknown>));
    }
  } catch {
    return alone;
  }
  if (!rows.some((r) => r.open)) rows.push(alone[0]!);
  return rows.sort((a, b) => a.at - b.at);
}
