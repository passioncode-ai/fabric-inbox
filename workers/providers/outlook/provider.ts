/**
 * Outlook.com and Microsoft 365 through Microsoft Graph as a `MailProvider` (provider.ts), for
 * `outlook:<id>` accounts. Microsoft turned basic authentication off for Outlook.com on 2024-09-16,
 * so IMAP with a password no longer reaches these mailboxes; Graph with the person's consent does.
 *
 * - Sign-in: oauth.ts (authorization code with PKCE, the `common` endpoint, the owner's own app
 *   registration); tokens sealed with the credential key; a refresh that returns a new refresh token
 *   replaces the old one at once (`persist`).
 * - Receiving: sync.ts (a delta query per folder, the import newest first, history first every tick).
 * - Actions: read and flag are `PATCH` of `isRead` and `flag`; archive, trash, spam and back are
 *   `move` to the well-known folder (`POST /me/messages/{id}/move`, destinationId by well-known name,
 *   https://learn.microsoft.com/en-us/graph/api/message-move); the id stays (immutable ids).
 * - Sending: the message is made here as MIME (the same RFC 5322 text every provider sends, with its
 *   own Message-ID, In-Reply-To and References), created as a draft (`POST /me/messages`,
 *   `Content-Type: text/plain`, base64; https://learn.microsoft.com/en-us/graph/outlook-send-mime-message)
 *   and sent (`POST /me/messages/{id}/send`, 202; Graph keeps the copy in Sent Items,
 *   https://learn.microsoft.com/en-us/graph/api/message-send). A message whose MIME would pass
 *   MIME_LIMIT is created without its files, which are then attached one by one: under 3 MB in one
 *   request, larger through an upload session
 *   (https://learn.microsoft.com/en-us/graph/outlook-large-attachments). Anything refused before the
 *   send request is `NotSentError` (nothing left); a send request that got no answer is an unknown
 *   outcome. With immutable ids the draft's id is the id of the copy in Sent Items.
 * - Drafts: the Drafts folder's own messages. A draft's id is its message's id, for life; its
 *   revision is a hash of Graph's `changeKey`, which changes with every change. A save is `PATCH` of
 *   the subject, body and recipients, then the files removed and added.
 */
import { validateAttachments, type MailAttachment } from "../../../shared/mail/attachments";
import { ProviderError, rawMime, type Fetcher, type Message, type SendInput } from "../gmail-client";
import type { GmailCache, StoredMessage } from "../gmail-cache";
import type { Store } from "../google-oauth";
import { rawHeaders } from "../imap/mime";
import { NotSentError, type DraftUpdate, type DraftView, type MailProvider, type MessageChange, type ProviderCapabilities, type ProviderSession, type SendResult } from "../provider";
import { MESSAGE_FIELDS, addresses, attachmentFromKey, attachmentKey, labelsFor, localId, messageWithBody, threadOf, type GraphAttachment, type GraphMessage } from "./convert";
import { GraphClient } from "./graph";
import { microsoftConfiguration, randomId, type MicrosoftEnvironment } from "./oauth";
import { MAX_MESSAGE_BYTES, OutlookSync, findDiscarded, readMessage, roleOfFolder } from "./sync";
import { DISCARDED_FOLDER, WELL_KNOWN, type OutlookAccount, type OutlookCredentials, type OutlookRole } from "./types";

/** A MIME message larger than this (base64, as sent) is created without its files, which follow one by one. */
export const MIME_LIMIT = 3 * 1024 * 1024;
/** A file at least this large is attached through an upload session (Microsoft's 3 MB threshold). */
export const UPLOAD_SESSION_BYTES = 3 * 1024 * 1024;
const enc = encodeURIComponent;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A draft's revision: Graph's changeKey, hashed into a short token. */
async function revisionOf(changeKey: string | undefined): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(changeKey ?? "")));
  return "r" + b64url(digest.slice(0, 12));
}

const recipients = (list: string[] | undefined) => (list ?? []).map((address) => ({ emailAddress: { address } }));

