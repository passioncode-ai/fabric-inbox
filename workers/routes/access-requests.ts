import { Hono, type Context } from "hono";
import { z } from "zod";
import { KEY_DAILY_SENDS } from "../../shared/mail/send-limits";
import type { Env } from "../types";
import type { Standing } from "../lib/members";
import { msg } from "../../shared/i18n";
import { actorOf, recordAudit } from "../lib/audit";
import { readAgentKeys } from "../mcp/keys";
import { AccessRequestSchema, CAPABILITIES, GrantSchema, REQUEST_TTL_MS, admitRequest, decide, isSubset, type AccessRequest } from "../mcp/grants";
import { readGrants, updateGrants, GrantsConflict } from "../mcp/grant-store";
import { readRequests, RequestsConflict, updateRequests } from "../mcp/access-requests";

/**
 * B-246 W3 (D-4, SCN-100): an agent key asks for access to mailboxes; the owner or an administrator approves it (as asked
 * or narrowed), or refuses it. An approval makes a grant for that key (grant/1). The asking routes take the key from
 * the protocol's caller id, never from the body; the deciding ones are an administrator's (member-gate refuses members).
 */
export const accessRequestsRouter = new Hono<{ Bindings: Env; Variables: { standing?: Standing } }>();
type C = Context<{ Bindings: Env; Variables: { standing?: Standing } }>;

const Ask = z.object({
  mailboxes: z.array(z.string().max(320)).min(1).max(200),
  can: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length),
  why: z.string().trim().min(1).max(500),
  until: z.string().datetime({ offset: true }).nullable().default(null),
  board: z.object({ project: z.string().min(1).max(192), message: z.string().min(8).max(128) }).optional(),
}).strict();
const Decision = z.object({
  verdict: z.enum(["approve", "refuse"]),
  /** Narrowing: a subset of what was asked; left out, as asked. */
  mailboxes: z.array(z.string().max(320)).min(1).max(200).optional(),
  can: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

/** The asking key's id, from the protocol's caller id (`key:<id>`); null for a person. */
const keyOf = (c: C): string | null => { const a = actorOf(c.req.raw, c.get("standing")?.email); return a?.startsWith("key:") ? a.slice(4) : null; };
const failure = (c: C, error: unknown) => {
  if (error instanceof RequestsConflict || error instanceof GrantsConflict) return c.json({ error: msg("The access requests changed at the same time. Try again.") }, 409);
  console.error(JSON.stringify({ event: "access_requests_failed", error: (error as Error)?.message?.slice(0, 200) }));
  return c.json({ error: msg("The access request could not be saved. Try again.") }, 502);
};

accessRequestsRouter.post("/api/access-requests", async (c) => {
  const keyId = keyOf(c);
  if (!keyId) return c.json({ error: msg("Only an agent key asks for access; a person is given it in Agent access.") }, 400);
  const parsed = Ask.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Name the mailboxes, what the key may do on them and why.") }, 400);
  const now = new Date();
  const candidate = AccessRequestSchema.safeParse({ schema: "access-request/1", id: `req-${crypto.randomUUID()}`, holder: { kind: "key", id: keyId }, ...parsed.data,
    requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(), state: "waiting" });
  if (!candidate.success) return c.json({ error: msg("A mailbox in the list is not one this server can name.") }, 400);
  const asked = candidate.data;
  try {
    type Answer = { status: 200 | 201 | 429; request: AccessRequest | null };
    const answer = await updateRequests<Answer>(c.env.BUCKET, (all) => {
      const admitted = admitRequest(all, asked, now);
      if (admitted.outcome === "repeat") return { next: all, result: { status: 200, request: all.find((r) => r.id === admitted.id) ?? null } };
      if (admitted.outcome === "too_many") return { next: all, result: { status: 429, request: null } };
      return { next: [...all, asked], result: { status: 201, request: asked } };
    }, now);
    if (answer.status === 429) return c.json({ error: msg("This key already has 10 requests waiting. Wait for a decision first.") }, 429);
    if (answer.status === 201) console.log(JSON.stringify({ event: "access_requested", request: asked.id, key: keyId, mailboxes: asked.mailboxes.length, can: asked.can }));
    return c.json({ request: answer.request, repeated: answer.status === 200 }, answer.status === 201 ? 201 : 200);
  } catch (error) { return failure(c, error); }
});

/** What the asking key holds now: its key's level and limit, its grants, its requests. */
accessRequestsRouter.get("/api/my-access", async (c) => {
  c.header("Cache-Control", "no-store");
  const keyId = keyOf(c);
  if (!keyId) return c.json({ error: msg("Only an agent key reads its own access here.") }, 400);
  try {
    const key = (await readAgentKeys(c.env.BUCKET)).find((k) => k.id === keyId);
    const grants = (await readGrants(c.env.BUCKET)).filter((g) => g.holder.kind === "key" && g.holder.id === keyId);
    const requests = (await readRequests(c.env.BUCKET)).filter((r) => r.holder.id === keyId);
    return c.json({ key: key ? { id: key.id, name: key.name, level: key.level, send: key.send, accounts: key.accounts, requestOnly: !!key.requestOnly } : null,
      grants, requests, decides: false });
  } catch (error) { return failure(c, error); }
});

accessRequestsRouter.get("/api/access-requests", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const all = await readRequests(c.env.BUCKET);
    const keys = await readAgentKeys(c.env.BUCKET).catch(() => []);
    const named = all.map((r) => ({ ...r, keyName: keys.find((k) => k.id === r.holder.id)?.name ?? null }));
    return c.json({ requests: [...named.filter((r) => r.state === "waiting"), ...named.filter((r) => r.state !== "waiting").reverse()] });
  } catch (error) { return failure(c, error); }
});

