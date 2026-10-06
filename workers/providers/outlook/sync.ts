/**
 * How an Outlook account's cache follows its mailbox (docs/architecture.md → "Outlook accounts").
 *
 * Per synced folder (Inbox, Sent Items, Drafts, Deleted Items, Junk Email, Archive — by Graph's
 * well-known names), a delta query (`/me/mailFolders/{id}/messages/delta`,
 * https://learn.microsoft.com/en-us/graph/delta-query-messages):
 *
 * - **Import** — the folder's first round, newest first (`$orderby=receivedDateTime desc`, the one
 *   order Graph allows there), 50 a page (`Prefer: odata.maxpagesize=50`), the Inbox first;
 *   properties only (the body is read when a message is first opened). The round's `@odata.nextLink`
 *   is kept between ticks; its last page gives the `@odata.deltaLink`.
 * - **History** — runs first, every tick, from the moment the account connects: each imported
 *   folder's `@odata.deltaLink` round (new mail read whole and, in the Inbox, queued once for rules,
 *   agents and categories; read state, flags and moves relabelled; removals checked), and for a
 *   folder still importing, its newest 20 messages, so new mail never waits behind an import.
 * - A removal (`@removed`) is a message deleted or moved out of the folder; with immutable ids the
 *   message keeps its id in its new folder, so it is asked for once: gone, it leaves the cache; in
 *   another synced folder, it is relabelled; elsewhere, it leaves the cache.
 * - **Reset** — Graph answering 410 Gone (or `syncStateNotFound`) for a delta link: the folder is
 *   imported again under a new generation, and after that the folder's cached rows the new round did
 *   not see are removed.
 *
 * Every step checks the page's deadline and keeps where it stopped, so a tick ends on time and the
 * next resumes; a throttled read waits its Retry-After when that fits the deadline, else the account
 * waits until then. One message that cannot be read is set aside, never holding back its account.
 */
import { ProviderError, type Message } from "../gmail-client";
import type { GmailCache, StoredMessage } from "../gmail-cache";
import type { Store } from "../google-oauth";
import type { PageResult } from "../provider";
import { MESSAGE_FIELDS, labelsFor, localId, messageFromGraph, messageWithBody, roleOfLabels, type GraphAttachment, type GraphMessage } from "./convert";
import type { GraphClient } from "./graph";
import { randomId } from "./oauth";
import { OUTLOOK_FOLDERS, type OutlookAccount, type OutlookFolderState, type OutlookRole, type OutlookSyncState } from "./types";

/** Messages per delta page. */
export const PAGE_SIZE = 50;
/** The newest messages read each tick of a folder still importing. */
export const NEWEST = 20;
/** A message larger than this is not downloaded to be read here (as for IMAP). */
export const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
/** The folders are listed again after a day. */
const LIST_EVERY_MS = 86_400_000;
/** The import order: what a person looks at first, first. */
const IMPORT_ORDER: OutlookRole[] = ["inbox", "sent", "archive", "drafts", "junk", "trash"];
/** How long a throttled read may wait in place for its Retry-After. */
const PATIENCE_MS = 5_000;

const patience = (deadline: number) => Math.max(0, Math.min(PATIENCE_MS, deadline - Date.now()));
const enc = encodeURIComponent;

/** The role of a Graph folder id among the account's synced folders. */
export function roleOfFolder(sync: OutlookSyncState, folderId: string | undefined): OutlookRole | undefined {
  return folderId ? sync.folders.find((f) => f.id === folderId)?.role : undefined;
}

/**
 * One message whole, read from Graph now: its properties, its MIME source for the body and every
 * header, and its attachments' list. Null when it is in a folder this server does not read. A source
 * larger than MAX_MESSAGE_BYTES is left out (the message is kept without its body).
 */
