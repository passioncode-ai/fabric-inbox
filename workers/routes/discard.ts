import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
  DISCARD_RETENTION_DAYS, allowEntry, discardFacts, forgetDiscard, learnDiscard, matchDiscard, ruleIdOf, type DiscardFacts, type DiscardRule,
} from "../../shared/mail/discard";
import { DiscardStoreConflict, explainDiscard, readDiscardStore, updateDiscardStore } from "../discard/store";
import { readSpamLists } from "../spam/lists";
import { cloudflareWorkspace } from "../discard/workspace";
import { parseRemoteAccount } from "../../shared/mail/accounts";
import { DISCARD_RESTORE_TARGETS, type DiscardRestoreTarget } from "../providers/provider";

/**
 * Discarded (operator decision 2026-10-06): throwing a message away on purpose, bringing it back,
 * and the rules learned from it (shared/mail/discard.ts). Behind the same Access and same-origin
 * boundary as every /api route. Arrival — mail a rule sends straight to Discarded — is in
 * workers/index.ts (Cloudflare) and workers/providers/account-service.ts (Gmail, IMAP, Outlook).
 */
export const discardRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const Message = z.object({
  accountId: z.string().regex(/^(cloudflare|gmail|imap|outlook):.+$/).max(400),
  providerMessageId: z.string().min(1).max(300),
});
export const DiscardInput = z.object({
  messages: z.array(Message).min(1).max(100),
  /** Learn a rule from each message (the default); false discards without teaching anything. */
  learn: z.boolean().default(true),
}).strict();
export const RestoreInput = z.object({
  messages: z.array(Message.extend({
    /** Undo: the rule this message's discard taught (`learnedRuleId` in the discard's answer); only it is taken back. */
    ruleId: z.string().regex(/^[ls]-[0-9a-f]{8}$/).optional(),
    /**
     * Where it goes back to: the inbox when absent (Not discarded); Undo names the folder the discard
     * took it from (its `from`). Never Sent, Drafts or Discarded; a Gmail, IMAP or Outlook message goes
     * back to inbox, archive or trash.
     */
    to: z.string().regex(/^[a-z0-9_-]{1,100}$/).refine((v) => !["sent", "draft", "discarded"].includes(v)).optional(),
  })).min(1).max(100),
  /** Unread again (Undo of a discard of unread mail); left as it is when absent. */
  read: z.boolean().optional(),
  /** Undo: what each discard taught (its message's ruleId) is taken back too (a rule it made goes); a message without one forgets nothing. */
  unlearn: z.boolean().default(false),
}).strict();
export const AllowEdit = z.object({ value: z.string().min(1).max(320), action: z.enum(["add", "remove"]) }).strict();

/** Why a message moved, as the person discarded it. */
export const MANUAL_REASON = "You discarded it";

type Ref = z.infer<typeof Message>;
interface Facts { facts: DiscardFacts; known: boolean; inThread: boolean; subject: string }

function failure(c: C, error: unknown, action: string) {
  if (error instanceof DiscardStoreConflict) return c.json({ error: error.message }, 409);
  console.error(JSON.stringify({ event: "discard_action_failed", action, error: (error as Error)?.message?.slice(0, 300) }));
  return c.json({ error: `${action} could not be completed: ${(error as Error)?.message ?? "unknown error"}` }, 502);
}

const cloudflare = (env: Env, ref: Ref) => {
  const mailbox = ref.accountId.slice("cloudflare:".length).toLowerCase();
  return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
};
const accounts = (env: Env) => {
  if (!env.GMAIL_ACCOUNTS) throw new Error("Mail accounts are not configured on this server");
  return env.GMAIL_ACCOUNTS.getByName("workspace");
};

/** The categories each message is in, by its key, for the why of a rule; nothing when they cannot be read. */
async function categoriesOf(env: Env, refs: Ref[]): Promise<Map<string, string>> {
  if (!env.CATEGORIES) return new Map();
  try {
    const found = await env.CATEGORIES.getByName("workspace").membership(refs.map((r) => ({ accountId: r.accountId, messageId: r.providerMessageId })));
    return new Map(Object.entries(found).map(([key, hits]) => [key, hits[0]?.name ?? ""]).filter(([, name]) => !!name) as [string, string][]);
  } catch { return new Map(); }
}

