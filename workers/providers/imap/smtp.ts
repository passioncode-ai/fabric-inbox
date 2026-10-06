/**
 * A small SMTP submission client (RFC 6409) over `MailSocket` (sockets.ts). nodemailer does not
 * run in workerd (465 timed out, 587's upgrade failed in the 2026-10-05 spike), so this speaks
 * the protocol itself: TLS from the first byte (465) or STARTTLS (587) — never plain text —, EHLO,
 * AUTH PLAIN or LOGIN (XOAUTH2 when given a token), MAIL/RCPT/DATA with dot-stuffing,
 * BODY=8BITMIME and SMTPUTF8 when the message needs them and the server offers them.
 *
 * What a failure means is the contract with the outbox (account-service.ts submit):
 * - `NotSentError` — refused or failed before the end-of-data mark was written: nothing left,
 *   the same idempotency key may try again;
 * - `ProviderError("send_outcome_unknown")` — the connection failed after the message was handed
 *   over and before the server answered: it may have gone, so it is never sent again on its own;
 * - success — the server answered 2xx to the end of data: it accepted the message.
 *
 * No credential is logged or carried in an error; server replies are reduced to public codes.
 */
import { ProviderError } from "../gmail-client";
import { NotSentError } from "../provider";
import { BLOCKED_PORTS, type MailSocket, type SocketFactory } from "./sockets";

