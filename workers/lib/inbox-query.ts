import { inboxIdentity, type InboxReadOptions, type InboxMessage } from "../../shared/mail/inbox";
import { signalsFromHeaders, triage } from "../../shared/mail/triage";
import { parseStoredHeaders } from "../agents/prefilter";
import { msg } from "../../shared/i18n";

/** Bounded SQL keyset read. SQL parameters contain every caller-controlled value. */
export function mailboxInboxQuery(accountId: string, options: InboxReadOptions) {
  const conditions: string[] = [], parameters: (string | number)[] = [];
  if (options.folder === "starred") conditions.push("starred = 1 AND folder_id NOT IN ('trash', 'spam', 'draft', 'discarded')");
  else { conditions.push("folder_id = ?"); parameters.push(options.folder); }
  if (options.unread) conditions.push("read = 0");
  if (options.query) {
    conditions.push("instr(lower(coalesce(subject,'') || ' ' || coalesce(sender,'') || ' ' || coalesce(recipient,'') || ' ' || coalesce(snippet,'')), ?) > 0");
    parameters.push(options.query.toLowerCase());
  }
  if (options.before) {
    const before = options.before;
    conditions.push("(timestamp < ? OR (timestamp = ? AND (? > ? OR (? = ? AND id > ?))))");
    parameters.push(before.timestamp, before.timestamp, accountId, before.accountId, accountId, before.accountId, before.providerMessageId);
  }
  parameters.push(options.limit + 1);
  return {
    sql: `SELECT * FROM (SELECT id, subject, sender, recipient, date, read, starred, thread_id, folder_id, raw_headers, message_id, spam_reason, discard_reason,
      substr(body,1,2000) AS snippet,
      coalesce(cast(round((julianday(date)-2440587.5)*86400000) AS INTEGER),0) AS timestamp
      FROM emails) WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC, id ASC LIMIT ?`,
    parameters,
  };
}
export interface MailboxInboxRow {
  [key: string]: string | number | null;
  id: string; subject: string | null; sender: string | null; recipient: string | null;
  date: string | null; read: number; starred: number; thread_id: string | null;
  snippet: string | null; timestamp: number; raw_headers: string | null; message_id: string | null;
  spam_reason: string | null; folder_id: string | null; discard_reason: string | null;
}

/** A plain-text preview: the body column holds HTML for most mail. */
export function textSnippet(body: string | null): string {
  if (!body) return "";
  return body
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
export function mailboxInboxMessage(accountId: string, row: MailboxInboxRow, ownDomains: string[] = []): InboxMessage {
  const message: InboxMessage = { id: inboxIdentity(accountId, row.id), accountId, provider: "cloudflare", providerMessageId: row.id,
    subject: row.subject || "", sender: row.sender || "", recipient: row.recipient || "",
    date: new Date(row.timestamp).toISOString(), timestamp: row.timestamp,
    read: !!row.read, starred: !!row.starred, snippet: textSnippet(row.snippet), threadId: row.thread_id || undefined,
    ...(row.message_id ? { rfcMessageId: String(row.message_id).replace(/^<|>$/g, "").toLowerCase() } : {}),
    ...(row.folder_id === "spam" ? { spamReason: row.spam_reason || msg("In Spam") } : {}),
    ...(row.folder_id === "discarded" ? { discardReason: row.discard_reason || msg("You discarded it") } : {}) };
  message.triage = triage({ sender: message.sender, subject: message.subject, read: message.read, starred: message.starred,
    signals: signalsFromHeaders(parseStoredHeaders(row.raw_headers)), ownDomains });
  return message;
}
