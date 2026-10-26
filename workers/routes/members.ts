import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { MAX_MEMBERS, MembersError, normaliseEmail, readMembers, ROLES, updateMembers, forgetMembers, type Member, type Standing } from "../lib/members";
import { normaliseAccountId } from "../mcp/scope";
import { msg } from "../../shared/i18n";
import { revokeKeysOf } from "./agent-keys";

/**
 * People on a shared server (B-149): who signs in as an administrator and who as a member with their
 * own mailboxes. Only an administrator reaches these routes (workers/app.ts, workers/lib/member-gate.ts);
 * agent keys never do: who may read whose mail is a person's act, like agent keys.
 */
export const membersRouter = new Hono<{ Bindings: Env; Variables: { standing?: Standing } }>();
type C = Context<{ Bindings: Env; Variables: { standing?: Standing } }>;

const SaveMember = z.object({
  role: z.enum(ROLES),
  accounts: z.array(z.string().max(400)).max(50).optional(),
}).strict();

const failure = (c: C, error: unknown) => {
  if (error instanceof MembersError) return c.json({ error: error.message }, error.status as 409);
  console.error(JSON.stringify({ event: "members_failed", error: (error as Error)?.message?.slice(0, 200) }));
  return c.json({ error: msg("The list of people could not be saved. Try again.") }, 502);
};

/** Who the signed-in person is here. Without Access (local development) they are the administrator. */
membersRouter.get("/api/me", (c) => {
  c.header("Cache-Control", "no-store");
  const s = c.get("standing");
  if (!s) return c.json({ role: "admin", email: null, accounts: null, listed: false });
  return c.json({ role: s.role, email: s.email, accounts: s.role === "member" ? s.accounts : null, listed: s.role === "admin" ? s.listed : true });
});

membersRouter.get("/api/members", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const members = await readMembers(c.env.BUCKET);
    return c.json({ members, open: members.length === 0, you: c.get("standing")?.email ?? null, max: MAX_MEMBERS });
  } catch (error) { return failure(c, error); }
});

membersRouter.put("/api/members/:email", async (c) => {
  const email = normaliseEmail(decodeURIComponent(c.req.param("email")));
  if (!email) return c.json({ error: msg("Enter an email address.") }, 400);
  const parsed = SaveMember.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Choose Administrator or Member.") }, 400);
  let accounts: string[] | null = null;
  if (parsed.data.role === "member") {
    // A member names mailboxes only: a whole-domain entry (B-36, agent keys) is not a member's.
    accounts = [...new Set((parsed.data.accounts ?? []).map(normaliseAccountId).filter((a): a is string => !!a && !a.startsWith("domain:")))];
    if (!accounts.length) return c.json({ error: msg("Choose at least one mailbox for a member.") }, 400);
  }
  try {
    const members = await updateMembers(c.env.BUCKET, (list) => {
      const old = list.find((m) => m.email === email);
      const entry: Member = { email, role: parsed.data.role, accounts, addedAt: old?.addedAt ?? new Date().toISOString() };
      return old ? list.map((m) => (m.email === email ? entry : m)) : [...list, entry];
    }, c.get("standing")?.email ?? null);
    forgetMembers();
    console.log(JSON.stringify({ event: "member_saved", role: parsed.data.role, mailboxes: accounts?.length ?? null }));
    // N-4: a member makes no keys; the keys they made as an administrator go when they become one.
    if (parsed.data.role === "member") {
      const keys = await revokeKeysOf(c.env, email).catch((error: unknown) => ({ revoked: [] as string[], warning: (error as Error).message }));
      return c.json({ members, revokedKeys: keys.revoked, ...(keys.warning ? { warning: keys.warning } : {}) });
    }
    return c.json({ members });
  } catch (error) { return failure(c, error); }
});

membersRouter.delete("/api/members/:email", async (c) => {
  const email = normaliseEmail(decodeURIComponent(c.req.param("email")));
  if (!email) return c.json({ error: msg("Enter an email address.") }, 400);
  try {
    let found = false;
    const members = await updateMembers(c.env.BUCKET, (list) => { found = list.some((m) => m.email === email); return list.filter((m) => m.email !== email); }, null);
    if (!found) return c.json({ error: msg("{email} is not on the list.", { email }) }, 404);
    forgetMembers();
    console.log(JSON.stringify({ event: "member_removed" }));
    // N-4: the keys they made leave with them.
    const keys = await revokeKeysOf(c.env, email).catch((error: unknown) => ({ revoked: [] as string[], warning: (error as Error).message }));
    return c.json({ members, revokedKeys: keys.revoked, ...(keys.warning ? { warning: keys.warning } : {}) });
  } catch (error) { return failure(c, error); }
});
