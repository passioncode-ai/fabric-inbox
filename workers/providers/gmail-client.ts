import { signalsFromHeaders, type TriageSignals } from "../../shared/mail/triage";
import { validateAttachments, type MailAttachment } from '../../shared/mail/attachments';
import {
  fromB64,
  GMAIL_SCOPE,
  type GmailEnvironment,
} from "./google-oauth";
export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 502,
  ) {
    super(code);
  }
}
export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}
export interface Message {
  id: string;
  accountId: string;
  providerMessageId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  /** Cc and Reply-To header values ("" when none); absent on messages cached before 2026-10-05. */
  cc?: string;
  replyTo?: string;
  /** Bcc (on your own sent mail and drafts) and In-Reply-To ("" when none); absent on messages cached before 2026-10-06. */
  bcc?: string;
  inReplyTo?: string;
  date: string;
  rfcMessageId: string;
  references: string;
  timestamp: number;
  snippet: string;
  text: string;
  html: string;
  read: boolean;
  archived: boolean;
  labels: string[];
  /** List/bulk/auto header signals for triage; absent on messages cached before 2026-09-28. */
  signals?: TriageSignals;
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    providerAttachmentId: string;
  }[];
}
export interface SendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  from?: string;
  attachments?: MailAttachment[];
}
export function normalizeMessage(
  accountId: string,
  raw: GmailMessage,
): Message {
  const headers = raw.payload?.headers || [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name)?.value || "";
  const msg: Message = {
    id: accountId + ":" + raw.id,
    accountId,
    providerMessageId: raw.id,
    threadId: raw.threadId,
    subject: header("subject"),
    from: header("from"),
    to: header("to"),
    cc: header("cc"),
    replyTo: header("reply-to"),
    bcc: header("bcc"),
    inReplyTo: header("in-reply-to"),
    date: header("date"),
    rfcMessageId: header("message-id"),
    references: header("references"),
    timestamp: Number(raw.internalDate) || 0,
    snippet: raw.snippet || "",
    text: "",
    html: "",
    read: !raw.labelIds?.includes("UNREAD"),
    archived: !raw.labelIds?.includes("INBOX"),
    labels: raw.labelIds || [],
    signals: signalsFromHeaders(headers.map((h) => ({ key: h.name, value: h.value }))),
    attachments: [],
  };
  const walk = (part: GmailPart) => {
    if (part.body?.attachmentId)
      msg.attachments.push({
        filename: part.filename || "",
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
        providerAttachmentId: part.body.attachmentId,
      });
    else if (part.body?.data) {
      const body = decodeBody(fromB64(part.body.data), part.headers);
      if (part.mimeType === "text/plain") msg.text += body;
      else if (part.mimeType === "text/html") msg.html += body;
    }
    part.parts?.forEach(walk);
  };
  if (raw.payload) walk(raw.payload);
  return msg;
}
/**
 * Decodes a text part in its declared charset (windows-1251, koi8-r, iso-8859-*
 * …); Gmail returns the original bytes. An unknown or missing charset is UTF-8.
 */
