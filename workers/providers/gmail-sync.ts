/**
 * How one Gmail account's cache follows Gmail (docs/architecture.md → "Gmail sync"). Each method
 * here is one bounded unit of work — a page — that AccountService runs under the object's lock,
 * so mail actions and reads interleave between pages instead of waiting for a whole import.
 *
 * - **History** (new mail, label changes, deletions) runs from the moment an account connects:
 *   the import records Gmail's historyId first, and every sync reads history before anything
 *   else. New mail is never queued behind the import.
 * - **Import**, in phases: `recent` — the inbox of the last 30 days, newest first, in full;
 *   `backfill` — every other message (spam and trash included), headers only, its body read from
 *   Gmail when first opened; `sweep` — rows a re-import did not see are deleted (gone from Gmail).
 * - **A message that keeps failing** is retried MAX_MESSAGE_ATTEMPTS times and then set aside
 *   under `skipped:`, so one bad message never stops its account (P1-7).
 */
import { normalizeMessage, ProviderError, type GmailClient, type GmailMessage } from "./gmail-client";
import { keyPart, type GmailCache } from "./gmail-cache";
import type { Store } from "./google-oauth";

export interface SyncState {
  /** "initial" until the import (recent, backfill, sweep) is done; history runs in both. */
  mode: "initial" | "history";
  /** Where history resumes. Set when an import starts, so mail arriving during it is seen. */
  historyId?: string;
  /** A history page in progress (startHistoryId stays historyId until the last page). */
  historyPageToken?: string;
  /** The messages.list page of the current import phase. Before 0.11 it was also the history page. */
  pageToken?: string;
  /** The historyId the import started at (kept for the first layout's state). */
  baseline?: string;
  /** Rows saved by this import carry it; the sweep deletes the rest. */
  generation?: string;
  phase?: "recent" | "backfill" | "sweep";
  /** Where the sweep resumes. */
  sweepAfter?: string;
  /** Messages the backfill has gone through, and the mailbox's size when the import started. */
  imported?: number;
  total?: number;
}

/** Failures of one message before it is set aside. */
export const MAX_MESSAGE_ATTEMPTS = 5;
/** Gmail requests in flight for one page. Gmail allows 250 quota units a second; a get costs 5. */
const CONCURRENCY = 6;
const RECENT_QUERY = "newer_than:30d";

/** The state an account saved before 0.11, in the shape this loop reads. */
export function normalizeSync(sync: SyncState): SyncState {
  const next = { ...sync };
  if (next.mode === "history" && next.pageToken && !next.phase) {
    next.historyPageToken = next.pageToken;
    delete next.pageToken;
  }
  if (next.mode === "initial" && next.baseline && !next.phase) {
    // An import of the first layout, part way through the whole mailbox: history runs from its
    // baseline at once, and the rest of the listing continues headers-only.
    next.historyId ??= next.baseline;
    next.phase = "backfill";
  }
  return next;
}

/** The import's progress in percent, when the mailbox's size is known. */
export function importPercent(sync: SyncState): number | undefined {
  if (sync.mode !== "initial" || !sync.total) return undefined;
  if (sync.phase === "sweep") return 99;
  return Math.min(99, Math.floor(((sync.imported ?? 0) / sync.total) * 100));
}

/**
 * A failure that says something about Gmail or the account (offline, rate limited, signed out),
 * not about one message. Those stop the page and back the account off; they never count against
 * a message. A message's own failure is Gmail failing to serve it, an id or a body that cannot be
 * read, or one that cannot be stored.
 */
function accountWide(error: unknown) {
  return error instanceof ProviderError && !["provider_failed", "invalid_id", "message_too_large"].includes(error.code);
}

async function each<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export interface PageResult {
  /** More of this kind of work is waiting. */
  more: boolean;
  /** Messages set aside on this page. */
  skipped: number;
}

export class GmailSync {
  constructor(private store: Store, private cache: GmailCache) {}

  /**
   * Fetches and handles each id; a message that fails only on its own is counted, and set aside
   * once it has failed MAX_MESSAGE_ATTEMPTS times. Throws, without advancing, while any failure
   * remains: an account-wide one at once, a message's own until it is set aside. The account
   * backs off between attempts (60 s doubling), so a message is set aside only after failing
   * for a quarter of an hour, never after one bad minute.
   */
  private async messages(accountId: string, ids: string[], handle: (id: string) => Promise<void>): Promise<number> {
    const failures: { id: string; error: unknown }[] = [];
    const retrying = new Set((await this.store.list({ prefix: `attempts:${accountId}:` })).keys());
    await each(ids, CONCURRENCY, async (id) => {
      try {
        await handle(id);
        if (retrying.has(`attempts:${accountId}:${id}`)) await this.store.delete(`attempts:${accountId}:${id}`);
      } catch (error) {
        failures.push({ id, error });
      }
    });
    if (!failures.length) return 0;
    const wide = failures.find((f) => accountWide(f.error));
    if (wide) throw wide.error;
    let skipped = 0;
    let blocking: unknown;
    for (const { id, error } of failures) {
      const key = `attempts:${accountId}:${id}`;
      const attempts = ((await this.store.get<{ attempts: number }>(key))?.attempts ?? 0) + 1;
      const code = error instanceof ProviderError ? error.code : "message_unreadable";
      if (attempts >= MAX_MESSAGE_ATTEMPTS) {
        await this.store.transaction(async (tx) => {
          await tx.put(`skipped:${accountId}:${id}`, { attempts, error: code, at: Date.now() });
          await tx.delete(key);
        });
        skipped++;
        console.warn(JSON.stringify({ event: "gmail_message_skipped", attempts, error: code }));
      } else {
        await this.store.put(key, { attempts, error: code });
        blocking ??= error;
      }
    }
    if (blocking) throw blocking;
    return skipped;
  }