export async function readMessage(graph: GraphClient, account: OutlookAccount, graphId: string, patienceMs?: number): Promise<{ message: Message; role: OutlookRole; bodyless: boolean } | null> {
  const meta = await graph.json<GraphMessage>(`/me/messages/${enc(graphId)}?$select=${MESSAGE_FIELDS}`, { patience: patienceMs });
  const role = roleOfFolder(account.sync, meta.parentFolderId);
  if (!role) return null;
  let mime: Uint8Array | null = null;
  try {
    mime = await graph.bytes(`/me/messages/${enc(graphId)}/$value`, MAX_MESSAGE_BYTES, { patience: patienceMs });
  } catch (error) {
    if (!(error instanceof ProviderError && error.code === "message_too_large")) throw error;
  }
  const attachments = meta.hasAttachments
    ? (await graph.json<{ value?: GraphAttachment[] }>(`/me/messages/${enc(graphId)}/attachments?$select=id,name,contentType,size,isInline`, { patience: patienceMs })).value ?? []
    : [];
  return { message: await messageWithBody(account.id, meta, role, mime, attachments), role, bodyless: !mime };
}

export class OutlookSync {
  constructor(private store: Store, private cache: GmailCache) {}

  /** Lists the synced folders by their well-known names: a folder that is new starts its import. */
  async discover(account: OutlookAccount, graph: GraphClient, deadline: number) {
    const sync = account.sync;
    const next: OutlookFolderState[] = [];
    for (const { role, wellKnown } of OUTLOOK_FOLDERS) {
      let folder: { id?: string; totalItemCount?: number };
      try {
        folder = await graph.json(`/me/mailFolders/${wellKnown}?$select=id,totalItemCount`, { patience: patience(deadline) });
      } catch (error) {
        // An account without an Archive folder (it appears when Archive is first used) syncs without one.
        if (error instanceof ProviderError && error.code === "not_found" && role !== "inbox") continue;
        throw error;
      }
      if (!folder.id) continue;
      const old = sync.folders.find((f) => f.role === role);
      next.push(old && old.id === folder.id ? { ...old, total: folder.totalItemCount ?? old.total }
        : { role, id: folder.id, total: folder.totalItemCount ?? 0, seen: 0, generation: randomId() });
    }
    // A folder gone (or replaced) takes its cached mail with it.
    for (const old of sync.folders) if (!next.some((f) => f.role === old.role && f.id === old.id)) await this.sweepRole(account, old.role, null, undefined, Infinity);
    sync.folders = next;
    sync.listedAt = Date.now();
    this.progress(sync);
  }

  /** History for every folder: what changed since the last round. */
  async historyPage(account: OutlookAccount, graph: GraphClient, deadline: number): Promise<PageResult> {
    const sync = account.sync;
    sync.since ??= Date.now();
    if (!sync.folders.length || !sync.listedAt || Date.now() - sync.listedAt > LIST_EVERY_MS) await this.discover(account, graph, deadline);
    let more = false, skipped = 0;
    for (const folder of sync.folders) {
      if (Date.now() >= deadline) { more = true; break; }
      const result = folder.deltaLink ? await this.round(account, graph, folder, "history", deadline) : await this.newest(account, graph, folder, deadline);
      more ||= result.more;
      skipped += result.skipped;
    }
    sync.more = more;
    this.progress(sync);
    return { more, skipped };
  }

  /**
   * The import until the deadline: each folder whose first round is not done, in IMPORT_ORDER, and
   * after a reset the sweep of the rows that round did not see again.
   */
  async importPage(account: OutlookAccount, graph: GraphClient, deadline: number): Promise<PageResult> {
    const sync = account.sync;
    let skipped = 0;
    for (const role of IMPORT_ORDER) {
      const folder = sync.folders.find((f) => f.role === role);
      if (!folder) continue;
      if (!folder.deltaLink) {
        skipped += (await this.round(account, graph, folder, "import", deadline)).skipped;
        if (!folder.deltaLink) { this.progress(sync); return { more: true, skipped }; }
      }
      if (folder.sweep) {
        const resume = await this.sweepRole(account, folder.role, folder.generation ?? null, folder.sweepAfter, deadline);
        if (resume) { folder.sweepAfter = resume; this.progress(sync); return { more: true, skipped }; }
        delete folder.sweep; delete folder.sweepAfter;
      }
      if (Date.now() >= deadline) break;
    }
    this.progress(sync);
    return { more: sync.mode === "initial", skipped };
  }

  /** The first URL of a folder's import round. */
  private initial(folder: OutlookFolderState) {
    return `/me/mailFolders/${enc(folder.id)}/messages/delta?$select=${MESSAGE_FIELDS}&$orderby=receivedDateTime%20desc`;
  }

