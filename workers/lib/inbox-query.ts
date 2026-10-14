import { inboxIdentity, type InboxReadOptions, type InboxMessage } from "../../shared/mail/inbox";
import { signalsFromHeaders, triage } from "../../shared/mail/triage";
import { parseStoredHeaders } from "../agents/prefilter";
import { displaySender } from "../../shared/mail/sender";
import { msg } from "../../shared/i18n";

/** Bounded SQL keyset read. SQL parameters contain every caller-controlled value. */
export function mailboxInboxQuery(accountId: string, options: InboxReadOptions) {
  const conditions: string[] = [], parameters: (string | number)[] = [];
  if (options.folder === "starred") conditions.push("starred = 1 AND folder_id NOT IN ('trash', 'spam', 'draft', 'discarded')");
  else { conditions.push("folder_id = ?"); parameters.push(options.folder); }
  if (options.unread) conditions.push("read = 0");
  if (options.query) {
    // SQLite's lower() folds ASCII only, so "Привет" never matched "привет" (UI walk 2026-10-08).
    // The ASCII-folded match stays; a query with other letters also looks for its lower, capitalised
    // and upper forms in the text as written.
    // The message's plain text (B-21); a row stored before the column was filled falls back to its body's start.
    const text = "(coalesce(subject,'') || ' ' || coalesce(sender,'') || ' ' || coalesce(sender_name,'') || ' ' || coalesce(recipient,'') || ' ' || coalesce(search_body,''))";
    const variants = searchVariants(options.query);
    conditions.push(`(instr(lower(${text}), ?) > 0${variants.map(() => ` OR instr(${text}, ?) > 0`).join("")})`);
    parameters.push(options.query.toLowerCase(), ...variants);
  }
  if (options.before) {
    const before = options.before;
    conditions.push("(timestamp < ? OR (timestamp = ? AND (? > ? OR (? = ? AND id > ?))))");
    parameters.push(before.timestamp, before.timestamp, accountId, before.accountId, accountId, before.accountId, before.providerMessageId);
  }
  parameters.push(options.limit + 1);
  return {
    sql: `SELECT * FROM (SELECT id, subject, sender, sender_name, recipient, date, read, starred, thread_id, folder_id, raw_headers, message_id, spam_reason, discard_reason,
      substr(body,1,2000) AS snippet, coalesce(search_text, substr(body,1,2000)) AS search_body,
      coalesce(cast(round((julianday(date)-2440587.5)*86400000) AS INTEGER),0) AS timestamp
      FROM emails) WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC, id ASC LIMIT ?`,
    parameters,
  };
}
/** Case forms of a query with non-ASCII letters, matched against the text as written (SQLite folds ASCII only). */
export function searchVariants(query: string): string[] {
  if (!/[^\u0000-\u007f]/.test(query)) return [];
  const lower = query.toLocaleLowerCase();
  const forms = [lower, lower.charAt(0).toLocaleUpperCase() + lower.slice(1), query.toLocaleUpperCase()];
  return [...new Set(forms)];
}

export interface MailboxInboxRow {
  [key: string]: string | number | null;
  id: string; subject: string | null; sender: string | null; sender_name: string | null; recipient: string | null;
  date: string | null; read: number; starred: number; thread_id: string | null;
  snippet: string | null; timestamp: number; raw_headers: string | null; message_id: string | null;
  spam_reason: string | null; folder_id: string | null; discard_reason: string | null;
}

/** The body as plain text: the body column holds HTML for most mail. */
function plainText(body: string | null): string {
  if (!body) return "";
  return body
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // An inline element joins the text around it, as a browser shows it: "<b>Ann</b>." reads "Ann.", not "Ann ." (B-113).
    .replace(/<\/?(?:a|abbr|b|bdi|bdo|cite|code|data|dfn|em|font|i|kbd|mark|q|s|samp|small|span|strike|strong|sub|sup|time|u|var|wbr)\b[^>]*>/gi, "")
    .replace(/<[^>]*>?/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
/** A plain-text preview. */
export function textSnippet(body: string | null): string { return plainText(body).slice(0, 300); }

/** How much of a message's text is searched (B-21): the stored column holds this much plain text. */
export const SEARCH_TEXT_CHARS = 20_000;
/** The text a Cloudflare message is searched by (B-21): its words, not its markup, the way Gmail searches. */
export function searchText(body: string | null): string { return plainText(body).slice(0, SEARCH_TEXT_CHARS); }
export function mailboxInboxMessage(accountId: string, row: MailboxInboxRow, ownDomains: string[] = []): InboxMessage {
  const message: InboxMessage = { id: inboxIdentity(accountId, row.id), accountId, provider: "cloudflare", providerMessageId: row.id,
    subject: row.subject || "", sender: displaySender(row.sender, row.sender_name, row.raw_headers), recipient: row.recipient || "",
    date: new Date(row.timestamp).toISOString(), timestamp: row.timestamp,
    read: !!row.read, starred: !!row.starred, snippet: textSnippet(row.snippet), threadId: row.thread_id || undefined,
    ...(row.message_id ? { rfcMessageId: String(row.message_id).replace(/^<|>$/g, "").toLowerCase() } : {}),
    ...(row.folder_id === "spam" ? { spamReason: row.spam_reason || msg("In Spam") } : {}),
    ...(row.folder_id === "discarded" ? { discardReason: row.discard_reason || msg("You discarded it") } : {}) };
  message.triage = triage({ sender: message.sender, subject: message.subject, read: message.read, starred: message.starred,
    signals: signalsFromHeaders(parseStoredHeaders(row.raw_headers)), ownDomains });
  return message;
}
