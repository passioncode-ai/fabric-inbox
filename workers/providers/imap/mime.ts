/**
 * IMAP messages in the cache's shape (`Message`, gmail-client.ts): an IMAP folder and its flags
 * become the labels the cache, the feed and triage already read, so one cache serves both
 * providers. The MIME work is postal-mime's (charsets, encoded words, nested multiparts).
 *
 * | IMAP | label |
 * |---|---|
 * | INBOX / Sent / Drafts / Trash / Junk | INBOX / SENT / DRAFT / TRASH / SPAM |
 * | Archive | none (the feed's archive is "in no other folder") |
 * | Discarded (a folder by that name) | DISCARDED |
 * | no \Seen | UNREAD |
 * | \Flagged | STARRED |
 */
import PostalMime, { decodeWords } from "postal-mime";
import { signalsFromHeaders } from "../../../shared/mail/triage";
import type { Message } from "../gmail-client";
import { ROLE_KEY, type FolderRole } from "./types";

const ROLE_LABEL: Record<FolderRole, string | null> = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT", trash: "TRASH", junk: "SPAM", archive: null, discarded: "DISCARDED" };

export function labelsFor(role: FolderRole, flags: Iterable<string>): string[] {
  const set = new Set([...flags].map((f) => f.toLowerCase()));
  const labels: string[] = [];
  const own = ROLE_LABEL[role];
  if (own) labels.push(own);
  if (!set.has("\\seen")) labels.push("UNREAD");
  if (set.has("\\flagged")) labels.push("STARRED");
  return labels;
}

/** A message's id here: its folder's key, the folder's UIDVALIDITY and its UID (`i-1712345678-42`). */
export function messageKey(role: FolderRole, uidValidity: number, uid: number) {
  return `${ROLE_KEY[role]}-${uidValidity}-${uid}`;
}
export function parseMessageKey(id: string): { role: FolderRole; uidValidity: number; uid: number } | null {
  const m = /^([a-z])-(\d{1,10})-(\d{1,10})$/.exec(id);
  if (!m) return null;
  const role = (Object.keys(ROLE_KEY) as FolderRole[]).find((r) => ROLE_KEY[r] === m[1]);
  return role ? { role, uidValidity: Number(m[2]), uid: Number(m[3]) } : null;
}

/** The first Message-ID in a header value, lower-cased, without its brackets. */
function firstId(value: string | undefined): string | undefined {
  return /<([^<>\s]+)>/.exec(value ?? "")?.[1]?.toLowerCase();
}
/**
 * A conversation's id, the same for every message in it: the root's Message-ID (the first in
 * References, else In-Reply-To, else the message's own), hashed into the thread id shape the app
 * and Gmail use. A message with no Message-ID is its own conversation.
 */
export function threadKey(references: string | undefined, inReplyTo: string | undefined, messageId: string | undefined, fallback: string): string {
  const root = firstId(references) ?? firstId(inReplyTo) ?? firstId(messageId) ?? fallback;
  // Two independent FNV-1a 32-bit hashes: 64 bits, enough for one account's conversations.
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < root.length; i++) {
    const c = root.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return "t" + a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const decode = (value: string | undefined) => {
  if (!value) return "";
  try { return decodeWords(value).trim(); } catch { return value.trim(); }
};
const snippetOf = (text: string, html: string) =>
  (text || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
    .replace(/\s+/g, " ").trim().slice(0, 200);

export interface ImapMeta {
  accountId: string;
  role: FolderRole;
  uidValidity: number;
  uid: number;
  flags: Iterable<string>;
  internalDate?: Date | number | null;
  size?: number;
}

/**
 * A message from its raw RFC 5322 text — the whole message (`withBody`), or only its header block
 * (an import of older mail: the body is read when the message is first opened).
 */
export async function messageFromRaw(raw: Uint8Array | string, meta: ImapMeta, withBody: boolean): Promise<Message> {
  const parsed = await new PostalMime({ attachmentEncoding: "arraybuffer" }).parse(withBody ? raw : headerBlock(raw));
  const header = (name: string) => parsed.headers.find((h) => h.key === name)?.value;
  const id = messageKey(meta.role, meta.uidValidity, meta.uid);
  const text = withBody ? parsed.text ?? "" : "";
  const html = withBody ? parsed.html ?? "" : "";
  const date = header("date") ?? "";
  const internal = meta.internalDate instanceof Date ? meta.internalDate.getTime() : typeof meta.internalDate === "number" ? meta.internalDate : 0;
  const labels = labelsFor(meta.role, meta.flags);
  return {
    id: meta.accountId + ":" + id,
    accountId: meta.accountId,
    providerMessageId: id,
    threadId: threadKey(header("references"), header("in-reply-to"), header("message-id"), id),
    subject: parsed.subject ?? decode(header("subject")),
    from: decode(header("from")),
    to: decode(header("to")),
    cc: decode(header("cc")),
    replyTo: decode(header("reply-to")),
    bcc: decode(header("bcc")),
    inReplyTo: (header("in-reply-to") ?? "").trim(),
    date,
    rfcMessageId: (header("message-id") ?? "").trim(),
    references: (header("references") ?? "").replace(/\s+/g, " ").trim(),
    timestamp: Number.isFinite(internal) && internal > 0 ? internal : Date.parse(date) || 0,
    snippet: withBody ? snippetOf(text, html) : "",
    text,
    html,
    read: !labels.includes("UNREAD"),
    archived: !labels.includes("INBOX"),
    labels,
    signals: signalsFromHeaders(parsed.headers),
    attachments: withBody ? parsed.attachments.map((a, i) => ({
      filename: a.filename ?? "",
      mimeType: a.mimeType || "application/octet-stream",
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
      providerAttachmentId: String(i),
    })) : [],
  };
}

/** The header block of a raw message (everything before the first empty line), and the empty line. */
export function headerBlock(raw: Uint8Array | string): Uint8Array {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  let end = bytes.length;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    // "\n\n" or "\n\r\n": the line just ended is followed by an empty one.
    if (bytes[i + 1] === 10) { end = i; break; }
    if (bytes[i + 1] === 13 && bytes[i + 2] === 10) { end = i; break; }
  }
  const head = bytes.subarray(0, end && bytes[end - 1] === 13 ? end - 1 : end);
  const out = new Uint8Array(head.length + 4);
  out.set(head);
  out.set([13, 10, 13, 10], head.length);
  return out;
}

/** Every header of a raw message, unfolded, values as they are (View source). */
export async function rawHeaders(raw: Uint8Array | string): Promise<{ key: string; value: string }[]> {
  const parsed = await new PostalMime().parse(headerBlock(raw));
  return parsed.headerLines.map((h) => {
    const at = h.line.indexOf(":");
    return { key: at < 0 ? h.line : h.line.slice(0, at).trim(), value: at < 0 ? "" : h.line.slice(at + 1).trim() };
  });
}

/** One file of a raw message, by its index among the message's attachments, as base64url. */
export async function attachmentFromRaw(raw: Uint8Array | string, attachmentId: string): Promise<{ data: string; size: number } | null> {
  if (!/^\d{1,4}$/.test(attachmentId)) return null;
  const parsed = await new PostalMime({ attachmentEncoding: "arraybuffer" }).parse(raw);
  const file = parsed.attachments[Number(attachmentId)];
  if (!file) return null;
  const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : new Uint8Array(file.content);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), size: bytes.length };
}
