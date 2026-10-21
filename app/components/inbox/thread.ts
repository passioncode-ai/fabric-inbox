import { displaySender } from "../../../shared/mail/sender";
import { htmlToText } from "../../../shared/mail/text";
import type { SentBy } from "../../../shared/mail/agent-state";
import { messagePath, rawAccount, type InboxMessage } from "./model";

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
  /** In Trash, Spam or Discarded: not part of the conversation as the reader shows it (B-114). */
  removed?: boolean;
  /** B-138: who sent a sent message: the reply agent (its answer or its waiting reply) or a person. */
  sentBy?: SentBy;
  /** The message's HTML as the thread route gives it (Cloudflare), so its cell shows it without another request. */
  body?: string;
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
      ...(e.agent_run && typeof e.agent_run === "object" ? { agentRun: e.agent_run as InboxMessage["agentRun"] } : {}),
    },
    kind: folder === "sent" ? "sent" : folder === "draft" ? "draft" : "received",
    open: id === open.providerMessageId,
    at: Date.parse(String(e.date ?? "")) || 0,
    ...(folder === "trash" || folder === "spam" || folder === "discarded" ? { removed: true } : {}),
    ...(e.sent_by === "agent" || e.sent_by === "agent_waiting" || e.sent_by === "person" ? { sentBy: e.sent_by } : {}),
    ...(typeof e.body === "string" ? { body: e.body } : {}),
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
    ...(labels.includes("TRASH") || labels.includes("SPAM") || labels.includes("DISCARDED") ? { removed: true } : {}),
  };
}

/**
 * The open message's whole conversation, oldest first (B-114). A message with no thread, or a thread
 * the server cannot read now, is shown alone: the reader never loses the message it opened. Mail in
 * Trash, Spam or Discarded is left out, as the list's count leaves it out, unless it is the open one.
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
  rows = rows.filter((r) => r.open || !r.removed);
  if (!rows.some((r) => r.open)) rows.push(alone[0]!);
  return rows.sort((a, b) => a.at - b.at);
}

type Send = (url: string, body?: unknown, method?: string) => Promise<unknown>;

/** The messages "Mark conversation read" changes: the unread ones you received (drafts and your own mail are read). */
export const unreadOf = (rows: ThreadRow[]) => rows.filter((r) => !r.message.read && r.kind === "received");

/**
 * Marks messages of one conversation read (B-114). The whole Cloudflare conversation is one request;
 * a Gmail, IMAP or Outlook message is marked one by one, every one tried. Throws, after trying all of
 * them, when any was refused: the caller says so and the list shows what the server now holds.
 */
export async function markRead(rows: ThreadRow[], send: Send, whole: boolean): Promise<void> {
  const unread = unreadOf(rows);
  const first = unread[0]?.message;
  if (!first) return;
  if (whole && first.provider === "cloudflare" && first.threadId) {
    await send(`/api/v1/mailboxes/${encodeURIComponent(rawAccount(first.accountId))}/threads/${encodeURIComponent(first.threadId)}/read`, {});
    return;
  }
  const results = await Promise.allSettled(unread.map((r) => r.message.provider === "cloudflare"
    ? send(messagePath(r.message), { read: true }, "PUT")
    : send(messagePath(r.message) + "/read", { read: true })));
  const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (refused) throw refused.reason;
}

/** A message as its cell shows it (B-138): its HTML when it has one, else its text. */
export async function messageBody(message: InboxMessage, request: Request): Promise<{ html: string; text: string }> {
  const m = (await request(messagePath(message))) as { text?: string | null; html?: string | null; body?: string | null } | null;
  return { html: String(m?.html ?? m?.body ?? ""), text: String(m?.text ?? "").trim() };
}

/** A message's text for the conversation (B-114): its plain text, or its HTML read as text. */
export async function messageText(message: InboxMessage, request: Request): Promise<string> {
  const m = (await request(messagePath(message))) as { text?: string | null; html?: string | null; body?: string | null } | null;
  const text = String(m?.text ?? "").trim();
  return text || htmlToText(String(m?.html ?? m?.body ?? "")).trim();
}
