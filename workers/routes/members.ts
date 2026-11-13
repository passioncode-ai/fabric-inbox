import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { LEVELS, levelsFor, MAX_MEMBERS, MembersError, normaliseEmail, readMembers, ROLES, updateMembers, forgetMembers, type Member, type Standing } from "../lib/members";
import { normaliseAccountId } from "../mcp/scope";
import { msg } from "../../shared/i18n";
import { revokeKeysOf } from "./agent-keys";
import { actorOf, readAudit, recordAudit } from "../lib/audit";
import { emailsOf, readSignIn, signInOf, syncSignIn } from "../lib/people-access";

/**
 * People on a shared server (B-149): who signs in as an administrator and who as a member with their
 * own mailboxes. Each change also lets the listed people through the server's sign-in (B-215, lib/people-access.ts). Only an administrator reaches these routes (workers/app.ts, workers/lib/member-gate.ts);
 * agent keys never do: who may read whose mail is a person's act, like agent keys.
 */
export const membersRouter = new Hono<{ Bindings: Env; Variables: { standing?: Standing } }>();
type C = Context<{ Bindings: Env; Variables: { standing?: Standing } }>;

const SaveMember = z.object({
  role: z.enum(ROLES),
  accounts: z.array(z.string().max(400)).max(50).optional(),
  /** B-160: a level per mailbox of `accounts`; a mailbox not named is send. */
  levels: z.record(z.string().max(400), z.enum(LEVELS)).optional(),
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
  return c.json({ role: s.role, email: s.email, accounts: s.role === "member" ? s.accounts : null, levels: s.role === "member" ? s.levels : null,
    listed: s.role === "admin" ? s.listed : true });
});

membersRouter.get("/api/members", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const members = await readMembers(c.env.BUCKET);
    // B-215: whether each listed person can sign in, by the last sync of the server's people policy.
    const signIn = await readSignIn(c.env.BUCKET).catch(() => null);
    // B-246 W4: the roles a person may be given here; Architect only with ROLE_GRANTS on.
    const roles = c.env.ROLE_GRANTS === "on" ? ROLES : ROLES.filter((r) => r !== "architect");
    return c.json({ members: members.map((m) => ({ ...m, signIn: signInOf(signIn, m.email) })), open: members.length === 0, you: c.get("standing")?.email ?? null, max: MAX_MEMBERS, roles,
      signIn: signIn ? { state: signIn.state, at: signIn.at, ...(signIn.reason ? { reason: signIn.reason } : {}) } : null });
  } catch (error) { return failure(c, error); }
});

membersRouter.put("/api/members/:email", async (c) => {
  const email = normaliseEmail(decodeURIComponent(c.req.param("email")));
  if (!email) return c.json({ error: msg("Enter an email address.") }, 400);
  const parsed = SaveMember.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Choose Administrator or Member.") }, 400);
  // B-246 W4 (D-3a): an architect is given only where roles are on; off, the role would reach nothing.
  if (parsed.data.role === "architect" && c.env.ROLE_GRANTS !== "on")
    return c.json({ error: msg("This server does not give the Architect role yet. Choose Administrator or Member.") }, 400);
  let accounts: string[] | null = null;
  if (parsed.data.role === "member") {
    // A member names mailboxes only: a whole-domain entry (B-36, agent keys) is not a member's.
    accounts = [...new Set((parsed.data.accounts ?? []).map(normaliseAccountId).filter((a): a is string => !!a && !a.startsWith("domain:")))];
    if (!accounts.length) return c.json({ error: msg("Choose at least one mailbox for a member.") }, 400);
  }
  // B-160: a level for a mailbox the member is not given is refused, not dropped: the caller meant something else.
  const named = Object.keys(parsed.data.levels ?? {}).map((k) => (k.includes(":") ? k : `cloudflare:${k}`).toLowerCase());
  if (named.some((k) => !accounts?.some((a) => a.toLowerCase() === k)))
    return c.json({ error: msg("A level is for one of the member's own mailboxes.") }, 400);
  const levels = accounts ? levelsFor(accounts, Object.fromEntries(Object.entries(parsed.data.levels ?? {}).map(([k, v]) => [k.includes(":") ? k : `cloudflare:${k}`, v]))) : {};
  try {
    let previous: Member | undefined;
    const members = await updateMembers(c.env.BUCKET, (list) => {
      const old = list.find((m) => m.email === email);
      previous = old;
      const entry: Member = { email, role: parsed.data.role, accounts, ...(Object.keys(levels).length ? { levels } : {}), addedAt: old?.addedAt ?? new Date().toISOString() };
      return old ? list.map((m) => (m.email === email ? entry : m)) : [...list, entry];
    }, c.get("standing")?.email ?? null);
    forgetMembers();
    const at = (l: Record<string, string> | undefined, level: string) => Object.keys(l ?? {}).filter((a) => l![a] === level);
    console.log(JSON.stringify({ event: "member_saved", role: parsed.data.role, mailboxes: accounts?.length ?? null, readOnly: at(levels, "read").length, agents: at(levels, "agents").length }));
    // B-156: who changed whom, kept. The first person added also lists the editor (updateMembers): that is part of this act.
    const actor = actorOf(c.req.raw, c.get("standing")?.email);
    await recordAudit(c.env.BUCKET, actor, { kind: "member_saved", person: email, role: parsed.data.role, mailboxes: accounts,
      ...(at(levels, "read").length ? { readOnly: at(levels, "read") } : {}), ...(at(levels, "agents").length ? { agents: at(levels, "agents") } : {}),
      previous: previous ? { role: previous.role, mailboxes: previous.accounts, ...(at(previous.levels, "read").length ? { readOnly: at(previous.levels, "read") } : {}),
        ...(at(previous.levels, "agents").length ? { agents: at(previous.levels, "agents") } : {}) } : null });
    // B-215: the listed people can sign in, with nothing done in Cloudflare by hand.
    const signIn = signInAnswer(await syncSignIn(c.env, emailsOf(members)), email);
    // N-4: a member makes no keys; the keys they made as an administrator go when they become one. A person who becomes
    // an architect starts with none too (B-246 W4b): the keys an architect then makes reach only what they give them,
    // so saving an architect again keeps those.
    if (parsed.data.role === "member" || (parsed.data.role === "architect" && previous?.role !== "architect")) {
      const keys = await revokeKeysOf(c.env, email).catch((error: unknown) => ({ revoked: [] as string[], warning: (error as Error).message }));
      if (keys.revoked.length) await recordAudit(c.env.BUCKET, actor, { kind: "keys_revoked", person: email, keys: keys.revoked });
      return c.json({ members, signIn, revokedKeys: keys.revoked, ...(keys.warning ? { warning: keys.warning } : {}) });
    }
    return c.json({ members, signIn });
  } catch (error) { return failure(c, error); }
});