export class OutlookProvider implements MailProvider<OutlookAccount> {
  readonly id = "outlook" as const;
  readonly syncer: OutlookSync;
  constructor(private store: Store, private cache: GmailCache, private env: MicrosoftEnvironment, private http: Fetcher = fetch) {
    this.syncer = new OutlookSync(store, cache);
  }
  configured() {
    return microsoftConfiguration(this.env).status === "configured";
  }
  capabilities(account: OutlookAccount): ProviderCapabilities {
    const has = (role: OutlookRole) => account.sync.folders.some((f) => f.role === role);
    return {
      organization: "folders", threads: "provider", drafts: has("drafts"), archive: has("archive"), spam: has("junk"), trash: has("trash"),
      search: "cache", sentCopy: "provider", auth: "oauth", delivery: "poll",
    };
  }
  pending(account: OutlookAccount) {
    return account.sync.mode === "initial" || !!account.sync.more;
  }
  progress(account: OutlookAccount) {
    const { mode, total, imported } = account.sync;
    if (mode !== "initial" || !total) return undefined;
    return Math.min(99, Math.floor(((imported ?? 0) / total) * 100));
  }
  /** Every folder imported again; the rows no new round sees are removed after it. */
  restartSync(account: OutlookAccount) {
    for (const folder of account.sync.folders) {
      Object.assign(folder, { generation: randomId(), sweep: true, seen: 0 });
      delete folder.deltaLink; delete folder.nextLink; delete folder.sweepAfter;
    }
    account.sync.mode = "initial";
  }
  /**
   * Microsoft has no request an app can make to take back one delegated grant: the person removes
   * the app's access in their Microsoft account (account.live.com/consent/Manage for a personal
   * account, My Apps for a work or school one). The tokens are deleted here either way.
   */
  async revoke() {
    return false;
  }
  /** A Graph client for an account, with its renewed tokens sealed through `persist`. */
  client(credentials: OutlookCredentials, persist: (next: OutlookCredentials) => Promise<void>) {
    const config = microsoftConfiguration(this.env);
    if (config.status !== "configured") throw new ProviderError("not_configured", 503);
    return new GraphClient(config, credentials, persist, this.http);
  }
  async open(account: OutlookAccount, credentials: unknown, persist: (next: unknown) => Promise<void>): Promise<ProviderSession> {
    return new OutlookSession(account, this.client(credentials as OutlookCredentials, persist), this.store, this.cache, this.syncer);
  }
}

export class OutlookSession implements ProviderSession {
  constructor(private account: OutlookAccount, readonly graph: GraphClient, private store: Store, private cache: GmailCache, private syncer: OutlookSync) {}

  async close() {}

  async syncPage(record: unknown, kind: "history" | "import", deadline: number) {
    const account = record as OutlookAccount;
    this.account = account;
    return kind === "history" ? this.syncer.historyPage(account, this.graph, deadline) : this.syncer.importPage(account, this.graph, deadline);
  }

  /** The Graph id of a message or draft here: kept on its cached row, or remembered when it was made here. */
  private async remote(id: string, missing = "message_not_found"): Promise<string> {
    const row = await this.cache.row(this.account.id, id) as StoredMessage | undefined;
    const known = row?.message.remoteId ?? (await this.store.get<string>(`gid:${this.account.id}:${id}`));
    if (!known) throw new ProviderError(missing, 404);
    return known;
  }
  private async remember(graphId: string) {
    const id = await localId(graphId);
    await this.store.put(`gid:${this.account.id}:${id}`, graphId);
    return id;
  }

  async message(messageId: string): Promise<Message> {
    const graphId = await this.remote(messageId);
    let read;
    try { read = await readMessage(this.graph, this.account, graphId); }
    catch (error) { if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("message_not_found", 404); throw error; }
    if (!read) throw new ProviderError("message_not_found", 404);
    if (read.bodyless) throw new ProviderError("message_too_large", 413);
    return read.message;
  }

  async change(messageId: string, change: MessageChange): Promise<(Message & { bodyless?: boolean }) | null> {
    const graphId = await this.remote(messageId);
    const path = `/me/messages/${enc(graphId)}`;
    let now: GraphMessage;
    try {
      if ("read" in change) now = await this.graph.json(path, { method: "PATCH", json: { isRead: change.read } });
      else if ("starred" in change) now = await this.graph.json(path, { method: "PATCH", json: { flag: { flagStatus: change.starred ? "flagged" : "notFlagged" } } });
      else if ("discarded" in change && change.discarded) {
        // Discarded: read, then into the folder named Discarded (made the first time).
        await this.graph.json(path, { method: "PATCH", json: { isRead: true } });
        const folder = await this.discardedFolder();
        now = await this.graph.json(path + "/move", { method: "POST", json: { destinationId: folder } });
      } else {
        const target = "trashed" in change ? (change.trashed ? "trash" : "inbox")
          : "archive" in change ? "archive" : "inbox" in change ? "inbox" : "discarded" in change ? change.to ?? "inbox" : change.spam ? "junk" : "inbox";
        if (!this.account.sync.folders.some((f) => f.role === target)) throw new ProviderError("not_supported", 400);
        now = await this.graph.json(path + "/move", { method: "POST", json: { destinationId: WELL_KNOWN[target] } });
      }
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("message_not_found", 404);
      throw error;
    }
    const role = roleOfFolder(this.account.sync, now?.parentFolderId);
    if (!role) return null;
    const row = await this.cache.row(this.account.id, messageId) as StoredMessage | undefined;
    if (!row) return (await readMessage(this.graph, this.account, now.id ?? graphId))?.message ?? null;
    const labels = labelsFor(role, now);
    const body = row.bodyless ? { text: "", html: "" } : await this.cache.body(this.account.id, messageId, row);
    return { ...row.message, ...body, labels, read: !labels.includes("UNREAD"), archived: !labels.includes("INBOX"), remoteId: now.id ?? graphId,
      ...(row.bodyless ? { bodyless: true } : {}) };
  }

