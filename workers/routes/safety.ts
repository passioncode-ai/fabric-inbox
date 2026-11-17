import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { parseRemoteAccount } from "../../shared/mail/accounts";
import { checkHeaders } from "../safety/verdict";
import { textToHtml } from "../lib/email-helpers";

/**
 * B-178: messages held by the arrival safety check (instructions aimed at agents). Read their state, list the held
 * ones, and release or keep one. Releasing is a person's act in the app; an agent asks for it through
 * `decide_held_message`, which waits for the owner's approval (workers/mcp/protocol.ts).
 */
export const safetyRouter = new Hono<{ Bindings: Env }>();

const Key = z.object({ accountId: z.string().min(3).max(300), messageId: z.string().min(1).max(500) }).strict();
const Lookup = z.object({ keys: z.array(Key).min(1).max(200) }).strict();
/** S03: `model` may only be false: the open-time check is deterministic (Q14); the review runs on arrival. */
const Check = Key.extend({ model: z.literal(false).optional() }).strict();
/** S03c: `refresh` looks again although a lookup of the last day is kept. */
const Domains = Key.extend({ refresh: z.boolean().optional() }).strict();
const Decide = Key.extend({ action: z.enum(["release", "keep"]), by: z.string().max(120).optional() }).strict();
/** What the person and an agent are shown of the hidden text: quoted, bounded. */
const HIDDEN_SHOWN = 4000;

const store = (env: Env) => env.CATEGORIES?.getByName("workspace");

safetyRouter.get("/api/safety/held", async (c) => {
  c.header("Cache-Control", "no-store");
  const s = store(c.env);
  if (!s) return c.json({ held: [], unavailable: true });
  const limit = Number(c.req.query("limit")) || 100;
  return c.json({ held: await s.heldMessages(limit) });
});

safetyRouter.post("/api/safety/lookup", async (c) => {
  const parsed = Lookup.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Name one or more messages") }, 400);
  const s = store(c.env);
  if (!s) return c.json({ records: {}, unavailable: true });
  const records = await s.safetyOf(parsed.data.keys.map((k) => ({ accountId: k.accountId.toLowerCase(), messageId: k.messageId })));
  for (const r of Object.values(records)) r.findings = { ...r.findings, hidden: r.findings.hidden.slice(0, HIDDEN_SHOWN) };
  // S03: the server's current feed version, so the reader colours a record checked against an older one grey.
  return c.json({ records, feedVersion: await s.feedVersion().catch(() => null) });
});

safetyRouter.post("/api/safety/decide", async (c) => {
  const parsed = Decide.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Name the message and release or keep") }, 400);
  const s = store(c.env);
  if (!s) return c.json({ error: msg("The safety check is not available on this server") }, 503);
  // A person signed in through Access is named by Access; an agent's tool names its key.
  const person = c.req.header("Cf-Access-Authenticated-User-Email");
  const by = person ? `person:${person.toLowerCase()}` : `agent:${parsed.data.by ?? "unknown"}`;
  const state = await s.decideHeld({ accountId: parsed.data.accountId.toLowerCase(), messageId: parsed.data.messageId }, parsed.data.action, by);
  if (!state) return c.json({ error: msg("This message is not held") }, 404);
  console.log(JSON.stringify({ event: "safety_decided", action: parsed.data.action, person: !!person }));
  return c.json({ state });
});

type CheckInputOf = Parameters<NonNullable<ReturnType<typeof store>>["recheckSafety"]>[1];
type ReadError = { status: 404 | 502; error: ReturnType<typeof msg> };

