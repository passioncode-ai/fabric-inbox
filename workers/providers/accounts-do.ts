import { DurableObject } from "cloudflare:workers";
import type { InboxReadOptions } from "../../shared/mail/inbox";
import {
  AccountService,
  type SendRequest,
  type IncomingEvent,
  type MessageFilters,
} from "./account-service";
import type { Store } from "./google-oauth";
import { hasCredentialKey } from "./credentials";
import { pollInterval, type AccountsEnvironment } from "./account-service";
import { GmailScheduler, type AlarmStorage } from "./gmail-scheduler";
import type { ImapConnectInput } from "./imap/connect";
import { autoReason, discardFacts, discardSafety, matchDiscard, recordApplied } from "../../shared/mail/discard";
import { readDiscardStore, updateDiscardStore } from "../discard/store";
import { readSpamLists } from "../spam/lists";
import { allServedDomains } from "../lib/mailbox-store";

interface AutomationStub {
  ingest(
    account: string,
    email: {
      id: string;
      sender: string;
      subject: string;
      body: string;
      date: string;
      thread_id?: string;
    },
  ): Promise<void>;
}
export interface GmailBindings extends AccountsEnvironment {
  GMAIL_ACCOUNTS: DurableObjectNamespace<GmailAccountsDO>;
  /** The workspace's R2 bucket: the discard rules (config/discard.json), the spam lists and the served domains. */
  BUCKET?: R2Bucket;
  DOMAINS?: string;
  AUTOMATIONS?: { getByName(name: string): AutomationStub };
  CATEGORIES?: { getByName(name: string): { ingest(account: { id: string; email: string }, event: { id: string; sender: string; subject: string; body: string; date: string }): Promise<void> } };
}
/** One object per Access workspace. Access users intentionally share every account. */
export class GmailAccountsDO extends DurableObject<GmailBindings> {
  private service: AccountService;
  private scheduler: GmailScheduler;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: GmailBindings) {
    super(ctx, env);
    this.service = new AccountService(ctx.storage as unknown as Store, env);
    this.scheduler = new GmailScheduler(ctx.storage as unknown as AlarmStorage, {
      listAccounts: () => this.service.listAccounts(),
      sync: (id, options) => this.service.sync(id, options),
      ready: (account) => this.service.ready(account),
    }, (fn) => this.serial(fn), () => (hasCredentialKey(this.env) ? pollInterval(this.env) : null));
  }
  // Serialize network-spanning operations as well as storage writes. A durable
  // sending receipt handles process death while this in-memory lock is held.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async drain() {
    if (!this.env.AUTOMATIONS && !this.env.CATEGORIES && !this.env.BUCKET) return;
    // Categories scope by the inbox's address, which the event does not carry.
    let emails: Map<string, string> | undefined;
    await this.service.drainEvents(async (event: IncomingEvent) => {
      const payload = { id: event.emailId, sender: event.sender, subject: event.subject, body: event.body, date: event.date, thread_id: event.threadId };
      if (this.env.AUTOMATIONS) await this.env.AUTOMATIONS.getByName(event.account).ingest(event.account, payload);
      if (this.env.CATEGORIES) {
        emails ??= new Map((await this.service.listAccounts()).accounts.map((a) => [a.provider + ":" + a.id, a.email] as [string, string]));
        await this.env.CATEGORIES.getByName("workspace").ingest({ id: event.account, email: emails.get(event.account) ?? "" }, payload);
      }
    }, Date.now(), await this.arrivalFilter(), (ruleId) => updateDiscardStore(this.env.BUCKET!, (store) => recordApplied(store, ruleId, Date.now())),
    // drain() never runs inside serial (a consumer may call back into this object), so taking the
    // lock here for the discard alone cannot deadlock; it keeps the discard off a sync page's back.
    (fn) => this.serial(fn));
  }
  /**
   * The discard rules applied to new inbox mail of Gmail, IMAP and Outlook accounts (after the
   * provider's own spam filter, which has already kept spam out of the inbox): a match goes to
   * Discarded unless the account wrote to the sender, took part in the conversation, the sender is
   * on one of the workspace's own domains, or is allowed (Always allow, Never spam). No rules, or rules
   * that cannot be read: no filter, and the mail is delivered as before.
   */
  private async arrivalFilter() {
    const bucket = this.env.BUCKET;
    if (!bucket) return undefined;
    let store;
    try { store = await readDiscardStore(bucket); }
    catch (error) {
      console.warn(JSON.stringify({ event: "discard_check_failed", error: (error as Error)?.message?.slice(0, 120) }));
      return undefined;
    }
    if (!store.rules.length) return undefined;
    const rules = store;
    let lists: Awaited<ReturnType<typeof readSpamLists>> | undefined;
    let own: string[] | undefined;
    return async (event: { accountId: string }, message: { from: string; threadId: string; signals?: { list?: string; listUnsubscribe?: boolean; precedence?: string } }) => {
      const headers = [
        ...(message.signals?.list ? [{ key: "List-Id", value: message.signals.list }] : []),
        ...(message.signals?.listUnsubscribe ? [{ key: "List-Unsubscribe", value: "yes" }] : []),
        ...(message.signals?.precedence ? [{ key: "Precedence", value: message.signals.precedence }] : []),
      ];
      const facts = discardFacts({ sender: message.from, headers });
      lists ??= await readSpamLists(bucket).catch(() => undefined);
      const rule = matchDiscard(rules, facts, lists);
      if (!rule) return null;
      own ??= await allServedDomains({ BUCKET: bucket, DOMAINS: this.env.DOMAINS } as never).catch(() => [] as string[]);
      const contact = await this.service.sentContact(event.accountId, message.from, message.threadId);
      const held = discardSafety({ sender: message.from, ...contact, ownDomains: own });
      if (held) {
        console.log(JSON.stringify({ event: "discard_held", provider: "remote", rule: rule.id, why: held }));
        return null;
      }
      return { reason: autoReason(rule), ruleId: rule.id };
    };
  }
  // Reads take no lock: every cached change is one transaction, and a read is about one page of
  // rows, so the feed never waits behind a sync page or a mail action.
  listAccounts() {
    return this.service.listAccounts();
  }
  /** Refresh: Gmail's new mail and changes for these accounts (all when omitted) within the budget. */
  async refresh(accountIds?: string[]) {
    const outcomes = await this.scheduler.refresh(accountIds);
    await this.drain().catch((error: unknown) =>
      console.warn(JSON.stringify({ event: "gmail_drain_failed", error: (error as Error)?.message?.slice(0, 200) })));
    return outcomes;
  }
  /** The providers and IMAP presets this server offers (no account, no secret). */
  mailProviders() {
    return this.service.mailProviders();
  }
  /**
   * Connects an IMAP account. Checking the servers takes seconds and runs outside the object's lock,
   * so mail actions and syncs go on meanwhile; the first sync starts at once.
   */
  async connectImap(input: ImapConnectInput) {
    const account = await this.service.connectImap(input);
    await this.scheduler.connected();
    return account;
  }
  async updateImapPassword(accountId: string, password: string) {
    const account = await this.service.updateImapPassword(accountId, password);
    await this.scheduler.connected();
    return account;
  }
  beginConnect() {
    return this.serial(() => this.service.connect());
  }
  callback(state: string, browserToken: string, code: string, error?: string) {
    return this.serial(async () => {
      const account = await this.service.callback(
        state,
        browserToken,
        code,
        error,
      );
      // Its first sync starts now, not a whole poll interval later.
      await this.scheduler.connected();
      return account;
    });
  }
  /** Starts connecting an Outlook account (Microsoft's sign-in address and this browser's token). */
  beginOutlookConnect() {
    return this.serial(() => this.service.outlookConnect());
  }
  /** The end of connecting an Outlook account; its first sync starts at once. */
  outlookCallback(state: string, browserToken: string, code: string, outcome?: string) {
    return this.serial(async () => {
      const account = await this.service.outlookCallback(state, browserToken, code, outcome);
      await this.scheduler.connected();
      return account;
    });
  }
  /** Asks Microsoft whether it accepts the server's client now (one Outlook account's token renewed). */
  checkMicrosoftClient() {
    return this.serial(() => this.service.microsoftClientCheck());
  }
  /** History then import pages for one account now; the shared alarm is never moved later (P1-6). */
  async sync(accountId: string) {
    const result = await this.scheduler.syncNow(accountId);
    // A sync that worked is reported as working even if handing its events on did not.
    await this.drain().catch((error: unknown) =>
      console.warn(JSON.stringify({ event: "gmail_drain_failed", error: (error as Error)?.message?.slice(0, 200) })));
    return result;
  }
  listMessages(accountId: string, options?: MessageFilters) {
    return this.service.listMessages(accountId, options);
  }
  inboxMessagesByIds(accountId: string, messageIds: string[], ownDomains: string[] = []) {
    return this.service.inboxMessagesByIds(accountId, messageIds, ownDomains);
  }
  getMessage(accountId: string, messageId: string) {
    return this.serial(() => this.service.getMessage(accountId, messageId));
  }
  countInbox(accountId: string) {
    return this.service.countInbox(accountId);
  }
  countUnreadInbox(accountId: string) {
    return this.service.countUnreadInbox(accountId);
  }
  listInboxMessages(accountId: string, options: InboxReadOptions) {
    return this.service.listInboxMessages(accountId, options);
  }
  send(accountId: string, request: SendRequest) {
    return this.serial(() => this.service.send(accountId, request));
  }
  createDraft(accountId: string, request: SendRequest) {
    return this.serial(() => this.service.createDraft(accountId, request));
  }
  getSendReceipt(accountId: string, key: string) {
    return this.serial(() => this.service.getSendReceipt(accountId, key));
  }
  getDraftReceipt(accountId: string, key: string) {
    return this.serial(() => this.service.getDraftReceipt(accountId, key));
  }
  setRead(accountId: string, messageId: string, read: boolean) {
    return this.serial(() => this.service.setRead(accountId, messageId, read));
  }
  setStarred(accountId: string, messageId: string, starred: boolean) {
    return this.serial(() => this.service.setStarred(accountId, messageId, starred));
  }
  setTrashed(accountId: string, messageId: string, trashed: boolean) {
    return this.serial(() => this.service.setTrashed(accountId, messageId, trashed));
  }
  setSpam(accountId: string, messageId: string, spam: boolean) {
    return this.serial(() => this.service.setSpam(accountId, messageId, spam));
  }
  archive(accountId: string, messageId: string) {
    return this.serial(() => this.service.archive(accountId, messageId));
  }
  moveToInbox(accountId: string, messageId: string) {
    return this.serial(() => this.service.moveToInbox(accountId, messageId));
  }
  /** Discards a message in its account (Discarded label or folder, read), with why. */
  discardMessage(accountId: string, messageId: string, reason: string) {
    return this.serial(() => this.service.discard(accountId, messageId, reason));
  }
  /** Not discarded: back to the inbox. */
  restoreDiscarded(accountId: string, messageId: string, read?: boolean) {
    return this.serial(() => this.service.restoreDiscarded(accountId, messageId, read));
  }
  /** What a message says about itself for a discard rule. */
  discardFacts(accountId: string, messageId: string) {
    return this.serial(() => this.service.discardFacts(accountId, messageId));
  }
  getAttachment(accountId: string, messageId: string, attachmentId: string) {
    return this.serial(() =>
      this.service.getAttachment(accountId, messageId, attachmentId),
    );
  }
  disconnect(accountId: string) {
    return this.serial(() => this.service.disconnect(accountId));
  }
  getHeaders(accountId: string, messageId: string) {
    return this.serial(() => this.service.getHeaders(accountId, messageId));
  }
  listDrafts(accountId: string, pageToken?: string) {
    return this.serial(() => this.service.listDrafts(accountId, pageToken));
  }
  getDraft(accountId: string, draftId: string) {
    return this.serial(() => this.service.getDraft(accountId, draftId));
  }
  updateDraft(accountId: string, draftId: string, request: Parameters<AccountService["updateDraft"]>[2]) {
    return this.serial(() => this.service.updateDraft(accountId, draftId, request));
  }
  deleteDraft(accountId: string, draftId: string) {
    return this.serial(() => this.service.deleteDraft(accountId, draftId));
  }
  sendDraft(accountId: string, draftId: string, idempotencyKey: string, expectedRevision?: string) {
    return this.serial(() => this.service.sendDraft(accountId, draftId, idempotencyKey, expectedRevision));
  }
  async alarm() {
    // A cache of the first layout moves over in the background, a few seconds per account per tick.
    for (const account of (await this.service.listAccounts()).accounts) {
      await this.serial(() => this.service.migrateCache(account.id)).catch((error: unknown) =>
        console.warn(JSON.stringify({ event: "gmail_cache_migration_failed", error: (error as Error)?.message?.slice(0, 200) })));
    }
    // Each sync page takes the lock on its own; mail actions and reads go on between pages.
    await this.scheduler.tick();
    // Discarded mail past its 30 days goes to its account's Trash, a few messages a tick.
    await this.serial(() => this.service.purgeDiscarded()).catch((error: unknown) =>
      console.warn(JSON.stringify({ event: "discarded_purge_failed", error: (error as Error)?.message?.slice(0, 200) })));
    // Release the account lock before invoking automations: a rule may RPC back
    // into this object to read or send mail. Holding it would deadlock the rule.
    try {
      await this.drain();
    } catch (error) {
      // Each event keeps its own retry; this is only what escaped them, said in the logs.
      console.warn(JSON.stringify({ event: "gmail_drain_failed", error: (error as Error)?.message?.slice(0, 200) }));
    }
  }
}
