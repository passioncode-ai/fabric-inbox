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
  let input: Parameters<NonNullable<ReturnType<typeof store>>["recheckSafety"]>[1];
  try {
    if (accountId.startsWith("cloudflare:")) {
      const mailbox = accountId.slice("cloudflare:".length);
      const email = await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailbox)).getEmail(messageId) as {
        sender?: string; sender_name?: string | null; subject?: string; body?: string; raw_headers?: string | null; folder_id?: string; date?: string;
        attachments?: { id: string; filename: string; mimetype: string; size: number }[] } | null;
      if (!email) return c.json({ error: msg("Email not found") }, 404);
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
      const remote = parseRemoteAccount(parsed.data.accountId);
      if (!remote || !c.env.GMAIL_ACCOUNTS) return c.json({ error: msg("Email not found") }, 404);
      const accounts = c.env.GMAIL_ACCOUNTS.getByName("workspace") as unknown as {
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
    return c.json({ error: msg("The message could not be read: {error}", { error: (error as Error)?.message?.slice(0, 200) ?? "" }) }, 502);
  }
  const record = await s.recheckSafety({ accountId, messageId }, input);
  if (record) record.findings = { ...record.findings, hidden: record.findings.hidden.slice(0, HIDDEN_SHOWN) };
  return c.json({ record, feedVersion: await s.feedVersion().catch(() => null) });
});
