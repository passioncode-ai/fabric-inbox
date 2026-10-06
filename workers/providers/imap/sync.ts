/**
 * How an IMAP account's cache follows its server (docs/architecture.md → "IMAP accounts").
 *
 * A message is its folder, the folder's UIDVALIDITY and its UID (`i-1712345678-42`, mime.ts).
 * Per synced folder (Inbox, Sent, Drafts, Trash, Junk, Archive — found by SPECIAL-USE, else by
 * the usual names), a sync page:
 *
 * - **History** — runs first, every time, from the moment the account connects: a UIDVALIDITY
 *   that changed drops the folder's cached rows and starts it again; UIDs above `top` are new mail
 *   (read whole, queued for rules, agents and categories when they arrived in the Inbox); flag
 *   changes come from CONDSTORE (`CHANGEDSINCE` the last HIGHESTMODSEQ) where the server has it,
 *   else from the newest FLAG_WINDOW UIDs; deletions and moves elsewhere from comparing the
 *   server's UID list with the cache whenever the folder's count differs from what is cached.
 * - **Import** — older mail, newest first by sequence number, headers only (the body is read when
 *   first opened), except the Inbox of the last 30 days, which is read whole.
 *
 * Every step checks the page's deadline and records where it stopped in `ImapSyncState`, so a
 * tick ends on time and the next one resumes. One message that cannot be read is set aside, never
 * holding back its account.
 */
import { ProviderError, type Message } from "../gmail-client";
import type { GmailCache } from "../gmail-cache";
import type { Store } from "../google-oauth";
import type { PageResult } from "../provider";
import type { Fetched, FolderInfo, ImapConnection } from "./client";
import { labelsFor, messageFromRaw, messageKey } from "./mime";
import { FOLDER_ROLES, ROLE_KEY, type FolderRole, type FolderState, type ImapAccount, type ImapSyncState } from "./types";

/** New messages read whole in one page, at most; the rest wait for the next. */
const NEW_PER_PAGE = 50;
/** Messages read per import step. */
const IMPORT_BATCH = 100;
/** Without CONDSTORE, flags are read again for this many of a folder's newest messages each sync. */
export const FLAG_WINDOW = 300;
/** The Inbox of the last RECENT_DAYS is imported whole. */
const RECENT_DAYS = 30;
/** A message larger than this is cached with its headers only, its body read when opened. */
const WHOLE_LIMIT = 2 * 1024 * 1024;
/** The folder list is read again after a day. */
const LIST_EVERY_MS = 86_400_000;
/** A folder whose count matches the cache is still compared in full at least this often (moves that kept the count). */
const RECONCILE_EVERY_MS = 6 * 3_600_000;

const NAMES: Record<Exclude<FolderRole, "inbox">, string[]> = {
  sent: ["sent", "sent messages", "sent items", "sent mail", "отправленные", "gesendet", "gesendete objekte"],
  drafts: ["drafts", "draft", "черновики", "entwürfe"],
  trash: ["trash", "deleted messages", "deleted items", "bin", "корзина", "удаленные", "удалённые", "papierkorb", "gelöscht"],
  junk: ["junk", "spam", "bulk mail", "junk e-mail", "junk email", "спам", "unerwünscht"],
  archive: ["archive", "archives", "архив", "archiv"],
};
const SPECIAL: Record<string, FolderRole> = { "\\inbox": "inbox", "\\sent": "sent", "\\drafts": "drafts", "\\trash": "trash", "\\junk": "junk", "\\archive": "archive" };

/** The folders this server reads, by role, and the targets it moves to without reading (Gmail's All Mail). */
export function mapFolders(list: FolderInfo[]): { roles: Partial<Record<FolderRole, string>>; targets: Partial<Record<FolderRole, string>> } {
  const roles: Partial<Record<FolderRole, string>> = {};
  const targets: Partial<Record<FolderRole, string>> = {};
  const selectable = list.filter((f) => !f.flags.some((x) => /\\noselect|\\nonexistent/i.test(x)));
  for (const f of selectable) {
    const role = SPECIAL[(f.specialUse ?? "").toLowerCase()] ?? f.flags.map((x) => SPECIAL[x.toLowerCase()]).find(Boolean);
    if (role && !roles[role]) roles[role] = f.path;
    if (/\\all/i.test(f.specialUse ?? "") || f.flags.some((x) => /^\\all$/i.test(x))) targets.archive ??= f.path;
  }
  roles.inbox ??= selectable.find((f) => f.path.toUpperCase() === "INBOX")?.path ?? "INBOX";
  for (const role of Object.keys(NAMES) as (keyof typeof NAMES)[]) {
    if (roles[role]) continue;
    const found = selectable.find((f) => NAMES[role].includes((f.delimiter ? f.path.split(f.delimiter).pop()! : f.path).toLowerCase()));
    if (found && !Object.values(roles).includes(found.path)) roles[role] = found.path;
  }
  if (roles.archive) delete targets.archive;
  return { roles, targets };
}

