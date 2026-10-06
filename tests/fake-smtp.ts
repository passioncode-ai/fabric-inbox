/**
 * An in-process SMTP submission server over node `net`, and a `SocketFactory` that reaches it the
 * way `cloudflare:sockets` reaches a real one (Web streams, `startTls()` after the locks are
 * released). TLS itself is not simulated: the factory records the upgrade, the server records that
 * it was asked for, and both keep talking plain text over the loopback.
 */
import net from "node:net";
import type { MailSocket, SocketFactory } from "../workers/providers/imap/sockets";

export interface FakeSmtpOptions {
  users?: Record<string, string>;
  /** AUTH mechanisms advertised. */
  mechanisms?: string[];
  /** Offer STARTTLS (and require it before AUTH). */
  starttls?: boolean;
  extensions?: string[];
  /** Close the connection after the end-of-data mark, before answering. */
  dropAfterData?: boolean;
  /** Recipients refused with 550. */
  rejectRecipients?: string[];
  /** The reply to a failed AUTH. */
  authFailure?: string;
  /** The reply to the end of data. */
  dataReply?: string;
  /** XOAUTH2 tokens accepted, by user. */
  tokens?: Record<string, string>;
}
export interface Received { from: string; params: string; recipients: string[]; data: string }

export class FakeSmtp {
  server: net.Server;
  port = 0;
  received: Received[] = [];
  /** Every command line, with AUTH arguments replaced. */
  commands: string[] = [];
  upgrades = 0;
  constructor(public options: FakeSmtpOptions = {}) {
    this.server = net.createServer((socket) => this.session(socket));
  }
  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private session(socket: net.Socket) {
    const o = this.options;
    let buffer = "", secure = false, authed = false, state: "cmd" | "data" | "auth-user" | "auth-pass" = "cmd";
    let mail: Received | null = null, loginUser = "";
    const send = (line: string) => { if (!socket.destroyed) socket.write(line + "\r\n"); };
    const ehlo = () => {
      const ext = [...(o.extensions ?? ["8BITMIME", "SMTPUTF8", "PIPELINING"])];
      if (o.starttls && !secure) ext.push("STARTTLS");
      else ext.push("AUTH " + (o.mechanisms ?? ["PLAIN", "LOGIN"]).join(" "));
      return ["250-fake.invalid", ...ext.map((e, i) => (i === ext.length - 1 ? "250 " : "250-") + e)];
    };
    const check = (user: string, pass: string) => (o.users ?? {})[user] === pass;
    send("220 fake.invalid ESMTP ready");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (state === "data") {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          mail!.data = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          state = "cmd";
          this.received.push(mail!);
          if (o.dropAfterData) { socket.destroy(); return; }
          send(o.dataReply ?? "250 2.0.0 OK queued");
          mail = null;
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (state === "auth-user") { loginUser = Buffer.from(line, "base64").toString(); state = "auth-pass"; this.commands.push("<user>"); send("334 UGFzc3dvcmQ6"); continue; }
        if (state === "auth-pass") {
          state = "cmd"; this.commands.push("<pass>");
          if (check(loginUser, Buffer.from(line, "base64").toString())) { authed = true; send("235 2.7.0 Accepted"); }
          else send(o.authFailure ?? "535 5.7.8 Authentication failed");
          continue;
        }
        this.commands.push(verb === "AUTH" ? line.split(" ").slice(0, 2).join(" ") + " <secret>" : line);
        if (verb === "EHLO") { for (const l of ehlo()) send(l); }
        else if (verb === "STARTTLS") { secure = true; this.upgrades++; send("220 2.0.0 Ready to start TLS"); }
        else if (verb === "AUTH") {
          if (o.starttls && !secure) { send("530 5.7.0 Must issue a STARTTLS command first"); continue; }
          const [, mech, arg] = line.split(" ");
          if (mech?.toUpperCase() === "PLAIN") {
            const [, user, pass] = Buffer.from(arg ?? "", "base64").toString().split("\0");
            if (check(user!, pass!)) { authed = true; send("235 2.7.0 Accepted"); } else send(o.authFailure ?? "535 5.7.8 Authentication failed");
          } else if (mech?.toUpperCase() === "LOGIN") { state = "auth-user"; send("334 VXNlcm5hbWU6"); }
          else if (mech?.toUpperCase() === "XOAUTH2") {
            const m = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$/.exec(Buffer.from(arg ?? "", "base64").toString());
            if (m && (o.tokens ?? {})[m[1]!] === m[2]) { authed = true; send("235 2.7.0 Accepted"); }
            else send("535 5.7.8 Username and Password not accepted");
          } else send("504 5.5.4 Unrecognized authentication type");
        } else if (verb === "MAIL") {
          if (!authed) { send("530 5.7.0 Authentication required"); continue; }
          const m = /^MAIL FROM:<([^>]*)>\s*(.*)$/i.exec(line);
          mail = { from: m?.[1] ?? "", params: m?.[2] ?? "", recipients: [], data: "" };
          send("250 2.1.0 OK");
        } else if (verb === "RCPT") {
          const rcpt = /<([^>]*)>/.exec(line)?.[1] ?? "";
          if ((o.rejectRecipients ?? []).includes(rcpt)) send("550 5.1.1 No such user");
          else { mail?.recipients.push(rcpt); send("250 2.1.5 OK"); }
        } else if (verb === "DATA") { state = "data"; send("354 Go ahead"); }
        else if (verb === "QUIT") { send("221 2.0.0 Bye"); socket.end(); }
        else if (verb === "RSET" || verb === "NOOP") send("250 OK");
        else send("502 5.5.1 Unrecognized command");
      }
    });
  }
}

