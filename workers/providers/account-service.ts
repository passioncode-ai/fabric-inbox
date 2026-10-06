import { validateAttachments, type MailAttachment } from '../../shared/mail/attachments';
import {
  configuration,
  createAuthorization,
  consumeState,
  seal,
  unseal,
  pkceChallenge,
  type Envelope,
  type GmailEnvironment,
  type Store,
} from "./google-oauth";
import {
  GmailClient,
  ProviderError,
  exchangeCode,
  makeMime,
  normalizeMessage,
  type Credentials,
  type Fetcher,
  type GmailMessage,
  type Message,
  type SendInput,
} from "./gmail-client";
import type { InboxReadOptions, InboxMessage } from "../../shared/mail/inbox";
import { GMAIL_FOLDERS, GmailCache, gmailInboxMessage, inFolder, keyPart, msgKey, type GmailFolder, type InboxCounts, type StoredMessage } from "./gmail-cache";
export { GMAIL_FOLDERS, type GmailFolder } from "./gmail-cache";
import { GmailSync, normalizeSync, type SyncState } from "./gmail-sync";
export { importPercent, type SyncState } from "./gmail-sync";
/** How a sync runs: until when it may start pages, whether it imports, and under whose lock. */
export interface SyncOptions {
  /** No page is started after this (epoch ms); history's first page and the import's next page always run. */
  deadline?: number;
  /** Read new mail and changes only (Refresh): no import page. */
  historyOnly?: boolean;
  /** Import pages only: history was read a moment ago by the same tick. */
  importOnly?: boolean;
  /** Runs each page under the caller's lock, so other work interleaves between pages. */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}
