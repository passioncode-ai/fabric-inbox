/**
 * Microsoft's identity platform and Microsoft Graph as one in-process `fetch`, enough for what this
 * server asks of an Outlook account, answering as the documented contracts do (read 2026-10-06):
 *
 * - token endpoint: authorization_code (with PKCE) and refresh_token grants; the refresh token is
 *   rotated on every refresh (`rotate`); refusals as `{ error, error_description: "AADSTS…" }`.
 * - `/me`, `/me/mailFolders/{well-known}`, message delta per folder (`Prefer: odata.maxpagesize`,
 *   `@odata.nextLink` / `@odata.deltaLink`, `@removed`, 410 Gone on a reset), a folder's messages,
 *   one message (`$select`, `$value`, its attachments and their `$value`), PATCH, move, DELETE,
 *   MIME drafts (`POST /me/messages`, text/plain base64), attachments (one POST, or an upload
 *   session with ranges to a pre-authenticated URL), send (202), the Drafts folder listed.
 * - ids are immutable only when the request says `Prefer: IdType="ImmutableId"`; otherwise a moved
 *   message gets a new id, as Graph's default ids do. Ids are about 150 characters with `=` and `-`.
 * - throttling: any request matching a rule answers 429 (or 503) with Retry-After, `times` times.
 *
 * Everything the server sent is recorded (`requests`), with bodies; no real credential appears here:
 * secrets and codes are made-up words built at run time.
 */
import PostalMime from "postal-mime";

export interface FakeMail {
  id: string;
  folder: string;
  subject: string;
  from: { name: string; address: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  received: string;
  isRead: boolean;
  flagged: boolean;
  isDraft: boolean;
  conversationId: string;
  internetMessageId: string;
  mime: string;
  attachments: { id: string; name: string; contentType: string; bytes: Uint8Array; isInline: boolean; type?: string }[];
  headers: { name: string; value: string }[];
  changeKey: number;
  /** The change sequence of the last change; the folder it was in before its last move. */
  seq: number;
}

export interface Throttle { match: RegExp; times: number; status?: 429 | 503; retryAfter: string }
export interface FakeGraphOptions {
  /** Answer refresh grants with a new refresh token every time (Microsoft may rotate it). */
  rotate?: boolean;
  /** What the token endpoint says to the next refresh: an error to return instead of tokens. */
  refreshError?: { status: number; error: string; description?: string };
  /** What the token endpoint says to the code redemption. */
  codeError?: { status: number; error: string; description?: string };
  /** The scopes granted (Microsoft answers full Graph URIs). */
  scope?: string;
  /** No refresh token in the code's answer (offline_access not granted). */
  noRefreshToken?: boolean;
  /** The account has no Outlook mailbox (a Microsoft account without Outlook.com). */
  noMailbox?: boolean;
  /** No Archive folder yet. */
  noArchive?: boolean;
}

const FOLDERS = ["inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive"] as const;
const json = (x: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json", ...headers } });
const graphError = (status: number, code: string) => json({ error: { code, message: "fake" } }, status);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let counter = 0;
/** A Graph-shaped id: long, with '-' and '=' (as Exchange ids are), unique per call. */
export function graphId(kind = "msg") {
  counter++;
  return "AAMkAD" + Buffer.from(`${kind}-${counter}-${"x".repeat(80)}-${Math.random()}`).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 140) + "=";
}

export class FakeGraph {
  options: FakeGraphOptions;
  mails = new Map<string, FakeMail>();
  /** Messages that were deleted for good, with the sequence they left at and the folder they left. */
  gone: { id: string; folder: string; seq: number }[] = [];
  /** Moves out of a folder: folder → [{ id, seq }]. */
  movedOut: { id: string; folder: string; seq: number }[] = [];
  folderIds: Record<string, string> = {};
  seq = 1;
  requests: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  throttles: Throttle[] = [];
  /** Folders whose next delta request answers 410 Gone. */
  resetNext = new Set<string>();
  /** Every valid refresh token (a rotated one replaces the old). */
  refreshTokens = new Set<string>();
  accessTokens = new Set<string>();
  sent: FakeMail[] = [];
  uploads = new Map<string, { message: string; name: string; size: number; contentType: string; isInline: boolean; got: Uint8Array[] }>();
  /** The answer to `/me`. */
  me = { id: "user-1", mail: "ann@outlook.example" as string | null, userPrincipalName: "ann@outlook.example" };
  codes = new Set<string>();
  verifierOf = new Map<string, string>();

