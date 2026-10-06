/**
 * The IMAP connection this server uses: imapflow (2.2.5) over TLS from the first byte, reduced to
 * the commands the sync and the mail actions need, with every failure turned into a public code.
 * imapflow runs in workerd under `nodejs_compat` (its `node:tls` is Cloudflare's socket); IMAP
 * STARTTLS is never used (2026-10-05 spike). No IDLE: a connection lives for one tick or one action.
 *
 * Failure codes (ProviderError):
 * - at login: `auth_failed`, `app_password_required`, `imap_disabled`, `auth_or_imap_disabled`
 *   (a server that does not say which), `web_login_required` (the person's part), `tls_failed`,
 *   `host_unreachable` (the server's);
 * - after login: `provider_unavailable` (the connection went), `folder_missing`, `provider_failed`.
 * Server text never leaves this module: it is matched here and reduced to a code.
 */
import { ImapFlow } from "imapflow";
import { ProviderError } from "../gmail-client";

export interface ImapEndpoint {
  host: string;
  port: number;
  user: string;
  password?: string;
  /** OAuth access token (XOAUTH2), for an OAuth provider on this transport. */
  accessToken?: string;
}
/** How to reach the server: real TLS in the Worker; the tests swap in a plain connection to a fake. */
export interface ImapTransport {
  secure: boolean;
  /** Where a host really is (the tests point every host at their fake server). */
  resolve?: (host: string, port: number) => { host: string; port: number };
  /** Milliseconds for connecting, the greeting and each command. */
  timeoutMs?: number;
  ImapFlowClass?: typeof ImapFlow;
}
export const TLS_TRANSPORT: ImapTransport = { secure: true };

export interface FolderInfo { path: string; specialUse?: string; flags: string[]; delimiter?: string }
export interface OpenedFolder { path: string; uidValidity: number; uidNext: number; exists: number; highestModseq?: string }
export interface Fetched {
  uid: number;
  seq?: number;
  flags: string[];
  internalDate?: Date;
  size?: number;
  modseq?: string;
  source?: Uint8Array;
  headers?: Uint8Array;
}

const text = (error: unknown) => {
  const e = error as { message?: string; responseText?: string; response?: string; serverResponseCode?: string; code?: string };
  return [e?.serverResponseCode, e?.responseText, e?.response, e?.message, e?.code].filter(Boolean).join(" ");
};

/** Why a login was refused, from the server's words (never repeated to anyone). */
export function loginFailure(error: unknown): string {
  const t = text(error);
  if (/application-specific password|app(lication)? password|InvalidSecondFactor|\[ALERT\] Please use an app/i.test(t)) return "app_password_required";
  // Yandex answers one sentence for both (measured 2026-10-06): "invalid credentials or IMAP is disabled".
  if (/credentials or imap is disabled/i.test(t)) return "auth_or_imap_disabled";
  if (/imap.{0,40}(disabled|not enabled|is off|switched off|access)|enable imap|pop3.{0,10}imap|not allowed to use imap/i.test(t)) return "imap_disabled";
  if (/web ?browser|web login|log ?in via|sign in via/i.test(t)) return "web_login_required";
  return "auth_failed";
}

/** A failure that is not a refused login: the server out of reach, TLS, or a command refused. */
export function connectionFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { code?: string; authenticationFailed?: boolean };
  if (e?.authenticationFailed) return new ProviderError(loginFailure(error), 401);
  const t = text(error);
  if (/cert|tls|ssl|handshake|ClosedAfterConnectTLS/i.test(t) && !/ECONNREFUSED|ENOTFOUND/i.test(t)) return new ProviderError("tls_failed", 503);
  if (/NoConnection|EConnectionClosed|ETIMEOUT|CONNECT_TIMEOUT|GREETING_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|closed|timeout|socket/i.test(t))
    return new ProviderError("host_unreachable", 503);
  return new ProviderError("provider_failed", 502);
}

const bytes = (b: unknown): Uint8Array | undefined => (b instanceof Uint8Array ? b : undefined);

export class ImapConnection {
  private constructor(private client: ImapFlow, readonly capabilities: Set<string>) {}

  /** Connects and signs in. Throws ProviderError with a login or connection code. */
  static async connect(endpoint: ImapEndpoint, transport: ImapTransport = TLS_TRANSPORT): Promise<ImapConnection> {
    const Flow = transport.ImapFlowClass ?? ImapFlow;
    const timeout = transport.timeoutMs ?? 20_000;
    const target = transport.resolve?.(endpoint.host, endpoint.port) ?? { host: endpoint.host, port: endpoint.port };
    const client = new Flow({
      host: target.host, port: target.port, secure: transport.secure, doSTARTTLS: false,
      ...(transport.secure ? { servername: endpoint.host } : {}),
      auth: endpoint.accessToken ? { user: endpoint.user, accessToken: endpoint.accessToken } : { user: endpoint.user, pass: endpoint.password ?? "" },
      logger: false, emitLogs: false, disableAutoIdle: true, disableCompression: true, qresync: false,
      connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: Math.max(timeout * 3, 60_000),
      clientInfo: { name: "Fabric Inbox" },
    } as ConstructorParameters<typeof ImapFlow>[0]);
    // An error after connect (the server closing the connection) must not crash the object.
    client.on("error", () => undefined);
    try {
      await client.connect();
    } catch (error) {
      try { client.close(); } catch { /* already closed */ }
      throw connectionFailure(error);
    }
    const caps = new Set<string>([...((client as unknown as { capabilities?: Map<string, unknown> }).capabilities?.keys() ?? [])].map((c) => c.toUpperCase()));
    return new ImapConnection(client, caps);
  }

