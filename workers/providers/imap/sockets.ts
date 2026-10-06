/**
 * The outbound TCP sockets the SMTP client speaks over: `cloudflare:sockets` in the Worker, an
 * in-process fake in the tests. The shape is the Workers `Socket` one, reduced to what SMTP uses.
 *
 * Workers cannot reach port 25 or Cloudflare's own address ranges; submission (465, 587) works.
 * STARTTLS needs `secureTransport: "starttls"` at connect, then `startTls()` once the server said
 * yes, with every reader and writer lock released first (measured in the 2026-10-05 spike).
 */
export interface MailSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Settles when the connection (and, for "on", its TLS handshake) is up or failed. */
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  startTls(): MailSocket;
  close(): Promise<unknown>;
}
export interface SocketOptions { secureTransport: "on" | "off" | "starttls"; allowHalfOpen: boolean }
export type SocketFactory = (address: { hostname: string; port: number }, options: SocketOptions) => MailSocket | Promise<MailSocket>;

/** Ports a Worker can never reach (SMTP relay); refused before any attempt. */
export const BLOCKED_PORTS = new Set([25]);

/** The Worker's own sockets, loaded on first use so this module stays importable outside workerd. */
export const cloudflareSockets: SocketFactory = async (address, options) => {
  const { connect } = await import("cloudflare:sockets");
  return connect(address, options) as unknown as MailSocket;
};
