import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { listEntry, type SpamLists } from "../../shared/mail/spam";
import { listChange, readSpamLists, SpamListConflict, updateSpamLists } from "../spam/lists";
import { listMailboxAddresses } from "../lib/mailbox-store";
import { DEFAULT_SPAM_DAILY_CALLS } from "../categories/store";

/**
 * Spam (SP-3, SP-4, SP-6): the operator's lists, Report spam / Not spam for both
 * providers, and emptying Spam now. Behind the same Access and same-origin boundary
 * as every /api route. Arrival (SP-1) is in workers/index.ts, the model (SP-2) in
 * workers/categories/store.ts.
 */
export const spamRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;
export const SPAM_RETENTION_DAYS = 30;

const LIST_NAMES = ["blockedSenders", "blockedDomains", "allowedSenders", "allowedDomains"] as const;
const Message = z.object({
  accountId: z.string().regex(/^(cloudflare|gmail):.+$/).max(320),
  providerMessageId: z.string().min(1).max(256),
  sender: z.string().max(320).default(""),
});
const Report = z.object({
  messages: z.array(Message).min(1).max(100),
  /** What else goes on the list: the sender, the sender's whole domain, or nothing. */
  list: z.enum(["sender", "domain", "none"]).default("sender"),
}).strict();
const ListEdit = z.object({
  list: z.enum(LIST_NAMES),
  value: z.string().min(1).max(320),
  action: z.enum(["add", "remove"]),
}).strict();

function failure(c: C, error: unknown, action: string) {
  if (error instanceof SpamListConflict) return c.json({ error: error.message }, 409);
  console.error(JSON.stringify({ event: "spam_action_failed", action, error: (error as Error)?.message?.slice(0, 300) }));
  return c.json({ error: `${action} could not be completed: ${(error as Error)?.message ?? "unknown error"}` }, 502);
}

spamRouter.get("/api/spam", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const lists = await readSpamLists(c.env.BUCKET);
    const model = c.env.CATEGORIES
      ? await c.env.CATEGORIES.getByName("workspace").spamStats().catch(() => null)
      : null;
    return c.json({ lists, retentionDays: SPAM_RETENTION_DAYS,
      model: model ?? { used: 0, limit: Number(c.env.SPAM_DAILY_LIMIT) || DEFAULT_SPAM_DAILY_CALLS, spamToday: 0, screenedToday: 0, unavailable: true } });
  } catch (error) { return failure(c, error, "Reading the spam rules"); }
});

spamRouter.post("/api/spam/lists", async (c) => {
  const parsed = ListEdit.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose a list, an address or domain, and add or remove" }, 400);
  const { list, value, action } = parsed.data;
  const kind = list.endsWith("Senders") ? "sender" : "domain";
  const entry = listEntry(value, kind);
  if (!entry) return c.json({ error: kind === "sender" ? `${value} is not an email address` : `${value} is not a domain` }, 400);
  try {
    const lists = await updateSpamLists(c.env.BUCKET, (l) => action === "remove"
      ? { ...l, [list]: l[list].filter((x) => x !== entry) }
      : listChange(l, { kind, value: entry }, list.startsWith("blocked") ? "blocked" : "allowed"));
    console.log(JSON.stringify({ event: "spam_list_changed", list, action }));
    return c.json({ lists });
  } catch (error) { return failure(c, error, "Changing the spam rules"); }
});

/** Moves each message and records the sender (or domain) on the list; says what did not move. */
async function move(c: C, spam: boolean) {
  const parsed = Report.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose one or more messages" }, 400);
  const { messages, list } = parsed.data;
  const results = await Promise.all(messages.map(async (m) => {
    try {
      if (m.accountId.startsWith("cloudflare:")) {
        const mailbox = m.accountId.slice("cloudflare:".length).toLowerCase();
        const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailbox));
        const moved = spam
          ? await stub.markSpam([m.providerMessageId], list === "none" ? "You reported it as spam"
            : `You reported it as spam; mail from ${list === "domain" ? "its domain" : "this sender"} now goes to Spam`)
          : await stub.markNotSpam([m.providerMessageId]);
        return { ...m, ok: moved.length > 0, error: moved.length ? undefined : spam ? "It is sent mail, a draft, or no longer here" : "It is no longer in Spam" };
      }
      if (!c.env.GMAIL_ACCOUNTS) return { ...m, ok: false as boolean, error: "Gmail is not configured on this server" as string | undefined };
      await c.env.GMAIL_ACCOUNTS.getByName("workspace").setSpam(m.accountId.slice("gmail:".length), m.providerMessageId, spam);
      return { ...m, ok: true, error: undefined };
    } catch (error) {
      return { ...m, ok: false, error: (error as Error).message.slice(0, 200) };
    }
  }));
  let lists: SpamLists | undefined;
  let listError: string | undefined;
  const entries = list === "none" ? [] : [...new Set(results.filter((r) => r.ok).map((r) => listEntry(r.sender, list)).filter((x): x is string => !!x))];
  if (entries.length) {
    try {
      lists = await updateSpamLists(c.env.BUCKET, (l) => entries.reduce((acc, value) => listChange(acc, { kind: list as "sender" | "domain", value }, spam ? "blocked" : "allowed"), l));
    } catch (error) {
      listError = `The messages moved, but the spam rules were not changed: ${(error as Error).message}`;
    }
  }
  const moved = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ event: spam ? "spam_reported" : "spam_released", moved, failed: results.length - moved, list }));
  const failed = results.filter((r) => !r.ok).map((r) => ({ accountId: r.accountId, providerMessageId: r.providerMessageId, error: r.error }));
  return c.json({ moved, failed, ...(!moved && failed.length ? { error: failed[0].error ?? "Nothing moved" } : {}),
    listed: entries, ...(lists ? { lists } : {}), ...(listError ? { listError } : {}) }, moved || !results.length ? 200 : 502);
}

spamRouter.post("/api/spam/report", (c) => move(c, true));
spamRouter.post("/api/spam/release", (c) => move(c, false));

/** Deletes everything in Spam now, in every Cloudflare mailbox; Gmail keeps its own 30 days. */
spamRouter.post("/api/spam/empty", async (c) => {
  try {
    const addresses = await listMailboxAddresses(c.env.BUCKET);
    const counts = await Promise.allSettled(addresses.map((a) => c.env.MAILBOX.get(c.env.MAILBOX.idFromName(a)).purgeSpam({ all: true })));
    const deleted = counts.reduce((n, r) => n + (r.status === "fulfilled" ? r.value : 0), 0);
    const failed = counts.filter((r) => r.status === "rejected").length;
    console.log(JSON.stringify({ event: "spam_emptied", deleted, failed }));
    return c.json({ deleted, failed }, failed && !deleted ? 502 : 200);
  } catch (error) { return failure(c, error, "Emptying Spam"); }
});