/**
 * A `SocketFactory` over node `net`, shaped like workerd's: one shared byte queue per connection,
 * each `MailSocket` view reading it through its own Web streams; `startTls()` refuses while a
 * reader or writer still holds a lock, as workerd does.
 */
export function nodeSockets(options: { failTls?: boolean; refuse?: boolean } = {}): SocketFactory & { upgrades: number; connections: { hostname: string; port: number; secureTransport: string }[] } {
  const factory = ((address: { hostname: string; port: number }, opts: { secureTransport: string }) => {
    factory.connections.push({ ...address, secureTransport: opts.secureTransport });
    const socket = net.connect(options.refuse ? 1 : address.port, "127.0.0.1");
    const queue: Uint8Array[] = [];
    let waiting: (() => void) | null = null, ended = false;
    socket.on("data", (d) => { queue.push(new Uint8Array(d)); waiting?.(); });
    socket.on("close", () => { ended = true; waiting?.(); });
    socket.on("error", () => { ended = true; waiting?.(); });
    const opened = new Promise<void>((resolve, reject) => {
      socket.once("connect", () => (opts.secureTransport === "on" && options.failTls ? reject(new Error("TLS handshake failed")) : resolve()));
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const view = (): MailSocket => {
      const readable = new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (!queue.length && !ended) await new Promise<void>((r) => { waiting = r; });
          waiting = null;
          if (queue.length) controller.enqueue(queue.shift()!);
          else controller.close();
        },
      }, { highWaterMark: 0 });
      const writable = new WritableStream<Uint8Array>({
        write: (chunk) => new Promise<void>((resolve, reject) => socket.write(chunk, (e) => (e ? reject(e) : resolve()))),
      });
      const self: MailSocket = {
        readable, writable, opened, closed,
        startTls() {
          if (readable.locked || writable.locked) throw new TypeError("startTls: the socket's streams are still locked");
          factory.upgrades++;
          const next = view();
          if (options.failTls) next.opened = Promise.reject(new Error("TLS handshake failed"));
          next.opened.catch(() => undefined);
          return next;
        },
        close: async () => { socket.destroy(); },
      };
      return self;
    };
    opened.catch(() => undefined);
    return view();
  }) as SocketFactory & { upgrades: number; connections: { hostname: string; port: number; secureTransport: string }[] };
  factory.upgrades = 0;
  factory.connections = [];
  return factory;
}