/** The import order: what a person looks at first, first. */
const IMPORT_ORDER: FolderRole[] = ["inbox", "sent", "archive", "drafts", "junk", "trash"];

export class ImapSync {
  constructor(private store: Store, private cache: GmailCache) {}

  /** Reads the folder list into the state: new folders start, folders gone leave with their cached mail. */
  async discover(account: ImapAccount, conn: ImapConnection) {
    const { roles, targets } = mapFolders(await conn.folders());
    const sync = account.sync;
    const next: FolderState[] = [];
    for (const role of FOLDER_ROLES) {
      const path = roles[role];
      if (!path) continue;
      const old = sync.folders.find((f) => f.role === role);
      next.push(old && old.path === path ? old : { role, path, uidValidity: 0, top: 0, known: 0 });
    }
    for (const old of sync.folders) {
      if (!next.includes(old) && old.uidValidity) await this.drop(account.id, old.role, old.uidValidity, Infinity);
    }
    sync.folders = next;
    sync.targets = targets;
    sync.condstore = conn.capabilities.has("CONDSTORE");
    sync.listedAt = Date.now();
  }

  /** Deletes a folder's cached rows of one UIDVALIDITY until the deadline; true when none is left. */
  private async drop(a: string, role: FolderRole, uidValidity: number, deadline: number): Promise<boolean> {
    const prefix = `message:${a}:${ROLE_KEY[role]}-${uidValidity}-`;
    for (;;) {
      const rows = await this.store.list({ prefix, limit: 100 });
      for (const key of rows.keys()) await this.cache.remove(a, key.slice(`message:${a}:`.length));
      if (rows.size < 100) return true;
      if (Date.now() >= deadline) return false;
    }
  }

  /** The cached UIDs of one folder (one UIDVALIDITY). */
  private async cachedUids(a: string, role: FolderRole, uidValidity: number): Promise<number[]> {
    const prefix = `message:${a}:${ROLE_KEY[role]}-${uidValidity}-`;
    const uids: number[] = [];
    let after: string | undefined;
    for (;;) {
      const rows = await this.store.list({ prefix, startAfter: after, limit: 500 });
      for (const key of rows.keys()) { after = key; uids.push(Number(key.slice(prefix.length))); }
      if (rows.size < 500) return uids;
    }
  }

  private async save(account: ImapAccount, folder: FolderState, m: Fetched, whole: boolean): Promise<Message | null> {
    const meta = { accountId: account.id, role: folder.role, uidValidity: folder.uidValidity, uid: m.uid, flags: m.flags, internalDate: m.internalDate, size: m.size };
    const raw = whole ? m.source : m.headers ?? m.source;
    try {
      if (!raw) throw new Error("no content");
      const message = await messageFromRaw(raw, meta, whole && !!m.source);
      await this.cache.save(account.id, message, undefined, { bodyless: !(whole && m.source) });
      return message;
    } catch (error) {
      // A message that cannot be read is set aside: counted, logged without its content, never retried forever.
      const id = messageKey(folder.role, folder.uidValidity, m.uid);
      await this.store.put(`skipped:${account.id}:${id}`, { error: "message_unreadable", at: Date.now() });
      console.warn(JSON.stringify({ event: "imap_message_skipped", role: folder.role, error: (error as Error)?.message?.slice(0, 80) }));
      return null;
    }
  }

  private async queueEvent(accountId: string, messageId: string) {
    const eventKey = "event:" + accountId + ":" + messageId;
    await this.store.transaction(async (tx) => {
      const old = await tx.get<{ delivered: boolean }>(eventKey);
      if (!old || !old.delivered) {
        const event = { accountId, messageId, delivered: false };
        await tx.put(eventKey, event);
        await tx.put("pending:" + eventKey, event);
      }
    });
  }

