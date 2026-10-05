import { DurableObject } from "cloudflare:workers";
import type { InboxReadOptions } from "../../shared/mail/inbox";
import {
  AccountService,
  type SendRequest,
  type IncomingEvent,
  type MessageFilters,
} from "./account-service";
import {
  configuration,
  type GmailEnvironment,
  type Store,
} from "./google-oauth";

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
export interface GmailBindings extends GmailEnvironment {
  GMAIL_ACCOUNTS: DurableObjectNamespace<GmailAccountsDO>;
  AUTOMATIONS?: { getByName(name: string): AutomationStub };
  CATEGORIES?: { getByName(name: string): { ingest(account: { id: string; email: string }, event: { id: string; sender: string; subject: string; body: string; date: string }): Promise<void> } };
}
/** One object per Access workspace. Access users intentionally share every account. */
export class GmailAccountsDO extends DurableObject<GmailBindings> {
  private service: AccountService;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: GmailBindings) {
    super(ctx, env);
    this.service = new AccountService(ctx.storage as unknown as Store, env);
  }
  // Serialize network-spanning operations as well as storage writes. A durable
  // sending receipt handles process death while this in-memory lock is held.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async schedule() {
    const config = configuration(this.env);
    if (config.status === "configured")
      await this.ctx.storage.setAlarm(Date.now() + config.pollMs);
  }
  private async drain() {
    if (!this.env.AUTOMATIONS && !this.env.CATEGORIES) return;
    // Categories scope by the inbox's address, which the event does not carry.
    let emails: Map<string, string> | undefined;
    await this.service.drainEvents(async (event: IncomingEvent) => {
      const payload = { id: event.emailId, sender: event.sender, subject: event.subject, body: event.body, date: event.date, thread_id: event.threadId };
      if (this.env.AUTOMATIONS) await this.env.AUTOMATIONS.getByName(event.account).ingest(event.account, payload);
      if (this.env.CATEGORIES) {
        emails ??= new Map((await this.service.listAccounts()).accounts.map((a) => ["gmail:" + a.id, a.email] as [string, string]));
        await this.env.CATEGORIES.getByName("workspace").ingest({ id: event.account, email: emails.get(event.account) ?? "" }, payload);
      }
    });
  }
  listAccounts() {
    return this.serial(() => this.service.listAccounts());
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
      await this.schedule();
      return account;
    });
  }
  async sync(accountId: string) {
    const result = await this.serial(async () => {
      await this.schedule();
      return this.service.sync(accountId);
    });
    // A sync that worked is reported as working even if handing its events on did not.
    await this.drain().catch((error: unknown) =>
      console.warn(JSON.stringify({ event: "gmail_drain_failed", error: (error as Error)?.message?.slice(0, 200) })));
    return result;
  }
  listMessages(accountId: string, options?: MessageFilters) {
    return this.serial(() => this.service.listMessages(accountId, options));
  }
  inboxMessagesByIds(accountId: string, messageIds: string[], ownDomains: string[] = []) {
    return this.serial(() => this.service.inboxMessagesByIds(accountId, messageIds, ownDomains));
  }
  getMessage(accountId: string, messageId: string) {
    return this.serial(() => this.service.getMessage(accountId, messageId));
  }
  countInbox(accountId: string) {
    return this.serial(() => this.service.countInbox(accountId));
  }
  countUnreadInbox(accountId: string) {
    return this.serial(() => this.service.countUnreadInbox(accountId));
  }
  listInboxMessages(accountId: string, options: InboxReadOptions) {
    return this.serial(() => this.service.listInboxMessages(accountId, options));
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
  getAttachment(accountId: string, messageId: string, attachmentId: string) {
    return this.serial(() =>
      this.service.getAttachment(accountId, messageId, attachmentId),
    );
  }
  disconnect(accountId: string) {
    return this.serial(() => this.service.disconnect(accountId));
  }
  async alarm() {
    await this.serial(async () => {
      const config = configuration(this.env);
      if (config.status !== "configured") return;
      // Schedule before outbound I/O: a restart cannot silently stop cloud polling.
      await this.schedule();
      const { accounts } = await this.service.listAccounts();
      if (!accounts.length) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const offset = (await this.ctx.storage.get<number>("poll:offset")) || 0;
      for (let i = 0; i < Math.min(5, accounts.length); i++) {
        const account = accounts[(offset + i) % accounts.length];
        if (
          account.status === "reconnect_required" ||
          (account.retryAt && account.retryAt > Date.now())
        )
          continue;
        try {
          await this.service.sync(account.id);
        } catch {
          /* Sanitized account status is durable; no secrets or upstream bodies in logs. */
        }
      }
      await this.ctx.storage.put("poll:offset", (offset + 5) % accounts.length);
    });
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