  /**
   * The id of the account's Discarded folder: the synced one, else a top-level folder by that name,
   * else one made now (`POST /me/mailFolders`, https://learn.microsoft.com/en-us/graph/api/user-post-mailfolders).
   * It joins the synced folders; the caller keeps the account record with it (AccountService.changeMessage).
   */
  private async discardedFolder(): Promise<string> {
    const synced = this.account.sync.folders.find((f) => f.role === "discarded");
    if (synced) return synced.id;
    let found = await findDiscarded(this.graph);
    let made = false;
    if (!found) {
      try {
        const created = await this.graph.json<{ id?: string; totalItemCount?: number }>("/me/mailFolders", { method: "POST", json: { displayName: DISCARDED_FOLDER, isHidden: false } });
        if (created?.id) { found = { id: created.id, totalItemCount: 0 }; made = true; }
      } catch (error) {
        // Made meanwhile (ErrorFolderExists, 409): the list has it now.
        if (!(error instanceof ProviderError)) throw error;
      }
      found ??= await findDiscarded(this.graph);
    }
    if (!found) throw new ProviderError("folder_create_refused", 502);
    this.account.sync.folders.push({ role: "discarded", id: found.id, total: found.totalItemCount ?? 0, seen: 0, generation: randomId() });
    console.log(JSON.stringify({ event: "outlook_discarded_folder", created: made }));
    return found.id;
  }

  async attachment(messageId: string, attachmentId: string) {
    const graphAttachment = attachmentFromKey(attachmentId);
    if (!graphAttachment) throw new ProviderError("attachment_not_found", 404);
    const graphId = await this.remote(messageId);
    let bytes: Uint8Array;
    try {
      // The raw file ($value) rather than base64 contentBytes, which Microsoft advises against for large files.
      bytes = await this.graph.bytes(`/me/messages/${enc(graphId)}/attachments/${enc(graphAttachment)}/$value`, MAX_MESSAGE_BYTES);
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("attachment_not_found", 404);
      throw error;
    }
    return { data: b64url(bytes), size: bytes.length };
  }

  async headers(messageId: string) {
    const graphId = await this.remote(messageId);
    try {
      const data = await this.graph.json<{ internetMessageHeaders?: { name: string; value: string }[] }>(`/me/messages/${enc(graphId)}?$select=internetMessageHeaders`);
      if (data.internetMessageHeaders?.length) return data.internetMessageHeaders.map((h) => ({ key: h.name, value: h.value }));
      // Graph keeps no transport headers for a draft or a sent copy: its own MIME source has them.
      return rawHeaders(await this.graph.bytes(`/me/messages/${enc(graphId)}/$value`, MAX_MESSAGE_BYTES));
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("message_not_found", 404);
      throw error;
    }
  }

  // ── Making messages: drafts first, then sent ──

  /** Adds one file to a message: one request under 3 MB, an upload session above. */
  private async attach(graphId: string, file: MailAttachment) {
    const bytes = fromBase64(file.content);
    const inline = file.disposition === "inline" && file.contentId ? { isInline: true, contentId: file.contentId } : { isInline: false };
    if (bytes.length < UPLOAD_SESSION_BYTES) {
      await this.graph.json(`/me/messages/${enc(graphId)}/attachments`, { method: "POST",
        json: { "@odata.type": "#microsoft.graph.fileAttachment", name: file.filename, contentType: file.type, contentBytes: file.content, ...inline } });
      return;
    }
    const session = await this.graph.json<{ uploadUrl?: string }>(`/me/messages/${enc(graphId)}/attachments/createUploadSession`, { method: "POST",
      json: { AttachmentItem: { attachmentType: "file", name: file.filename, size: bytes.length, contentType: file.type, ...inline } } });
    if (!session?.uploadUrl) throw new ProviderError("provider_failed", 502);
    await this.graph.upload(session.uploadUrl, bytes);
  }