  /** One page of history from `sync.historyId`: every changed message read again, new mail queued for automations. */
  async historyPage(accountId: string, sync: SyncState, client: GmailClient): Promise<PageResult> {
    const page = await client.history(sync.historyId!, sync.historyPageToken);
    const ids = new Set<string>(), added = new Set<string>();
    for (const item of page.history || []) {
      for (const message of item.messages || []) ids.add(message.id);
      for (const change of [...(item.messagesAdded || []), ...(item.messagesDeleted || []), ...(item.labelsAdded || []), ...(item.labelsRemoved || [])])
        ids.add(change.message.id);
      for (const change of item.messagesAdded || []) added.add(change.message.id);
    }
    const skipped = await this.messages(accountId, [...ids], async (id) => {
      keyPart(id);
      let message;
      try {
        message = normalizeMessage(accountId, await client.message(id));
      } catch (error) {
        // Gone from Gmail: the cached copy goes too, with its body and its place in the counts.
        if (error instanceof ProviderError && error.code === "not_found") return this.cache.remove(accountId, id);
        throw error;
      }
      await this.cache.save(accountId, message, sync.generation);
      // A stable event key survives history replay and is kept after acknowledgement.
      if (added.has(id) && !message.labels.includes("SENT") && !message.labels.includes("DRAFT")) {
        const eventKey = "event:" + accountId + ":" + id;
        await this.store.transaction(async (tx) => {
          const old = await tx.get<{ delivered: boolean }>(eventKey);
          if (!old || !old.delivered) {
            const event = { accountId, messageId: id, delivered: false };
            await tx.put(eventKey, event);
            await tx.put("pending:" + eventKey, event);
          }
        });
      }
    });
    if (page.nextPageToken) {
      sync.historyPageToken = page.nextPageToken;
      return { more: true, skipped };
    }
    sync.historyId = page.historyId;
    delete sync.historyPageToken;
    return { more: false, skipped };
  }

  /** One unit of the import: its start, a page of a phase, or a stretch of the sweep. */
  async importPage(accountId: string, sync: SyncState, client: GmailClient, deadline: number): Promise<PageResult> {
    if (!sync.phase) {
      const profile = await client.profile();
      if (!profile.historyId) throw new ProviderError("invalid_profile");
      // History first: from this point on, whatever changes in Gmail reaches the cache.
      Object.assign(sync, { mode: "initial", historyId: profile.historyId, baseline: profile.historyId, generation: crypto.randomUUID(),
        phase: "recent", imported: 0, total: profile.messagesTotal ?? 0 } satisfies SyncState);
      delete sync.historyPageToken;
      delete sync.pageToken;
      delete sync.sweepAfter;
      return { more: true, skipped: 0 };
    }
    if (sync.phase === "sweep") {
      const { after, removed } = await this.cache.sweep(accountId, sync.generation, sync.sweepAfter, deadline);
      if (removed) console.log(JSON.stringify({ event: "gmail_sweep", removed }));
      if (after) {
        sync.sweepAfter = after;
        return { more: true, skipped: 0 };
      }
      sync.mode = "history";
      for (const k of ["phase", "pageToken", "sweepAfter", "baseline"] as const) delete sync[k];
      return { more: false, skipped: 0 };
    }
    const recent = sync.phase === "recent";
    const page = await client.list(recent
      ? { pageToken: sync.pageToken, labelIds: ["INBOX"], q: RECENT_QUERY, maxResults: 50 }
      : { pageToken: sync.pageToken, includeSpamTrash: true, maxResults: 100 });
    const skipped = await this.messages(accountId, (page.messages || []).map((m) => m.id), async (id) => {
      keyPart(id);
      // Already read by this import (the recent inbox, or history): not fetched twice.
      if ((await this.cache.row(accountId, id))?.generation === sync.generation && sync.generation) return;
      let raw: GmailMessage;
      try {
        raw = await client.message(id, recent ? "full" : "metadata");
      } catch (error) {
        if (error instanceof ProviderError && error.code === "not_found") return; // deleted since it was listed
        throw error;
      }
      await this.cache.save(accountId, normalizeMessage(accountId, raw), sync.generation, { bodyless: !recent });
    });
    if (!recent) sync.imported = (sync.imported ?? 0) + (page.messages?.length ?? 0);
    if (page.nextPageToken) {
      sync.pageToken = page.nextPageToken;
      return { more: true, skipped };
    }
    delete sync.pageToken;
    if (recent) sync.phase = "backfill";
    else {
      sync.phase = "sweep";
      delete sync.sweepAfter;
    }
    return { more: true, skipped };
  }
}
