import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import type { Standing } from "../lib/members";
import { msg } from "../../shared/i18n";
import { actorOf, recordAudit } from "../lib/audit";
import { readAgentKeys } from "../mcp/keys";
import { CAPABILITIES, GrantSchema, type StoredGrant } from "../mcp/grants";
import { GrantsConflict, MAX_GRANTS, readGrants, updateGrants } from "../mcp/grant-store";

/**
 * B-246 W2c (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md, SCN-101): the access grants of this server. Only an
 * administrator reaches these routes (workers/lib/member-gate.ts refuses members); over MCP, giving a grant waits for
 * the owner unless the key holds the `keys` standing (B-215). A grant decides nothing yet: every agent call is decided by
 * today's checks and logged where the grants would differ (W2c shadow), until the cut-over.
 */
export const grantsRouter = new Hono<{ Bindings: Env; Variables: { standing?: Standing } }>();
type C = Context<{ Bindings: Env; Variables: { standing?: Standing } }>;

const GiveGrant = z.object({
  holder: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("key"), id: z.string().min(1).max(128) }),
    z.object({ kind: z.literal("person"), email: z.string().email().max(320) }),
  ]),
  mailboxes: z.array(z.string().max(320)).min(1).max(200),
  can: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length),
  limits: z.object({ sendMode: z.enum(["drafts", "send"]).default("send"), dailySendLimit: z.number().int().min(0).max(1000).nullable().default(null),
    ownerApproval: z.boolean().default(false) }).default({}),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  why: z.string().trim().min(1).max(500),
}).strict();

const holderName = (g: Pick<StoredGrant, "holder">) => (g.holder.kind === "key" ? `key:${g.holder.id}` : g.holder.email);
const failure = (c: C, error: unknown) => {
  if (error instanceof GrantsConflict) return c.json({ error: msg("The grants changed at the same time. Try again.") }, 409);
  console.error(JSON.stringify({ event: "grants_failed", error: (error as Error)?.message?.slice(0, 200) }));
  return c.json({ error: msg("The grants could not be saved. Try again.") }, 502);
};

grantsRouter.get("/api/grants", async (c) => {
  c.header("Cache-Control", "no-store");
  try { return c.json({ grants: await readGrants(c.env.BUCKET), max: MAX_GRANTS, decides: false }); }
  catch (error) { return failure(c, error); }
});

grantsRouter.post("/api/grants", async (c) => {
  const parsed = GiveGrant.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Name who gets access, the mailboxes, what they may do and why.") }, 400);
  const actor = actorOf(c.req.raw, c.get("standing")?.email) ?? "local development";
  if (parsed.data.holder.kind === "key" && !(await readAgentKeys(c.env.BUCKET)).some((k) => k.id === (parsed.data.holder as { id: string }).id))
    return c.json({ error: msg("No agent key with that id on this server.") }, 404);
  const candidate = GrantSchema.safeParse({ schema: "grant/1", id: `grant-${crypto.randomUUID()}`, ...parsed.data, grantedBy: actor, grantedAt: new Date().toISOString() });
  if (!candidate.success) return c.json({ error: msg("A mailbox in the list is not one this server can name.") }, 400);
  const grant = candidate.data;
  try {
    await updateGrants(c.env.BUCKET, (all) => [...all, grant]);
    await recordAudit(c.env.BUCKET, actor, { kind: "grant_given", grant: grant.id, holder: holderName(grant), mailboxes: grant.mailboxes, can: grant.can, why: grant.why });
    return c.json({ grant, decides: false }, 201);
  } catch (error) { return failure(c, error); }
});

grantsRouter.delete("/api/grants/:id", async (c) => {
  const id = c.req.param("id");
  const actor = actorOf(c.req.raw, c.get("standing")?.email) ?? "local development";
  let removed: StoredGrant[] = [];
  try {
    await updateGrants(c.env.BUCKET, (all) => {
      // A grant goes with every grant delegated from it (R-4): nothing is left that only it bounded.
      const gone = new Set([id]);
      for (let grew = true; grew;) { grew = false; for (const g of all) if (g.parent && gone.has(g.parent) && !gone.has(g.id)) { gone.add(g.id); grew = true; } }
      removed = all.filter((g) => gone.has(g.id));
      return all.filter((g) => !gone.has(g.id));
    });
  } catch (error) { return failure(c, error); }
  const main = removed.find((g) => g.id === id);
  if (!main) return c.json({ error: msg("No grant with that id.") }, 404);
  await recordAudit(c.env.BUCKET, actor, { kind: "grant_revoked", grant: id, holder: holderName(main), also: removed.filter((g) => g.id !== id).map((g) => g.id) });
  return c.json({ revoked: removed.map((g) => g.id) });
});
