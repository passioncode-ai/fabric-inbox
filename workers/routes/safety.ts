import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";

/**
 * B-178: messages held by the arrival safety check (instructions aimed at agents). Read their state, list the held
 * ones, and release or keep one. Releasing is a person's act in the app; an agent asks for it through
 * `decide_held_message`, which waits for the owner's approval (workers/mcp/protocol.ts).
 */
export const safetyRouter = new Hono<{ Bindings: Env }>();

const Key = z.object({ accountId: z.string().min(3).max(300), messageId: z.string().min(1).max(500) }).strict();
const Lookup = z.object({ keys: z.array(Key).min(1).max(200) }).strict();
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
  return c.json({ records });
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
