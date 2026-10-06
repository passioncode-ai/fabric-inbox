/**
 * Gmail as a `MailProvider` (provider.ts): Google OAuth, the Gmail API (gmail-client.ts) and the
 * history/import loop (gmail-sync.ts). Its behaviour and stored data are those of 0.10: account
 * ids `gmail:<id>`, records under `account:<id>`, the cache layout and the drafts API.
 */
import { validateAttachments, type MailAttachment } from "../../shared/mail/attachments";
import { configuration, type GmailEnvironment, type Store } from "./google-oauth";
import { GmailClient, ProviderError, makeMime, normalizeMessage, type Credentials, type Fetcher, type GmailMessage, type Message, type SendInput } from "./gmail-client";
import { DISCARDED_LABEL, type GmailCache } from "./gmail-cache";
import { GmailSync, importPercent, normalizeSync, type SyncState } from "./gmail-sync";
import type { AccountBase, DraftUpdate, DraftView, MailProvider, MessageChange, ProviderCapabilities, ProviderSession } from "./provider";

export interface GmailAccount extends AccountBase {
  provider: "gmail";
  sync: SyncState;
}

/** The name of the account's own label that is Discarded (made the first time a message is discarded). */
export const DISCARD_LABEL_NAME = "Discarded";
/** Where this server keeps the id Gmail gave that label (`Label_…`). */
const discardLabelKey = (accountId: string) => `label:${accountId}:discarded`;

const CAPABILITIES: ProviderCapabilities = {
  organization: "labels", threads: "provider", drafts: true, archive: true, spam: true, trash: true,
  search: "cache", sentCopy: "provider", auth: "oauth", delivery: "poll",
};

/** A draft Gmail no longer has is `draft_not_found`, not a provider failure. */
async function draftOrMissing<T>(work: Promise<T>): Promise<T> {
  try { return await work; }
  catch (error) { if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("draft_not_found", 404); throw error; }
}

/** One Gmail draft as the drafts list (and, with its body, the composer) shows it. */
export function gmailDraft(accountId: string, draft: { id: string; message: GmailMessage }, withBody: boolean): DraftView {
  const m = normalizeMessage(accountId, draft.message);
  return {
    draftId: draft.id, revision: m.providerMessageId, messageId: m.providerMessageId, threadId: m.threadId,
    to: m.to, cc: m.cc || null, bcc: m.bcc || null, subject: m.subject, date: m.timestamp ? new Date(m.timestamp).toISOString() : m.date,
    inReplyTo: m.inReplyTo || null, references: m.references || null, snippet: m.snippet,
    attachments: m.attachments.map((a) => ({ id: a.providerAttachmentId, filename: a.filename, mimetype: a.mimeType, size: a.size })),
    ...(withBody ? { text: m.text, html: m.html } : {}),
  };
}

export class GmailProvider implements MailProvider<GmailAccount> {
  readonly id = "gmail" as const;
  private syncer: GmailSync;
  constructor(private store: Store, cache: GmailCache, private env: GmailEnvironment, private http: Fetcher = fetch) {
    this.syncer = new GmailSync(store, cache);
  }
  configured() {
    return configuration(this.env).status === "configured";
  }
  capabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }
  pending(account: GmailAccount) {
    return account.sync.mode === "initial" || !!account.sync.historyPageToken;
  }
  progress(account: GmailAccount) {
    return importPercent(account.sync);
  }
  restartSync(account: GmailAccount) {
    account.sync = { mode: "initial" };
  }
  async revoke(_account: GmailAccount, credentials?: unknown) {
    const token = (credentials as Partial<Credentials> | undefined)?.refreshToken;
    if (!token) return false;
    const result = await this.http("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(20000),
    });
    return result.ok;
  }
  async open(account: GmailAccount, credentials: unknown, persist: (next: unknown) => Promise<void>): Promise<ProviderSession> {
    if (!this.configured()) throw new ProviderError("not_configured", 503);
    const client = new GmailClient(this.env, credentials as Credentials, persist, this.http);
    const label = await this.store.get<string>(discardLabelKey(account.id));
    if (label) client.labelAliases = { [label]: DISCARDED_LABEL };
    return new GmailSession(account, client, this.syncer, this.store);
  }
}