  constructor(options: FakeGraphOptions = {}) {
    this.options = options;
    for (const f of FOLDERS) this.folderIds[f] = graphId("folder-" + f);
  }

  /** A sign-in code Microsoft would redirect with, for a given PKCE verifier challenge. */
  issueCode(challenge?: string) {
    const code = "code-" + Math.random().toString(36).slice(2);
    this.codes.add(code);
    if (challenge) this.verifierOf.set(code, challenge);
    return code;
  }

  /** New mail in a folder (the newest received last unless a date is given). */
  deliver(subject: string, o: Partial<Omit<FakeMail, "id" | "subject">> & { folder?: string; body?: string; attach?: { name: string; contentType: string; bytes: Uint8Array }[] } = {}): FakeMail {
    const id = graphId();
    const internetMessageId = `<${subject.replace(/\W/g, "")}.${counter}@example.org>`;
    const received = o.received ?? new Date(Date.UTC(2026, 9, 5, 10, 0, 0) + counter * 60_000).toISOString();
    const from = o.from ?? { name: "Bob", address: "bob@example.org" };
    const mime = o.mime ?? [`From: ${from.name} <${from.address}>`, `To: ${(o.to ?? [this.me.mail]).join(", ")}`, `Subject: ${subject}`, `Message-ID: ${internetMessageId}`,
      `Date: ${new Date(received).toUTCString()}`, "List-Id: <news.example.org>", "Content-Type: text/plain; charset=utf-8", "", o.body ?? `Hello, ${subject}`, ""].join("\r\n");
    const mail: FakeMail = {
      id, folder: o.folder ?? "inbox", subject, from, to: o.to ?? [this.me.mail!], cc: o.cc, bcc: o.bcc, received, isRead: o.isRead ?? false, flagged: o.flagged ?? false,
      isDraft: o.isDraft ?? false, conversationId: o.conversationId ?? graphId("conv"), internetMessageId, mime,
      attachments: (o.attach ?? []).map((a) => ({ id: graphId("att"), name: a.name, contentType: a.contentType, bytes: a.bytes, isInline: false })),
      headers: [{ name: "Received", value: "from example.org" }, { name: "List-Id", value: "<news.example.org>" }, { name: "Message-ID", value: internetMessageId }],
      changeKey: 1, seq: this.seq++,
    };
    this.mails.set(id, mail);
    return mail;
  }
  touch(mail: FakeMail) { mail.changeKey++; mail.seq = this.seq++; }
  /** Another mail app moves a message (its immutable id stays). */
  move(mail: FakeMail, folder: string) { this.movedOut.push({ id: mail.id, folder: mail.folder, seq: this.seq }); mail.folder = folder; this.touch(mail); }
  /** Another mail app deletes a message for good. */
  purge(mail: FakeMail) { this.gone.push({ id: mail.id, folder: mail.folder, seq: this.seq++ }); this.mails.delete(mail.id); }
  folderOf(id: string) { return Object.entries(this.folderIds).find(([, v]) => v === id)?.[0]; }