  /** A new draft from MIME made here, with its files; its Graph id and conversation. */
  private async create(input: SendInput): Promise<{ graphId: string; conversationId?: string }> {
    const files = validateAttachments(input.attachments);
    const domain = this.account.email.split("@").pop() || "fabric-inbox.invalid";
    const headers = [`Message-ID: <${crypto.randomUUID()}@${domain}>`];
    let mime = base64(new TextEncoder().encode(rawMime(this.account.email, { ...input, attachments: files }, headers)));
    const later = mime.length > MIME_LIMIT ? files : [];
    if (later.length) mime = base64(new TextEncoder().encode(rawMime(this.account.email, { ...input, attachments: [] }, headers)));
    const draft = await this.graph.json<GraphMessage>("/me/messages", { method: "POST", body: mime, contentType: "text/plain" });
    if (!draft?.id) throw new ProviderError("provider_failed", 502);
    try {
      for (const file of later) await this.attach(draft.id, file);
    } catch (error) {
      await this.graph.send(`/me/messages/${enc(draft.id)}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    }
    return { graphId: draft.id, conversationId: draft.conversationId };
  }

  /**
   * Sends a draft that exists. Graph refusing the request (a recipient it will not take, the
   * mailbox's sending limit, a throttle) is "not sent"; no answer at all is an unknown outcome.
   */
  private async sendExisting(graphId: string, conversationId: string | undefined, discardOnRefusal: boolean): Promise<SendResult> {
    try {
      await this.graph.send(`/me/messages/${enc(graphId)}/send`, { method: "POST" });
    } catch (error) {
      if (error instanceof ProviderError && ["provider_rejected", "access_denied", "not_found", "message_too_large", "rate_limited", "provider_auth_failed", "reconnect_required"].includes(error.code)) {
        if (discardOnRefusal) await this.graph.send(`/me/messages/${enc(graphId)}`, { method: "DELETE" }).catch(() => undefined);
        throw new NotSentError(error.code === "provider_rejected" ? "message_rejected" : error.code, error.status);
      }
      throw error;
    }
    console.log(JSON.stringify({ event: "outlook_sent" }));
    return { id: await this.remember(graphId), threadId: await threadOf(conversationId, graphId) };
  }

  async send(input: SendInput): Promise<SendResult> {
    let draft: { graphId: string; conversationId?: string };
    try {
      draft = await this.create(input);
    } catch (error) {
      // Nothing was sent: the message, its files or the draft was refused, or Graph did not answer.
      const code = error instanceof ProviderError ? error.code : (error as { code?: string })?.code ?? "provider_unavailable";
      const status = error instanceof ProviderError ? error.status : (error as { status?: number })?.status ?? 503;
      throw new NotSentError(code, status);
    }
    return this.sendExisting(draft.graphId, draft.conversationId, true);
  }

  async createDraft(input: SendInput) {
    const draft = await this.create(input);
    const id = await this.remember(draft.graphId);
    return { draftId: id, id, threadId: await threadOf(draft.conversationId, draft.graphId) };
  }

  /** A draft's properties now; one that was sent or deleted is `draft_not_found`. */
  private async draftMeta(draftId: string): Promise<{ graphId: string; meta: GraphMessage }> {
    const graphId = await this.remote(draftId, "draft_not_found");
    let meta: GraphMessage;
    try { meta = await this.graph.json<GraphMessage>(`/me/messages/${enc(graphId)}?$select=${MESSAGE_FIELDS}`); }
    catch (error) { if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("draft_not_found", 404); throw error; }
    if (!meta.isDraft) throw new ProviderError("draft_not_found", 404);
    return { graphId, meta };
  }
  private async files(graphId: string, has: boolean | undefined): Promise<GraphAttachment[]> {
    if (!has) return [];
    return (await this.graph.json<{ value?: GraphAttachment[] }>(`/me/messages/${enc(graphId)}/attachments?$select=id,name,contentType,size,isInline`)).value ?? [];
  }
  private async view(id: string, meta: GraphMessage, attachments: GraphAttachment[], mime: Uint8Array | null): Promise<DraftView> {
    const m = await messageWithBody(this.account.id, meta, "drafts", mime, attachments);
    return {
      draftId: id, revision: await revisionOf(meta.changeKey), messageId: id, threadId: m.threadId,
      to: addresses(meta.toRecipients).join(", "), cc: addresses(meta.ccRecipients).join(", ") || null, bcc: addresses(meta.bccRecipients).join(", ") || null,
      subject: m.subject, date: new Date(Date.parse(meta.lastModifiedDateTime ?? "") || m.timestamp || Date.now()).toISOString(),
      inReplyTo: m.inReplyTo || null, references: m.references || null, snippet: m.snippet,
      attachments: m.attachments.map((a) => ({ id: a.providerAttachmentId, filename: a.filename, mimetype: a.mimeType, size: a.size })),
      ...(mime ? { text: m.text, html: m.html } : {}),
    };
  }

  async listDrafts(cursor?: string) {
    if (cursor !== undefined && !/^\d{1,6}$/.test(cursor)) throw new ProviderError("invalid_filter", 400);
    const skip = Number(cursor ?? 0);
    const page = await this.graph.json<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(
      `/me/mailFolders/drafts/messages?$select=${MESSAGE_FIELDS},lastModifiedDateTime&$top=25&$skip=${skip}&$orderby=lastModifiedDateTime%20desc`);
    const drafts: DraftView[] = [];
    for (const meta of page.value ?? []) {
      if (!meta.id) continue;
      const id = await this.remember(meta.id);
      drafts.push(await this.view(id, meta, await this.files(meta.id, meta.hasAttachments).catch(() => []), null));
    }
    return { drafts, nextCursor: page["@odata.nextLink"] ? String(skip + (page.value?.length ?? 0)) : null };
  }

  async getDraft(draftId: string) {
    const { graphId, meta } = await this.draftMeta(draftId);
    const mime = await this.graph.bytes(`/me/messages/${enc(graphId)}/$value`, MAX_MESSAGE_BYTES);
    return this.view(draftId, meta, await this.files(graphId, meta.hasAttachments), mime);
  }

  async draftRevision(draftId: string) {
    return revisionOf((await this.draftMeta(draftId)).meta.changeKey);
  }

  async updateDraft(draftId: string, update: DraftUpdate) {
    const { expectedRevision, keepAttachments, ...input } = update;
    const { graphId, meta } = await this.draftMeta(draftId);
    if (expectedRevision !== undefined && (await revisionOf(meta.changeKey)) !== expectedRevision) throw new ProviderError("draft_conflict", 409);
    const added = validateAttachments(input.attachments);
    // The same checks a send makes (addresses, header characters, sizes) before anything changes.
    rawMime(this.account.email, { ...input, attachments: [] });
    await this.graph.json(`/me/messages/${enc(graphId)}`, { method: "PATCH", json: {
      subject: input.subject,
      body: input.html !== undefined ? { contentType: "html", content: input.html } : { contentType: "text", content: input.text },
      toRecipients: recipients(input.to), ccRecipients: recipients(input.cc), bccRecipients: recipients(input.bcc),
    } });
    if (keepAttachments !== undefined) {
      const keep = new Set(keepAttachments);
      for (const file of await this.files(graphId, true)) {
        if (!keep.has(attachmentKey(file.id))) await this.graph.send(`/me/messages/${enc(graphId)}/attachments/${enc(file.id)}`, { method: "DELETE" });
      }
    }
    for (const file of added) await this.attach(graphId, file);
    const after = await this.graph.json<GraphMessage>(`/me/messages/${enc(graphId)}?$select=id,changeKey,conversationId`);
    return { draftId, revision: await revisionOf(after.changeKey), messageId: draftId, threadId: await threadOf(after.conversationId ?? meta.conversationId, graphId) };
  }

  async deleteDraft(draftId: string) {
    const { graphId } = await this.draftMeta(draftId);
    try { await this.graph.send(`/me/messages/${enc(graphId)}`, { method: "DELETE" }); }
    catch (error) { if (error instanceof ProviderError && error.code === "not_found") throw new ProviderError("draft_not_found", 404); throw error; }
    await this.store.delete(`gid:${this.account.id}:${draftId}`);
  }

  /** Sends the draft as Graph holds it (its recipients, text, quote and files); Graph moves it to Sent Items. */
  async sendDraft(draftId: string): Promise<SendResult> {
    const { graphId, meta } = await this.draftMeta(draftId);
    if (!meta.toRecipients?.length && !meta.ccRecipients?.length && !meta.bccRecipients?.length) throw new NotSentError("invalid_message", 400);
    return this.sendExisting(graphId, meta.conversationId, false);
  }
}
