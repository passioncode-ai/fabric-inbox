import { z } from "zod";

/**
 * A setup: everything needed to bring a Fabric Inbox up in one step — which
 * server the app connects to, which domains it serves, and the mailboxes with
 * the agent that answers each and where a copy is forwarded. The same file is
 * read by the desktop onboarding (server part) and applied by the server
 * (domains and mailboxes). It holds no secrets.
 */
export const SETUP_FORMAT = "fabric-inbox-setup/1";

const domain = z.string().trim().toLowerCase().regex(/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Not a domain name");
const address = z.string().trim().toLowerCase().email().max(254);
const origin = z.string().trim().url().max(2048);

export const SetupMailboxSchema = z.object({
  address,
  name: z.string().trim().min(1).max(80).optional(),
  /** Agent id, or "off"; omitted keeps whatever the server has. */
  agent: z.union([z.literal("off"), z.object({ id: z.string().min(1).max(100) })]).optional(),
  /** Where the original keeps going (e.g. the Gmail the address used to forward to). */
  forwardTo: address.optional(),
  /** Why the entry exists, e.g. "Email Routing: forward to contact@…". */
  note: z.string().max(300).optional(),
}).strict();

export const SetupSchema = z.object({
  format: z.literal(SETUP_FORMAT),
  name: z.string().trim().min(1).max(100),
  server: z.object({
    origin,
    accessOrigin: z.string().trim().url().max(2048).optional(),
  }).strict(),
  domains: z.array(domain).max(200).default([]),
  mailboxes: z.array(SetupMailboxSchema).max(500).default([]),
  /** Mail for an address with no mailbox on this domain goes to this mailbox instead of bouncing. */
  catchAll: z.array(z.object({ domain, mailbox: address }).strict()).max(200).default([]),
  /** Domains seen but not served by this server, with the reason (another account, etc.). */
  notServed: z.array(z.object({ domain, reason: z.string().max(300) }).strict()).max(200).default([]),
}).strict().superRefine((setup, ctx) => {
  const served = new Set(setup.domains);
  const seen = new Set<string>();
  setup.mailboxes.forEach((m, i) => {
    const d = m.address.slice(m.address.lastIndexOf("@") + 1);
    if (!served.has(d)) ctx.addIssue({ code: "custom", path: ["mailboxes", i, "address"], message: `${m.address}: its domain is not in domains` });
    if (seen.has(m.address)) ctx.addIssue({ code: "custom", path: ["mailboxes", i, "address"], message: `${m.address} appears twice` });
    seen.add(m.address);
    if (m.forwardTo && served.has(m.forwardTo.slice(m.forwardTo.lastIndexOf("@") + 1)))
      ctx.addIssue({ code: "custom", path: ["mailboxes", i, "forwardTo"], message: `${m.address}: forwarding to a served domain would loop` });
  });
  setup.catchAll.forEach((c, i) => {
    if (!served.has(c.domain)) ctx.addIssue({ code: "custom", path: ["catchAll", i, "domain"], message: `${c.domain} is not in domains` });
    if (!seen.has(c.mailbox)) ctx.addIssue({ code: "custom", path: ["catchAll", i, "mailbox"], message: `${c.mailbox} is not one of the mailboxes` });
    if (!c.mailbox.endsWith("@" + c.domain)) ctx.addIssue({ code: "custom", path: ["catchAll", i, "mailbox"], message: `${c.mailbox} is not on ${c.domain}` });
  });
});
export type Setup = z.infer<typeof SetupSchema>;
export type SetupMailbox = z.infer<typeof SetupMailboxSchema>;

/** Readable problems for a file that is not a valid setup. */
export function parseSetup(value: unknown): { ok: true; setup: Setup } | { ok: false; problems: string[] } {
  const parsed = SetupSchema.safeParse(value);
  if (parsed.success) return { ok: true, setup: parsed.data };
  return { ok: false, problems: parsed.error.issues.slice(0, 20).map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message) };
}

export type ApplyOutcome = "created" | "updated" | "unchanged" | "refused";
export interface ApplyResult {
  domainsAdded: string[];
  catchAllSet: string[];
  mailboxes: { address: string; outcome: ApplyOutcome; reason?: string }[];
}
