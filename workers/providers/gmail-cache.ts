/**
 * The Gmail cache of one Durable Object: how a message is laid out in storage, the
 * date-ordered index the feed reads, and the inbox counters. Storage only — no request to
 * Gmail is made here (the client is gmail-client.ts, the sync loop gmail-sync.ts).
 *
 * Layout 2 (docs/architecture.md → "Gmail cache"), per account `a`:
 *
 *   message:a:<id>                 metadata row (StoredMessage, `layout: 2`)
 *   body:a:<id>:<blob>:<i>         the body, in chunks under 128 KiB
 *   idx:a:<view>:<rev-ts>:<id>     one row per folder the message is in (and `<folder>~u` while
 *                                  unread), newest first; the value is what the feed shows
 *   count:a                        { unread, total } of the inbox, kept in the same transaction
 *   cache:a                        { layout, after } — the layout and a migration's resume point
 *
 * Layout 1 (before 0.11) kept body chunks under the message's own key and had no index, so
 * every inbox read and count scanned the whole cache and failed past 20,000 keys. `migrate`
 * moves an account from 1 to 2 in resumable, transactional batches; until it is done the reads
 * fall back to the old scan, so no cached mail is ever hidden or lost on the way.
 */
import { triage } from "../../shared/mail/triage";
import { compareInbox, inboxIdentity, inboxPage, type InboxFolder, type InboxMessage, type InboxReadOptions } from "../../shared/mail/inbox";
import { ProviderError, type Message } from "./gmail-client";
import type { RemoteProvider } from "../../shared/mail/accounts";
import type { Store } from "./google-oauth";

export interface StoredMessage {
  message: Omit<Message, "text" | "html">;
  parts: number;
  blobId: string;
  generation?: string;
  /** 2 once the row is indexed and counted; absent on rows of the first layout. */
  layout?: 2;
  /** Imported with its headers only; the body is read from Gmail the first time it is opened. */
  bodyless?: boolean;
}
/** What the feed shows of a message: the index row's value. */
export type IndexRow = Pick<Message, "providerMessageId" | "threadId" | "subject" | "from" | "to" | "snippet" | "date" | "timestamp" | "read" | "labels" | "signals" | "rfcMessageId">;
export interface InboxCounts { unread: number; total: number }
interface CacheState { layout: 1 | 2; after?: string }

/** The folders a Gmail search can name; they are views over labels, as the feed shows them. */
export const GMAIL_FOLDERS = ["inbox", "sent", "archive", "starred", "spam", "trash", "draft", "discarded"] as const;
export type GmailFolder = (typeof GMAIL_FOLDERS)[number];
const FEED_FOLDERS: InboxFolder[] = ["inbox", "sent", "archive", "trash", "starred", "spam", "discarded"];
/**
 * The label every provider maps its Discarded place onto: Gmail's own "Discarded" label (whatever its
 * id), an IMAP or Outlook folder named Discarded. Discarded counts as deleted: such a message is in
 * no other view (inbox, archive, starred), and out of the inbox's counts.
 */
export const DISCARDED_LABEL = "DISCARDED";
export function inFolder(labels: string[], folder: GmailFolder) {
  const trash = labels.includes("TRASH"), spam = labels.includes("SPAM"), draft = labels.includes("DRAFT"), discarded = labels.includes(DISCARDED_LABEL);
  if (folder === "trash") return trash;
  if (folder === "spam") return spam && !trash;
  if (folder === "discarded") return discarded && !trash && !spam;
  if (folder === "draft") return draft && !trash;
  if (trash || spam || draft || discarded) return false;
  return folder === "inbox" ? labels.includes("INBOX") : folder === "sent" ? labels.includes("SENT")
    : folder === "starred" ? labels.includes("STARRED") : !labels.includes("INBOX") && !labels.includes("SENT");
}

export function keyPart(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new ProviderError("invalid_id", 400);
  return value;
}
export function msgKey(accountId: string, messageId: string) {
  return "message:" + keyPart(accountId) + ":" + keyPart(messageId);
}
const bodyPrefix = (a: string, id: string) => `body:${a}:${id}:`;
const legacyBodyPrefix = (a: string, id: string) => `message:${a}:${id}:body:`;
const countKey = (a: string) => "count:" + a;
const stateKey = (a: string) => "cache:" + a;
/** Every key prefix one account owns in this cache. */
export const cachePrefixes = (a: string) => [`message:${a}:`, `body:${a}:`, `idx:${a}:`];