/** S03 and S03c: what the checks read of one stored message (its text, sender lines, receiver headers and files). */
async function readForCheck(env: Env, rawAccountId: string, accountId: string, messageId: string): Promise<{ input: CheckInputOf } | ReadError> {
  let input: CheckInputOf;
  try {
    if (accountId.startsWith("cloudflare:")) {
      const mailbox = accountId.slice("cloudflare:".length);
      const email = await env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)).getEmail(messageId) as {
        sender?: string; sender_name?: string | null; subject?: string; body?: string; raw_headers?: string | null; folder_id?: string; date?: string;
        attachments?: { id: string; filename: string; mimetype: string; size: number }[] } | null;
      if (!email) return { status: 404, error: msg("Email not found") };
      let raw: { key: string; value: string }[] = [];
      try { raw = JSON.parse(email.raw_headers || "[]"); } catch { raw = []; }
      const headers = checkHeaders(raw);
      const header = (name: string) => headers.find((h) => h.key === name)?.value;
      input = { subject: email.subject ?? "", html: email.body ?? "", sender: email.sender ?? "", timestamp: Date.parse(email.date ?? "") || Date.now(),
        fromLine: header("from") ?? (email.sender_name ? `"${email.sender_name.replaceAll('"', "")}" <${email.sender ?? ""}>` : email.sender ?? ""),
        replyToLine: header("reply-to") ?? null, headers: headers.filter((h) => h.key === "authentication-results" || h.key === "received"),
        files: (email.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, mimetype: a.mimetype, size: a.size })),
        scope: email.folder_id === "sent" || email.folder_id === "draft" ? "links" : "received" };
    } else {
      // The provider's id keeps its case; the record's key is lower case, as the lookup's.
      const remote = parseRemoteAccount(rawAccountId);
      if (!remote || !env.GMAIL_ACCOUNTS) return { status: 404, error: msg("Email not found") };
      const accounts = env.GMAIL_ACCOUNTS.getByName("workspace") as unknown as {
        getMessage(id: string, m: string): Promise<{ from: string; replyTo?: string; subject: string; html: string; text: string; labels: string[]; timestamp: number;
          attachments?: { filename: string; mimeType: string; size: number; providerAttachmentId: string; inline?: boolean }[] }>;
        getHeaders(id: string, m: string): Promise<{ headers: { key: string; value: string }[] }>;
      };
      const m = await accounts.getMessage(remote.id, messageId);
      const sent = m.labels.includes("DRAFT") || (m.labels.includes("SENT") && !m.labels.includes("INBOX"));
      // Only Gmail's receiver lines count; Outlook's and IMAP's are not read for nothing.
      const headers = remote.provider === "gmail" && !sent
        ? await accounts.getHeaders(remote.id, messageId).then((h) => checkHeaders(h.headers), () => []) : [];
      input = { subject: m.subject, html: m.html || textToHtml(m.text || ""), sender: m.from, timestamp: m.timestamp || Date.now(), fromLine: m.from,
        replyToLine: m.replyTo || null, headers: headers.filter((h) => h.key === "authentication-results" || h.key === "received"),
        files: (m.attachments ?? []).filter((a) => !a.inline && a.providerAttachmentId)
          .map((a) => ({ id: a.providerAttachmentId, filename: a.filename || "attachment", mimetype: a.mimeType || "application/octet-stream", size: a.size || 0 })),
        scope: sent ? "links" : "received" };
    }
  } catch (error) {
    return { status: 502, error: msg("The message could not be read: {error}", { error: (error as Error)?.message?.slice(0, 200) ?? "" }) };
  }
  return { input };
}

/**
 * S03 (B-269, B-222): one message's deterministic checks run now (sender, links, files; no model), for a message with
 * no record or one checked against an older feed. It writes only `findings.check` (R6-1): a held message stays held.
 * Mail we sent and drafts get the links check only. Answers the record and the server's feed version.
 */
safetyRouter.post("/api/safety/check", async (c) => {
  const parsed = Check.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Name one message to check") }, 400);
  const s = store(c.env);
  if (!s) return c.json({ error: msg("The safety check is not available on this server") }, 503);
  const accountId = parsed.data.accountId.toLowerCase();
  const messageId = parsed.data.messageId;
  const read = await readForCheck(c.env, parsed.data.accountId, accountId, messageId);
  if ("error" in read) return c.json({ error: read.error }, read.status);
  const input = read.input;
  const record = await s.recheckSafety({ accountId, messageId }, input);
  if (record) record.findings = { ...record.findings, hidden: record.findings.hidden.slice(0, HIDDEN_SHOWN) };
  return c.json({ record, feedVersion: await s.feedVersion().catch(() => null) });
});

/**
 * S03c (B-288): looks up one message's sender domains: who registered each From and Reply-To domain and when (RDAP),
 * whether it takes mail and publishes SPF and DMARC, and what its site's main page does, visited from the server.
 * A message with no record is checked first (no model). Writes only `findings.domains`. Answers the record and the
 * feed version; 429 when the day's lookups are spent.
 */
safetyRouter.post("/api/safety/domains", async (c) => {
  const parsed = Domains.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Name one message to look up") }, 400);
  const s = store(c.env);
  if (!s) return c.json({ error: msg("The safety check is not available on this server") }, 503);
  const accountId = parsed.data.accountId.toLowerCase();
  const messageId = parsed.data.messageId;
  const read = await readForCheck(c.env, parsed.data.accountId, accountId, messageId);
  if ("error" in read) return c.json({ error: read.error }, read.status);
  // Mail you sent and drafts: the sender is you; only received mail is looked up.
  if (read.input.scope !== "received") return c.json({ error: msg("Only received mail has a sender to look up.") }, 400);
  const key = { accountId, messageId };
  if (!(await s.safetyOf([key]))[`${accountId}|${messageId}`]) await s.recheckSafety(key, read.input);
  const answer = await s.lookupSenderDomains(key, { fromLine: read.input.fromLine, replyToLine: read.input.replyToLine ?? null }, parsed.data.refresh === true);
  if (answer.limited) return c.json({ error: msg("Today's domain lookups on this server are spent. Try again tomorrow.") }, 429);
  const record = answer.record;
  if (record) record.findings = { ...record.findings, hidden: record.findings.hidden.slice(0, HIDDEN_SHOWN) };
  return c.json({ record, feedVersion: await s.feedVersion().catch(() => null) });
});