  /** History for every folder: what changed since the last sync. */
  async historyPage(account: ImapAccount, conn: ImapConnection, deadline: number): Promise<PageResult> {
    const sync = account.sync;
    if (!sync.folders.length || !sync.listedAt || Date.now() - sync.listedAt > LIST_EVERY_MS) await this.discover(account, conn);
    let more = false, skipped = 0;
    for (const folder of sync.folders) {
      if (Date.now() >= deadline) { more = true; break; }
      const result = await this.folderHistory(account, conn, folder, deadline);
      more ||= result.more;
      skipped += result.skipped;
    }
    sync.more = more;
    this.progress(sync);
    return { more, skipped };
  }

  private async folderHistory(account: ImapAccount, conn: ImapConnection, folder: FolderState, deadline: number): Promise<PageResult> {
    let opened;
    try {
      opened = await conn.open(folder.path);
    } catch (error) {
      // A folder deleted at the server since the list was read: read the list again next time.
      if (error instanceof ProviderError && error.code === "folder_missing") { account.sync.listedAt = 0; return { more: false, skipped: 0 }; }
      throw error;
    }
    let skipped = 0;
    if (folder.uidValidity && folder.uidValidity !== opened.uidValidity) {
      // The server renumbered the folder: every cached UID of it is meaningless now.
      console.warn(JSON.stringify({ event: "imap_uidvalidity_changed", role: folder.role }));
      if (!(await this.drop(account.id, folder.role, folder.uidValidity, deadline))) return { more: true, skipped: 0 };
      folder.uidValidity = 0;
    }
    // A server that does not say UIDNEXT (allowed by RFC 3501 only in odd cases): read the last UID instead.
    const uidNext = Number.isFinite(opened.uidNext) && opened.uidNext > 0 ? opened.uidNext
      : opened.exists ? ((await conn.fetch("*", {}, { bySeq: true }))[0]?.uid ?? 0) + 1 : 1;
    if (!folder.uidValidity) {
      // First sight of the folder: mail above uidNext - 1 is new from now on; what is there is imported.
      Object.assign(folder, { uidValidity: opened.uidValidity, top: Math.max(0, uidNext - 1), importFrom: opened.exists, importTotal: opened.exists, known: 0 });
      delete folder.modseq;
      delete folder.reconciledAt;
      if (opened.highestModseq) folder.modseq = opened.highestModseq;
      if (account.sync.mode !== "initial" && opened.exists) account.sync.mode = "initial";
      return { more: false, skipped: 0 };
    }
    let more = false;
    // New mail: everything above top, oldest first, whole.
    if (uidNext - 1 > folder.top) {
      const fresh = (await conn.fetch(`${folder.top + 1}:*`, {})).filter((m) => m.uid > folder.top).sort((x, y) => x.uid - y.uid);
      const now = fresh.slice(0, NEW_PER_PAGE);
      for (let i = 0; i < now.length; i += 10) {
        if (Date.now() >= deadline) { more = true; break; }
        const batch = now.slice(i, i + 10);
        const small = batch.filter((m) => (m.size ?? 0) <= WHOLE_LIMIT).map((m) => m.uid);
        const big = batch.filter((m) => (m.size ?? 0) > WHOLE_LIMIT).map((m) => m.uid);
        const got = [
          ...(small.length ? await conn.fetch(small.join(","), { source: true }) : []),
          ...(big.length ? await conn.fetch(big.join(","), { headers: true }) : []),
        ].sort((x, y) => x.uid - y.uid);
        for (const m of got) {
          const id = messageKey(folder.role, folder.uidValidity, m.uid);
          const had = await this.cache.row(account.id, id);
          if (!had) {
            const saved = await this.save(account, folder, m, (m.size ?? 0) <= WHOLE_LIMIT);
            if (!saved) skipped++;
            else {
              folder.known++;
              // New mail in the Inbox reaches rules, agents and categories, once (the event key is stable).
              if (folder.role === "inbox") await this.queueEvent(account.id, id);
            }
          }
          folder.top = Math.max(folder.top, m.uid);
        }
        // UIDs the server listed but did not return (gone meanwhile) are passed over.
        folder.top = Math.max(folder.top, batch[batch.length - 1]!.uid);
      }
      if (fresh.length > now.length) more = true;
    }
    // Flag changes on mail already here.
    if (Date.now() < deadline) {
      const changed = account.sync.condstore && folder.modseq
        ? await conn.fetch(`1:${Math.max(1, folder.top)}`, {}, { changedSince: folder.modseq })
        : folder.top ? await conn.fetch(`${Math.max(1, folder.top - FLAG_WINDOW)}:${folder.top}`, {}) : [];
      for (const m of changed) {
        if (m.uid > folder.top) continue;
        await this.cache.relabel(account.id, messageKey(folder.role, folder.uidValidity, m.uid), labelsFor(folder.role, m.flags));
      }
      if (opened.highestModseq) folder.modseq = opened.highestModseq;
    }
    // Deletions and moves elsewhere: once imported, a count that differs means the cache is behind.
    const imported = !folder.importFrom;
    const stale = !folder.reconciledAt || Date.now() - folder.reconciledAt > RECONCILE_EVERY_MS;
    if (imported && Date.now() < deadline && (opened.exists !== folder.known || stale)) {
      const server = new Set((await conn.uids()).filter((u) => u <= folder.top));
      const cached = await this.cachedUids(account.id, folder.role, folder.uidValidity);
      let known = 0;
      for (const uid of cached) {
        if (server.has(uid)) { known++; continue; }
        await this.cache.remove(account.id, messageKey(folder.role, folder.uidValidity, uid));
      }
      // On the server and not here (set aside, or missed while sequence numbers moved): read their headers.
      const have = new Set(cached);
      const missing = [...server].filter((u) => !have.has(u));
      const skippedIds = new Set((await this.store.list({ prefix: `skipped:${account.id}:${ROLE_KEY[folder.role]}-${folder.uidValidity}-`, limit: 1000 })).keys());
      const wanted = missing.filter((u) => !skippedIds.has(`skipped:${account.id}:${messageKey(folder.role, folder.uidValidity, u)}`)).slice(0, IMPORT_BATCH);
      if (wanted.length) {
        for (const m of await conn.fetch(wanted.join(","), { headers: true })) {
          if (await this.save(account, folder, m, false)) known++; else skipped++;
        }
        if (missing.length > wanted.length) more = true;
      }
      folder.known = known;
      folder.reconciledAt = Date.now();
    }
    return { more, skipped };
  }