class GmailSession implements ProviderSession {
  constructor(private account: GmailAccount, private client: GmailClient, private syncer: GmailSync, private store: Store) {}
  /**
   * The id of the account's "Discarded" label: the one this server made or found before, else one of
   * the account's labels by that name, else a new one. Kept, and read as DISCARDED on every message.
   */
  private async discardLabel(fresh = false): Promise<string> {
    const key = discardLabelKey(this.account.id);
    if (!fresh) {
      const kept = await this.store.get<string>(key);
      if (kept) return kept;
    }
    const find = async () => (await this.client.labels()).labels?.find((l) => l.name.trim().toLowerCase() === DISCARD_LABEL_NAME.toLowerCase())?.id;
    let id = await find();
    if (!id) {
      try { id = (await this.client.createLabel(DISCARD_LABEL_NAME)).id; }
      // Made meanwhile (another window, Gmail itself): the list has it now.
      catch (error) { id = await find(); if (!id) throw error; }
    }
    if (!id) throw new ProviderError("discard_label_unavailable", 502);
    await this.store.put(key, id);
    this.client.labelAliases = { [id]: DISCARDED_LABEL };
    console.log(JSON.stringify({ event: "gmail_discard_label_ready", again: fresh }));
    return id;
  }
  /** A change naming the Discarded label; a label deleted in Gmail since is found or made again, once. */
  private async withLabel(work: (label: string) => Promise<unknown>) {
    try { await work(await this.discardLabel()); }
    catch (error) {
      if (!(error instanceof ProviderError && (error.code === "provider_failed" || error.code === "not_found"))) throw error;
      await work(await this.discardLabel(true));
    }
  }
  async syncPage(record: AccountBase & { sync: unknown }, kind: "history" | "import", deadline: number) {
    const account = record as GmailAccount;
    account.sync = normalizeSync(account.sync);
    return kind === "history"
      ? this.syncer.historyPage(account.id, account.sync, this.client)
      : this.syncer.importPage(account.id, account.sync, this.client, deadline);
  }
  async message(messageId: string): Promise<Message> {
    return normalizeMessage(this.account.id, await this.client.message(messageId));
  }
  async change(messageId: string, change: MessageChange): Promise<Message> {
    const c = this.client;
    if ("read" in change) await c.modify(messageId, change.read ? [] : ["UNREAD"], change.read ? ["UNREAD"] : []);
    else if ("starred" in change) await c.setStarred(messageId, change.starred);
    else if ("trashed" in change) await c.setTrashed(messageId, change.trashed);
    else if ("archive" in change) await c.modify(messageId, [], ["INBOX"]);
    else if ("inbox" in change) {
      // Back to the Inbox from the archive, Trash or Spam: untrash only removes TRASH, so INBOX is added too.
      if ((await c.message(messageId)).labelIds?.includes("TRASH")) await c.setTrashed(messageId, false);
      // Out of Discarded too, when the account has that label: the inbox is one place.
      const discard = await this.store.get<string>(discardLabelKey(this.account.id));
      await c.modify(messageId, ["INBOX"], ["SPAM", ...(discard ? [discard] : [])]);
    } else if ("spam" in change) {
      // Report spam or Not spam through Gmail's own label, which also trains Gmail (SP-3).
      await c.modify(messageId, change.spam ? ["SPAM"] : ["INBOX"], change.spam ? ["INBOX"] : ["SPAM"]);
    } else if ("discarded" in change) {
      // Discarded is the account's own "Discarded" label, out of the inbox, read; from Trash it is untrashed first.
      if (change.discarded) {
        if ((await c.message(messageId)).labelIds?.includes("TRASH")) await c.setTrashed(messageId, false);
        await this.withLabel((label) => c.modify(messageId, [label], ["INBOX", "UNREAD", "SPAM"]));
      } else {
        // Back where it was: the inbox, the archive (no INBOX), or Trash.
        const to = change.to ?? "inbox";
        await this.withLabel((label) => c.modify(messageId, to === "inbox" ? ["INBOX"] : [], [label]));
        if (to === "trash") await c.setTrashed(messageId, true);
      }
    }
    // Read full provider state after acknowledgement; never optimistically cache labels.
    return this.message(messageId);
  }
  attachment(messageId: string, attachmentId: string) {
    return this.client.attachment(messageId, attachmentId);
  }
  async headers(messageId: string) {
    try {
      const raw = await this.client.messageHeaders(messageId);
      return (raw.payload?.headers ?? []).map((h) => ({ key: h.name, value: h.value }));
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("message_not_found", 404);
      throw error;
    }
  }
  async send(input: SendInput) {
    const result = await this.client.send(makeMime(this.account.email, input), input.threadId);
    if (!result.id) throw new ProviderError("invalid_send_receipt");
    return { id: result.id, threadId: result.threadId };
  }
  async createDraft(input: SendInput) {
    const result = await this.client.createDraft(makeMime(this.account.email, input), input.threadId);
    if (!result.id || !result.message?.id) throw new ProviderError("invalid_send_receipt");
    return { draftId: result.id, id: result.message.id, threadId: result.message.threadId };
  }
  /**
   * Gmail's own drafts (B-50, B-52), read and changed in Gmail so they show there too. A draft's
   * revision is its message id: Gmail gives the message a new id on every change, so a save or a
   * send that names the id it read is refused when the draft moved on (`draft_conflict`).
   */
  async listDrafts(pageToken?: string) {
    if (pageToken !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(pageToken)) throw new ProviderError("invalid_filter", 400);
    const page = await this.client.listDrafts(pageToken);
    const drafts: DraftView[] = [];
    for (const d of page.drafts ?? []) {
      try { drafts.push(gmailDraft(this.account.id, await this.client.getDraft(d.id), false)); }
      catch (error) { if (!(error instanceof ProviderError && error.code === "not_found")) throw error; /* sent or deleted meanwhile */ }
    }
    return { drafts, nextCursor: page.nextPageToken ?? null };
  }
  async getDraft(draftId: string) {
    return gmailDraft(this.account.id, await draftOrMissing(this.client.getDraft(draftId)), true);
  }
  async draftRevision(draftId: string) {
    return (await draftOrMissing(this.client.getDraft(draftId, "minimal"))).message.id;
  }
  async updateDraft(draftId: string, request: DraftUpdate) {
    const client = this.client;
    const { expectedRevision, keepAttachments, ...input } = request;
    const current = await draftOrMissing(client.getDraft(draftId));
    if (expectedRevision !== undefined && current.message.id !== expectedRevision) throw new ProviderError("draft_conflict", 409);
    // The draft's message is replaced whole: the files it keeps are read and written again.
    const keep = keepAttachments === undefined ? null : new Set(keepAttachments);
    const kept: MailAttachment[] = [];
    for (const f of normalizeMessage(this.account.id, current.message).attachments) {
      if (keep && !keep.has(f.providerAttachmentId)) continue;
      const data = (await client.attachment(current.message.id, f.providerAttachmentId)).data.replace(/-/g, "+").replace(/_/g, "/");
      kept.push({ content: data + "=".repeat((4 - (data.length % 4)) % 4), filename: f.filename || "attachment", type: f.mimeType || "application/octet-stream", disposition: "attachment" as const });
    }
    const files = validateAttachments([...kept, ...validateAttachments(input.attachments)]);
    const raw = makeMime(this.account.email, { ...input, attachments: files });
    const result = await client.updateDraft(draftId, raw, input.threadId);
    return { draftId, revision: result.message.id, messageId: result.message.id, threadId: result.message.threadId };
  }
  async deleteDraft(draftId: string) {
    await draftOrMissing(this.client.deleteDraft(draftId));
  }
  async sendDraft(draftId: string) {
    const sent = await this.client.sendDraft(draftId);
    if (!sent.id) throw new ProviderError("invalid_send_receipt");
    return { id: sent.id, threadId: sent.threadId };
  }
  async close() {}
}