export interface SmtpOptions {
  host: string;
  port: number;
  security: "tls" | "starttls";
  user: string;
  /** An app password, or (with `token`) nothing. */
  password?: string;
  /** An OAuth access token: AUTH XOAUTH2 (an OAuth provider on this transport). */
  token?: string;
  socket: SocketFactory;
  /** The name given in EHLO: the sender's domain. */
  clientName?: string;
  /** How long one reply may take (ms); the reply to the end of data gets three times as long. */
  timeoutMs?: number;
}
interface Reply { code: number; lines: string[] }
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (text: string) => {
  const bytes = enc.encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Lines starting with "." get one more (RFC 5321 4.5.2); line ends become CRLF; the data ends with CRLF.CRLF. */
export function dotStuff(message: string): string {
  const crlf = message.replace(/\r?\n|\r/g, "\r\n");
  const stuffed = crlf.replace(/(^|\r\n)\./g, "$1..");
  return (stuffed.endsWith("\r\n") ? stuffed : stuffed + "\r\n") + ".\r\n";
}

/** The reply text, without anything that could echo what was sent: for classification only. */
const text = (reply: Reply) => reply.lines.join(" ").slice(0, 300);

/** Why a login was refused, as a public code (the server's own words never leave this module). */
function authFailure(reply: Reply): string {
  const t = text(reply);
  if (/application-specific password|app password|InvalidSecondFactor/i.test(t)) return "app_password_required";
  if (/web ?browser|web login|sign in via/i.test(t)) return "web_login_required";
  return "smtp_auth_failed";
}

class Connection {
  private socket!: MailSocket;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  /** Set once the end-of-data mark has been written: from then on a failure is an unknown outcome. */
  dataSent = false;
  extensions = new Map<string, string>();
  constructor(private o: SmtpOptions) {}

  private attach(socket: MailSocket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }
  async open() {
    if (BLOCKED_PORTS.has(this.o.port)) throw new NotSentError("port_blocked", 400);
    try {
      this.attach(await this.o.socket({ hostname: this.o.host, port: this.o.port }, { secureTransport: this.o.security === "tls" ? "on" : "starttls", allowHalfOpen: false }));
      await this.timed(this.socket.opened, this.o.timeoutMs ?? 30_000);
    } catch (error) {
      throw new NotSentError(this.o.security === "tls" && /tls|ssl|certificate|handshake/i.test(String((error as Error)?.message)) ? "smtp_tls_failed" : "smtp_unreachable", 503);
    }
    let greeting: Reply;
    try { greeting = await this.read(); }
    catch { throw new NotSentError("smtp_unreachable", 503); }
    if (greeting.code !== 220) throw new NotSentError(greeting.code === 554 || greeting.code === 421 ? "smtp_refused" : "smtp_unreachable", 503);
    await this.ehlo();
    if (this.o.security === "starttls") {
      if (!this.extensions.has("STARTTLS")) throw new NotSentError("smtp_tls_failed", 503);
      const ok = await this.command("STARTTLS");
      if (ok.code !== 220) throw new NotSentError("smtp_tls_failed", 503);
      // Every lock goes before the upgrade, or workerd refuses it.
      this.reader.releaseLock();
      this.writer.releaseLock();
      try {
        this.attach(this.socket.startTls());
        await this.timed(this.socket.opened, this.o.timeoutMs ?? 30_000);
      } catch {
        throw new NotSentError("smtp_tls_failed", 503);
      }
      this.buffer = "";
      await this.ehlo();
    }
    await this.authenticate();
  }
  private async ehlo() {
    const reply = await this.command(`EHLO ${this.o.clientName || "fabric-inbox.invalid"}`);
    if (reply.code !== 250) throw new NotSentError("smtp_unreachable", 503);
    this.extensions.clear();
    for (const line of reply.lines.slice(1)) {
      const [name, ...rest] = line.trim().split(/\s+/);
      if (name) this.extensions.set(name.toUpperCase(), rest.join(" ").toUpperCase());
    }
  }
  private async authenticate() {
    const mechanisms = new Set((this.extensions.get("AUTH") ?? "").split(/\s+/).filter(Boolean));
    let reply: Reply;
    if (this.o.token) {
      if (!mechanisms.has("XOAUTH2")) throw new NotSentError("smtp_auth_unsupported", 502);
      reply = await this.command("AUTH XOAUTH2 " + b64(`user=${this.o.user}\x01auth=Bearer ${this.o.token}\x01\x01`), true);
      // A refused token answers 334 with a JSON reason; an empty line ends the exchange.
      if (reply.code === 334) reply = await this.command("", true);
      if (reply.code === 535 || reply.code === 534 || reply.code === 530 || reply.code === 454) throw new NotSentError("reconnect_required", 401);
    } else if (mechanisms.has("PLAIN") || !mechanisms.has("LOGIN")) {
      if (!mechanisms.has("PLAIN") && !mechanisms.has("LOGIN")) throw new NotSentError("smtp_auth_unsupported", 502);
      reply = await this.command("AUTH PLAIN " + b64(`\0${this.o.user}\0${this.o.password ?? ""}`), true);
    } else {
      reply = await this.command("AUTH LOGIN", true);
      if (reply.code === 334) reply = await this.command(b64(this.o.user), true);
      if (reply.code === 334) reply = await this.command(b64(this.o.password ?? ""), true);
    }
    if (reply.code !== 235) {
      if (reply.code >= 500 || reply.code === 454) throw new NotSentError(authFailure(reply), 401);
      throw new NotSentError("smtp_temporary_failure", 503);
    }
  }

  private timed<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })])
      .finally(() => clearTimeout(timer));
  }
  /** One reply, all its lines. A connection that ends or stalls first is an error the caller classifies. */
  async read(ms = this.o.timeoutMs ?? 30_000): Promise<Reply> {
    const lines: string[] = [];
    const deadline = Date.now() + ms;
    for (;;) {
      let at: number;
      while ((at = this.buffer.indexOf("\r\n")) < 0) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("timeout");
        const { value, done } = await this.timed(this.reader.read(), left);
        if (done) throw new Error("closed");
        this.buffer += dec.decode(value, { stream: true });
        if (this.buffer.length > 64_000) throw new Error("reply_too_long");
      }
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      const code = Number(line.slice(0, 3));
      if (!/^\d{3}[ -]?/.test(line)) throw new Error("bad_reply");
      lines.push(line.slice(4));
      if (line[3] !== "-") return { code, lines };
    }
  }
  async write(data: string) {
    await this.writer.write(enc.encode(data));
  }
  /** One command and its reply. A failure here, before any data, means nothing was sent. */
  async command(line: string, secret = false): Promise<Reply> {
    try {
      await this.write(line + "\r\n");
      return await this.read();
    } catch (error) {
      // The words of an AUTH line never reach a log or an error.
      void secret;
      throw error instanceof NotSentError ? error : new NotSentError("smtp_connection_lost", 503);
    }
  }
  async close() {
    try { await this.write("QUIT\r\n"); await this.read(5_000); } catch { /* closing anyway */ }
    try { this.reader.releaseLock(); this.writer.releaseLock(); } catch { /* already released */ }
    try { await this.socket.close(); } catch { /* already closed */ }
  }
}