export function decodeBody(bytes: Uint8Array, headers?: { name: string; value: string }[]): string {
  const type = headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(type)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Not a WHATWG encoding label: fall back to UTF-8 below.
    }
  }
  return new TextDecoder().decode(bytes);
}
function safeHeader(value: string) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(value) || value.length > 998)
    throw new ProviderError("invalid_header", 400);
  return value;
}
function address(value: string) {
  safeHeader(value);
  if (!/^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(value))
    throw new ProviderError("invalid_address", 400);
  return value;
}
function base64Text(text: string) {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  // Chunk conversion avoids one rope node per byte and argument-count limits.
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(chunks.join(''));
}
export function makeMime(sender: string, input: SendInput): string {
  const attachments = validateAttachments(input.attachments);
  address(sender);
  if (input.threadId !== undefined && (typeof input.threadId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(input.threadId)))
    throw new ProviderError("invalid_message", 400);
  if (input.from && input.from !== sender)
    throw new ProviderError("sender_mismatch", 400);
  if (
    !Array.isArray(input.to) ||
    !input.to.length ||
    ![input.to, input.cc || [], input.bcc || []].every(
      (a) => Array.isArray(a) && a.every((x) => typeof x === "string"),
    ) ||
    typeof input.text !== "string" ||
    typeof input.subject !== "string"
  )
    throw new ProviderError("invalid_message", 400);
  if (
    input.to.length + (input.cc?.length || 0) + (input.bcc?.length || 0) >
      100 ||
    input.text.length > 1000000 ||
    (input.html?.length || 0) > 1000000
  )
    throw new ProviderError("message_too_large", 413);
  const subject = safeHeader(input.subject);
  // RFC 2047 encoded words must be <= 75 chars; chunk by code point, not UTF-16 unit.
  const chunks: string[] = [];
  let current = "";
  for (const cp of subject) {
    if (new TextEncoder().encode(current + cp).length > 42) {
      chunks.push(current);
      current = "";
    }
    current += cp;
  }
  if (current || !chunks.length) chunks.push(current);
  const h = [
    `From: ${sender}`,
    `To: ${input.to.map(address).join(", ")}`,
    `Subject: ${chunks.map((s) => "=?UTF-8?B?" + base64Text(s) + "?=").join("\r\n ")}`,
    "MIME-Version: 1.0",
  ];
  if (input.cc?.length) h.push("Cc: " + input.cc.map(address).join(", "));
  if (input.bcc?.length) h.push("Bcc: " + input.bcc.map(address).join(", "));
  if (input.inReplyTo) h.push("In-Reply-To: " + safeHeader(input.inReplyTo));
  if (input.references) h.push("References: " + safeHeader(input.references));
  const body = (text: string) =>
    base64Text(text)
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";
  const parts: string[] = [];
  if (input.html !== undefined) {
    if (typeof input.html !== "string")
      throw new ProviderError("invalid_message", 400);
    const boundary = "fabric_" + crypto.randomUUID();
    parts.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    parts.push(
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      body(input.text),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      body(input.html),
      `--${boundary}--`,
    );
  } else
    parts.push(
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      body(input.text),
    );
  if (attachments.length) {
    const mixed = 'fabric_mixed_' + crypto.randomUUID();
    h.push(`Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, ...parts);
    for (const attachment of attachments) {
      // RFC 2231 handles UTF-8 filenames without injecting quoted header syntax.
      const filename = encodeURIComponent(attachment.filename).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      const encodedFilename = filename.match(/(?:%[A-Fa-f0-9]{2}|[^%]){1,18}/g)!;
      h.push(`--${mixed}`, `Content-Type: ${attachment.type}`,
        `Content-Disposition: ${attachment.disposition};`,
        ...encodedFilename.map((chunk, i) => ` filename*${i}*=${i === 0 ? "UTF-8''" : ''}${chunk}${i === encodedFilename.length - 1 ? '' : ';'}`),
        ...(attachment.contentId ? [`Content-ID: <${attachment.contentId}>`] : []),
        'Content-Transfer-Encoding: base64', '', attachment.content.match(/.{1,76}/g)?.join('\r\n') || '');
    }
    h.push(`--${mixed}--`);
  } else h.push(...parts);
  return base64Text(h.join("\r\n")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export class GmailClient {
  constructor(
    private env: GmailEnvironment,
    private credentials: Credentials,
    private persist: (credentials: Credentials) => Promise<void>,
    private http: Fetcher = fetch,
  ) {}
  private async token(force = false) {
    if (!force && this.credentials.expiresAt > Date.now() + 60000)
      return this.credentials.accessToken;
    if (!this.credentials.refreshToken)
      throw new ProviderError("reconnect_required", 401);
    let response: Response;
    try {
      response = await this.http("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.env.GOOGLE_CLIENT_ID!,
          client_secret: this.env.GOOGLE_CLIENT_SECRET!,
          grant_type: "refresh_token",
          refresh_token: this.credentials.refreshToken,
        }),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new ProviderError("provider_unavailable", 503);
    }
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
    };
    if (!response.ok)
      throw new ProviderError(
        data.error === "invalid_grant"
          ? "reconnect_required"
          : response.status === 429
            ? "rate_limited"
            : "oauth_failed",
        response.status === 429 ? 429 : 401,
      );
    if (!data.access_token || !data.expires_in)
      throw new ProviderError("oauth_failed");
    const next = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.credentials.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    await this.persist(next);
    this.credentials = next;
    return next.accessToken;
  }
  async request<T>(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.http(
        "https://gmail.googleapis.com/gmail/v1/users/me/" + path,
        {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...init.headers,
            Authorization: "Bearer " + token,
          },
          signal: AbortSignal.timeout(25000),
        },
      );
    } catch {
      throw new ProviderError("provider_unavailable", 503);
    }
    // Only retry reads. Writes have uncertain outcomes and must never be repeated here.
    if (
      response.status === 401 &&
      retry &&
      (!init.method || init.method === "GET")
    ) {
      await this.token(true);
      return this.request<T>(path, init, false);
    }
    if (!response.ok)
      throw new ProviderError(
        response.status === 401
          ? "reconnect_required"
          : response.status === 429
            ? "rate_limited"
            : response.status === 404
              ? path.startsWith("history?")
                ? "history_expired"
                : "not_found"
              : "provider_failed",
        response.status === 429 ? 429 : response.status === 404 ? 404 : 502,
      );
    // A DELETE answers 204 with no body.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  profile() {
    return this.request<GmailProfile>("profile");
  }
  list(pageToken?: string) {
    const q = new URLSearchParams({
      maxResults: "25",
      includeSpamTrash: "true",
    });
    if (pageToken) q.set("pageToken", pageToken);
    return this.request<{
      messages?: { id: string }[];
      nextPageToken?: string;
    }>("messages?" + q);
  }
  message(id: string) {
    return this.request<GmailMessage>(
      "messages/" + encodeURIComponent(id) + "?format=full",
    );
  }
  /** Every header of one message, as Gmail has it (format=metadata carries no body). */
  messageHeaders(id: string) {
    return this.request<GmailMessage>(
      "messages/" + encodeURIComponent(id) + "?format=metadata",
    );
  }
  history(startHistoryId: string, pageToken?: string) {
    const q = new URLSearchParams({ startHistoryId, maxResults: "25" });
    if (pageToken) q.set("pageToken", pageToken);
    return this.request<{
      historyId: string;
      nextPageToken?: string;
      history?: {
        messages?: { id: string }[];
        messagesAdded?: { message: { id: string } }[];
        messagesDeleted?: { message: { id: string } }[];
        labelsAdded?: { message: { id: string } }[];
        labelsRemoved?: { message: { id: string } }[];
      }[];
    }>("history?" + q);
  }
  send(raw: string, threadId?: string) {
    return this.request<{ id: string; threadId: string }>(
      "messages/send",
      {
        method: "POST",
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
      },
      false,
    );
  }
  createDraft(raw: string, threadId?: string) {
    return this.request<{
      id: string;
      message: { id: string; threadId: string };
    }>(
      "drafts",
      {
        method: "POST",
        body: JSON.stringify({
          message: { raw, ...(threadId ? { threadId } : {}) },
        }),
      },
      false,
    );
  }
  // ── Drafts (B-50/B-52): Gmail's own drafts, so they show in Gmail too ──
  listDrafts(pageToken?: string) {
    const q = new URLSearchParams({ maxResults: "25" });
    if (pageToken) q.set("pageToken", pageToken);
    return this.request<{ drafts?: { id: string; message: { id: string; threadId: string } }[]; nextPageToken?: string }>("drafts?" + q);
  }
  getDraft(id: string, format: "full" | "minimal" = "full") {
    return this.request<{ id: string; message: GmailMessage }>("drafts/" + encodeURIComponent(id) + "?format=" + format);
  }
  /** Replaces the draft's message; Gmail gives the new message a new id (the draft's revision here). */
  updateDraft(id: string, raw: string, threadId?: string) {
    return this.request<{ id: string; message: { id: string; threadId: string } }>(
      "drafts/" + encodeURIComponent(id),
      { method: "PUT", body: JSON.stringify({ id, message: { raw, ...(threadId ? { threadId } : {}) } }) },
      false,
    );
  }
  deleteDraft(id: string) {
    return this.request<void>("drafts/" + encodeURIComponent(id), { method: "DELETE" }, false);
  }
  /** Sends the draft as Gmail holds it; Gmail removes the draft. */
  sendDraft(id: string) {
    return this.request<{ id: string; threadId: string }>("drafts/send", { method: "POST", body: JSON.stringify({ id }) }, false);
  }
  modify(id: string, addLabelIds: string[], removeLabelIds: string[]) {
    return this.request<GmailMessage>(
      "messages/" + encodeURIComponent(id) + "/modify",
      { method: "POST", body: JSON.stringify({ addLabelIds, removeLabelIds }) },
      false,
    );
  }
  setStarred(id: string, starred: boolean) {
    if (typeof starred !== "boolean")
      throw new ProviderError("invalid_starred_state", 400);
    return this.modify(id, starred ? ["STARRED"] : [], starred ? [] : ["STARRED"]);
  }
  setTrashed(id: string, trashed: boolean) {
    if (typeof trashed !== "boolean")
      throw new ProviderError("invalid_trashed_state", 400);
    return this.request<GmailMessage>(
      "messages/" + encodeURIComponent(id) + (trashed ? "/trash" : "/untrash"),
      { method: "POST" },
      false,
    );
  }
  attachment(messageId: string, attachmentId: string) {
    return this.request<{ data: string; size: number }>(
      "messages/" +
        encodeURIComponent(messageId) +
        "/attachments/" +
        encodeURIComponent(attachmentId),
    );
  }
}
export async function exchangeCode(
  env: GmailEnvironment,
  code: string,
  verifier: string,
  redirectUri: string,
  http: Fetcher = fetch,
): Promise<Credentials> {
  let response: Response;
  try {
    response = await http("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ProviderError("oauth_failed");
  }
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (
    !response.ok ||
    !data.access_token ||
    !data.refresh_token ||
    !data.expires_in
  )
    throw new ProviderError("oauth_failed", 400);
  if (!data.scope?.split(" ").includes(GMAIL_SCOPE))
    throw new ProviderError("insufficient_scope", 403);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