/** What one message says about itself, read where it is kept. Null when it is not there; throws what refuses it. */
async function factsOf(env: Env, ref: Ref, category?: string): Promise<Facts | null> {
  if (ref.accountId.startsWith("cloudflare:")) {
    const row = await cloudflare(env, ref).discardFacts(ref.providerMessageId);
    if (!row) return null;
    if (row.folder === "sent" || row.folder === "draft") throw new Error("It is sent mail or a draft");
    return { facts: discardFacts({ sender: row.sender, headers: row.headers, category }), known: row.known, inThread: row.inThread, subject: row.subject };
  }
  const remote = parseRemoteAccount(ref.accountId);
  if (!remote) throw new Error("Not an account of this server");
  const row = await accounts(env).discardFacts(remote.id, ref.providerMessageId);
  return { facts: discardFacts({ sender: row.sender, headers: row.headers, category }), known: row.known, inThread: row.inThread, subject: row.subject };
}

const ERROR_TEXT: Record<string, string> = {
  message_not_found: "It is no longer here",
  not_supported: "This account cannot do that",
  spam_not_discardable: "It is in Spam: moving it out would teach the account's spam filter that it is not spam. Spam is emptied on its own",
};
/** What a refused discard or restore says to the person, from the provider's code or the error's own words. */
export const discardErrorText = (error: unknown) => {
  const message = (error as Error)?.message ?? "unknown error";
  return ERROR_TEXT[message] ?? message.slice(0, 200);
};
const errorText = discardErrorText;

/**
 * Discard: each message leaves the inbox for Discarded, read, and its rule is learned (or counted).
 * Answers what moved (with the folder it left and whether it was unread, for Undo), what did not and
 * why, and each rule touched — `created` the first time, when the app says so once, with Don't.
 */