accessRequestsRouter.post("/api/access-requests/:id/decision", async (c) => {
  const id = c.req.param("id");
  const parsed = Decision.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Approve or refuse, and narrow it only to part of what was asked.") }, 400);
  const actor = actorOf(c.req.raw, c.get("standing")?.email) ?? "local development";
  const now = new Date();
  try {
    const request = (await readRequests(c.env.BUCKET, now)).find((r) => r.id === id);
    if (!request) return c.json({ error: msg("No access request with that id.") }, 404);
    if (request.state !== "waiting") return c.json({ error: msg("This request was already decided, or it expired."), request }, 409);
    let grantId: string | undefined;
    if (parsed.data.verdict === "approve") {
      const grant = GrantSchema.safeParse({ schema: "grant/1", id: `grant-${crypto.randomUUID()}`, holder: request.holder,
        mailboxes: parsed.data.mailboxes ?? request.mailboxes, can: parsed.data.can ?? request.can,
        limits: { sendMode: "send", dailySendLimit: KEY_DAILY_SENDS.default, ownerApproval: false }, expiresAt: request.until, grantedBy: actor, grantedAt: now.toISOString(), why: request.why });
      if (!grant.success) return c.json({ error: msg("A mailbox in the list is not one this server can name.") }, 400);
      // Narrowing only: never more than was asked (D-2), so an approval cannot widen a request.
      if (!isSubset(grant.data, { mailboxes: request.mailboxes, can: request.can, limits: grant.data.limits, expiresAt: request.until }))
        return c.json({ error: msg("Approve or refuse, and narrow it only to part of what was asked.") }, 400);
      await updateGrants(c.env.BUCKET, (all) => [...all, grant.data]);
      grantId = grant.data.id;
    }
    const decided = await updateRequests<AccessRequest | null>(c.env.BUCKET, (all) => {
      const current = all.find((r) => r.id === id);
      const next = current ? decide(current, parsed.data.verdict === "approve" ? "approved" : "refused", actor, now, { note: parsed.data.note, grant: grantId }) : null;
      return { next: next ? all.map((r) => (r.id === id ? next : r)) : all, result: next };
    }, now);
    if (!decided) {
      // Decided by someone else in between: the grant made for this decision goes again (a decision is taken once, R-3).
      if (grantId) await updateGrants(c.env.BUCKET, (all) => all.filter((g) => g.id !== grantId));
      return c.json({ error: msg("This request was already decided, or it expired.") }, 409);
    }
    if (grantId) await recordAudit(c.env.BUCKET, actor, { kind: "grant_given", grant: grantId, holder: `key:${request.holder.id}`, mailboxes: parsed.data.mailboxes ?? request.mailboxes,
      can: parsed.data.can ?? request.can, why: request.why });
    console.log(JSON.stringify({ event: "access_request_decided", request: id, verdict: decided.state }));
    return c.json({ request: decided, grant: grantId ?? null });
  } catch (error) { return failure(c, error); }
});

export type { AccessRequest };