const MAX_TS = 9_999_999_999_999;
/** The time the feed sorts by: Gmail's internal date, or the Date header when that is missing. */
export function feedTimestamp(m: { timestamp: number; date: string }) {
  return Number.isFinite(m.timestamp) && m.timestamp > 0 ? m.timestamp : Date.parse(m.date) || 0;
}
/** Newest first under an ascending key order. */
function rev(timestamp: number) {
  return String(MAX_TS - Math.min(Math.max(0, Math.floor(timestamp)), MAX_TS)).padStart(13, "0");
}
function views(m: Pick<Message, "labels" | "read">) {
  const out: string[] = [];
  for (const f of FEED_FOLDERS) if (inFolder(m.labels, f)) out.push(f, ...(m.read ? [] : [f + "~u"]));
  return out;
}
const idxKey = (a: string, view: string, m: IndexRow) => `idx:${a}:${view}:${rev(feedTimestamp(m))}:${m.providerMessageId}`;
function indexRow(m: StoredMessage["message"]): IndexRow {
  return { providerMessageId: m.providerMessageId, threadId: m.threadId, subject: m.subject, from: m.from, to: m.to, snippet: m.snippet,
    date: m.date, timestamp: m.timestamp, read: m.read, labels: m.labels, ...(m.signals ? { signals: m.signals } : {}),
    rfcMessageId: m.rfcMessageId ?? "" };
}
const inInbox = (m: Pick<Message, "labels">) => inFolder(m.labels, "inbox");

/** Which provider a cached account belongs to, for the feed's account id and its wording. */
export interface FeedSource { provider: RemoteProvider; providerName?: string }
const GMAIL_FEED: FeedSource = { provider: "gmail", providerName: "Gmail" };

/** One cached message (Gmail's, or an IMAP account's mapped onto the same labels) as the unified feed shows it. */
export function gmailInboxMessage(accountId: string, m: IndexRow, ownDomains: string[] = [], feed: FeedSource = GMAIL_FEED): InboxMessage {
  const id = feed.provider + ":" + accountId;
  const labels = m.labels;
  const timestamp = feedTimestamp(m);
  return { id: inboxIdentity(id, m.providerMessageId), accountId: id, provider: feed.provider, providerMessageId: m.providerMessageId,
    subject: m.subject, sender: m.from, recipient: m.to, date: new Date(timestamp).toISOString(), timestamp,
    read: m.read, starred: labels.includes("STARRED"), snippet: m.snippet, threadId: m.threadId,
    ...(m.rfcMessageId ? { rfcMessageId: m.rfcMessageId.replace(/^<|>$/g, "").toLowerCase() } : {}),
    ...(labels.includes("SPAM") ? { spamReason: `${feed.providerName ?? "The provider"} marked it as spam` } : {}),
    triage: triage({ sender: m.from, subject: m.subject, read: m.read, starred: labels.includes("STARRED"), labels, signals: m.signals, ownDomains }) };
}
const searchText = (m: Pick<Message, "subject" | "from" | "to" | "snippet">) => [m.subject, m.from, m.to, m.snippet].join(" ").toLowerCase();

/** Rows a search may read before it says the cache is too large to search in one request. */
export const SEARCH_SCAN_LIMIT = 50_000;
const CHUNK = 24_000;
const MIGRATE_BATCH = 100;

export class GmailCache {
  /** Accounts known to be on layout 2 in this object's lifetime. */
  private current = new Set<string>();
  constructor(private store: Store) {}

  /** The layout an account's cache is on; a cache with no rows starts on layout 2. */
  async layout(a: string): Promise<1 | 2> {
    if (this.current.has(a)) return 2;
    const state = await this.store.get<CacheState>(stateKey(a));
    if (state?.layout === 2) { this.current.add(a); return 2; }
    if (state) return 1;
    if ((await this.store.list({ prefix: `message:${a}:`, limit: 1 })).size) {
      await this.store.put<CacheState>(stateKey(a), { layout: 1 });
      return 1;
    }
    await this.store.put<CacheState>(stateKey(a), { layout: 2 });
    this.current.add(a);
    return 2;
  }