discardRouter.post("/api/discard", async (c) => {
  const parsed = DiscardInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose one or more messages" }, 400);
  const { messages, learn } = parsed.data;
  const categories = learn ? await categoriesOf(c.env, messages) : new Map<string, string>();
  const results = await Promise.all(messages.map(async (m) => {
    try {
      const facts = learn ? await factsOf(c.env, m, categories.get(JSON.stringify([m.accountId, m.providerMessageId]))) : null;
      if (learn && !facts) return { ...m, ok: false as const, error: "It is no longer here" };
      if (m.accountId.startsWith("cloudflare:")) {
        const [moved] = await cloudflare(c.env, m).discardMessages([m.providerMessageId], MANUAL_REASON);
        if (!moved) return { ...m, ok: false as const, error: "It is sent mail, a draft, or no longer here" };
        return { ...m, ok: true as const, id: moved.id, from: moved.from, unread: moved.unread, facts };
      }
      const remote = parseRemoteAccount(m.accountId)!;
      const moved = await accounts(c.env).discardMessage(remote.id, m.providerMessageId, MANUAL_REASON);
      return { ...m, ok: true as const, id: moved.id, from: moved.from, unread: moved.unread, facts };
    } catch (error) {
      return { ...m, ok: false as const, error: errorText(error) };
    }
  }));
  const done = results.filter((r) => r.ok);
  const learned = new Map<string, { rule: DiscardRule; created: boolean }>();
  // The rule each message's discard was counted on: Undo takes back that, and nothing else.
  const taught = new Map<object, string>();
  const skipped = new Set<string>();
  let ruleError: string | undefined;
  const teach = done.filter((r) => r.facts);
  if (teach.length) {
    try {
      // "Written to" and "own domains" are the workspace's (every mailbox and account), as on arrival;
      // a sender that cannot be cleared counts as written to, so no rule is learned that would hold back anyway.
      const workspace = cloudflareWorkspace(c.env);
      for (const r of teach) if (!r.facts!.known && r.facts!.facts.sender) r.facts!.known = await workspace.known(r.facts!.facts.sender);
      const ownDomains = await workspace.ownDomains().catch(() => [] as string[]);
      await updateDiscardStore(c.env.BUCKET, (store) => {
        // A retried write starts over: what was learned is what the last attempt saw.
        learned.clear(); skipped.clear(); taught.clear();
        let next = store;
        for (const r of teach) {
          const result = learnDiscard(next, r.facts!.facts, Date.now(), { known: r.facts!.known, ownDomains });
          next = result.store;
          if (result.rule) {
            learned.set(result.rule.id, { rule: result.rule, created: (learned.get(result.rule.id)?.created ?? false) || result.created });
            taught.set(r, result.rule.id);
          }
          if (result.skipped) skipped.add(result.skipped);
        }
        return next;
      });
    } catch (error) {
      ruleError = `The messages were discarded, but nothing was learned: ${(error as Error).message}`;
    }
  }
  // A new rule's one-line reason from the model, when the server has one; never holds the answer up.
  const fresh = [...learned.values()].filter((l) => l.created);
  if (fresh.length && c.env.AI) {
    const explain = (async () => {
      for (const { rule } of fresh) {
        const source = teach.find((r) => r.facts && ruleIdOf(r.facts.facts) === rule.id);
        const text = await explainDiscard(c.env.AI, rule.why, source?.facts?.subject ?? "");
        if (text) await updateDiscardStore(c.env.BUCKET, (store) => ({ ...store, rules: store.rules.map((r) => (r.id === rule.id && !r.why.model ? { ...r, why: { ...r.why, model: text } } : r)) }));
      }
    })().catch((error: unknown) => console.warn(JSON.stringify({ event: "discard_explain_failed", error: (error as Error)?.message?.slice(0, 120) })));
    try { c.executionCtx.waitUntil(explain); } catch { /* called in-process (the agent protocol): it finishes on its own */ }
  }
  console.log(JSON.stringify({ event: "discarded", moved: done.length, failed: results.length - done.length, learned: learned.size, created: fresh.length }));
  const failed = results.filter((r) => !r.ok).map((r) => ({ accountId: r.accountId, providerMessageId: r.providerMessageId, error: (r as { error?: string }).error }));
  return c.json({
    moved: done.length, failed,
    results: done.map((r) => ({ accountId: r.accountId, providerMessageId: r.providerMessageId, id: (r as { id: string }).id, from: (r as { from: string }).from, unread: (r as { unread: boolean }).unread,
      ...(taught.has(r) ? { learnedRuleId: taught.get(r) } : {}) })),
    learned: [...learned.values()].map(({ rule, created }) => ({ ruleId: rule.id, kind: rule.kind, label: rule.label, discards: rule.discards, created })),
    skipped: [...skipped],
    ...(ruleError ? { ruleError } : {}),
    ...(!done.length && failed.length ? { error: failed[0]!.error ?? "Nothing was discarded" } : {}),
  }, done.length || !results.length ? 200 : 502);
});

/**
 * Not discarded: messages back to the inbox. Answers the rules that would discard them again, so the
 * app can offer "Stop discarding mail like this". With `unlearn` (Undo) the discard is also taken
 * back from what was learned.
 */
