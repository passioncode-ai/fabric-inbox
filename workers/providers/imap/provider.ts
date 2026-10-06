/**
 * IMAP and SMTP with an app password as a `MailProvider` (provider.ts), for `imap:<id>` accounts:
 * iCloud, Yahoo, AOL, Fastmail, Zoho, Yandex, Mail.ru, GMX, Gmail with an app password, or any
 * server the person names (presets.ts).
 *
 * - Receiving: imapflow over TLS (client.ts); the sync is sync.ts; a session holds one connection,
 *   opened on first use and logged out on `close()` — after each tick and each action, no IDLE.
 * - Sending: the SMTP client (smtp.ts) over Worker sockets; the copy in Sent is appended here unless
 *   the provider keeps it itself, and only when Sent does not already have it.
 * - Drafts: the account's Drafts folder. A draft keeps one id for its life (its first message's
 *   id); each save appends the new version and deletes the old one, and the draft's revision is
 *   its current message's id.
 * - Credentials: the app password, sealed (credentials.ts); a refused login during sync or an
 *   action is `reconnect_required` — the person enters a new password in Settings → Accounts.
 */
import PostalMime from "postal-mime";
import { validateAttachments, type MailAttachment } from "../../../shared/mail/attachments";
import { ProviderError, rawMime, type Message, type SendInput } from "../gmail-client";
import type { GmailCache, StoredMessage } from "../gmail-cache";
import type { Store } from "../google-oauth";
import { hasCredentialKey, type CredentialEnvironment } from "../credentials";
import { NotSentError, type DraftUpdate, type DraftView, type MailProvider, type MessageChange, type PageResult, type ProviderCapabilities, type ProviderSession, type SendResult } from "../provider";
import { ImapConnection, TLS_TRANSPORT, type ImapTransport } from "./client";
import { attachmentFromRaw, labelsFor, messageFromRaw, messageKey, parseMessageKey, rawHeaders, threadKey } from "./mime";
import { preset, presetName } from "./presets";
import { sendSmtp, verifySmtp } from "./smtp";
import { cloudflareSockets, type SocketFactory } from "./sockets";
import { ImapSync, mapFolders } from "./sync";
import type { FolderRole, FolderState, ImapAccount, ImapCredentials, ServerSettings } from "./types";

/** How the provider reaches servers; the tests replace both with in-process fakes. */
export interface ImapDeps {
  transport?: ImapTransport;
  sockets?: SocketFactory;
}
/** A message larger than this is not downloaded to be read here (Gmail's own limit is 25 MB). */
const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
/** Login failures that only the person can fix. */
const LOGIN_CODES = new Set(["auth_failed", "app_password_required", "imap_disabled", "auth_or_imap_disabled", "web_login_required"]);

const smtpOptions = (server: ServerSettings, password: string, sockets: SocketFactory, email: string) => ({
  host: server.smtp.host, port: server.smtp.port, security: server.smtp.security, user: server.smtpUser, password, socket: sockets,
  clientName: email.split("@").pop() || undefined,
});

