/**
 * The accounts the server keeps for its providers (docs/architecture.md → "Mail providers"): the
 * records, their sealed credentials, the message cache every provider shares, sends with their
 * idempotent receipts, the incoming-event queue, status and backoff. The provider's own work runs
 * through a `ProviderSession` (provider.ts): Gmail in gmail-provider.ts, IMAP/SMTP in imap/.
 *
 * Records live under `account:<id>`; the world names an account `<provider>:<id>` (shared/mail/
 * accounts.ts). Gmail records written before 0.11 are read as they are: same key, same id, same cache.
 */
import { validateAttachments } from '../../shared/mail/attachments';
import type { RemoteProvider } from "../../shared/mail/accounts";
import {
  configuration,
  createAuthorization,
  consumeState,
  pkceChallenge,
  type GmailEnvironment,
  type Store,
} from "./google-oauth";
import { GmailClient, ProviderError, exchangeCode, makeMime, type Fetcher, type Message, type SendInput } from "./gmail-client";
import type { InboxReadOptions, InboxMessage } from "../../shared/mail/inbox";
import { isGmailReason, type GmailReason } from "../../shared/mail/gmail-reasons";
import { GMAIL_FOLDERS, GmailCache, gmailInboxMessage, inFolder, keyPart, msgKey, type GmailFolder, type InboxCounts, type StoredMessage } from "./gmail-cache";
export { GMAIL_FOLDERS, type GmailFolder } from "./gmail-cache";
import { credentialKeys, hasCredentialKey, openCredentials, sealCredentials, type CredentialEnvironment, type CredentialKeys } from "./credentials";
import { GmailProvider, type GmailAccount } from "./gmail-provider";
import { normalizeSync } from "./gmail-sync";
import { NotSentError, type DraftUpdate, type MailProvider, type MessageChange, type ProviderCapabilities, type ProviderSession } from "./provider";
import type { ImapAccount, ImapCredentials } from "./imap/types";
import { ImapProvider, type ImapDeps } from "./imap/provider";
import { serverSettings, type ImapConnectInput } from "./imap/connect";
import { CUSTOM, PRESETS } from "./imap/presets";
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
  const sync = account.sync as { mode: string; historyPageToken?: string; more?: boolean };
  return sync.mode === "initial" || !!sync.historyPageToken || !!sync.more;
}
const RETRY_MS = 60_000, MAX_RETRY_MS = 900_000;

export type AccountRecord = GmailAccount | ImapAccount;
export type PublicAccount = Omit<AccountRecord, "credentials">;
const DAY = 86_400_000;
/**
 * Google's answer to a refresh, "invalid_grant", says only that the grant is gone. A grant that ends
 * about 7 days after it was given is a Testing app's (Google's stated expiry); one that ends on the
 * date Google gave is too. Anything else was removed: in the Google account, by a password change,
 * or after six months unused.
 */
export function grantEndReason(account: Pick<AccountRecord, "connectedAt" | "accessUntil">, now = Date.now()): GmailReason {
  if (account.accessUntil && now >= account.accessUntil - 3_600_000) return "testing_expiry";
  const age = account.connectedAt ? now - account.connectedAt : -1;
  return age >= 7 * DAY - 2 * 3_600_000 && age <= 9 * DAY ? "testing_expiry" : "access_revoked";
}
/**
 * What a failure says about the account itself, or null when it concerns one request only (a
 * message gone, the provider busy). The same answer is kept on the account by a sync and by a write.
 */