discardRouter.post("/api/discard/restore", async (c) => {
  const parsed = RestoreInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose one or more messages" }, 400);
  const { messages, read, unlearn } = parsed.data;
  const results = await Promise.all(messages.map(async (m) => {
    let facts: Facts | null = null;
    try { facts = await factsOf(c.env, m); } catch { /* the move below says what is wrong */ }
    try {
      if (m.accountId.startsWith("cloudflare:")) {
        const moved = await cloudflare(c.env, m).restoreDiscarded([m.providerMessageId], read, m.to);
        if (!moved.length) return { ...m, ok: false as const, error: "It is no longer in Discarded" };
        return { ...m, ok: true as const, id: m.providerMessageId, facts };
      }
      const remote = parseRemoteAccount(m.accountId);
      if (!remote) return { ...m, ok: false as const, error: "Not an account of this server" };
      if (m.to && !(DISCARD_RESTORE_TARGETS as readonly string[]).includes(m.to)) return { ...m, ok: false as const, error: "A Gmail, IMAP or Outlook message goes back to the inbox, the archive or Trash" };
      const moved = await accounts(c.env).restoreDiscarded(remote.id, m.providerMessageId, read, m.to as DiscardRestoreTarget | undefined);
      return { ...m, ok: true as const, id: moved.id, facts };
    } catch (error) {
      return { ...m, ok: false as const, error: errorText(error) };
    }
  }));
  const done = results.filter((r) => r.ok);
  let ruleError: string | undefined;
  let store;
  try {
    store = unlearn && done.some((r) => r.ruleId)
      ? await updateDiscardStore(c.env.BUCKET, (s) => done.reduce((acc, r) => (r.ruleId ? forgetDiscard(acc, r.ruleId) : acc), s))
      : await readDiscardStore(c.env.BUCKET);
  } catch (error) {
    ruleError = `The messages are back in the inbox, but the rules could not be read: ${(error as Error).message}`;
  }
  const spam = store ? await readSpamLists(c.env.BUCKET).catch(() => undefined) : undefined;
  const rules = new Map<string, DiscardRule>();
  if (store) for (const r of done) {
    const rule = r.facts ? matchDiscard(store, r.facts.facts, spam) : null;
    if (rule) rules.set(rule.id, rule);
  }
  console.log(JSON.stringify({ event: "discard_restored", moved: done.length, failed: results.length - done.length, unlearn }));
  const failed = results.filter((r) => !r.ok).map((r) => ({ accountId: r.accountId, providerMessageId: r.providerMessageId, error: (r as { error?: string }).error }));
  return c.json({
    moved: done.length, failed,
    results: done.map((r) => ({ accountId: r.accountId, providerMessageId: r.providerMessageId, id: (r as { id: string }).id })),
    rules: [...rules.values()].map((r) => ({ ruleId: r.id, kind: r.kind, label: r.label, discards: r.discards })),
    ...(ruleError ? { ruleError } : {}),
    ...(!done.length && failed.length ? { error: failed[0]!.error ?? "Nothing was restored" } : {}),
  }, done.length || !results.length ? 200 : 502);
});

/** Every discard rule, newest use first, the Always allow list, and how long Discarded keeps mail. */
discardRouter.get("/api/discard/rules", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const store = await readDiscardStore(c.env.BUCKET);
    return c.json({ rules: store.rules, allowed: store.allowed, retentionDays: DISCARD_RETENTION_DAYS });
  } catch (error) { return failure(c, error, "Reading the discard rules"); }
});

/** Stop discarding mail like this: the rule goes; mail already in Discarded stays there. */
discardRouter.delete("/api/discard/rules/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[ls]-[0-9a-f]{8}$/.test(id)) return c.json({ error: "Not a discard rule" }, 400);
  try {
    let found = false;
    const store = await updateDiscardStore(c.env.BUCKET, (s) => {
      found = s.rules.some((r) => r.id === id);
      return { ...s, rules: s.rules.filter((r) => r.id !== id) };
    });
    if (!found) return c.json({ error: "That rule is not there any more" }, 404);
    console.log(JSON.stringify({ event: "discard_rule_removed" }));
    return c.json({ rules: store.rules, allowed: store.allowed });
  } catch (error) { return failure(c, error, "Removing the rule"); }
});

/** The Always allow list: senders and domains whose mail is never discarded on arrival. */
discardRouter.post("/api/discard/allowed", async (c) => {
  const parsed = AllowEdit.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Give an address or a domain, and add or remove" }, 400);
  const entry = allowEntry(parsed.data.value);
  if (!entry) return c.json({ error: `${parsed.data.value} is not an email address or a domain` }, 400);
  try {
    const store = await updateDiscardStore(c.env.BUCKET, (s) => ({ ...s,
      allowed: parsed.data.action === "add" ? [entry, ...s.allowed.filter((x) => x !== entry)] : s.allowed.filter((x) => x !== entry) }));
    console.log(JSON.stringify({ event: "discard_allowed_changed", action: parsed.data.action }));
    return c.json({ allowed: store.allowed, rules: store.rules });
  } catch (error) { return failure(c, error, "Changing the Always allow list"); }
});