/** Work is still waiting: an import not finished, or a history page in progress. */
export function syncPending(account: Pick<AccountRecord, "sync">) {
  return account.sync.mode === "initial" || !!account.sync.historyPageToken;
}
const RETRY_MS = 60_000, MAX_RETRY_MS = 900_000;
export interface AccountRecord {
  id: string;
  provider: "gmail";
  email: string;
  runtime: "cloud";
  status:
    | "connected"
    | "syncing"
    | "reconnect_required"
    | "rate_limited"
    | "error";
  createdAt: number;
  lastSyncAt?: number;
  error?: string;
  retryAt?: number;
  credentials: Envelope;
  sync: SyncState;
  /** Failed syncs in a row: the wait before the next one doubles from 60 s to 15 min. */
  failures?: number;
  /** Messages set aside after failing MAX_MESSAGE_ATTEMPTS times (kept under `skipped:`). */
  skipped?: number;
}
export type PublicAccount = Omit<AccountRecord, "credentials">;
export interface SendRequest extends SendInput {
  idempotencyKey: string;
}
export interface SendReceipt {
  status: "sending" | "accepted" | "unknown" | "failed";
  idempotencyKey: string;
  providerMessageId?: string;
  providerDraftId?: string;
  threadId?: string;
  error?: string;
}
interface StoredSend extends SendReceipt {
  digest: string;
}
export interface IncomingEvent {
  account: string;
  emailId: string;
  threadId: string;
  subject: string;
  sender: string;
  body: string;
  date: string;
}
interface PendingEvent {
  accountId: string;
  messageId: string;
  delivered: boolean;
  /** Failed deliveries so far, when the next may run, and the last error (reliability audit M3). */
  attempts?: number;
  nextAt?: number;
  lastError?: string;
}
const MAX_EVENT_ATTEMPTS = 10;
function publicAccount(record: AccountRecord): PublicAccount {
  const { credentials: _, ...account } = record;
  return account;
}
/** A search of one Gmail account's cache: every field is its own filter, and all of them apply. */
export interface MessageFilters {
  cursor?: string; limit?: number;
  /** Text in the subject, sender, recipients or snippet. */
  query?: string; from?: string; to?: string; subject?: string;
  /** Epoch ms, both inclusive. */
  after?: number; before?: number;
  unread?: boolean; starred?: boolean; hasAttachment?: boolean; folder?: GmailFolder;
}
function checkFilters(f: MessageFilters) {
  const bad = (["query", "from", "to", "subject"] as const).some((k) => f[k] !== undefined && typeof f[k] !== "string")
    || (["after", "before"] as const).some((k) => f[k] !== undefined && !Number.isFinite(f[k]))
    || (["unread", "starred", "hasAttachment"] as const).some((k) => f[k] !== undefined && typeof f[k] !== "boolean");
  if (bad) throw new ProviderError("invalid_filter", 400);
  if (f.folder !== undefined && !GMAIL_FOLDERS.includes(f.folder)) throw new ProviderError("invalid_folder", 400);
}
function matches(m: Omit<Message, "text" | "html">, f: MessageFilters) {
  const has = (value: string | undefined, needle: string | undefined) => !needle || (value ?? "").toLowerCase().includes(needle.toLowerCase());
  const timestamp = Number.isFinite(m.timestamp) && m.timestamp > 0 ? m.timestamp : Date.parse(m.date) || 0;
  return has([m.subject, m.from, m.to, m.cc, m.snippet].join(" "), f.query) && has(m.from, f.from) && has([m.to, m.cc].join(" "), f.to)
    && has(m.subject, f.subject) && (f.after === undefined || timestamp >= f.after) && (f.before === undefined || timestamp <= f.before)
    && (f.unread === undefined || f.unread === !m.read) && (f.starred === undefined || f.starred === m.labels.includes("STARRED"))
    && (f.hasAttachment === undefined || f.hasAttachment === (m.attachments?.length ?? 0) > 0) && (!f.folder || inFolder(m.labels, f.folder));
}
/** How long one read may spend moving an account's cache to the current layout before it answers from the old one. */
const MIGRATE_ON_READ_MS = 5_000;
/** Rows of the first layout that it already hid: an earlier import's leftovers once history took over. */
function hiddenByFirstLayout(account: AccountRecord, row: StoredMessage) {
  return account.sync.mode === "history" && row.generation !== account.sync.generation;
}
export class AccountService {
  readonly cache: GmailCache;
  private syncer: GmailSync;
  constructor(
    private store: Store,
    private env: GmailEnvironment,
    private http: Fetcher = fetch,
  ) {
    this.cache = new GmailCache(store);
    this.syncer = new GmailSync(store, this.cache);
  }
  config() {
    const config = configuration(this.env);
    if (config.status !== "configured")
      throw new ProviderError("not_configured", 503);
    return config;
  }
  async listAccounts() {
    return {
      configuration: configuration(this.env).status,
      accounts: [
        ...(
          await this.store.list<AccountRecord>({ prefix: "account:" })
        ).values(),
      ].map(publicAccount),
      providers: [
        { id: "gmail", status: configuration(this.env).status },
        { id: "imap", status: "not_configured" },
        { id: "outlook", status: "not_configured" },
      ],
    };
  }
  async connect() {
    return createAuthorization(this.store, this.config());
  }
  async callback(
    state: string,
    browserToken: string,
    code: string,
    error?: string,
  ) {
    const config = this.config();
    const saved = await consumeState(this.store, state, browserToken);
    if (error || !code || code.length > 4096)
      throw new ProviderError("oauth_denied", 400);
    const credentials = await exchangeCode(
      this.env,
      code,
      saved.verifier,
      config.redirectUri,
      this.http,
    );
    const client = new GmailClient(
      this.env,
      credentials,
      async () => {},
      this.http,
    );
    const profile = await client.profile();
    if (!profile.emailAddress || !profile.historyId)
      throw new ProviderError("invalid_profile");
    const existing = [
      ...(
        await this.store.list<AccountRecord>({ prefix: "account:" })
      ).values(),
    ].find((a) => a.email.toLowerCase() === profile.emailAddress.toLowerCase());
    const identityKey =
      "identity:" + (await pkceChallenge(profile.emailAddress.toLowerCase()));
    const id =
      existing?.id ||
      (await this.store.get<string>(identityKey)) ||
      crypto.randomUUID();
    const account: AccountRecord = {
      id,
      provider: "gmail",
      email: profile.emailAddress,
      runtime: "cloud",
      status: "connected",
      createdAt: existing?.createdAt || Date.now(),
      credentials: await seal(config.encryptionKey, id, credentials),
      sync: existing?.sync || { mode: "initial" },
    };
    await this.store.put("account:" + id, account);
    await this.store.put(identityKey, id);
    return publicAccount(account);
  }
  private async account(id: string) {
    const account = await this.store.get<AccountRecord>(
      "account:" + keyPart(id),
    );
    if (!account) throw new ProviderError("account_not_found", 404);
    return account;
  }
  private async client(account: AccountRecord) {
    const config = this.config();
    let credentials: Credentials;
    try {
      credentials = await unseal<Credentials>(
        config.encryptionKey,
        account.id,
        account.credentials,
      );
    } catch {
      throw new ProviderError("credential_store_unavailable", 503);
    }
    return new GmailClient(
      this.env,
      credentials,
      async (next) => {
        account.credentials = await seal(
          config.encryptionKey,
          account.id,
          next,
        );
        await this.store.put("account:" + account.id, account);
      },
      this.http,
    );
  }
  private async saveMessage(account: AccountRecord, message: Message, options: { bodyless?: boolean } = {}) {
    await this.cache.save(account.id, message, account.sync.generation, options);
  }
  /** Moves the account's cache to the current layout within `budgetMs`; true once it is there. */
  async migrateCache(accountId: string, budgetMs = MIGRATE_ON_READ_MS) {
    const account = await this.account(accountId);
    return this.cache.migrate(account.id, (row) => hiddenByFirstLayout(account, row), Date.now() + budgetMs);
  }
  async getMessage(accountId: string, messageId: string): Promise<Message> {
    const account = await this.account(accountId),
      key = msgKey(accountId, messageId);
    const row = await this.store.get<StoredMessage>(key);
    if (!row || hiddenByFirstLayout(account, row))
      throw new ProviderError("message_not_found", 404);
    // Imported with its headers only (older mail): its body is read from Gmail when first opened.
    if (row.bodyless) {
      const fresh = normalizeMessage(accountId, await (await this.client(account)).message(messageId));
      await this.saveMessage(account, fresh);
      return fresh;
    }
    // Cached before Cc and Reply-To were kept: read it once more from Gmail so a reply reaches
    // the right people. Gmail out of reach is no reason to fail the read; the cached copy stands.
    if (!("cc" in row.message)) {
      try {
        const fresh = normalizeMessage(accountId, await (await this.client(account)).message(messageId));
        await this.saveMessage(account, fresh);
        return fresh;
      } catch (error) {
        console.warn(JSON.stringify({ event: "gmail_message_refresh_failed", error: error instanceof ProviderError ? error.code : "unknown" }));
      }
    }
    return { ...row.message, ...(await this.cache.body(account.id, messageId, row)) };
  }
  async listMessages(accountId: string, options: MessageFilters = {}) {
    checkFilters(options);
    const account = await this.account(accountId);
    const prefix = "message:" + keyPart(accountId) + ":";
    const limit = Math.min(100, Math.max(1, options.limit || 50));
    // Metadata rows use a separate prefix from body chunks at read time. Cursor is a provider id, never an arbitrary storage key.
    if (options.cursor) keyPart(options.cursor);
    let after = options.cursor
      ? prefix + options.cursor + ":\uffff"
      : undefined;
    const messages: Omit<Message, "text" | "html">[] = [];
    let nextCursor: string | undefined;
    // Bound scanned rows as well as returned results, including sparse searches.
    for (let batch = 0; batch < 5 && messages.length < limit; batch++) {
      const rows = await this.store.list<StoredMessage | string>({
        prefix,
        limit: 200,
        startAfter: after,
      });
      if (!rows.size) break;
      for (const [key, row] of rows) {
        after = key;
        if (typeof row === "string") continue;
        nextCursor = row.message.providerMessageId;
        if (hiddenByFirstLayout(account, row)) continue;
        if (!matches(row.message, options)) continue;
        messages.push(row.message);
        if (messages.length >= limit) break;
      }
      if (rows.size < 200 && messages.length < limit) {
        nextCursor = undefined;
        break;
      }
    }
    return { messages, nextCursor, sync: account.sync, status: account.status };
  }
  /**
   * One page of the account's feed, newest first, from the cache's date index: about one page
   * of rows is read however large the cache is. While the cache is still being moved to the
   * current layout, the old full scan answers. No request is made to Gmail here.
   */
  async listInboxMessages(accountId: string, options: InboxReadOptions): Promise<InboxMessage[]> {
    const account = await this.account(accountId);
    if (await this.cache.migrate(account.id, (row) => hiddenByFirstLayout(account, row), Date.now() + MIGRATE_ON_READ_MS))
      return this.cache.inboxPage(account.id, options);
    return this.cache.legacyInboxPage(account.id, options, (row) => !hiddenByFirstLayout(account, row));
  }
  /**
   * The cached messages with these ids, in the feed's shape, leaving out trash,
   * spam, drafts and ids no longer cached (a category's view, CAT-5).
   */
  async inboxMessagesByIds(accountId: string, messageIds: string[], ownDomains: string[] = []): Promise<InboxMessage[]> {
    const account = await this.account(accountId);
    const out: InboxMessage[] = [];
    for (const messageId of messageIds.slice(0, 100)) {
      let key: string;
      try { key = msgKey(accountId, messageId); } catch { continue; }
      const row = await this.store.get<StoredMessage>(key);
      if (!row || hiddenByFirstLayout(account, row)) continue;
      const labels = row.message.labels;
      if (labels.includes("TRASH") || labels.includes("SPAM") || labels.includes("DRAFT")) continue;
      out.push(gmailInboxMessage(accountId, row.message, ownDomains));
    }
    return out;
  }
  /** Unread and total mail in the Gmail inbox: counters kept with every cached change. */
  async countInbox(accountId: string): Promise<InboxCounts> {
    const account = await this.account(accountId);
    if (await this.cache.migrate(account.id, (row) => hiddenByFirstLayout(account, row), Date.now() + MIGRATE_ON_READ_MS))
      return this.cache.counts(account.id);
    return this.cache.legacyCounts(account.id, (row) => !hiddenByFirstLayout(account, row));
  }
  async countUnreadInbox(accountId: string): Promise<number> {
    return (await this.countInbox(accountId)).unread;
  }
  /**
   * Brings an account's cache up to date: history first, to its last page (new mail is never
   * behind the import), then import pages until `deadline`. Each page runs under `lock`.
   * Throws the first failure after recording it on the account (status, error, when to retry).
   */
  async sync(accountId: string, options: SyncOptions = {}): Promise<PublicAccount> {
    const lock = options.lock ?? (<T>(fn: () => Promise<T>) => fn());
    const deadline = options.deadline ?? Date.now();
    let step = { account: publicAccount(await this.account(accountId)), more: false };
    if (!options.importOnly) {
      step = await lock(() => this.syncPage(accountId, "history", deadline));
      while (step.more && Date.now() < deadline) step = await lock(() => this.syncPage(accountId, "history", deadline));
    }
    if (options.historyOnly) return step.account;
    step = await lock(() => this.syncPage(accountId, "import", deadline));
    while (step.more && Date.now() < deadline) step = await lock(() => this.syncPage(accountId, "import", deadline));
    return step.account;
  }
  /** One page of history or of the import, with the account's status kept true either way. */
  private async syncPage(accountId: string, kind: "history" | "import", deadline: number): Promise<{ account: PublicAccount; more: boolean }> {
    const account = await this.account(accountId);
    if (account.status === "reconnect_required")
      throw new ProviderError("reconnect_required", 401);
    if (account.retryAt && account.retryAt > Date.now())
      throw new ProviderError(account.status === "rate_limited" ? "rate_limited" : "sync_backoff", 429);
    account.sync = normalizeSync(account.sync);
    // History starts with the import, which records where it begins; an imported account has no import page.
    if ((kind === "history" && !account.sync.historyId) || (kind === "import" && account.sync.mode === "history"))
      return { account: publicAccount(account), more: false };
    const client = await this.client(account);
    let more: boolean;
    try {
      const page = kind === "history"
        ? await this.syncer.historyPage(account.id, account.sync, client)
        : await this.syncer.importPage(account.id, account.sync, client, deadline);
      more = page.more;
      if (page.skipped) account.skipped = (account.skipped ?? 0) + page.skipped;
      account.status = account.sync.mode === "initial" ? "syncing" : "connected";
      account.lastSyncAt = Date.now();
      delete account.error;
      delete account.retryAt;
      delete account.failures;
    } catch (error) {
      if (error instanceof ProviderError && error.code === "history_expired") {
        // Gmail no longer has history from there: import again under a new generation. The cache
        // stays visible meanwhile, and the sweep removes what the new import does not find.
        account.sync = { mode: "initial" };
        account.status = "syncing";
        account.error = "history_expired";
        await this.store.put("account:" + accountId, account);
        console.warn(JSON.stringify({ event: "gmail_history_expired" }));
        return { account: publicAccount(account), more: true };
      }
      account.error = error instanceof ProviderError ? error.code : "sync_failed";
      account.status = account.error === "reconnect_required" ? "reconnect_required"
        : account.error === "rate_limited" ? "rate_limited" : "error";
      account.failures = (account.failures ?? 0) + 1;
      account.retryAt = Date.now() + (account.status === "rate_limited" ? MAX_RETRY_MS
        : Math.min(RETRY_MS * 2 ** (account.failures - 1), MAX_RETRY_MS));
      await this.store.put("account:" + accountId, account);
      console.warn(JSON.stringify({ event: "gmail_sync_failed", kind, error: account.error, failures: account.failures }));
      throw error;
    }
    await this.store.put("account:" + accountId, account);
    return { account: publicAccount(account), more };
  }
  send(accountId: string, request: SendRequest) {
    return this.submit("send", accountId, request);
  }
  createDraft(accountId: string, request: SendRequest) {
    return this.submit("draft", accountId, request);
  }
  getSendReceipt(accountId: string, idempotencyKey: string) {
    return this.receipt("send", accountId, idempotencyKey);
  }
  getDraftReceipt(accountId: string, idempotencyKey: string) {
    return this.receipt("draft", accountId, idempotencyKey);
  }
  private async receipt(
    kind: "send" | "draft",
    accountId: string,
    idempotencyKey: string,
  ): Promise<SendReceipt> {
    await this.account(accountId);
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey))
      throw new ProviderError("idempotency_key_required", 400);
    const key = kind + ":" + keyPart(accountId) + ":" + idempotencyKey;
    const receipt = await this.store.get<StoredSend>(key);
    if (!receipt) throw new ProviderError("receipt_not_found", 404);
    if (receipt.status === "sending") {
      receipt.status = "unknown";
      receipt.error = "send_outcome_unknown";
      await this.store.put(key, receipt);
    }
    const { digest: _, ...publicReceipt } = receipt;
    return publicReceipt;
  }
  private async submit(
    kind: "send" | "draft",
    accountId: string,
    request: SendRequest,
  ): Promise<SendReceipt> {
    const account = await this.account(accountId);
    const { idempotencyKey, ...input } = request;
    if (
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)
    )
      throw new ProviderError("idempotency_key_required", 400);
    // Validate before reserving; hash a canonical representation, not random MIME boundaries.
    input.attachments = validateAttachments(input.attachments);
    const raw = makeMime(account.email, input);
    const digest = await pkceChallenge(
      JSON.stringify({
        to: input.to,
        cc: input.cc || [],
        bcc: input.bcc || [],
        subject: input.subject,
        text: input.text,
        html: input.html ?? null,
        threadId: input.threadId || "",
        inReplyTo: input.inReplyTo || "",
        references: input.references || "",
        from: account.email,
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
      }),
    );
    const key = kind + ":" + keyPart(accountId) + ":" + idempotencyKey;
    const reservation = await this.store.transaction(async (tx) => {
      const old = await tx.get<StoredSend>(key);
      if (old) {
        if (old.digest !== digest)
          throw new ProviderError("idempotency_conflict", 409);
        return { fresh: false, receipt: old };
      }
      const receipt: StoredSend = { status: "sending", idempotencyKey, digest };
      await tx.put(key, receipt);
      return { fresh: true, receipt };
    });
    const receipt = reservation.receipt;
    if (!reservation.fresh) {
      if (receipt.status === "sending") {
        receipt.status = "unknown";
        receipt.error = "send_outcome_unknown";
        await this.store.put(key, receipt);
      }
      const { digest: _, ...publicReceipt } = receipt;
      return publicReceipt;
    }
    try {
      const client = await this.client(account);
      if (kind === "draft") {
        const result = await client.createDraft(raw, input.threadId);
        if (!result.id || !result.message?.id)
          throw new ProviderError("invalid_send_receipt");
        receipt.providerDraftId = result.id;
        receipt.providerMessageId = result.message.id;
        receipt.threadId = result.message.threadId;
      } else {
        const result = await client.send(raw, input.threadId);
        if (!result.id) throw new ProviderError("invalid_send_receipt");
        receipt.providerMessageId = result.id;
        receipt.threadId = result.threadId;
      }
      receipt.status = "accepted";
    } catch (error) {
      receipt.status = "unknown";
      receipt.error =
        error instanceof ProviderError ? error.code : "send_outcome_unknown";
    }
    // A failed durable receipt write leaves 'sending'; future attempts resolve to unknown, never resend.
    await this.store.put(key, receipt);
    const { digest: _, ...publicReceipt } = receipt;
    return publicReceipt;
  }
  async setRead(accountId: string, messageId: string, read: boolean) {
    if (typeof read !== "boolean")
      throw new ProviderError("invalid_read_state", 400);
    return this.modify(
      accountId,
      messageId,
      read ? [] : ["UNREAD"],
      read ? ["UNREAD"] : [],
    );
  }
  async setStarred(accountId: string, messageId: string, starred: boolean) {
    if (typeof starred !== "boolean")
      throw new ProviderError("invalid_starred_state", 400);
    return this.changeMessage(accountId, messageId, client => client.setStarred(messageId, starred));
  }
  async setTrashed(accountId: string, messageId: string, trashed: boolean) {
    if (typeof trashed !== "boolean")
      throw new ProviderError("invalid_trashed_state", 400);
    return this.changeMessage(accountId, messageId, client => client.setTrashed(messageId, trashed));
  }
  async archive(accountId: string, messageId: string) {
    return this.modify(accountId, messageId, [], ["INBOX"]);
  }
  /** Back to the Inbox from the archive, Trash or Spam: untrash only removes TRASH, so INBOX is added too. */
  async moveToInbox(accountId: string, messageId: string) {
    return this.changeMessage(accountId, messageId, async (client) => {
      if ((await client.message(messageId)).labelIds?.includes("TRASH")) await client.setTrashed(messageId, false);
      await client.modify(messageId, ["INBOX"], ["SPAM"]);
    });
  }
  /** Report spam or Not spam through Gmail's own label, which also trains Gmail (SP-3). */
  async setSpam(accountId: string, messageId: string, spam: boolean) {
    if (typeof spam !== "boolean") throw new ProviderError("invalid_spam_state", 400);
    return this.modify(accountId, messageId, spam ? ["SPAM"] : ["INBOX"], spam ? ["INBOX"] : ["SPAM"]);
  }
  private async modify(
    accountId: string,
    messageId: string,
    add: string[],
    remove: string[],
  ) {
    return this.changeMessage(accountId, messageId, client => client.modify(messageId, add, remove));
  }
  private async changeMessage(
    accountId: string,
    messageId: string,
    change: (client: GmailClient) => Promise<unknown>,
  ) {
    keyPart(messageId);
    const account = await this.account(accountId);
    const client = await this.client(account);
    await change(client);
    // Read full provider state after acknowledgement; never optimistically cache labels.
    // A timeout or a failed read rejects and leaves the previous cache intact.
    const message = normalizeMessage(
      accountId,
      await client.message(messageId),
    );
    await this.saveMessage(account, message);
    return message;
  }
  async getAttachment(
    accountId: string,
    messageId: string,
    attachmentId: string,
  ) {
    const account = await this.account(accountId);
    keyPart(messageId);
    if (!attachmentId || attachmentId.length > 2048)
      throw new ProviderError("invalid_id", 400);
    return (await this.client(account)).attachment(messageId, attachmentId);
  }
  async disconnect(accountId: string) {
    const account = await this.account(accountId);
    let revoked = false;
    try {
      const credentials = await unseal<Credentials>(
        this.config().encryptionKey,
        accountId,
        account.credentials,
      );
      const result = await this.http("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: credentials.refreshToken }),
        signal: AbortSignal.timeout(20000),
      });
      revoked = result.ok;
    } catch {
      /* Local removal is still possible when Google or the encryption key is unavailable. */
    }
    await this.store.delete("account:" + accountId);
    await this.cache.clear(keyPart(accountId));
    for (const prefix of [
      "attempts:" + accountId + ":",
      "skipped:" + accountId + ":",
      "event:" + accountId + ":",
      "pending:event:" + accountId + ":",
    ]) {
      for (;;) {
        const rows = await this.store.list({ prefix, limit: 100 });
        if (!rows.size) break;
        for (const key of rows.keys()) await this.store.delete(key);
      }
    }
    // Preserve send receipts so reconnect/replay can never erase uncertainty.
    return { status: "disconnected", revoked };
  }
  /**
   * Hands pending Gmail events to their consumers, each on its own: one that fails waits its
   * backoff (30 s doubling to 1 h) and, after MAX_EVENT_ATTEMPTS, is set aside under
   * `dead:event:` with its error, so it never holds back the events behind it.
   */
  async drainEvents(deliver: (event: IncomingEvent) => Promise<unknown>, now = Date.now()): Promise<{ delivered: number; failed: number; dead: number }> {
    const result = { delivered: 0, failed: 0, dead: 0 };
    let handled = 0;
    for (const [key, event] of await this.store.list<PendingEvent>({ prefix: "pending:event:", limit: 500 })) {
      if (handled >= 25) break;
      if (event.nextAt && event.nextAt > now) continue;
      handled++;
      try {
        let message: Message;
        try {
          message = await this.getMessage(event.accountId, event.messageId);
        } catch (error) {
          if (error instanceof ProviderError && error.status === 404) {
            await this.store.transaction(async (tx) => {
              await tx.put(key.slice("pending:".length), { ...event, delivered: true });
              await tx.delete(key);
            });
            continue;
          }
          throw error;
        }
        await deliver({
          account: "gmail:" + event.accountId,
          emailId: message.providerMessageId,
          threadId: message.threadId,
          subject: message.subject,
          sender: message.from,
          // HTML-only mail has no text part; categories strip HTML on ingest (as the backfill does).
          body: message.text || message.html || "",
          date: message.date || new Date(message.timestamp || Date.now()).toISOString(),
        });
        await this.store.transaction(async (tx) => {
          await tx.put(key.slice("pending:".length), { ...event, delivered: true });
          await tx.delete(key);
        });
        result.delivered++;
      } catch (error) {
        const attempts = (event.attempts ?? 0) + 1;
        const lastError = error instanceof ProviderError ? error.message : (error as Error)?.message?.slice(0, 200) ?? "unknown";
        if (attempts >= MAX_EVENT_ATTEMPTS) {
          await this.store.transaction(async (tx) => {
            await tx.put("dead:" + key.slice("pending:".length), { ...event, attempts, lastError });
            await tx.delete(key);
          });
          result.dead++;
        } else {
          await this.store.put(key, { ...event, attempts, lastError, nextAt: now + Math.min(30_000 * 2 ** (attempts - 1), 3_600_000) });
          result.failed++;
        }
        console.warn(JSON.stringify({ event: attempts >= MAX_EVENT_ATTEMPTS ? "gmail_event_dead" : "gmail_event_retry", attempts, error: lastError }));
      }
    }
    return result;
  }
  // ── Composing and reading in full: self-contained additions (0.11) ──
  /** Every header of one message, read from Gmail (the cache keeps only those the feed needs). */
  async getHeaders(accountId: string, messageId: string) {
    keyPart(messageId);
    const account = await this.account(accountId);
    try {
      const raw = await (await this.client(account)).messageHeaders(messageId);
      return { headers: (raw.payload?.headers ?? []).map((h) => ({ key: h.name, value: h.value })) };
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("message_not_found", 404);
      throw error;
    }
  }
  /**
   * Gmail's own drafts (B-50, B-52), read and changed in Gmail so they show there too. A draft's
   * revision is its message id: Gmail gives the message a new id on every change, so a save or a
   * send that names the id it read is refused when the draft moved on (`draft_conflict`).
   */
  async listDrafts(accountId: string, pageToken?: string) {
    const account = await this.account(accountId);
    if (pageToken !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(pageToken)) throw new ProviderError("invalid_filter", 400);
    const client = await this.client(account);
    const page = await client.listDrafts(pageToken);
    const drafts: ReturnType<typeof gmailDraft>[] = [];
    for (const d of page.drafts ?? []) {
      try { drafts.push(gmailDraft(accountId, await client.getDraft(d.id), false)); }
      catch (error) { if (!(error instanceof ProviderError && error.code === "not_found")) throw error; /* sent or deleted meanwhile */ }
    }
    return { drafts, nextCursor: page.nextPageToken ?? null };
  }
  async getDraft(accountId: string, draftId: string) {
    keyPart(draftId);
    const account = await this.account(accountId);
    return gmailDraft(accountId, await draftOrMissing((await this.client(account)).getDraft(draftId)), true);
  }
  async updateDraft(accountId: string, draftId: string, request: SendInput & { expectedRevision?: string; keepAttachments?: string[] }) {
    keyPart(draftId);
    const account = await this.account(accountId);
    const client = await this.client(account);
    const { expectedRevision, keepAttachments, ...input } = request;
    const current = await draftOrMissing(client.getDraft(draftId));
    if (expectedRevision !== undefined && current.message.id !== expectedRevision) throw new ProviderError("draft_conflict", 409);
    // The draft's message is replaced whole: the files it keeps are read and written again.
    const keep = keepAttachments === undefined ? null : new Set(keepAttachments);
    const kept: MailAttachment[] = [];
    for (const f of normalizeMessage(accountId, current.message).attachments) {
      if (keep && !keep.has(f.providerAttachmentId)) continue;
      const data = (await client.attachment(current.message.id, f.providerAttachmentId)).data.replace(/-/g, "+").replace(/_/g, "/");
      kept.push({ content: data + "=".repeat((4 - (data.length % 4)) % 4), filename: f.filename || "attachment", type: f.mimeType || "application/octet-stream", disposition: "attachment" as const });
    }
    const files = validateAttachments([...kept, ...validateAttachments(input.attachments)]);
    const raw = makeMime(account.email, { ...input, attachments: files });
    const result = await client.updateDraft(draftId, raw, input.threadId);
    return { draftId, revision: result.message.id, messageId: result.message.id, threadId: result.message.threadId };
  }
  async deleteDraft(accountId: string, draftId: string) {
    keyPart(draftId);
    const account = await this.account(accountId);
    await draftOrMissing((await this.client(account)).deleteDraft(draftId));
    return { deleted: draftId };
  }
  /** Sends a draft as Gmail holds it, once per idempotency key (its receipt is a send receipt). */
  async sendDraft(accountId: string, draftId: string, idempotencyKey: string, expectedRevision?: string): Promise<SendReceipt> {
    keyPart(draftId);
    const account = await this.account(accountId);
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) throw new ProviderError("idempotency_key_required", 400);
    const key = "send:" + keyPart(accountId) + ":" + idempotencyKey;
    const digest = await pkceChallenge(JSON.stringify({ draft: draftId }));
    const answer = async (receipt: StoredSend) => {
      if (receipt.status === "sending") { receipt.status = "unknown"; receipt.error = "send_outcome_unknown"; await this.store.put(key, receipt); }
      const { digest: _, ...publicReceipt } = receipt;
      return publicReceipt;
    };
    // A retry after the draft went out (and Gmail removed it) answers the first attempt.
    const old = await this.store.get<StoredSend>(key);
    if (old) { if (old.digest !== digest) throw new ProviderError("idempotency_conflict", 409); return answer(old); }
    const client = await this.client(account);
    const current = await draftOrMissing(client.getDraft(draftId, "minimal"));
    if (expectedRevision !== undefined && current.message.id !== expectedRevision) throw new ProviderError("draft_conflict", 409);
    const reservation = await this.store.transaction(async (tx) => {
      const existing = await tx.get<StoredSend>(key);
      if (existing) { if (existing.digest !== digest) throw new ProviderError("idempotency_conflict", 409); return { fresh: false, receipt: existing }; }
      const receipt: StoredSend = { status: "sending", idempotencyKey, digest };
      await tx.put(key, receipt);
      return { fresh: true, receipt };
    });
    if (!reservation.fresh) return answer(reservation.receipt);
    const receipt = reservation.receipt;
    try {
      const sent = await client.sendDraft(draftId);
      if (!sent.id) throw new ProviderError("invalid_send_receipt");
      receipt.status = "accepted"; receipt.providerMessageId = sent.id; receipt.threadId = sent.threadId;
    } catch (error) {
      receipt.status = "unknown";
      receipt.error = error instanceof ProviderError ? error.code : "send_outcome_unknown";
    }
    await this.store.put(key, receipt);
    const { digest: _, ...publicReceipt } = receipt;
    return publicReceipt;
  }
}

/** A draft Gmail no longer has is `draft_not_found`, not a provider failure. */
async function draftOrMissing<T>(work: Promise<T>): Promise<T> {
  try { return await work; }
  catch (error) { if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("draft_not_found", 404); throw error; }
}

/** One Gmail draft as the drafts list (and, with its body, the composer) shows it. */
function gmailDraft(accountId: string, draft: { id: string; message: GmailMessage }, withBody: boolean) {
  const m = normalizeMessage(accountId, draft.message);
  return {
    draftId: draft.id, revision: m.providerMessageId, messageId: m.providerMessageId, threadId: m.threadId,
    to: m.to, cc: m.cc || null, bcc: m.bcc || null, subject: m.subject, date: m.timestamp ? new Date(m.timestamp).toISOString() : m.date,
    inReplyTo: m.inReplyTo || null, references: m.references || null, snippet: m.snippet,
    attachments: m.attachments.map((a) => ({ id: a.providerAttachmentId, filename: a.filename, mimetype: a.mimeType, size: a.size })),
    ...(withBody ? { text: m.text, html: m.html } : {}),
  };
}
