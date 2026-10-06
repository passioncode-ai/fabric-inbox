/**
 * What a person types to connect an IMAP account, checked before anything is tried: a preset and
 * the address and app password, or (Other) the servers themselves. The password is only ever in
 * the request body and, once checked against the servers, sealed on the server (credentials.ts).
 */
import { z } from "zod";
import { ProviderError } from "../gmail-client";
import { PRESETS, preset, type PresetId } from "./presets";
import { BLOCKED_PORTS } from "./sockets";
import type { ServerSettings } from "./types";

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
/** Hosts that can never be a mail provider reachable from a Worker. */
const LOCAL = /(^|\.)(localhost|local|internal|invalid|test|example)$/i;

export const ImapConnectBody = z.object({
  preset: z.enum([...PRESETS.map((p) => p.id), "custom"] as unknown as [PresetId, ...PresetId[]]),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(512),
  /** Other (custom) only. */
  imapHost: z.string().trim().toLowerCase().max(253).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  smtpHost: z.string().trim().toLowerCase().max(253).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecurity: z.enum(["tls", "starttls"]).optional(),
  /** Other (custom) only: the login name, when it is not the address. */
  username: z.string().trim().min(1).max(320).optional(),
}).strict();
export type ImapConnectInput = z.infer<typeof ImapConnectBody>;

export const ImapPasswordBody = z.object({ password: z.string().min(1).max(512) }).strict();

/** The servers to use for this input; refuses a host or port no Worker could use. */
export function serverSettings(input: ImapConnectInput): ServerSettings {
  if (input.preset !== "custom") {
    const p = preset(input.preset)!;
    const local = input.email.split("@")[0]!;
    return { imap: { ...p.imap }, smtp: { ...p.smtp }, imapUser: p.imapUser === "local-part" ? local : input.email, smtpUser: input.email };
  }
  const { imapHost, smtpHost } = input;
  if (!imapHost || !smtpHost || !HOST.test(imapHost) || !HOST.test(smtpHost)) throw new ProviderError("invalid_server", 400);
  if (LOCAL.test(imapHost) || LOCAL.test(smtpHost)) throw new ProviderError("invalid_server", 400);
  const smtpPort = input.smtpPort ?? (input.smtpSecurity === "starttls" ? 587 : 465);
  if (BLOCKED_PORTS.has(smtpPort)) throw new ProviderError("port_blocked", 400);
  // Port 143 (and 110, 995: POP) would mean STARTTLS or plain text, which this server never uses for IMAP.
  const imapPort = input.imapPort ?? 993;
  if ([143, 110, 995].includes(imapPort)) throw new ProviderError("imap_tls_required", 400);
  const user = input.username ?? input.email;
  return { imap: { host: imapHost, port: imapPort }, smtp: { host: smtpHost, port: smtpPort, security: input.smtpSecurity ?? (smtpPort === 587 ? "starttls" : "tls") }, imapUser: user, smtpUser: user };
}
