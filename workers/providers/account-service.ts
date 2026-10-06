import { validateAttachments } from '../../shared/mail/attachments';
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
  type Message,
  type SendInput,
} from "./gmail-client";
import type { InboxReadOptions, InboxMessage } from "../../shared/mail/inbox";
import { GMAIL_FOLDERS, GmailCache, gmailInboxMessage, inFolder, keyPart, msgKey, type GmailFolder, type InboxCounts, type StoredMessage } from "./gmail-cache";
export { GMAIL_FOLDERS, type GmailFolder } from "./gmail-cache";
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
  sync: {
    mode: "initial" | "history";
    historyId?: string;
    pageToken?: string;
    baseline?: string;
    generation?: string;
  };
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
  constructor(
    private store: Store,
    private env: GmailEnvironment,
    private http: Fetcher = fetch,
  ) {
    this.cache = new GmailCache(store);
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
  async sync(accountId: string) {
    const account = await this.account(accountId);
    if (account.status === "reconnect_required")
      throw new ProviderError("reconnect_required", 401);
    if (account.retryAt && account.retryAt > Date.now())
      throw new ProviderError(
        account.status === "rate_limited" ? "rate_limited" : "sync_backoff",
        429,
      );
    const client = await this.client(account);
    try {
      if (account.sync.mode === "initial") {
        if (!account.sync.baseline) {
          account.sync.baseline = (await client.profile()).historyId;
          account.sync.generation = crypto.randomUUID();
          await this.store.put("account:" + accountId, account);
        }
        const page = await client.list(account.sync.pageToken);
        for (const item of page.messages || []) {
          try {
            await this.saveMessage(
              account,
              normalizeMessage(accountId, await client.message(item.id)),
            );
          } catch (error) {
            if (!(error instanceof ProviderError && error.code === "not_found"))
              throw error;
          }
        }
        if (page.nextPageToken) account.sync.pageToken = page.nextPageToken;
        else
          account.sync = {
            mode: "history",
            historyId: account.sync.baseline,
            generation: account.sync.generation,
          };
      } else {
        const page = await client.history(
          account.sync.historyId!,
          account.sync.pageToken,
        );
        const ids = new Set<string>(),
          added = new Set<string>();
        for (const item of page.history || []) {
          for (const message of item.messages || []) ids.add(message.id);
          for (const change of [
            ...(item.messagesAdded || []),
            ...(item.messagesDeleted || []),
            ...(item.labelsAdded || []),
            ...(item.labelsRemoved || []),
          ])
            ids.add(change.message.id);
          for (const change of item.messagesAdded || [])
            added.add(change.message.id);
        }
        for (const id of ids) {
          try {
            const message = normalizeMessage(
              accountId,
              await client.message(id),
            );
            await this.saveMessage(account, message);
            // Stable event key survives history replay and is retained after acknowledgement.
            if (
              added.has(id) &&
              !message.labels.includes("SENT") &&
              !message.labels.includes("DRAFT")
            ) {
              const eventKey =
                "event:" + keyPart(accountId) + ":" + keyPart(id);
              await this.store.transaction(async (tx) => {
                const old = await tx.get<PendingEvent>(eventKey);
                if (!old || !old.delivered) {
                  const event = { accountId, messageId: id, delivered: false };
                  await tx.put(eventKey, event);
                  await tx.put("pending:" + eventKey, event);
                }
              });
            }
          } catch (error) {
            if (error instanceof ProviderError && error.code === "not_found")
              await this.cache.remove(accountId, keyPart(id));
            else throw error;
          }
        }
        if (page.nextPageToken) account.sync.pageToken = page.nextPageToken;
        else {
          account.sync.historyId = page.historyId;
          delete account.sync.pageToken;
        }
      }
      account.status =
        account.sync.mode === "initial" ? "syncing" : "connected";
      account.lastSyncAt = Date.now();
      delete account.error;
      delete account.retryAt;
    } catch (error) {
      if (error instanceof ProviderError && error.code === "history_expired") {
        account.sync = { mode: "initial" };
        account.status = "syncing";
        account.error = "history_expired";
        await this.store.put("account:" + accountId, account);
        return publicAccount(account);
      }
      account.error =
        error instanceof ProviderError ? error.code : "sync_failed";
      account.status =
        account.error === "reconnect_required"
          ? "reconnect_required"
          : account.error === "rate_limited"
            ? "rate_limited"
            : "error";
      account.retryAt =
        Date.now() + (account.status === "rate_limited" ? 900000 : 60000);
      await this.store.put("account:" + accountId, account);
      throw error;
    }
    await this.store.put("account:" + accountId, account);
    return publicAccount(account);
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
}