/** An RFC 5322 date, as the Date header carries it. */
function rfc2822(d: Date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export class ImapProvider implements MailProvider<ImapAccount> {
  readonly id = "imap" as const;
  readonly transport: ImapTransport;
  readonly sockets: SocketFactory;
  private syncer: ImapSync;
  constructor(private store: Store, private cache: GmailCache, private env: CredentialEnvironment, deps: ImapDeps = {}) {
    this.transport = deps.transport ?? TLS_TRANSPORT;
    this.sockets = deps.sockets ?? cloudflareSockets;
    this.syncer = new ImapSync(store, cache);
  }
  configured() {
    return hasCredentialKey(this.env);
  }
  presetName(id?: string) {
    return presetName(id);
  }
  capabilities(account: ImapAccount): ProviderCapabilities {
    const has = (role: FolderRole) => account.sync.folders.some((f) => f.role === role) || !!account.sync.targets?.[role];
    return {
      organization: "folders", threads: "headers", drafts: has("drafts"), archive: has("archive"), spam: has("junk"), trash: has("trash"),
      search: "cache", sentCopy: preset(account.preset)?.sentCopy === "provider" ? "provider" : "server", auth: "app-password", delivery: "poll",
    };
  }
  pending(account: ImapAccount) {
    return account.sync.mode === "initial" || !!account.sync.more;
  }
  progress(account: ImapAccount) {
    const { mode, total, imported } = account.sync;
    if (mode !== "initial" || !total) return undefined;
    return Math.min(99, Math.floor(((imported ?? 0) / total) * 100));
  }
  restartSync(account: ImapAccount) {
    account.sync = { mode: "initial", folders: account.sync.folders.map((f) => ({ role: f.role, path: f.path, uidValidity: 0, top: 0, known: 0 })), targets: account.sync.targets };
  }
  /** An app password cannot be revoked from here: the person deletes it at the provider. */
  async revoke() {
    return false;
  }
  async open(account: ImapAccount, credentials: unknown): Promise<ProviderSession> {
    return new ImapSession(account, (credentials as ImapCredentials).password, this, this.store, this.cache, this.syncer);
  }

  /**
   * Checks the settings the person gave: an IMAP login and the folder list, then an SMTP login.
   * Throws ProviderError with what went wrong (wrong password, IMAP off, TLS, server out of reach).
   * iCloud's IMAP takes the name before @ (Apple's page); the whole address is tried when it is refused.
   */
  async verify(settings: ServerSettings, password: string, email: string) {
    const attempt = (user: string) => ImapConnection.connect({ host: settings.imap.host, port: settings.imap.port, user, password }, this.transport);
    let conn: ImapConnection;
    let imapUser = settings.imapUser;
    try {
      conn = await attempt(imapUser);
    } catch (error) {
      if (!(error instanceof ProviderError && error.code === "auth_failed" && imapUser !== email)) throw error;
      conn = await attempt(email);
      imapUser = email;
    }
    let folders;
    try {
      folders = mapFolders(await conn.folders());
      // Sign-in alone does not prove the mailbox can be read: open the Inbox once.
      await conn.open(folders.roles.inbox ?? "INBOX");
    } finally {
      await conn.close();
    }
    try {
      await verifySmtp(smtpOptions(settings, password, this.sockets, email));
    } catch (error) {
      if (error instanceof NotSentError) throw new ProviderError(error.code, error.status);
      throw error;
    }
    return { settings: { ...settings, imapUser }, folders, condstore: conn.capabilities.has("CONDSTORE") };
  }
}

class ImapSession implements ProviderSession {
  private conn?: ImapConnection;
  private connecting?: Promise<ImapConnection>;
  constructor(private account: ImapAccount, private password: string, private provider: ImapProvider, private store: Store, private cache: GmailCache, private syncer: ImapSync) {}

  /** The session's connection, opened on first use. A refused login is the person's to fix. */
  private async connection(): Promise<ImapConnection> {
    if (this.conn?.usable) return this.conn;
    this.connecting ??= ImapConnection.connect({ host: this.account.server.imap.host, port: this.account.server.imap.port, user: this.account.server.imapUser, password: this.password }, this.provider.transport)
      .catch((error) => {
        delete this.connecting;
        if (error instanceof ProviderError && LOGIN_CODES.has(error.code)) throw new ProviderError("reconnect_required", 401);
        if (error instanceof ProviderError && (error.code === "host_unreachable" || error.code === "tls_failed")) throw new ProviderError("provider_unavailable", 503);
        throw error;
      });
    this.conn = await this.connecting;
    delete this.connecting;
    return this.conn;
  }
  async close() {
    await this.conn?.close();
    delete this.conn;
  }

  async syncPage(record: unknown, kind: "history" | "import", deadline: number): Promise<PageResult> {
    const account = record as ImapAccount;
    this.account = account;
    const conn = await this.connection();
    return kind === "history" ? this.syncer.historyPage(account, conn, deadline) : this.syncer.importPage(account, conn, deadline);
  }

  private folder(role: FolderRole): FolderState | undefined {
    return this.account.sync.folders.find((f) => f.role === role);
  }
  /** The folder and UID of a message id, checked against the folder's current UIDVALIDITY. */
  private async locate(messageId: string) {
    const key = parseMessageKey(messageId);
    const folder = key && this.folder(key.role);
    if (!key || !folder) throw new ProviderError("message_not_found", 404);
    const conn = await this.connection();
    const opened = await conn.open(folder.path, true);
    if (opened.uidValidity !== key.uidValidity) throw new ProviderError("message_not_found", 404);
    return { conn, folder, uid: key.uid, uidValidity: key.uidValidity, role: key.role };
  }
  private async source(messageId: string) {
    const at = await this.locate(messageId);
    const [head] = await at.conn.fetch(String(at.uid), {});
    if (!head) throw new ProviderError("message_not_found", 404);
    if ((head.size ?? 0) > MAX_MESSAGE_BYTES) throw new ProviderError("message_too_large", 413);
    const [row] = await at.conn.fetch(String(at.uid), { source: true });
    if (!row?.source) throw new ProviderError("message_not_found", 404);
    return { ...at, row };
  }

  async message(messageId: string): Promise<Message> {
    const at = await this.source(messageId);
    return messageFromRaw(at.row.source!, { accountId: this.account.id, role: at.role, uidValidity: at.uidValidity, uid: at.uid, flags: at.row.flags, internalDate: at.row.internalDate, size: at.row.size }, true);
  }

  /** The cached copy with new labels (and a new id after a move), its body kept; or the message read again. */
  private async fromCache(oldId: string, next: { id: string; role: FolderRole; flags: string[] }): Promise<Message & { bodyless?: boolean }> {
    const row = await this.cache.row(this.account.id, oldId) as StoredMessage | undefined;
    if (!row) return this.message(next.id);
    const labels = labelsFor(next.role, next.flags);
    const body = row.bodyless ? { text: "", html: "" } : await this.cache.body(this.account.id, oldId, row);
    return { ...row.message, ...body, id: this.account.id + ":" + next.id, providerMessageId: next.id, labels, read: !labels.includes("UNREAD"), archived: !labels.includes("INBOX"),
      ...(row.bodyless ? { bodyless: true } : {}) };
  }

  async change(messageId: string, change: MessageChange): Promise<(Message & { bodyless?: boolean }) | null> {
    const at = await this.locate(messageId);
    if ("read" in change || "starred" in change) {
      const flag = "read" in change ? "\\Seen" : "\\Flagged";
      const on = "read" in change ? change.read : change.starred;
      await at.conn.setFlags(at.uid, on ? [flag] : [], on ? [] : [flag]);
      const [now] = await at.conn.fetch(String(at.uid), {});
      if (!now) throw new ProviderError("message_not_found", 404);
      return this.fromCache(messageId, { id: messageId, role: at.role, flags: now.flags });
    }
    const target: FolderRole = "trashed" in change ? (change.trashed ? "trash" : "inbox")
      : "archive" in change ? "archive" : "inbox" in change ? "inbox" : change.spam ? "junk" : "inbox";
    if (target === at.role) return this.fromCache(messageId, { id: messageId, role: at.role, flags: (await at.conn.fetch(String(at.uid), {}))[0]?.flags ?? [] });
    const destination = this.folder(target)?.path ?? this.account.sync.targets?.[target];
    if (!destination) throw new ProviderError("not_supported", 400);
    // The Message-ID finds the message in its new folder when the server does not say its new UID.
    const cached = await this.cache.row(this.account.id, messageId) as StoredMessage | undefined;
    let rfcId = cached?.message.rfcMessageId;
    if (!rfcId) {
      const [head] = await at.conn.fetch(String(at.uid), { headers: true });
      rfcId = head?.headers ? (await rawHeaders(head.headers)).find((h) => h.key.toLowerCase() === "message-id")?.value : undefined;
    }
    const [before] = await at.conn.fetch(String(at.uid), {});
    let newUid = await at.conn.move(at.uid, destination);
    const dest = this.folder(target);
    // Moved to a folder this server does not read (Gmail's All Mail): it leaves the cache.
    if (!dest) return null;
    const opened = await at.conn.open(dest.path, true);
    if (!newUid && rfcId) newUid = (await at.conn.findMessageId(rfcId)).sort((x, y) => y - x)[0];
    // Not found (no UIDPLUS and no Message-ID): the next sync reads it in its new folder.
    if (!newUid) return null;
    const [now] = await at.conn.fetch(String(newUid), {});
    return this.fromCache(messageId, { id: messageKey(target, opened.uidValidity, newUid), role: target, flags: now?.flags ?? before?.flags ?? [] });
  }

  async attachment(messageId: string, attachmentId: string) {
    const at = await this.source(messageId);
    const file = await attachmentFromRaw(at.row.source!, attachmentId);
    if (!file) throw new ProviderError("attachment_not_found", 404);
    return file;
  }
  async headers(messageId: string) {
    const at = await this.locate(messageId);
    const [row] = await at.conn.fetch(String(at.uid), { headers: true });
    if (!row?.headers) throw new ProviderError("message_not_found", 404);
    return rawHeaders(row.headers);
  }

  /** The message as it is sent and as it is kept: Date and Message-ID added, Bcc only in the kept copy. */
  private compose(input: SendInput) {
    const date = new Date();
    const domain = this.account.email.split("@").pop() || "fabric-inbox.invalid";
    const rfcId = `<${crypto.randomUUID()}@${domain}>`;
    const headers = [`Date: ${rfc2822(date)}`, `Message-ID: ${rfcId}`];
    return {
      date, rfcId,
      kept: rawMime(this.account.email, input, headers),
      wire: rawMime(this.account.email, input, headers, { omitBcc: true }),
      threadId: threadKey(input.references, input.inReplyTo, rfcId, rfcId),
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    const m = this.compose(input);
    const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
    await sendSmtp(smtpOptions(this.account.server, this.password, this.provider.sockets, this.account.email), { from: this.account.email, recipients }, m.wire);
    console.log(JSON.stringify({ event: "imap_sent", recipients: recipients.length }));
    // Accepted. The copy in Sent is a courtesy that must never turn a sent message into a failure.
    const id = await this.keepSent(m.kept, m.rfcId, m.date).catch((error) => {
      console.warn(JSON.stringify({ event: "imap_sent_copy_failed", error: error instanceof ProviderError ? error.code : "unknown" }));
      return undefined;
    });
    return { id: id ?? m.rfcId.slice(1, -1), threadId: m.threadId };
  }

  /** Appends the sent message to Sent unless the provider keeps it or already has it. Returns its id when known. */
  private async keepSent(raw: string, rfcId: string, date: Date): Promise<string | undefined> {
    const sent = this.folder("sent");
    if (!sent || this.provider.capabilities(this.account).sentCopy === "provider") return undefined;
    const conn = await this.connection();
    const opened = await conn.open(sent.path, true);
    const already = await conn.findMessageId(rfcId);
    if (already.length) return messageKey("sent", opened.uidValidity, already[0]!);
    const appended = await conn.append(sent.path, raw, ["\\Seen"], date);
    return appended.uid ? messageKey("sent", appended.uidValidity ?? opened.uidValidity, appended.uid) : undefined;
  }

  // ── Drafts: the account's Drafts folder ──
  private drafts() {
    const f = this.folder("drafts");
    if (!f) throw new ProviderError("not_supported", 400);
    return f;
  }
  /** The current message id of a draft (it changes on each save); the draft id itself never does. */
  private async current(draftId: string) {
    const mapped = await this.store.get<string>(`draft:${this.account.id}:${draftId}`);
    return mapped ?? draftId;
  }
  private async draftIdOf(messageId: string) {
    return (await this.store.get<string>(`draft:${this.account.id}:of:${messageId}`)) ?? messageId;
  }
  private async remember(draftId: string, messageId: string, previous?: string) {
    await this.store.transaction(async (tx) => {
      await tx.put(`draft:${this.account.id}:${draftId}`, messageId);
      await tx.put(`draft:${this.account.id}:of:${messageId}`, draftId);
      if (previous && previous !== messageId) await tx.delete(`draft:${this.account.id}:of:${previous}`);
    });
  }
  private async forget(draftId: string, messageId: string) {
    await this.store.delete(`draft:${this.account.id}:${draftId}`);
    await this.store.delete(`draft:${this.account.id}:of:${messageId}`);
  }
  private async appendDraft(input: SendInput) {
    const folder = this.drafts();
    const m = this.compose(input);
    const conn = await this.connection();
    const opened = await conn.open(folder.path, true);
    const appended = await conn.append(folder.path, m.kept, ["\\Draft", "\\Seen"], m.date);
    let uid = appended.uid;
    if (!uid) { await conn.open(folder.path, true); uid = (await conn.findMessageId(m.rfcId))[0]; }
    if (!uid) throw new ProviderError("provider_failed", 502);
    return { id: messageKey("drafts", appended.uidValidity ?? opened.uidValidity, uid), threadId: m.threadId };
  }
  private async view(messageId: string, withBody: boolean): Promise<DraftView> {
    const m = await this.message(messageId);
    return {
      draftId: await this.draftIdOf(messageId), revision: messageId, messageId, threadId: m.threadId,
      to: m.to, cc: m.cc || null, bcc: m.bcc || null, subject: m.subject, date: m.timestamp ? new Date(m.timestamp).toISOString() : m.date,
      inReplyTo: m.inReplyTo || null, references: m.references || null, snippet: m.snippet,
      attachments: m.attachments.map((a) => ({ id: a.providerAttachmentId, filename: a.filename, mimetype: a.mimeType, size: a.size })),
      ...(withBody ? { text: m.text, html: m.html } : {}),
    };
  }
  async createDraft(input: SendInput) {
    const saved = await this.appendDraft(input);
    await this.remember(saved.id, saved.id);
    return { draftId: saved.id, id: saved.id, threadId: saved.threadId };
  }
  async listDrafts(cursor?: string) {
    if (cursor !== undefined) throw new ProviderError("invalid_filter", 400);
    const folder = this.drafts();
    const conn = await this.connection();
    const opened = await conn.open(folder.path);
    if (!opened.exists) return { drafts: [], nextCursor: null };
    const rows = (await conn.fetch(`${Math.max(1, opened.exists - 99)}:${opened.exists}`, { source: true }, { bySeq: true })).filter((r) => !r.flags.some((f) => /\\deleted/i.test(f)));
    const drafts: DraftView[] = [];
    for (const r of rows) {
      if (!r.source || (r.size ?? 0) > MAX_MESSAGE_BYTES) continue;
      const id = messageKey("drafts", opened.uidValidity, r.uid);
      const m = await messageFromRaw(r.source, { accountId: this.account.id, role: "drafts", uidValidity: opened.uidValidity, uid: r.uid, flags: r.flags, internalDate: r.internalDate, size: r.size }, true);
      drafts.push({ draftId: await this.draftIdOf(id), revision: id, messageId: id, threadId: m.threadId, to: m.to, cc: m.cc || null, bcc: m.bcc || null, subject: m.subject,
        date: m.timestamp ? new Date(m.timestamp).toISOString() : m.date, inReplyTo: m.inReplyTo || null, references: m.references || null, snippet: m.snippet,
        attachments: m.attachments.map((a) => ({ id: a.providerAttachmentId, filename: a.filename, mimetype: a.mimeType, size: a.size })) });
    }
    drafts.sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0));
    return { drafts, nextCursor: null };
  }
  private async existing(draftId: string) {
    const id = await this.current(draftId);
    try { await this.locate(id); }
    catch (error) { if (error instanceof ProviderError && error.code === "message_not_found") throw new ProviderError("draft_not_found", 404); throw error; }
    const [row] = await (await this.connection()).fetch(String(parseMessageKey(id)!.uid), {});
    if (!row || row.flags.some((f) => /\\deleted/i.test(f))) throw new ProviderError("draft_not_found", 404);
    return id;
  }
  async getDraft(draftId: string) {
    return this.view(await this.existing(draftId), true);
  }
  async draftRevision(draftId: string) {
    return this.existing(draftId);
  }
  async updateDraft(draftId: string, request: DraftUpdate) {
    const { expectedRevision, keepAttachments, ...input } = request;
    const current = await this.existing(draftId);
    if (expectedRevision !== undefined && current !== expectedRevision) throw new ProviderError("draft_conflict", 409);
    // The new version is whole: the files kept are read from the current one and written again.
    const keep = keepAttachments === undefined ? null : new Set(keepAttachments);
    const kept: MailAttachment[] = [];
    const old = await this.message(current);
    for (const f of old.attachments) {
      if (keep && !keep.has(f.providerAttachmentId)) continue;
      const file = await this.attachment(current, f.providerAttachmentId);
      const data = file.data.replace(/-/g, "+").replace(/_/g, "/");
      kept.push({ content: data + "=".repeat((4 - (data.length % 4)) % 4), filename: f.filename || "attachment", type: f.mimeType || "application/octet-stream", disposition: "attachment" });
    }
    const files = validateAttachments([...kept, ...validateAttachments(input.attachments)]);
    const saved = await this.appendDraft({ ...input, attachments: files });
    await this.remember(draftId, saved.id, current);
    // The old version goes only after the new one is safely there.
    const at = await this.locate(current).catch(() => null);
    if (at) await at.conn.remove(at.uid);
    return { draftId, revision: saved.id, messageId: saved.id, threadId: saved.threadId };
  }
  async deleteDraft(draftId: string) {
    const current = await this.existing(draftId);
    const at = await this.locate(current);
    await at.conn.remove(at.uid);
    await this.forget(draftId, current);
  }
  /** Sends the draft as it is kept: its recipients, text, quote and files; then it leaves Drafts. */
  async sendDraft(draftId: string): Promise<SendResult> {
    const current = await this.existing(draftId);
    const at = await this.source(current);
    const parsed = await new PostalMime({ attachmentEncoding: "base64" }).parse(at.row.source!);
    const list = (a: typeof parsed.to) => (a ?? []).flatMap((x) => (x.address ? [x.address] : (x.group ?? []).map((g) => g.address))).filter(Boolean);
    const input: SendInput = {
      to: list(parsed.to), cc: list(parsed.cc), bcc: list(parsed.bcc), subject: parsed.subject ?? "", text: parsed.text ?? "",
      ...(parsed.html ? { html: parsed.html } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo.trim() } : {}), ...(parsed.references ? { references: parsed.references.replace(/\s+/g, " ").trim() } : {}),
      attachments: parsed.attachments.map((a) => {
        const cid = a.contentId?.replace(/^<|>$/g, "");
        return { content: String(a.content), filename: a.filename || "attachment", type: a.mimeType || "application/octet-stream",
          ...(a.disposition === "inline" && cid ? { disposition: "inline" as const, contentId: cid } : { disposition: "attachment" as const }) };
      }),
    };
    if (!input.to.length) throw new NotSentError("invalid_message", 400);
    const sent = await this.send(input);
    // Sent: the draft goes. A failure here leaves a draft of a message that went; it is logged, not unsent.
    try {
      const again = await this.locate(current);
      await again.conn.remove(again.uid);
      await this.forget(draftId, current);
    } catch (error) {
      console.warn(JSON.stringify({ event: "imap_draft_cleanup_failed", error: error instanceof ProviderError ? error.code : "unknown" }));
    }
    return sent;
  }
}