  /** Runs one command; a failure becomes a public code, and the connection is marked unusable when it went. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const failure = connectionFailure(error);
      throw failure.code === "host_unreachable" ? new ProviderError("provider_unavailable", 503) : failure;
    }
  }

  get usable() {
    return !!(this.client as unknown as { usable?: boolean }).usable;
  }

  async folders(): Promise<FolderInfo[]> {
    const list = await this.run(() => this.client.list());
    return list.map((f) => ({ path: f.path, specialUse: f.specialUse || undefined, flags: [...(f.flags ?? [])], delimiter: f.delimiter || undefined }));
  }

  async open(path: string, write = false): Promise<OpenedFolder> {
    try {
      const m = await this.client.mailboxOpen(path, { readOnly: !write });
      return {
        path: m.path, uidValidity: Number(m.uidValidity), uidNext: Number(m.uidNext), exists: Number(m.exists),
        ...(m.highestModseq !== undefined && m.highestModseq !== null ? { highestModseq: String(m.highestModseq) } : {}),
      };
    } catch (error) {
      if (/NONEXISTENT|TRYCREATE|doesn't exist|does not exist|no such|unknown mailbox|not found/i.test(text(error))) throw new ProviderError("folder_missing", 404);
      throw connectionFailure(error).code === "host_unreachable" ? new ProviderError("provider_unavailable", 503) : connectionFailure(error);
    }
  }

  /** Messages of the open folder by UID range (or sequence range with `bySeq`), with what is asked. */
  async fetch(range: string, query: { source?: boolean; headers?: boolean }, options: { bySeq?: boolean; changedSince?: string } = {}): Promise<Fetched[]> {
    const rows = await this.run(() => this.client.fetchAll(range, {
      uid: true, flags: true, internalDate: true, size: true,
      ...(query.source ? { source: true } : {}), ...(query.headers ? { headers: true } : {}),
    }, { uid: !options.bySeq, ...(options.changedSince ? { changedSince: BigInt(options.changedSince) } : {}) }));
    return rows.filter((m) => m && m.uid).map((m) => ({
      uid: Number(m.uid), seq: m.seq, flags: [...(m.flags ?? [])], internalDate: m.internalDate ? new Date(m.internalDate) : undefined,
      size: m.size, ...(m.modseq !== undefined ? { modseq: String(m.modseq) } : {}),
      ...(bytes(m.source) ? { source: bytes(m.source) } : {}), ...(bytes(m.headers) ? { headers: bytes(m.headers) } : {}),
    }));
  }

  /** Every UID of the open folder. */
  async uids(): Promise<number[]> {
    const found = await this.run(() => this.client.search({ all: true }, { uid: true }));
    return (found || []).map(Number).sort((a, b) => a - b);
  }

  /** UIDs of the open folder carrying this Message-ID. */
  async findMessageId(messageId: string): Promise<number[]> {
    if (!messageId || /[\r\n"]/.test(messageId)) return [];
    const found = await this.run(() => this.client.search({ header: { "message-id": messageId } }, { uid: true }));
    return (found || []).map(Number);
  }

  async setFlags(uid: number, add: string[], remove: string[]) {
    if (add.length) await this.run(() => this.client.messageFlagsAdd(String(uid), add, { uid: true }));
    if (remove.length) await this.run(() => this.client.messageFlagsRemove(String(uid), remove, { uid: true }));
  }

  /** Moves one message of the open folder; answers its new UID when the server says (UIDPLUS). */
  async move(uid: number, destination: string): Promise<number | undefined> {
    const result = await this.run(() => this.client.messageMove(String(uid), destination, { uid: true }));
    const map = result ? (result as { uidMap?: Map<number, number> }).uidMap : undefined;
    const moved = map?.get(uid) ?? map?.get(Number(uid));
    return moved ? Number(moved) : undefined;
  }

  async append(path: string, raw: string | Uint8Array, flags: string[], date?: Date): Promise<{ uid?: number; uidValidity?: number }> {
    const content = typeof raw === "string" ? raw : (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer?.from(raw) ?? raw;
    const result = await this.run(() => this.client.append(path, content as never, flags, date));
    const r = result as { uid?: number; uidValidity?: bigint | number } | false;
    return r ? { ...(r.uid ? { uid: Number(r.uid) } : {}), ...(r.uidValidity !== undefined ? { uidValidity: Number(r.uidValidity) } : {}) } : {};
  }

  /** Deletes one message of the open folder for good (\Deleted, then UID EXPUNGE where the server has it). */
  async remove(uid: number) {
    await this.run(() => this.client.messageDelete(String(uid), { uid: true }));
  }

  /**
   * Makes a folder (the Discarded folder); one that is already there is not a failure. A server that
   * refuses to make it answers `folder_create_refused`.
   */
  async create(path: string): Promise<string> {
    try {
      const made = await this.client.mailboxCreate(path);
      return (made as { path?: string } | undefined)?.path || path;
    } catch (error) {
      if (/ALREADYEXISTS|already exists/i.test(text(error))) return path;
      const failure = connectionFailure(error);
      if (failure.code === "host_unreachable") throw new ProviderError("provider_unavailable", 503);
      throw new ProviderError("folder_create_refused", 502);
    }
  }

  async close() {
    try {
      await Promise.race([this.client.logout(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    } catch { /* closing anyway */ }
    try { this.client.close(); } catch { /* already closed */ }
  }
}