  private view(m: FakeMail, select?: string[]) {
    const all: Record<string, unknown> = {
      id: m.id, conversationId: m.conversationId, parentFolderId: this.folderIds[m.folder], subject: m.subject, from: { emailAddress: m.from }, sender: { emailAddress: m.from },
      toRecipients: m.to.map((address) => ({ emailAddress: { address, name: address } })), ccRecipients: (m.cc ?? []).map((address) => ({ emailAddress: { address } })),
      bccRecipients: (m.bcc ?? []).map((address) => ({ emailAddress: { address } })), replyTo: [], receivedDateTime: m.received, sentDateTime: m.received,
      lastModifiedDateTime: m.received, isRead: m.isRead, isDraft: m.isDraft, flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" }, hasAttachments: m.attachments.some((a) => !a.isInline) || m.attachments.length > 0,
      internetMessageId: m.internetMessageId, bodyPreview: m.mime.split("\r\n\r\n")[1]?.slice(0, 100) ?? "", changeKey: "CQAAAB" + m.changeKey + "==",
      internetMessageHeaders: m.isDraft || m.folder === "sentitems" ? [] : m.headers,
    };
    if (!select) { delete all.internetMessageHeaders; return all; }
    return Object.fromEntries(Object.entries(all).filter(([k]) => k === "id" || select.includes(k)));
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : init.body instanceof Uint8Array ? `<${init.body.byteLength} bytes>` : undefined;
    this.requests.push({ method, url: url.href, headers, body });
    for (const t of this.throttles) {
      if (t.times > 0 && t.match.test(method + " " + url.pathname + url.search)) {
        t.times--;
        return json({ error: { code: "TooManyRequests", message: "Please retry again later." } }, t.status ?? 429, { "Retry-After": t.retryAfter });
      }
    }
    if (url.hostname === "login.microsoftonline.com") return this.token(url, method, body ?? "");
    if (url.hostname === "outlook.office.com") return this.uploadRange(url, method, headers, init.body as Uint8Array);
    if (url.hostname !== "graph.microsoft.com") throw new TypeError("fake network: " + url.href);
    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.accessTokens.has(token)) return graphError(401, "InvalidAuthenticationToken");
    const immutable = /IdType="ImmutableId"/.test(headers.prefer ?? "");
    return this.graph(url, method, headers, body, immutable, init.body);
  };