/** Opens, says hello, upgrades and signs in; answers what the server offers. Used to check settings. */
export async function verifySmtp(options: SmtpOptions): Promise<{ extensions: string[] }> {
  const c = new Connection(options);
  try {
    await c.open();
    return { extensions: [...c.extensions.keys()] };
  } finally {
    await c.close().catch(() => undefined);
  }
}

export interface Envelope { from: string; recipients: string[] }

/** Sends one message (the RFC 5322 text, CRLF or LF line ends). Resolves once the server accepted it. */
export async function sendSmtp(options: SmtpOptions, envelope: Envelope, message: string): Promise<{ response: string }> {
  const c = new Connection(options);
  try {
    await c.open();
    const utf8 = [envelope.from, ...envelope.recipients].some((a) => /[^\x00-\x7f]/.test(a)) || /[^\x00-\x7f]/.test(message.slice(0, message.indexOf("\r\n\r\n") >>> 0));
    const eightBit = /[^\x00-\x7f]/.test(message);
    if (utf8 && !c.extensions.has("SMTPUTF8")) throw new NotSentError("smtputf8_unsupported", 400);
    const params = [eightBit && c.extensions.has("8BITMIME") ? "BODY=8BITMIME" : "", utf8 ? "SMTPUTF8" : ""].filter(Boolean).join(" ");
    const from = await c.command(`MAIL FROM:<${envelope.from}>${params ? " " + params : ""}`);
    if (from.code !== 250) throw new NotSentError(from.code >= 500 ? "sender_rejected" : "smtp_temporary_failure", from.code >= 500 ? 400 : 503);
    if (!envelope.recipients.length) throw new NotSentError("invalid_message", 400);
    for (const rcpt of envelope.recipients) {
      const r = await c.command(`RCPT TO:<${rcpt}>`);
      if (r.code !== 250 && r.code !== 251) throw new NotSentError(r.code >= 500 ? "recipient_rejected" : "smtp_temporary_failure", r.code >= 500 ? 400 : 503);
    }
    const data = await c.command("DATA");
    if (data.code !== 354) throw new NotSentError(data.code >= 500 ? "message_rejected" : "smtp_temporary_failure", data.code >= 500 ? 400 : 503);
    // From the first byte of the message on, a failure may have left something at the server.
    let done: Reply;
    try {
      c.dataSent = true;
      await c.write(dotStuff(message));
      done = await c.read((options.timeoutMs ?? 30_000) * 3);
    } catch {
      throw new ProviderError("send_outcome_unknown", 502);
    }
    // A refusal of the whole message is an answer: nothing was accepted.
    if (done.code >= 400) throw new NotSentError(done.code >= 500 ? "message_rejected" : "smtp_temporary_failure", done.code >= 500 ? 400 : 503);
    if (done.code < 200 || done.code >= 300) throw new ProviderError("send_outcome_unknown", 502);
    return { response: String(done.code) };
  } finally {
    await c.close().catch(() => undefined);
  }
}