  /**
   * Moves an account's cache to layout 2 until `deadline` (epoch ms): body chunks to their own
   * prefix, every row indexed and counted, chunks of a replaced body and rows the first layout
   * already hid (`hidden`) deleted. Each batch, with its resume point, is one transaction, so a
   * restart resumes where it stopped and nothing is indexed or counted twice. True when done.
   */
  async migrate(a: string, hidden: (row: StoredMessage) => boolean, deadline: number): Promise<boolean> {
    if ((await this.layout(a)) === 2) return true;
    let batches = 0;
    while (batches === 0 || Date.now() < deadline) {
      batches++;
      const done = await this.store.transaction(async (tx) => {
        const state = await tx.get<CacheState>(stateKey(a));
        if (state?.layout === 2) return true;
        let after = state?.after;
        const rows = await tx.list<StoredMessage | string>({ prefix: `message:${a}:`, startAfter: after, limit: MIGRATE_BATCH });
        // The blob each row of this batch keeps (null: the row is gone), to place its chunks.
        const blobs = new Map<string, string | null>();
        for (const [key, row] of rows) {
          after = key;
          if (typeof row === "string") {
            // message:a:<id>:body:<blob>:<i>. The row sorts before its chunks, so it is migrated already.
            const [, , id, , blob, part] = key.split(":");
            const keep = blobs.has(id) ? blobs.get(id) : (await tx.get<StoredMessage>(`message:${a}:${id}`))?.blobId ?? null;
            if (keep === blob) await tx.put(`${bodyPrefix(a, id)}${blob}:${part}`, row);
            await tx.delete(key);
            continue;
          }
          blobs.set(row.message.providerMessageId, hidden(row) && row.layout !== 2 ? null : row.blobId);
          if (row.layout === 2) continue;
          if (hidden(row)) { await tx.delete(key); continue; }
          await tx.put<StoredMessage>(key, { ...row, layout: 2 });
          await this.index(tx, a, row.message, 1);
        }
        const finished = rows.size < MIGRATE_BATCH;
        await tx.put<CacheState>(stateKey(a), finished ? { layout: 2 } : { layout: 1, after });
        return finished;
      });
      if (done) {
        this.current.add(a);
        console.log(JSON.stringify({ event: "gmail_cache_migrated", layout: 2 }));
        return true;
      }
    }
    return false;
  }

  /** Index rows and counters for one message, added (sign 1) or removed (sign -1), inside `tx`. */
  private async index(tx: Store, a: string, m: StoredMessage["message"], sign: 1 | -1) {
    const row = indexRow(m);
    for (const view of views(m)) {
      if (sign > 0) await tx.put<IndexRow>(idxKey(a, view, row), row);
      else await tx.delete(idxKey(a, view, row));
    }
    if (!inInbox(m)) return;
    const counts = (await tx.get<InboxCounts>(countKey(a))) ?? { unread: 0, total: 0 };
    counts.total = Math.max(0, counts.total + sign);
    if (!m.read) counts.unread = Math.max(0, counts.unread + sign);
    await tx.put(countKey(a), counts);
  }

  async row(a: string, id: string) {
    return this.store.get<StoredMessage>(msgKey(a, id));
  }