membersRouter.delete("/api/members/:email", async (c) => {
  const email = normaliseEmail(decodeURIComponent(c.req.param("email")));
  if (!email) return c.json({ error: msg("Enter an email address.") }, 400);
  try {
    let found: Member | undefined;
    const members = await updateMembers(c.env.BUCKET, (list) => { found = list.find((m) => m.email === email); return list.filter((m) => m.email !== email); }, null);
    if (!found) return c.json({ error: msg("{email} is not on the list.", { email }) }, 404);
    forgetMembers();
    console.log(JSON.stringify({ event: "member_removed" }));
    const actor = actorOf(c.req.raw, c.get("standing")?.email);
    await recordAudit(c.env.BUCKET, actor, { kind: "member_removed", person: email, previous: { role: found.role, mailboxes: found.accounts } });
    // N-4: the keys they made leave with them.
    const keys = await revokeKeysOf(c.env, email).catch((error: unknown) => ({ revoked: [] as string[], warning: (error as Error).message }));
    if (keys.revoked.length) await recordAudit(c.env.BUCKET, actor, { kind: "keys_revoked", person: email, keys: keys.revoked });
    // B-215: their sign-in goes with them.
    const synced = await syncSignIn(c.env, emailsOf(members));
    return c.json({ members, signIn: { state: synced.state, ...(synced.reason ? { reason: synced.reason } : {}) }, revokedKeys: keys.revoked, ...(keys.warning ? { warning: keys.warning } : {}) });
  } catch (error) { return failure(c, error); }
});

/** B-215: Try again: the server's people policy rewritten from the list as it is now. */
membersRouter.post("/api/members/sign-in", async (c) => {
  try {
    const members = await readMembers(c.env.BUCKET);
    const synced = await syncSignIn(c.env, emailsOf(members));
    return c.json({ state: synced.state, at: synced.at, people: synced.emails.length, ...(synced.reason ? { reason: synced.reason } : {}) }, synced.state === "failed" ? 502 : 200);
  } catch (error) { return failure(c, error); }
});

/** What a save answers about the person's sign-in. */
function signInAnswer(state: Awaited<ReturnType<typeof syncSignIn>>, email: string) {
  return { state: state.state, ...signInOf(state, email) };
}

/** B-156: the audit record, newest first: changes to the list of people and what members sent. An administrator's. */
membersRouter.get("/api/audit", async (c) => {
  c.header("Cache-Control", "no-store");
  const limit = Number(c.req.query("limit") ?? 50);
  try {
    return c.json(await readAudit(c.env.BUCKET, { limit: Number.isFinite(limit) ? limit : 50, cursor: c.req.query("cursor") || undefined }));
  } catch (error) {
    console.error(JSON.stringify({ event: "audit_read_failed", error: (error as Error)?.message?.slice(0, 200) }));
    return c.json({ error: msg("The record of changes could not be read. Try again.") }, 502);
  }
});