export function accountProblem(error: unknown, account: Pick<AccountRecord, "connectedAt" | "accessUntil">, now = Date.now()):
  { status: AccountRecord["status"]; error: string; reason?: GmailReason } | null {
  if (!(error instanceof ProviderError)) return null;
  switch (error.code) {
    case "reconnect_required":
      return { status: "reconnect_required", error: "reconnect_required",
        reason: error.reason === "invalid_grant" ? grantEndReason(account, now) : isGmailReason(error.reason) ? error.reason : undefined };
    case "insufficient_scope":
      return { status: "reconnect_required", error: "reconnect_required", reason: "insufficient_scope" };
    case "gmail_api_disabled":
      return { status: "error", error: "gmail_api_disabled", reason: "gmail_api_disabled" };
    case "google_client_rejected":
      return { status: "error", error: "google_client_rejected", reason: "client_rejected" };
    default:
      return null;
  }
}
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
/** A search of one account's cache: every field is its own filter, and all of them apply. */
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
  return account.provider === "gmail" && account.sync.mode === "history" && row.generation !== account.sync.generation;
}
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/** How providers reach their servers; the tests give in-process fakes. */
export interface ProviderDeps {
  imap?: ImapDeps;
}
export type AccountsEnvironment = GmailEnvironment & CredentialEnvironment & { MAIL_POLL_SECONDS?: string };

/** The poll interval of every provider: MAIL_POLL_SECONDS, else GMAIL_POLL_SECONDS, else 300 s (60 s … 1 h). */
export function pollInterval(env: AccountsEnvironment) {
  const seconds = Number(env.MAIL_POLL_SECONDS || env.GMAIL_POLL_SECONDS || 300);
  return Math.max(60, Math.min(3600, Number.isFinite(seconds) ? seconds : 300)) * 1000;
}