  private token(url: URL, method: string, body: string): Response {
    if (method !== "POST" || !url.pathname.endsWith("/oauth2/v2.0/token")) return new Response("<html>", { status: 404 });
    const form = new URLSearchParams(body);
    const fail = (e: { status: number; error: string; description?: string }) => json({ error: e.error, error_description: e.description ?? `${e.error}: fake`, error_codes: [] }, e.status);
    const tokens = (refresh: boolean) => {
      const access = "access-" + Math.random().toString(36).slice(2);
      this.accessTokens.add(access);
      const out: Record<string, unknown> = { token_type: "Bearer", expires_in: 3599, access_token: access,
        scope: this.options.scope ?? "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read" };
      if (refresh) {
        const next = "refresh-" + Math.random().toString(36).slice(2);
        this.refreshTokens.add(next);
        out.refresh_token = next;
      }
      return json(out);
    };
    if (form.get("grant_type") === "authorization_code") {
      if (this.options.codeError) return fail(this.options.codeError);
      const code = form.get("code") ?? "";
      if (!this.codes.delete(code)) return fail({ status: 400, error: "invalid_grant", description: "AADSTS54005: code already redeemed" });
      if (!form.get("code_verifier")) return fail({ status: 400, error: "invalid_grant", description: "AADSTS50148: verifier" });
      return tokens(!this.options.noRefreshToken);
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.options.refreshError) return fail(this.options.refreshError);
      const old = form.get("refresh_token") ?? "";
      if (!this.refreshTokens.has(old)) return fail({ status: 400, error: "invalid_grant", description: "AADSTS70000: refresh token not valid" });
      if (this.options.rotate) this.refreshTokens.delete(old);
      const answer = tokens(!!this.options.rotate);
      if (this.options.rotate) return answer;
      return answer;
    }
    return fail({ status: 400, error: "unsupported_grant_type" });
  }

  /** Delta tokens: `f:<folder>:<seq>` (deltaLink) and `s:<folder>:<offset>:<seq>:<initial>` (nextLink). */
  private delta(folder: string, url: URL, headers: Record<string, string>, immutable: boolean): Response {
    if (this.resetNext.delete(folder)) return new Response(null, { status: 410, headers: { Location: url.origin + url.pathname } });
    const size = Number(/odata\.maxpagesize=(\d+)/.exec(headers.prefer ?? "")?.[1] ?? 10);
    const base = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(this.folderIds[folder])}/messages/delta`;
    const skip = url.searchParams.get("$skiptoken"), dt = url.searchParams.get("$deltatoken");
    let since = 0, offset = 0, start = this.seq;
    if (skip) { const [, , o, s, st] = skip.split(":"); offset = Number(o); since = Number(s); start = Number(st); }
    else if (dt) { since = Number(dt.split(":")[2]); start = this.seq; }
    // The round's items: changed since `since` and in the folder now, and @removed for what left it.
    const items: Record<string, unknown>[] = [
      ...[...this.mails.values()].filter((m) => m.folder === folder && m.seq >= since && (since === 0 || m.seq >= since))
        .sort((a, b) => b.received.localeCompare(a.received)).map((m) => this.view(m, MESSAGE_FIELDS)),
      ...(since ? [...this.movedOut.filter((x) => x.folder === folder && x.seq >= since), ...this.gone.filter((x) => x.folder === folder && x.seq >= since)]
        .map((x) => ({ id: x.id, "@removed": { reason: "deleted" } })) : []),
    ];
    void immutable;
    const page = items.slice(offset, offset + size);
    const out: Record<string, unknown> = { value: page };
    if (offset + size < items.length) out["@odata.nextLink"] = `${base}?$skiptoken=s:${folder}:${offset + size}:${since}:${start}`;
    else out["@odata.deltaLink"] = `${base}?$deltatoken=f:${folder}:${start}`;
    return json(out);
  }

  private find(id: string) { return this.mails.get(decodeURIComponent(id)); }

  private async graph(url: URL, method: string, headers: Record<string, string>, body: string | undefined, immutable: boolean, raw: unknown): Promise<Response> {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    const select = url.searchParams.get("$select")?.split(",");
    let m: RegExpExecArray | null;
    if (path === "/me" && method === "GET") return json(this.me);
    if ((m = /^\/me\/mailFolders\/([a-z]+)$/.exec(path)) && method === "GET") {
      if (this.options.noMailbox) return graphError(404, "MailboxNotEnabledForRESTAPI");
      if (m[1] === "archive" && this.options.noArchive) return graphError(404, "ErrorFolderNotFound");
      const id = this.folderIds[m[1]];
      if (!id) return graphError(404, "ErrorFolderNotFound");
      return json({ id, totalItemCount: [...this.mails.values()].filter((x) => x.folder === m![1]).length });
    }
    if ((m = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(path)) && method === "GET") {
      const folder = this.folderOf(m[1]);
      if (!folder) return graphError(404, "ErrorItemNotFound");
      return this.delta(folder, url, headers, immutable);
    }
    if ((m = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(path)) && method === "GET") {
      const folder = this.folderOf(m[1]) ?? m[1];
      const top = Number(url.searchParams.get("$top") ?? 10), skip = Number(url.searchParams.get("$skip") ?? 0);
      const all = [...this.mails.values()].filter((x) => x.folder === folder).sort((a, b) => b.received.localeCompare(a.received));
      const out: Record<string, unknown> = { value: all.slice(skip, skip + top).map((x) => this.view(x, select)) };
      if (skip + top < all.length) out["@odata.nextLink"] = url.href.replace(/\$skip=\d+/, "$skip=" + (skip + top));
      return json(out);
    }
    if (path === "/me/messages" && method === "POST") {
      const mime = Buffer.from(body ?? "", "base64").toString("utf8");
      if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) return graphError(400, "ErrorMimeContentInvalidBase64String");
      const parsed = await new PostalMime().parse(mime);
      const list = (a: typeof parsed.to) => (a ?? []).map((x) => x.address!).filter(Boolean);
      const mail = this.deliver(parsed.subject ?? "", { folder: "drafts", isDraft: true, isRead: true, mime, to: list(parsed.to), cc: list(parsed.cc), bcc: list(parsed.bcc),
        from: { name: "", address: this.me.mail! }, received: new Date().toISOString() });
      mail.internetMessageId = parsed.messageId ?? mail.internetMessageId;
      mail.attachments = parsed.attachments.map((a) => ({ id: graphId("att"), name: a.filename ?? "file", contentType: a.mimeType, bytes: new Uint8Array(a.content as ArrayBuffer), isInline: a.disposition === "inline" }));
      return json(this.view(mail), 201);
    }
    if ((m = /^\/me\/messages\/([^/]+)(\/.*)?$/.exec(path))) {
      const mail = this.find(m[1]);
      const rest = m[2] ?? "";
      if (!mail) return graphError(404, "ErrorItemNotFound");
      if (rest === "" && method === "GET") return json(this.view(mail, select ?? undefined));
      if (rest === "/$value" && method === "GET") return new Response(mail.mime, { status: 200, headers: { "Content-Type": "message/rfc822", "Content-Length": String(Buffer.byteLength(mail.mime)) } });
      if (rest === "" && method === "PATCH") {
        const patch = JSON.parse(body ?? "{}");
        if ("isRead" in patch) mail.isRead = patch.isRead;
        if (patch.flag) mail.flagged = patch.flag.flagStatus === "flagged";
        if ("subject" in patch) mail.subject = patch.subject;
        if (patch.toRecipients) mail.to = patch.toRecipients.map((r: { emailAddress: { address: string } }) => r.emailAddress.address);
        if (patch.ccRecipients) mail.cc = patch.ccRecipients.map((r: { emailAddress: { address: string } }) => r.emailAddress.address);
        if (patch.bccRecipients) mail.bcc = patch.bccRecipients.map((r: { emailAddress: { address: string } }) => r.emailAddress.address);
        if (patch.body) mail.mime = mail.mime.split("\r\n\r\n")[0] + "\r\n\r\n" + patch.body.content;
        this.touch(mail);
        return json(this.view(mail));
      }
      if (rest === "" && method === "DELETE") {
        if (mail.folder === "deleteditems") this.purge(mail); else this.move(mail, "deleteditems");
        return new Response(null, { status: 204 });
      }
      if (rest === "/move" && method === "POST") {
        const { destinationId } = JSON.parse(body ?? "{}");
        const folder = this.folderIds[destinationId] ? destinationId : this.folderOf(destinationId);
        if (!folder || (folder === "archive" && this.options.noArchive)) return graphError(404, "ErrorFolderNotFound");
        this.move(mail, folder);
        if (!immutable) {
          // Without immutable ids, a moved message is a new item with a new id.
          this.mails.delete(mail.id);
          mail.id = graphId();
          this.mails.set(mail.id, mail);
        }
        return json(this.view(mail), 201);
      }
      if (rest === "/send" && method === "POST") {
        if (!mail.isDraft) return graphError(400, "ErrorInvalidRequest");
        if (!mail.to.length && !(mail.cc ?? []).length && !(mail.bcc ?? []).length) return graphError(400, "ErrorInvalidRecipients");
        mail.isDraft = false;
        this.move(mail, "sentitems");
        this.sent.push(mail);
        return new Response(null, { status: 202 });
      }
      if (rest === "/attachments" && method === "GET") return json({ value: mail.attachments.map((a) => ({ "@odata.type": a.type ?? "#microsoft.graph.fileAttachment", id: a.id, name: a.name, contentType: a.contentType, size: a.bytes.length, isInline: a.isInline })) });
      if (rest === "/attachments" && method === "POST") {
        const a = JSON.parse(body ?? "{}");
        const bytes = new Uint8Array(Buffer.from(a.contentBytes, "base64"));
        if (bytes.length >= 3 * 1024 * 1024) return graphError(413, "ErrorRequestEntityTooLarge");
        const att = { id: graphId("att"), name: a.name, contentType: a.contentType, bytes, isInline: !!a.isInline };
        mail.attachments.push(att);
        this.touch(mail);
        return json({ id: att.id }, 201);
      }
      if (rest === "/attachments/createUploadSession" && method === "POST") {
        const item = JSON.parse(body ?? "{}").AttachmentItem;
        if (item.size < 3 * 1024 * 1024) return graphError(400, "ErrorAttachmentSizeShouldNotBeLessThanMinimumSize");
        const session = "sess" + Math.random().toString(36).slice(2);
        this.uploads.set(session, { message: mail.id, name: item.name, size: item.size, contentType: item.contentType, isInline: !!item.isInline, got: [] });
        return json({ uploadUrl: `https://outlook.office.com/api/v2.0/Users('u')/Messages('m')/AttachmentSessions('${session}')?authtoken=made-up`, nextExpectedRanges: ["0-"] }, 201);
      }
      if ((m = /^\/attachments\/([^/]+)(\/\$value)?$/.exec(rest))) {
        const att = mail.attachments.find((a) => a.id === m![1]);
        if (!att) return graphError(404, "ErrorItemNotFound");
        if (method === "DELETE") { mail.attachments = mail.attachments.filter((a) => a !== att); this.touch(mail); return new Response(null, { status: 204 }); }
        if (m[2]) return new Response(att.bytes, { status: 200, headers: { "Content-Type": att.contentType, "Content-Length": String(att.bytes.length) } });
      }
    }
    void raw;
    return graphError(400, "BadRequest");
  }

  private uploadRange(url: URL, method: string, headers: Record<string, string>, body: Uint8Array): Response {
    const session = /AttachmentSessions\('([^']+)'\)/.exec(decodeURIComponent(url.pathname))?.[1] ?? "";
    const upload = this.uploads.get(session);
    if (!upload || method !== "PUT") return new Response(null, { status: 404 });
    if (headers.authorization) return new Response("no Authorization header on a pre-authenticated URL", { status: 400 });
    const [, from, to, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers["content-range"] ?? "") ?? [];
    const have = upload.got.reduce((n, c) => n + c.length, 0);
    if (Number(from) !== have || Number(total) !== upload.size || Number(to) - Number(from) + 1 !== body.length) return new Response(null, { status: 416 });
    upload.got.push(new Uint8Array(body));
    if (have + body.length < upload.size) return json({ nextExpectedRanges: [String(have + body.length)] });
    const bytes = new Uint8Array(upload.size);
    let at = 0;
    for (const c of upload.got) { bytes.set(c, at); at += c.length; }
    const mail = this.mails.get(upload.message)!;
    const id = graphId("att");
    mail.attachments.push({ id, name: upload.name, contentType: upload.contentType, bytes, isInline: upload.isInline });
    this.touch(mail);
    this.uploads.delete(session);
    return new Response(null, { status: 201, headers: { Location: `https://outlook.office.com/api/v2.0/Users('u')/Messages('m')/Attachments('${id}')` } });
  }
}

const MESSAGE_FIELDS = ["id", "conversationId", "parentFolderId", "subject", "from", "sender", "toRecipients", "ccRecipients", "bccRecipients",
  "replyTo", "receivedDateTime", "sentDateTime", "isRead", "isDraft", "flag", "hasAttachments", "internetMessageId", "bodyPreview", "changeKey"];
void b64;