  /**
   * Pages of one delta round until it ends (its deltaLink kept) or the deadline (its nextLink kept).
   * An import round saves properties only; a history round reads new mail whole.
   */
  private async round(account: OutlookAccount, graph: GraphClient, folder: OutlookFolderState, kind: "import" | "history", deadline: number): Promise<PageResult> {
    let url = folder.nextLink ?? (kind === "history" ? folder.deltaLink! : this.initial(folder));
    let skipped = 0;
    for (;;) {
      if (Date.now() >= deadline) { folder.nextLink = url; return { more: true, skipped }; }
      let page: { value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
      try {
        page = await graph.json(url, { prefer: [`odata.maxpagesize=${PAGE_SIZE}`], patience: patience(deadline) });
      } catch (error) {
        if (error instanceof ProviderError && error.code === "delta_reset") {
          // Graph ended the round: import the folder again, then remove what it no longer has.
          console.warn(JSON.stringify({ event: "outlook_delta_reset", role: folder.role }));
          Object.assign(folder, { generation: randomId(), sweep: true, seen: 0 });
          delete folder.deltaLink; delete folder.nextLink; delete folder.sweepAfter;
          account.sync.mode = "initial";
          return { more: true, skipped };
        }
        throw error;
      }
      // A page is always finished: its nextLink is kept only after every item of it is applied.
      for (const item of page.value ?? []) skipped += await this.apply(account, graph, folder, item, kind, deadline);
      if (page["@odata.nextLink"]) { url = page["@odata.nextLink"]; folder.nextLink = url; continue; }
      if (page["@odata.deltaLink"]) folder.deltaLink = page["@odata.deltaLink"];
      delete folder.nextLink;
      return { more: false, skipped };
    }
  }

  /** One item of a delta page. Returns 1 when the message was set aside. */
  private async apply(account: OutlookAccount, graph: GraphClient, folder: OutlookFolderState, item: GraphMessage, kind: "import" | "history", deadline: number): Promise<number> {
    if (!item?.id) return 0;
    const id = await localId(item.id);
    const row = await this.cache.row(account.id, id) as StoredMessage | undefined;
    if (item["@removed"]) {
      // Already relabelled into another folder by that folder's round: nothing left to do here.
      if (!row || roleOfLabels(row.message.labels) !== folder.role) return 0;
      await this.settle(account, graph, id, item.id, deadline);
      return 0;
    }
    if (kind === "import") {
      folder.seen = (folder.seen ?? 0) + 1;
      await this.cache.save(account.id, await messageFromGraph(account.id, item, folder.role), folder.generation, { bodyless: true });
      return 0;
    }
    if (row) {
      // A change, or a message moved in: its properties when the page carries them, else its labels.
      if (item.subject !== undefined && item.receivedDateTime !== undefined)
        await this.cache.save(account.id, await messageFromGraph(account.id, item, folder.role), folder.generation, { bodyless: true });
      else
        await this.cache.relabel(account.id, id, labelsFor(folder.role, {
          isRead: item.isRead ?? !row.message.labels.includes("UNREAD"),
          flag: item.flag ?? { flagStatus: row.message.labels.includes("STARRED") ? "flagged" : "notFlagged" },
        }));
      return 0;
    }
    return this.arrived(account, graph, folder, item, deadline);
  }

  /** New mail: read whole, cached, and in the Inbox queued once for rules, agents and categories. */
  private async arrived(account: OutlookAccount, graph: GraphClient, folder: OutlookFolderState, item: GraphMessage, deadline: number): Promise<number> {
    let read: Awaited<ReturnType<typeof readMessage>>;
    try {
      read = await readMessage(graph, account, item.id, patience(deadline));
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") return 0; // gone meanwhile
      if (error instanceof ProviderError && (error.code === "rate_limited" || error.code === "provider_unavailable" || error.code === "provider_auth_failed")) throw error;
      // Kept with its properties only; set aside so the reason is counted, never retried forever.
      const id = await localId(item.id);
      await this.store.put(`skipped:${account.id}:${id}`, { error: error instanceof ProviderError ? error.code : "message_unreadable", at: Date.now() });
      await this.cache.save(account.id, await messageFromGraph(account.id, item, folder.role), folder.generation, { bodyless: true });
      console.warn(JSON.stringify({ event: "outlook_message_skipped", role: folder.role, error: error instanceof ProviderError ? error.code : "unknown" }));
      return 1;
    }
    if (!read) return 0;
    await this.cache.save(account.id, read.message, folder.generation, { bodyless: read.bodyless });
    if (read.role === "inbox" && !read.message.labels.includes("DRAFT")) await this.queueEvent(account.id, read.message.providerMessageId);
    return 0;
  }

  /** A message reported removed from a folder: asked for once, then relabelled or forgotten. */
  private async settle(account: OutlookAccount, graph: GraphClient, id: string, graphId: string, deadline: number) {
    let now: GraphMessage;
    try {
      now = await graph.json<GraphMessage>(`/me/messages/${enc(graphId)}?$select=id,parentFolderId,isRead,flag`, { patience: patience(deadline) });
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") { await this.cache.remove(account.id, id); return; }
      throw error;
    }
    const role = roleOfFolder(account.sync, now.parentFolderId);
    if (role) await this.cache.relabel(account.id, id, labelsFor(role, now));
    else await this.cache.remove(account.id, id);
  }

  /** A folder still importing: its newest messages, so new mail is never behind the import. */
  private async newest(account: OutlookAccount, graph: GraphClient, folder: OutlookFolderState, deadline: number): Promise<PageResult> {
    const page = await graph.json<{ value?: GraphMessage[] }>(
      `/me/mailFolders/${enc(folder.id)}/messages?$select=${MESSAGE_FIELDS}&$top=${NEWEST}&$orderby=receivedDateTime%20desc`, { patience: patience(deadline) });
    let skipped = 0;
    for (const item of page.value ?? []) {
      if (Date.now() >= deadline) return { more: true, skipped };
      const id = await localId(item.id);
      if (await this.cache.row(account.id, id)) {
        await this.cache.relabel(account.id, id, labelsFor(folder.role, item));
        continue;
      }
      const received = Date.parse(item.receivedDateTime ?? "");
      if (Number.isFinite(received) && received >= (account.sync.since ?? Infinity)) skipped += await this.arrived(account, graph, folder, item, deadline);
      else await this.cache.save(account.id, await messageFromGraph(account.id, item, folder.role), folder.generation, { bodyless: true });
    }
    return { more: false, skipped };
  }

  private async queueEvent(accountId: string, messageId: string) {
    const eventKey = "event:" + accountId + ":" + messageId;
    await this.store.transaction(async (tx) => {
      const old = await tx.get<{ delivered: boolean }>(eventKey);
      if (!old || !old.delivered) {
        const event = { accountId, messageId, delivered: false };
        await tx.put(eventKey, event);
        await tx.put("pending:event:" + accountId + ":" + messageId, event);
      }
    });
  }

  /**
   * Removes the cached rows of one folder role that are not of `keep` (null: all of them), from
   * `after` until `deadline`. Returns where to resume, or undefined when done.
   */
  async sweepRole(account: OutlookAccount, role: OutlookRole, keep: string | null, after: string | undefined, deadline: number): Promise<string | undefined> {
    const prefix = `message:${account.id}:`;
    do {
      const rows = await this.store.list<StoredMessage | string>({ prefix, startAfter: after, limit: 200 });
      for (const [key, row] of rows) {
        after = key;
        if (typeof row === "string" || roleOfLabels(row.message.labels) !== role || (keep !== null && row.generation === keep)) continue;
        await this.cache.remove(account.id, row.message.providerMessageId);
      }
      if (rows.size < 200) return undefined;
    } while (Date.now() < deadline);
    return after;
  }

  /** The import's totals, and "history" once every folder's first round is done. */
  progress(sync: OutlookSyncState) {
    const importing = sync.folders.filter((f) => !f.deltaLink || f.sweep);
    if (!importing.length) {
      sync.mode = "history";
      delete sync.imported;
      delete sync.total;
      return;
    }
    sync.mode = "initial";
    sync.total = sync.folders.reduce((n, f) => n + (f.deltaLink ? f.seen ?? 0 : Math.max(f.total ?? 0, f.seen ?? 0)), 0);
    sync.imported = sync.folders.reduce((n, f) => n + (f.seen ?? 0), 0);
  }
}