  /**
   * Saves a message: the body first under a fresh blob, then the row, its index rows and the
   * counters in one transaction, then the chunks of the body it replaced. A failure before the
   * transaction leaves the previous copy whole. A message saved `bodyless` keeps a body cached
   * before (and its attachment list), since headers alone say nothing about either.
   */
  async save(a: string, message: Message, generation: string | undefined, options: { bodyless?: boolean } = {}) {
    const key = msgKey(a, message.providerMessageId);
    const { text, html, ...metadata } = message;
    const blobId = crypto.randomUUID();
    let parts = 0;
    if (!options.bodyless) {
      // Durable Object values are limited to 128 KiB; Unicode JSON is split below that byte bound.
      const data = JSON.stringify({ text, html });
      parts = Math.max(1, Math.ceil(data.length / CHUNK));
      for (let i = 0; i < parts; i++) await this.store.put(`${bodyPrefix(a, message.providerMessageId)}${blobId}:${i}`, data.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    const kept = await this.store.transaction(async (tx) => {
      const previous = await tx.get<StoredMessage>(key);
      const keepBody = options.bodyless && previous && !previous.bodyless && previous.parts > 0;
      const row: StoredMessage = keepBody
        ? { message: { ...metadata, attachments: previous.message.attachments }, parts: previous.parts, blobId: previous.blobId, generation, layout: 2 }
        : { message: metadata, parts, blobId, generation, layout: 2, ...(options.bodyless ? { bodyless: true } : {}) };
      if (previous?.layout === 2) await this.index(tx, a, previous.message, -1);
      await tx.put<StoredMessage>(key, row);
      await this.index(tx, a, row.message, 1);
      return row.blobId;
    });
    await this.dropBodies(a, message.providerMessageId, kept);
  }

  /**
   * Changes a cached message's labels (an IMAP flag change) without touching its body: the row, its
   * index rows and the counters move together in one transaction. False when it is not cached.
   */
  async relabel(a: string, id: string, labels: string[]): Promise<boolean> {
    const key = msgKey(a, id);
    return this.store.transaction(async (tx) => {
      const previous = await tx.get<StoredMessage>(key);
      if (!previous) return false;
      const same = previous.message.labels.length === labels.length && previous.message.labels.every((l) => labels.includes(l));
      if (same) return true;
      if (previous.layout === 2) await this.index(tx, a, previous.message, -1);
      const row: StoredMessage = { ...previous, layout: 2, message: { ...previous.message, labels, read: !labels.includes("UNREAD"), archived: !labels.includes("INBOX") } };
      await tx.put<StoredMessage>(key, row);
      await this.index(tx, a, row.message, 1);
      return true;
    });
  }

  /** Deletes a message with its body chunks, index rows and its share of the counters. */
  async remove(a: string, id: string) {
    const key = msgKey(a, id);
    await this.store.transaction(async (tx) => {
      const previous = await tx.get<StoredMessage>(key);
      if (!previous) return;
      if (previous.layout === 2) await this.index(tx, a, previous.message, -1);
      await tx.delete(key);
    });
    await this.dropBodies(a, id);
  }

  /** Every body chunk of a message except those of the blob `keep` (in either layout). */
  private async dropBodies(a: string, id: string, keep?: string) {
    for (const prefix of [bodyPrefix(a, id), legacyBodyPrefix(a, id)]) {
      let after: string | undefined;
      for (;;) {
        const rows = await this.store.list({ prefix, startAfter: after, limit: 100 });
        for (const key of rows.keys()) {
          after = key;
          if (keep && key.slice(prefix.length).startsWith(keep + ":")) continue;
          await this.store.delete(key);
        }
        if (rows.size < 100) break;
      }
    }
  }

  /** The body of a cached row; a chunk may still sit under the first layout's key mid-migration. */
  async body(a: string, id: string, row: StoredMessage): Promise<{ text: string; html: string }> {
    let body = "";
    for (let i = 0; i < row.parts; i++) {
      const part = (await this.store.get<string>(`${bodyPrefix(a, id)}${row.blobId}:${i}`))
        ?? (await this.store.get<string>(`${legacyBodyPrefix(a, id)}${row.blobId}:${i}`));
      if (part === undefined) throw new ProviderError("message_store_unavailable", 503);
      body += part;
    }
    return body ? JSON.parse(body) : { text: "", html: "" };
  }

  /**
   * One page of the feed for an account, newest first: `limit + 1` rows after `before`, read
   * from the index. Without a search this reads about one page of rows however large the cache
   * is; a search reads the folder until it has a page, up to SEARCH_SCAN_LIMIT rows.
   */
  async inboxPage(a: string, options: InboxReadOptions, feed: FeedSource = GMAIL_FEED): Promise<InboxMessage[]> {
    const prefix = `idx:${a}:${options.folder}${options.unread ? "~u" : ""}:`;
    const need = options.limit + 1;
    const query = options.query ? options.query.toLowerCase() : "";
    const out: InboxMessage[] = [];
    // Rows at the cursor's own timestamp are read again and filtered by the full position.
    let after = options.before ? prefix + rev(options.before.timestamp) : undefined;
    let scanned = 0;
    for (;;) {
      const batch = query ? 500 : Math.min(500, need - out.length + 10);
      const rows = await this.store.list<IndexRow>({ prefix, startAfter: after, limit: batch });
      for (const [key, row] of rows) {
        after = key;
        scanned++;
        if (query && !searchText(row).includes(query)) continue;
        const m = gmailInboxMessage(a, row, options.ownDomains, feed);
        if (options.before && compareInbox(m, options.before) <= 0) continue;
        out.push(m);
        if (out.length >= need) return out;
      }
      if (rows.size < batch) return out;
      if (scanned >= SEARCH_SCAN_LIMIT) throw new ProviderError("cache_scan_limit", 503);
    }
  }

  /** Unread and total mail in the inbox: the stored counters. */
  async counts(a: string): Promise<InboxCounts> {
    return (await this.store.get<InboxCounts>(countKey(a))) ?? { unread: 0, total: 0 };
  }

  /**
   * The first layout's read, used only while an account's migration is unfinished: the whole
   * cache in key order, sorted by date. Refuses an incomplete scan rather than hiding mail.
   */
  async legacyInboxPage(a: string, options: InboxReadOptions, visible: (row: StoredMessage) => boolean, feed: FeedSource = GMAIL_FEED): Promise<InboxMessage[]> {
    let messages: InboxMessage[] = [];
    let after: string | undefined;
    for (let batch = 0; batch < 200; batch++) {
      const rows = await this.store.list<StoredMessage | string>({ prefix: `message:${a}:`, limit: 100, startAfter: after });
      for (const [key, row] of rows) {
        after = key;
        if (typeof row === "string" || !visible(row)) continue;
        const m = row.message;
        if (!inFolder(m.labels, options.folder) || (options.unread && m.read) || (options.query && !searchText(m).includes(options.query.toLowerCase()))) continue;
        messages.push(gmailInboxMessage(a, m, options.ownDomains, feed));
      }
      messages = inboxPage(messages, options);
      if (rows.size < 100) return messages;
    }
    throw new ProviderError("cache_scan_limit", 503);
  }

  /** The first layout's count, while an account's migration is unfinished. */
  async legacyCounts(a: string, visible: (row: StoredMessage) => boolean): Promise<InboxCounts> {
    let unread = 0, total = 0;
    let after: string | undefined;
    for (let batch = 0; batch < 200; batch++) {
      const rows = await this.store.list<StoredMessage | string>({ prefix: `message:${a}:`, limit: 100, startAfter: after });
      for (const [key, row] of rows) {
        after = key;
        if (typeof row === "string" || !visible(row) || !inInbox(row.message)) continue;
        total++;
        if (!row.message.read) unread++;
      }
      if (rows.size < 100) return { unread, total };
    }
    throw new ProviderError("cache_scan_limit", 503);
  }

  /**
   * Deletes, after `after` and until `deadline`, every row not of `generation`: what a finished
   * re-import did not see is no longer in Gmail. Returns where to resume, or undefined when done.
   */
  async sweep(a: string, generation: string | undefined, after: string | undefined, deadline: number): Promise<{ after?: string; removed: number }> {
    let removed = 0;
    do {
      const rows = await this.store.list<StoredMessage | string>({ prefix: `message:${a}:`, startAfter: after, limit: 200 });
      for (const [key, row] of rows) {
        after = key;
        if (typeof row === "string" || row.generation === generation) continue;
        await this.remove(a, row.message.providerMessageId);
        removed++;
      }
      if (rows.size < 200) return { removed };
    } while (Date.now() < deadline);
    return { after, removed };
  }

  /** Forgets everything this cache holds for an account (disconnecting it). */
  async clear(a: string) {
    for (const prefix of cachePrefixes(a)) {
      for (;;) {
        const rows = await this.store.list({ prefix, limit: 100 });
        if (!rows.size) break;
        for (const key of rows.keys()) await this.store.delete(key);
      }
    }
    await this.store.delete(countKey(a));
    await this.store.delete(stateKey(a));
    this.current.delete(a);
  }
}