export class AccountService {
  readonly cache: GmailCache;
  private gmail: GmailProvider;
  private imap: ImapProvider;
  private keys?: Promise<CredentialKeys | null>;
  private renewed = new Map<string, AccountRecord["credentials"]>();
  constructor(
    private store: Store,
    private env: AccountsEnvironment,
    private http: Fetcher = fetch,
    deps: ProviderDeps = {},
  ) {
    this.cache = new GmailCache(store);
    this.gmail = new GmailProvider(store, this.cache, env, http);
    this.imap = new ImapProvider(store, this.cache, env, deps.imap);
  }
  /** The provider of an account (or of a provider id). */
  provider(of: RemoteProvider | Pick<AccountRecord, "provider">): MailProvider<AccountRecord> {
    const id = typeof of === "string" ? of : of.provider;
    const provider = id === "gmail" ? this.gmail : id === "imap" ? this.imap : undefined;
    if (!provider) throw new ProviderError("not_configured", 503);
    return provider as unknown as MailProvider<AccountRecord>;
  }
  /** Whether an account's provider is set up on this server, so its sync can run. */
  ready(account: Pick<AccountRecord, "provider">) {
    try { return this.provider(account).configured(); } catch { return false; }
  }
  capabilities(account: AccountRecord): ProviderCapabilities {
    return this.provider(account).capabilities(account);
  }
  config() {
    const config = configuration(this.env);
    if (config.status !== "configured")
      throw new ProviderError("not_configured", 503);
    return config;
  }
  protected credentialKeys() {
    this.keys ??= credentialKeys(this.env);
    return this.keys;
  }
  protected async seal(accountId: string, value: unknown) {
    const keys = await this.credentialKeys();
    if (!keys) throw new ProviderError("not_configured", 503);
    return sealCredentials(keys, accountId, value);
  }
  async listAccounts() {
    const accounts = [...(await this.store.list<AccountRecord>({ prefix: "account:" })).values()];
    return {
      configuration: configuration(this.env).status,
      accounts: accounts.map((a) => {
        let capabilities: ProviderCapabilities | undefined;
        try { capabilities = this.capabilities(a); } catch { /* a provider this build does not carry */ }
        return { ...publicAccount(a), providerName: this.providerName(a), ...(capabilities ? { capabilities } : {}) };
      }),
      providers: [
        { id: "gmail", status: configuration(this.env).status },
        { id: "imap", status: hasCredentialKey(this.env) ? "configured" : "not_configured" },
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
    ].find((a) => a.provider === "gmail" && a.email.toLowerCase() === profile.emailAddress.toLowerCase()) as GmailAccount | undefined;
    const identityKey =
      "identity:" + (await pkceChallenge(profile.emailAddress.toLowerCase()));
    const id =
      existing?.id ||
      (await this.store.get<string>(identityKey)) ||
      crypto.randomUUID();
    const account: GmailAccount = {
      id,
      provider: "gmail",
      email: profile.emailAddress,
      runtime: "cloud",
      status: "connected",
      createdAt: existing?.createdAt || Date.now(),
      connectedAt: Date.now(),
      ...(credentials.refreshExpiresAt ? { accessUntil: credentials.refreshExpiresAt } : {}),
      credentials: await this.seal(id, credentials),
      sync: existing?.sync || { mode: "initial" },
    };
    await this.store.put("account:" + id, account);
    await this.store.put(identityKey, id);
    return publicAccount(account);
  }
  /**
   * The providers this server can connect, with the IMAP presets and their help pages (no secret,
   * nothing about any account): what Settings → Accounts and the agent tool list_mail_providers show.
   */
  mailProviders() {
    return {
      providers: [
        { id: "gmail", name: "Gmail", auth: "oauth", status: configuration(this.env).status },
        { id: "imap", name: "Other mail (IMAP)", auth: "app-password", status: hasCredentialKey(this.env) ? "configured" : "not_configured" },
        { id: "outlook", name: "Outlook", auth: "oauth", status: "not_configured" },
      ],
      presets: [...PRESETS, { ...CUSTOM }].map((p) => ({
        id: p.id, name: p.name, domains: p.domains, steps: p.steps, source: p.source || null, appPasswordUrl: p.appPasswordUrl || null, sentCopy: p.sentCopy,
        ...("imap" in p ? { imap: p.imap, smtp: p.smtp } : {}),
      })),
    };
  }
  /**
   * Connects an IMAP account (or connects one again with new settings): its IMAP login, folders and
   * SMTP login are checked first, and only then is the password sealed and the account stored. An
   * address already connected through Google sign-in is refused, so no mail is read twice.
   */
  async connectImap(input: ImapConnectInput) {
    if (!hasCredentialKey(this.env)) throw new ProviderError("not_configured", 503);
    const settings = serverSettings(input);
    const accounts = [...(await this.store.list<AccountRecord>({ prefix: "account:" })).values()];
    if (accounts.some((a) => a.provider === "gmail" && a.email.toLowerCase() === input.email)) throw new ProviderError("already_connected", 409);
    const checked = await this.imap.verify(settings, input.password, input.email);
    const existing = accounts.find((a) => a.provider === "imap" && a.email.toLowerCase() === input.email) as ImapAccount | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const sameServer = existing && existing.server.imap.host === checked.settings.imap.host && existing.server.imapUser === checked.settings.imapUser;
    const account: ImapAccount = {
      id, provider: "imap", preset: input.preset, email: input.email, runtime: "cloud", status: "syncing",
      createdAt: existing?.createdAt ?? Date.now(),
      credentials: await this.seal(id, { password: input.password } satisfies ImapCredentials),
      server: checked.settings,
      // The same mailbox again keeps its cache and where its sync stands; another one starts over.
      sync: sameServer ? existing!.sync : {
        mode: "initial", condstore: checked.condstore, listedAt: 0, targets: checked.folders.targets,
        folders: (Object.entries(checked.folders.roles) as [ImapAccount["sync"]["folders"][number]["role"], string][])
          .map(([role, path]) => ({ role, path, uidValidity: 0, top: 0, known: 0 })),
      },
    };
    if (existing && !sameServer) await this.cache.clear(id);
    await this.putAccount(account);
    console.log(JSON.stringify({ event: "imap_connected", preset: input.preset, again: !!existing }));
    return publicAccount(account);
  }
  /** A new app password for an IMAP account, checked against both servers before it replaces the old one. */
  async updateImapPassword(accountId: string, password: string) {
    const account = await this.account(accountId);
    if (account.provider !== "imap") throw new ProviderError("not_supported", 400);
    if (typeof password !== "string" || !password || password.length > 512) throw new ProviderError("invalid_password", 400);
    const checked = await this.imap.verify(account.server, password, account.email);
    account.server = checked.settings;
    account.credentials = await this.seal(account.id, { password } satisfies ImapCredentials);
    this.renewed.delete(account.id);
    account.status = account.sync.mode === "initial" ? "syncing" : "connected";
    delete account.error;
    delete account.retryAt;
    delete account.failures;
    await this.store.put("account:" + account.id, account);
    console.log(JSON.stringify({ event: "imap_password_changed", preset: account.preset }));
    return publicAccount(account);
  }
  protected async account(id: string) {
    const account = await this.store.get<AccountRecord>(
      "account:" + keyPart(id),
    );
    if (!account) throw new ProviderError("account_not_found", 404);
    return account;
  }
  /**
   * Opens an account's provider session with its credentials. An envelope sealed before 0.11, or
   * with a key since rotated, is sealed again with the current key on the way (credentials.ts).
   */
  protected async session(account: AccountRecord): Promise<ProviderSession> {
    const provider = this.provider(account);
    if (!provider.configured()) throw new ProviderError("not_configured", 503);
    const keys = await this.credentialKeys();
    if (!keys) throw new ProviderError("not_configured", 503);
    let opened: { value: unknown; stale: boolean };
    try {
      opened = await openCredentials(keys, account.id, account.credentials);
    } catch {
      // The keys the server holds cannot open what was sealed for this account: only a reconnect
      // (or, for IMAP, the password entered again) gives it access again.
      throw new ProviderError("reconnect_required", 401, "credentials_unreadable");
    }
    // Renewed credentials (an OAuth refresh) go into the stored record and into every copy of it a
    // caller writes later in this object's life (putAccount), so no page writes an older envelope back.
    const persist = async (next: unknown) => {
      const sealed = await this.seal(account.id, next);
      account.credentials = sealed;
      this.renewed.set(account.id, sealed);
      const latest = await this.store.get<AccountRecord>("account:" + account.id);
      if (latest) await this.store.put("account:" + account.id, { ...latest, credentials: sealed });
    };
    if (opened.stale) {
      try { await persist(opened.value); }
      catch (error) { console.warn(JSON.stringify({ event: "credential_reseal_failed", error: (error as Error)?.message?.slice(0, 100) })); }
    }
    return provider.open(account, opened.value, persist);
  }
  /**
   * Runs work in the account's provider session. A failure that is about the account rather than
   * this one request (the grant gone, the Gmail API off, the client refused, a password refused) is
   * kept on the account, so the inbox and Settings say why, the same as when a sync meets it.
   */
  protected async withSession<T>(account: AccountRecord, work: (session: ProviderSession) => Promise<T>): Promise<T> {
    return this.noting(account.id, async () => {
      const session = await this.session(account);
      try { return await work(session); }
      finally { await session.close().catch(() => undefined); }
    });
  }
  private async noting<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      await this.noteProblem(accountId, error);
      throw error;
    }
  }
  private async noteProblem(accountId: string, error: unknown) {
    const current = await this.store.get<AccountRecord>("account:" + accountId);
    if (!current) return;
    const problem = accountProblem(error, current);
    if (!problem || (current.status === problem.status && current.error === problem.error && current.reason === problem.reason)) return;
    current.status = problem.status;
    current.error = problem.error;
    if (problem.reason) current.reason = problem.reason; else delete current.reason;
    await this.store.put("account:" + accountId, current);
    console.warn(JSON.stringify({ event: current.provider === "gmail" ? "gmail_account_problem" : "mail_account_problem", provider: current.provider, error: problem.error, reason: problem.reason ?? null }));
  }
  /** Writes an account record, with credentials renewed meanwhile by a session kept over its newer ones. */
  protected async putAccount(account: AccountRecord) {
    const renewed = this.renewed.get(account.id);
    if (renewed) account.credentials = renewed;
    await this.store.put("account:" + account.id, account);
  }
  /** How a person knows the account's provider: "Gmail", or the IMAP preset's name. */
  providerName(account: Pick<AccountRecord, "provider"> & { preset?: string }): string {
    return account.provider === "gmail" ? "Gmail" : this.imap.presetName(account.preset);
  }
  private async saveMessage(account: AccountRecord, message: Message, options: { bodyless?: boolean } = {}) {
    await this.cache.save(account.id, message, (account.sync as { generation?: string }).generation, options);
  }
  /** Moves the account's cache to the current layout within `budgetMs`; true once it is there. */
  async migrateCache(accountId: string, budgetMs = MIGRATE_ON_READ_MS) {
    const account = await this.account(accountId);
    return this.cache.migrate(account.id, (row) => hiddenByFirstLayout(account, row), Date.now() + budgetMs);
  }
  /** The id a message has now: an IMAP move gives it a new one, kept as an alias for a while. */
  protected async currentId(accountId: string, messageId: string) {
    const alias = await this.store.get<{ to: string; at: number }>("moved:" + accountId + ":" + messageId);
    return alias && alias.at > Date.now() - 7 * 86_400_000 ? alias.to : messageId;
  }
  async getMessage(accountId: string, messageId: string): Promise<Message> {
    const account = await this.account(accountId);
    keyPart(messageId);
    messageId = await this.currentId(account.id, messageId);
    const key = msgKey(accountId, messageId);
    const row = await this.store.get<StoredMessage>(key);
    if (!row || hiddenByFirstLayout(account, row))
      throw new ProviderError("message_not_found", 404);
    // Imported with its headers only (older mail): its body is read from the provider when first opened.
    if (row.bodyless) {
      const fresh = await this.withSession(account, (s) => s.message(messageId));
      await this.saveMessage(account, fresh);
      return fresh;
    }
    // Cached before Cc and Reply-To were kept: read it once more from Gmail so a reply reaches
    // the right people. Gmail out of reach is no reason to fail the read; the cached copy stands.
    if (!("cc" in row.message)) {
      try {
        const fresh = await this.withSession(account, (s) => s.message(messageId));
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
      ? prefix + options.cursor + ":￿"
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
   * current layout, the old full scan answers. No request is made to the provider here.
   */
  async listInboxMessages(accountId: string, options: InboxReadOptions): Promise<InboxMessage[]> {
    const account = await this.account(accountId);
    const feed = { provider: account.provider, providerName: this.providerName(account) };
    if (await this.cache.migrate(account.id, (row) => hiddenByFirstLayout(account, row), Date.now() + MIGRATE_ON_READ_MS))
      return this.cache.inboxPage(account.id, options, feed);
    return this.cache.legacyInboxPage(account.id, options, (row) => !hiddenByFirstLayout(account, row), feed);
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
      out.push(gmailInboxMessage(accountId, row.message, ownDomains, { provider: account.provider, providerName: this.providerName(account) }));
    }
    return out;
  }
  /** Unread and total mail in the account's inbox: counters kept with every cached change. */
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
   * behind the import), then import pages until `deadline`. Each page runs under `lock`; the
   * provider session (an IMAP connection) is opened once for the whole sync and always closed.
   * Throws the first failure after recording it on the account (status, error, when to retry).
   */
  async sync(accountId: string, options: SyncOptions = {}): Promise<PublicAccount> {
    const lock = options.lock ?? (<T>(fn: () => Promise<T>) => fn());
    const deadline = options.deadline ?? Date.now();
    let step = { account: publicAccount(await this.account(accountId)), more: false };
    const sessions: { current?: ProviderSession } = {};
    try {
      if (!options.importOnly) {
        step = await lock(() => this.syncPage(accountId, "history", deadline, sessions));
        while (step.more && Date.now() < deadline) step = await lock(() => this.syncPage(accountId, "history", deadline, sessions));
      }
      if (options.historyOnly) return step.account;
      step = await lock(() => this.syncPage(accountId, "import", deadline, sessions));
      while (step.more && Date.now() < deadline) step = await lock(() => this.syncPage(accountId, "import", deadline, sessions));
      return step.account;
    } finally {
      await sessions.current?.close().catch(() => undefined);
    }
  }
  /** One page of history or of the import, with the account's status kept true either way. */
  private async syncPage(accountId: string, kind: "history" | "import", deadline: number, sessions: { current?: ProviderSession }): Promise<{ account: PublicAccount; more: boolean }> {
    const account = await this.account(accountId);
    if (account.status === "reconnect_required")
      throw new ProviderError("reconnect_required", 401);
    if (account.retryAt && account.retryAt > Date.now())
      throw new ProviderError(account.status === "rate_limited" ? "rate_limited" : "sync_backoff", 429);
    const provider = this.provider(account);
    if (account.provider === "gmail") {
      account.sync = normalizeSync(account.sync);
      // History starts with the import, which records where it begins; an imported account has no import page.
      if (kind === "history" && !account.sync.historyId) return { account: publicAccount(account), more: false };
    }
    if (kind === "import" && account.sync.mode === "history") return { account: publicAccount(account), more: false };
    let more: boolean;
    try {
      const session = sessions.current ??= await this.session(account);
      const page = await session.syncPage(account, kind, deadline);
      more = page.more;
      if (page.skipped) account.skipped = (account.skipped ?? 0) + page.skipped;
      account.status = account.sync.mode === "initial" ? "syncing" : "connected";
      account.lastSyncAt = Date.now();
      delete account.error;
      delete account.reason;
      delete account.retryAt;
      delete account.failures;
    } catch (error) {
      if (error instanceof ProviderError && error.code === "history_expired") {
        // The provider no longer has history from there: import again under a new generation. The
        // cache stays visible meanwhile, and the sweep removes what the new import does not find.
        provider.restartSync(account);
        account.status = "syncing";
        account.error = "history_expired";
        await this.putAccount(account);
        console.warn(JSON.stringify({ event: "gmail_history_expired", provider: account.provider }));
        return { account: publicAccount(account), more: true };
      }
      // A session that failed is not reused: the next page opens a fresh one.
      if (sessions.current) { await sessions.current.close().catch(() => undefined); delete sessions.current; }
      const problem = accountProblem(error, account);
      account.error = problem?.error ?? (error instanceof ProviderError ? error.code : "sync_failed");
      account.status = problem?.status ?? (account.error === "rate_limited" ? "rate_limited" : "error");
      if (problem?.reason) account.reason = problem.reason; else delete account.reason;
      account.failures = (account.failures ?? 0) + 1;
      account.retryAt = Date.now() + (account.status === "rate_limited" ? MAX_RETRY_MS
        : Math.min(RETRY_MS * 2 ** (account.failures - 1), MAX_RETRY_MS));
      await this.putAccount(account);
      console.warn(JSON.stringify({ event: account.provider === "gmail" ? "gmail_sync_failed" : "mail_sync_failed", provider: account.provider, kind, error: account.error, reason: account.reason ?? null, failures: account.failures }));
      throw error;
    }
    await this.putAccount(account);
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
    if (!IDEMPOTENCY_KEY.test(idempotencyKey))
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
      !IDEMPOTENCY_KEY.test(idempotencyKey)
    )
      throw new ProviderError("idempotency_key_required", 400);
    // Validate before reserving; hash a canonical representation, not random MIME boundaries.
    input.attachments = validateAttachments(input.attachments);
    makeMime(account.email, input);
    if (kind === "draft" && !this.capabilities(account).drafts) throw new ProviderError("not_supported", 400);
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
      const result = await this.withSession(account, (s) => kind === "draft" ? s.createDraft(input) : s.send(input));
      if (kind === "draft") receipt.providerDraftId = result.draftId;
      receipt.providerMessageId = result.id;
      receipt.threadId = result.threadId;
      receipt.status = "accepted";
    } catch (error) {
      // Refused before anything was handed over (a wrong password, a rejected recipient, a server
      // out of reach): nothing left, so the reservation goes and the same key may try again.
      if (error instanceof NotSentError) {
        await this.store.delete(key);
        throw new ProviderError(error.code, error.status);
      }
      receipt.status = "unknown";
      receipt.error =
        error instanceof ProviderError ? error.code : "send_outcome_unknown";
      await this.noteProblem(account.id, error);
    }
    // A failed durable receipt write leaves 'sending'; future attempts resolve to unknown, never resend.
    await this.store.put(key, receipt);
    const { digest: _, ...publicReceipt } = receipt;
    return publicReceipt;
  }
  async setRead(accountId: string, messageId: string, read: boolean) {
    if (typeof read !== "boolean")
      throw new ProviderError("invalid_read_state", 400);
    return this.changeMessage(accountId, messageId, { read });
  }
  async setStarred(accountId: string, messageId: string, starred: boolean) {
    if (typeof starred !== "boolean")
      throw new ProviderError("invalid_starred_state", 400);
    return this.changeMessage(accountId, messageId, { starred });
  }
  async setTrashed(accountId: string, messageId: string, trashed: boolean) {
    if (typeof trashed !== "boolean")
      throw new ProviderError("invalid_trashed_state", 400);
    return this.changeMessage(accountId, messageId, { trashed });
  }
  async archive(accountId: string, messageId: string) {
    return this.changeMessage(accountId, messageId, { archive: true });
  }
  /** Back to the Inbox from the archive, Trash or Spam. */
  async moveToInbox(accountId: string, messageId: string) {
    return this.changeMessage(accountId, messageId, { inbox: true });
  }
  /** Report spam or Not spam through the provider's own spam folder, which also trains its filter (SP-3). */
  async setSpam(accountId: string, messageId: string, spam: boolean) {
    if (typeof spam !== "boolean") throw new ProviderError("invalid_spam_state", 400);
    return this.changeMessage(accountId, messageId, { spam });
  }
  private async changeMessage(accountId: string, messageId: string, change: MessageChange) {
    keyPart(messageId);
    const account = await this.account(accountId);
    const capabilities = this.capabilities(account);
    if (("archive" in change && !capabilities.archive) || ("spam" in change && !capabilities.spam) || ("trashed" in change && !capabilities.trash))
      throw new ProviderError("not_supported", 400);
    const id = await this.currentId(account.id, messageId);
    // Read full provider state after acknowledgement; never optimistically cache labels.
    // A timeout or a failed read rejects and leaves the previous cache intact.
    const message = await this.withSession(account, (s) => s.change(id, change));
    if (!message) {
      // It left the folders this server reads (or its new place is known only after the next sync).
      const row = await this.cache.row(account.id, id);
      await this.cache.remove(account.id, id);
      if (!row) throw new ProviderError("message_not_found", 404);
      return { ...row.message, text: "", html: "", labels: [], read: true, archived: true } as Message;
    }
    if (message.providerMessageId !== id) {
      // Moved (IMAP): the message has a new id in its new folder. The old id keeps answering for a
      // week, so an Undo or a second action from a list read before the move still finds it.
      await this.cache.remove(account.id, id);
      const moved = { to: message.providerMessageId, at: Date.now() };
      await this.store.put("moved:" + account.id + ":" + id, moved);
      if (messageId !== id) await this.store.put("moved:" + account.id + ":" + messageId, moved);
    }
    const { bodyless, ...saved } = message;
    await this.saveMessage(account, saved, { bodyless });
    return saved;
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
    const id = await this.currentId(account.id, messageId);
    return this.withSession(account, (s) => s.attachment(id, attachmentId));
  }
  async disconnect(accountId: string) {
    const account = await this.account(accountId);
    let revoked = false;
    try {
      const keys = await this.credentialKeys();
      if (keys) {
        const { value } = await openCredentials(keys, account.id, account.credentials);
        revoked = await this.provider(account).revoke(account, value);
      }
    } catch {
      /* Local removal is still possible when the provider or the encryption key is unavailable. */
    }
    await this.store.delete("account:" + accountId);
    await this.cache.clear(keyPart(accountId));
    for (const prefix of [
      "attempts:" + accountId + ":",
      "skipped:" + accountId + ":",
      "event:" + accountId + ":",
      "pending:event:" + accountId + ":",
      "moved:" + accountId + ":",
      "draft:" + accountId + ":",
    ]) {
      for (;;) {
        const rows = await this.store.list({ prefix, limit: 100 });
        if (!rows.size) break;
        for (const key of rows.keys()) await this.store.delete(key);
      }
    }
    console.log(JSON.stringify({ event: "account_disconnected", provider: account.provider, revoked }));
    // Preserve send receipts so reconnect/replay can never erase uncertainty.
    return { status: "disconnected", revoked, provider: account.provider };
  }
  /**
   * Hands pending incoming events to their consumers, each on its own: one that fails waits its
   * backoff (30 s doubling to 1 h) and, after MAX_EVENT_ATTEMPTS, is set aside under
   * `dead:event:` with its error, so it never holds back the events behind it.
   */
  async drainEvents(deliver: (event: IncomingEvent) => Promise<unknown>, now = Date.now()): Promise<{ delivered: number; failed: number; dead: number }> {
    const result = { delivered: 0, failed: 0, dead: 0 };
    let handled = 0;
    const providers = new Map<string, string>();
    for (const [key, event] of await this.store.list<PendingEvent>({ prefix: "pending:event:", limit: 500 })) {
      if (handled >= 25) break;
      if (event.nextAt && event.nextAt > now) continue;
      handled++;
      try {
        let message: Message;
        let provider = providers.get(event.accountId);
        try {
          if (!provider) providers.set(event.accountId, provider = (await this.account(event.accountId)).provider);
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
          account: provider + ":" + event.accountId,
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
  // ── Composing and reading in full ──
  /** Every header of one message, read from the provider (the cache keeps only those the feed needs). */
  async getHeaders(accountId: string, messageId: string) {
    keyPart(messageId);
    const account = await this.account(accountId);
    const id = await this.currentId(account.id, messageId);
    return { headers: await this.withSession(account, (s) => s.headers(id)) };
  }
  /**
   * The account's own drafts (B-50, B-52), read and changed at the provider so they show there
   * too. A save or a send that names the revision it read is refused when the draft moved on
   * (`draft_conflict`).
   */
  async listDrafts(accountId: string, pageToken?: string) {
    const account = await this.account(accountId);
    if (!this.capabilities(account).drafts) return { drafts: [], nextCursor: null };
    return this.withSession(account, (s) => s.listDrafts(pageToken));
  }
  async getDraft(accountId: string, draftId: string) {
    keyPart(draftId);
    const account = await this.account(accountId);
    return this.withSession(account, (s) => s.getDraft(draftId));
  }
  async updateDraft(accountId: string, draftId: string, request: DraftUpdate) {
    keyPart(draftId);
    const account = await this.account(accountId);
    return this.withSession(account, (s) => s.updateDraft(draftId, request));
  }
  async deleteDraft(accountId: string, draftId: string) {
    keyPart(draftId);
    const account = await this.account(accountId);
    await this.withSession(account, (s) => s.deleteDraft(draftId));
    return { deleted: draftId };
  }
  /** Sends a draft as the provider holds it, once per idempotency key (its receipt is a send receipt). */
  async sendDraft(accountId: string, draftId: string, idempotencyKey: string, expectedRevision?: string): Promise<SendReceipt> {
    keyPart(draftId);
    const account = await this.account(accountId);
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ProviderError("idempotency_key_required", 400);
    const key = "send:" + keyPart(accountId) + ":" + idempotencyKey;
    const digest = await pkceChallenge(JSON.stringify({ draft: draftId }));
    const answer = async (receipt: StoredSend) => {
      if (receipt.status === "sending") { receipt.status = "unknown"; receipt.error = "send_outcome_unknown"; await this.store.put(key, receipt); }
      const { digest: _, ...publicReceipt } = receipt;
      return publicReceipt;
    };
    // A retry after the draft went out (and the provider removed it) answers the first attempt.
    const old = await this.store.get<StoredSend>(key);
    if (old) { if (old.digest !== digest) throw new ProviderError("idempotency_conflict", 409); return answer(old); }
    return this.withSession(account, async (session) => {
      const current = await session.draftRevision(draftId);
      if (expectedRevision !== undefined && current !== expectedRevision) throw new ProviderError("draft_conflict", 409);
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
        const sent = await session.sendDraft(draftId);
        receipt.status = "accepted"; receipt.providerMessageId = sent.id; receipt.threadId = sent.threadId;
      } catch (error) {
        if (error instanceof NotSentError) {
          await this.store.delete(key);
          throw new ProviderError(error.code, error.status);
        }
        receipt.status = "unknown";
        receipt.error = error instanceof ProviderError ? error.code : "send_outcome_unknown";
        await this.noteProblem(account.id, error);
      }
      await this.store.put(key, receipt);
      const { digest: _, ...publicReceipt } = receipt;
      return publicReceipt;
    });
  }
}