  /** One step of the import: the next batch of the first folder still importing. */
  async importPage(account: ImapAccount, conn: ImapConnection, deadline: number): Promise<PageResult> {
    const sync = account.sync;
    let skipped = 0;
    for (const role of IMPORT_ORDER) {
      const folder = sync.folders.find((f) => f.role === role);
      if (!folder?.importFrom || !folder.uidValidity) continue;
      if (Date.now() >= deadline) return { more: true, skipped };
      const opened = await conn.open(folder.path);
      if (opened.uidValidity !== folder.uidValidity) return { more: true, skipped }; // history handles it first
      const from = Math.min(folder.importFrom, opened.exists);
      if (from < 1) { delete folder.importFrom; continue; }
      const lo = Math.max(1, from - IMPORT_BATCH + 1);
      const rows = (await conn.fetch(`${lo}:${from}`, { headers: true }, { bySeq: true })).filter((m) => m.uid <= folder.top);
      const recentSince = Date.now() - RECENT_DAYS * 86_400_000;
      const whole = new Set(folder.role === "inbox" ? rows.filter((m) => (m.internalDate?.getTime() ?? 0) >= recentSince && (m.size ?? 0) <= WHOLE_LIMIT).map((m) => m.uid) : []);
      const sources = whole.size ? new Map((await conn.fetch([...whole].join(","), { source: true })).map((m) => [m.uid, m])) : new Map<number, Fetched>();
      for (const m of rows) {
        const id = messageKey(folder.role, folder.uidValidity, m.uid);
        if (await this.cache.row(account.id, id)) continue; // already read by history
        const full = sources.get(m.uid);
        if (await this.save(account, folder, full ?? m, !!full)) folder.known++;
        else skipped++;
      }
      sync.imported = (sync.imported ?? 0) + (from - lo + 1);
      folder.importFrom = lo - 1;
      if (!folder.importFrom) delete folder.importFrom;
      this.progress(sync);
      return { more: sync.mode === "initial", skipped };
    }
    this.progress(sync);
    return { more: false, skipped };
  }

  /** The import's totals, and "history" once every folder is imported. */
  private progress(sync: ImapSyncState) {
    const importing = sync.folders.some((f) => f.importFrom || !f.uidValidity);
    sync.total = sync.folders.reduce((n, f) => n + (f.importTotal ?? 0), 0);
    if (!importing) {
      sync.mode = "history";
      delete sync.imported;
      delete sync.total;
    } else sync.mode = "initial";
  }
}
