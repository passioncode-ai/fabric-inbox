/**
 * Microsoft Graph for one Outlook account: the access token (renewed through `persist`, so a
 * rotated refresh token is sealed at once), every request with immutable item ids, and Graph's
 * answers turned into public error codes. No token or Graph error text leaves this file.
 *
 * Contract (read 2026-10-06):
 *  - `Prefer: IdType="ImmutableId"` keeps a message's id when it moves between folders of the
 *    mailbox, on every request that sends it, delta queries included
 *    (https://learn.microsoft.com/en-us/graph/outlook-immutable-id).
 *  - Throttling is 429 with a Retry-After in seconds; wait that long, never retry at once
 *    (https://learn.microsoft.com/en-us/graph/throttling). Outlook allows one app 10,000 requests per
 *    10 minutes and four concurrent requests per mailbox, and 150 MB of uploads per 5 minutes
 *    (https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits): a session
 *    makes one request at a time.
 *  - An expired or reset delta token is 410 Gone (or a 4xx with `syncStateNotFound`); the folder is
 *    synchronized again from the start (https://learn.microsoft.com/en-us/graph/delta-query-overview).
 */
import { ProviderError, type Fetcher } from "../gmail-client";
import { refreshMicrosoftToken, retryAfter, type MicrosoftConfig } from "./oauth";
import type { OutlookCredentials } from "./types";

export const GRAPH = "https://graph.microsoft.com/v1.0";
const IMMUTABLE = 'IdType="ImmutableId"';

export interface GraphRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** A JSON body, or a string sent as it is with `contentType`. */
  json?: unknown;
  body?: string;
  contentType?: string;
  /** More `Prefer` preferences (odata.maxpagesize=50, …). */
  prefer?: string[];
  /** A throttled read waits Retry-After and tries once more, when that is at most this long (ms). */
  patience?: number;
}

/** Graph's error body: `{ error: { code, message } }`. Only the code is read. */
async function graphCode(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { error?: { code?: string } };
    return typeof data.error?.code === "string" ? data.error.code : "";
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GraphClient {
  constructor(
    private config: MicrosoftConfig,
    private credentials: OutlookCredentials,
    private persist: (credentials: OutlookCredentials) => Promise<void>,
    private http: Fetcher = fetch,
  ) {}

  /** A valid access token; a minute before it ends, a new one (and the rotated refresh token, sealed). */
  async token(force = false): Promise<string> {
    if (!force && this.credentials.expiresAt > Date.now() + 60_000) return this.credentials.accessToken;
    const next = await refreshMicrosoftToken(this.config, this.credentials, this.http);
    await this.persist(next);
    this.credentials = next;
    return next.accessToken;
  }

  /** The URL of a path, or a nextLink/deltaLink Graph gave; anything else is refused (the token goes nowhere else). */
  private url(path: string): string {
    if (path.startsWith("https://")) {
      if (!path.startsWith(GRAPH + "/")) throw new ProviderError("provider_failed", 502);
      return path;
    }
    return GRAPH + path;
  }

  /** One request; the answer when it is 2xx, a ProviderError with a public code otherwise. */
  async send(path: string, request: GraphRequest = {}, retry = true): Promise<Response> {
    const method = request.method ?? "GET";
    const token = await this.token();
    const headers: Record<string, string> = { Authorization: "Bearer " + token, Prefer: [IMMUTABLE, ...(request.prefer ?? [])].join(", ") };
    let body: string | undefined;
    if (request.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(request.json); }
    else if (request.body !== undefined) { headers["Content-Type"] = request.contentType ?? "text/plain"; body = request.body; }
    else if (method === "POST") headers["Content-Length"] = "0";
    let response: Response;
    try {
      response = await this.http(this.url(path), { method, headers, body, signal: AbortSignal.timeout(25_000) });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("provider_unavailable", 503);
    }
    if (response.ok) return response;
    // A read refused with 401 is tried once more with a new token; a write is never repeated here.
    if (response.status === 401 && retry && method === "GET") {
      await this.token(true);
      return this.send(path, request, false);
    }
    if (response.status === 401) {
      // Whether the grant itself is gone is the token endpoint's to say (reconnect_required there).
      if (method !== "GET") await this.token(true);
      throw new ProviderError("provider_auth_failed", 401);
    }
    const code = await graphCode(response);
    if (response.status === 429 || ((response.status === 503 || response.status === 504) && response.headers.has("Retry-After"))) {
      const at = retryAfter(response) ?? Date.now() + 30_000;
      if (method === "GET" && retry && request.patience !== undefined && at - Date.now() <= request.patience) {
        await sleep(Math.max(0, at - Date.now()));
        return this.send(path, request, false);
      }
      throw new ProviderError("rate_limited", 429, undefined, at);
    }
    if (response.status === 410 || code === "syncStateNotFound" || code === "SyncStateNotFound" || code === "resyncRequired")
      throw new ProviderError("delta_reset", 410);
    if (response.status === 404)
      throw new ProviderError(/^Mailbox(NotEnabled|NotSupported)ForRESTAPI$/.test(code) ? "mailbox_unavailable" : "not_found", 404);
    if (response.status === 403) throw new ProviderError("access_denied", 403);
    if (response.status === 413) throw new ProviderError("message_too_large", 413);
    if (response.status >= 500) throw new ProviderError("provider_unavailable", 503);
    if (response.status === 400) throw new ProviderError("provider_rejected", 400);
    throw new ProviderError("provider_failed", 502);
  }

  async json<T>(path: string, request: GraphRequest = {}): Promise<T> {
    const response = await this.send(path, request);
    if (response.status === 202 || response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new ProviderError("provider_failed", 502);
    }
  }

  /** Raw bytes ($value), refused past `maxBytes` before or while reading them. */
  async bytes(path: string, maxBytes: number, request: GraphRequest = {}): Promise<Uint8Array> {
    const response = await this.send(path, request);
    const declared = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError("message_too_large", 413);
    }
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(await response.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new ProviderError("message_too_large", 413); }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  }

  /**
   * Bytes to a pre-authenticated upload URL of an attachment upload session, in ranges under 4 MB,
   * with no Authorization header, as Microsoft's large-attachment guide says
   * (https://learn.microsoft.com/en-us/graph/outlook-large-attachments).
   */
  async upload(uploadUrl: string, bytes: Uint8Array): Promise<void> {
    if (!/^https:\/\/[a-z0-9.-]+\.(office|office365|outlook)\.com\//i.test(uploadUrl) && !uploadUrl.startsWith(GRAPH + "/"))
      throw new ProviderError("provider_failed", 502);
    const CHUNK = 3 * 1024 * 1024;
    for (let start = 0; start < bytes.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, bytes.length);
      let response: Response;
      try {
        response = await this.http(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}` },
          body: bytes.slice(start, end),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new ProviderError("provider_unavailable", 503);
      }
      if (response.status === 429) throw new ProviderError("rate_limited", 429, undefined, retryAfter(response));
      if (!response.ok) throw new ProviderError(response.status >= 500 ? "provider_unavailable" : "provider_rejected", response.status >= 500 ? 503 : 400);
      await response.body?.cancel().catch(() => undefined);
    }
  }
}
