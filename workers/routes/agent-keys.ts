import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { cloudflareApi, CloudflareApiError } from "../routing/cloudflare-api";
import { AgentAccess, TOKEN_DURATIONS, type TokenDuration } from "../mcp/access";
import {
  AgentKeysConflict, DEFAULT_DAILY_SENDS, LEVELS, MAX_DAILY_SENDS, MAX_KEYS, readAgentKeys, SEND_MODES, STANDINGS, updateAgentKeys, type AgentKey,
} from "../mcp/keys";
import { recordAudit } from "../lib/audit";
import { normaliseAccountId } from "../mcp/scope";
import { msg } from "../../shared/i18n";
import type { Standing } from "../lib/members";

/**
 * Agent access (AP-7): the owner issues, lists and revokes the keys agents use on `/mcp`.
 * These routes are for a person in the app: a service token is refused on every path but `/mcp`
 * (workers/app.ts), and no tool of the protocol calls them.
 */
export const agentKeysRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;
/**
 * B-246 W4b (packet D-3a, Delegation): the signed-in architect's email, or null for anyone else. An architect lists and
 * revokes only the keys they made, and makes only keys that ask for access; what such a key reaches is the grants the
 * architect gives it (workers/routes/grants.ts), each held only while the architect's role does.
 */
export const architectOf = (c: Context): string | null => {
  const s = (c as unknown as Context<{ Variables: { standing?: Standing } }>).get("standing");
  return s?.role === "architect" ? s.email : null;
};

/** The signed-in person's email (Access), or null for an agent key or development. */
const signedInEmail = (c: C): string | null => {
  const email = (c as unknown as Context<{ Bindings: Env; Variables: { access?: { email?: unknown } } }>).get("access")?.email;
  return typeof email === "string" && email ? email.toLowerCase() : null;
};

const NewKey = z.object({
  name: z.string().trim().min(1, msg("Name the agent this key is for")).max(80),
  level: z.enum(LEVELS),
  send: z.enum(SEND_MODES).default("drafts"),
  dailySendLimit: z.number().int().min(1).max(MAX_DAILY_SENDS).default(DEFAULT_DAILY_SENDS),
  duration: z.enum(Object.keys(TOKEN_DURATIONS) as [TokenDuration, ...TokenDuration[]]).default("1y"),
  /** Mailboxes this key may reach (AP-11); left out, the whole workspace. */
  accounts: z.array(z.string().max(400)).max(50).optional(),
  /** B-38: "owner" when the owner approves each irreversible action of this key in Agent access. */
  approval: z.enum(["agent", "owner"]).default("agent"),
  /** B-246 W3: a key that reaches no mailbox and may only ask for access; it is a Read key with an empty list. */
  requestOnly: z.boolean().default(false),
}).strict();

export type NewKeyInput = Omit<z.infer<typeof NewKey>, "accounts"> & { accounts: string[] | null };

/** Validates a new key; `accounts` comes back normalised, or null for the whole workspace. */
export function validateNewKey(raw: unknown): { ok: true; value: NewKeyInput } | { ok: false; error: string } {
  const parsed = NewKey.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? msg("Invalid key") };
  const { accounts: asked, ...rest } = parsed.data;
  if (rest.requestOnly) return { ok: true, value: { ...rest, level: "read", send: "drafts", accounts: [] } };
  if (asked === undefined) return { ok: true, value: { ...rest, accounts: null } };
  if (rest.level === "admin") return { ok: false, error: msg("An Admin key manages the whole workspace, so it cannot be limited to mailboxes. Choose Read or Mail.") };
  if (!asked.length) return { ok: false, error: msg("Choose at least one mailbox, or leave the limit out for the whole workspace.") };
  const accounts: string[] = [];
  for (const a of asked) {
    const id = normaliseAccountId(a);
    if (!id) return { ok: false, error: msg('{value} is not an account: use "cloudflare:<address>", "domain:<domain>", "gmail:<id>", "imap:<id>" or "outlook:<id>".', { value: JSON.stringify(a.slice(0, 80)) }) };
    if (!accounts.includes(id)) accounts.push(id);
  }
  return { ok: true, value: { ...rest, accounts } };
}

/**
 * A read key sends nothing. An admin key can make rules and reply agents that send, so "Drafts
 * only" would promise what it cannot hold: an admin key always sends.
 */
export const sendFor = (level: AgentKey["level"], send: AgentKey["send"]): AgentKey["send"] => (level === "read" ? "drafts" : level === "admin" ? "send" : send);

const publicKey = (k: AgentKey) => ({ id: k.id, clientId: k.clientId, name: k.name, level: k.level, send: k.send, dailySendLimit: k.dailySendLimit, createdAt: k.createdAt, expiresAt: k.expiresAt, accounts: k.accounts, approval: k.approval ?? "agent", standing: k.standing ?? [], createdBy: k.createdBy ?? null,
  // B-250: a key that may only ask for access says so in every listing.
  ...(k.requestOnly ? { requestOnly: true } : {}) });

function access(c: C): AgentAccess | Response {
  const api = cloudflareApi(c.env);
  if (!api) return c.json({ error: msg("This server has no Cloudflare token, so it cannot make agent keys. Save one as CLOUDFLARE_API_TOKEN (Domains shows the permissions).") }, 503);
  return new AgentAccess(api, c.env);
}

const KEY_LOCK = "agent-keys";
/** Runs a key change alone; a second one at the same time is told to wait. */
async function alone(c: C, run: () => Promise<Response>): Promise<Response> {
  const ledger = c.env.EMAIL_MCP.getByName("workspace");
  const holder = crypto.randomUUID();
  if (!(await ledger.acquireLock(KEY_LOCK, holder, 60_000))) return c.json({ error: msg("Another agent key is being made or revoked; try again in a moment.") }, 409);
  try { return await run(); }
  finally { await ledger.releaseLock(KEY_LOCK, holder).catch(() => {}); }
}

function failure(c: C, error: unknown, action: string) {
  if (error instanceof AgentKeysConflict) return c.json({ error: error.message }, 409);
  // A refusal of the token is the owner's to fix (403, with the permission named); Cloudflare being down is 502.
  if (error instanceof CloudflareApiError) return c.json({ error: error.message }, error.status === 404 ? 404 : error.status === 400 || error.status === 409 ? error.status : error.status === 401 || error.status === 403 ? 403 : 502);
  console.error(JSON.stringify({ event: "agent_keys_failed", action, error: (error as Error)?.message?.slice(0, 300) }));
  return c.json({ error: msg("{action} could not be completed: {error}. Try again.", { action, error: ((error as Error)?.message ?? msg("unknown error")).replace(/[.\s]+$/, "") }) }, 502);
}

/** Ready-to-paste client setups. They carry the secret, so they are returned once, with it. */
export function clientConfigs(mcpUrl: string, clientId: string, clientSecret: string) {
  const headers = { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret };
  return {
    // Stores the secret in Claude Code's own config (~/.claude.json) and the shell's history.
    claudeCode: `claude mcp add --transport http fabric-inbox ${mcpUrl} --header "CF-Access-Client-Id: ${clientId}" --header "CF-Access-Client-Secret: ${clientSecret}"`,
    json: { mcpServers: { "fabric-inbox": { type: "http", url: mcpUrl, headers } } },
    // Keeps the secret out of every file: the client reads it from the environment when it connects.
    jsonFromEnvironment: { mcpServers: { "fabric-inbox": { type: "http", url: mcpUrl, headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": "${FABRIC_INBOX_CLIENT_SECRET}" } } } },
  };
}

agentKeysRouter.get("/api/agent-keys", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const architect = architectOf(c);
    const keys = (await readAgentKeys(c.env.BUCKET)).filter((k) => !architect || k.createdBy === architect);
    return c.json({ keys: keys.map(publicKey), mcpUrl: `${new URL(c.req.url).origin}/mcp`, levels: LEVELS, durations: Object.keys(TOKEN_DURATIONS), canIssue: !!cloudflareApi(c.env) });
  } catch (error) { return failure(c, error, msg("Reading the agent keys")); }
});

agentKeysRouter.post("/api/agent-keys", async (c) => {
  c.header("Cache-Control", "no-store");
  const parsed = validateNewKey(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const input = parsed.value;
  if (architectOf(c) && !input.requestOnly)
    return c.json({ error: msg("An architect makes keys that ask for access; give the key its access afterwards.") }, 403);
  const cf = access(c);
  if (cf instanceof Response) return cf;
  return alone(c, async () => {
  if ((await readAgentKeys(c.env.BUCKET)).length >= MAX_KEYS) return c.json({ error: msg("At most {max} agent keys; revoke one first", { max: MAX_KEYS }) }, 400);
  let token: Awaited<ReturnType<AgentAccess["create"]>>;
  try { token = await cf.create(input.name, input.duration); }
  catch (error) { return failure(c, error, msg("Making the key in Cloudflare")); }
  const key: AgentKey = {
    id: token.id, clientId: token.client_id, name: input.name, level: input.level, send: sendFor(input.level, input.send),
    dailySendLimit: input.dailySendLimit, createdAt: new Date().toISOString(), expiresAt: token.expires_at ?? null, accounts: input.accounts,
    ...(input.approval === "owner" ? { approval: "owner" as const } : {}),
    ...(signedInEmail(c) ? { createdBy: signedInEmail(c)! } : {}),
    ...(input.requestOnly ? { requestOnly: true as const } : {}),
  };
  try {
    await updateAgentKeys(c.env.BUCKET, (keys) => [...keys.filter((k) => k.id !== key.id), key]);
  } catch (error) {
    // The server does not know this token, so it must not exist either.
    await cf.revoke(token.id).catch((e) => console.error(JSON.stringify({ event: "agent_key_rollback_failed", tokenId: token.id, error: String(e) })));
    return failure(c, error, msg("Saving the key"));
  }
  console.log(JSON.stringify({ event: "agent_key_created", keyId: key.id, level: key.level, send: key.send, limitedTo: key.accounts?.length ?? null }));
  const mcpUrl = `${new URL(c.req.url).origin}/mcp`;
  return c.json({ key: publicKey(key), clientSecret: token.client_secret, mcpUrl, configs: clientConfigs(mcpUrl, token.client_id, token.client_secret) }, 201);
  });
});

agentKeysRouter.delete("/api/agent-keys/:id", (c) => alone(c, async () => {
  const id = c.req.param("id");
  const architect = architectOf(c);
  let removed: AgentKey | undefined;
  let notTheirs = false;
  try {
    // Out of the registry first: the key stops working on this server at once.
    await updateAgentKeys(c.env.BUCKET, (keys) => {
      removed = keys.find((k) => k.id === id);
      // B-246 W4b: an architect revokes only the keys they made.
      if (removed && architect && removed.createdBy !== architect) { notTheirs = true; removed = undefined; return keys; }
      return keys.filter((k) => k.id !== id);
    });
  } catch (error) { return failure(c, error, msg("Revoking the key")); }
  if (notTheirs) return c.json({ error: msg("An architect revokes only the keys and access they gave.") }, 403);
  if (!removed) return c.json({ error: msg("No such agent key") }, 404);
  console.log(JSON.stringify({ event: "agent_key_revoked", keyId: id }));
  const cf = access(c);
  if (cf instanceof Response) return c.json({ revoked: id, warning: msg("The key no longer works here, but its token could not be deleted in Cloudflare (no token on the server); delete it in Zero Trust → Service credentials.") });
  try { await cf.revoke(id); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return c.json({ revoked: id, warning: msg("The key no longer works here, but Cloudflare did not delete its token: {reason} Delete it in Zero Trust → Service credentials.", { reason }) });
  }
  return c.json({ revoked: id });
}));

/**
 * B-38: turn the owner's approval of a key's irreversible actions on or off. B-215: set what the key may do without
 * the owner's approval that people and keys otherwise always wait for (`standing`, an Admin key's only). Nothing
 * else of a key changes here, and no tool reaches this route (NOT_TOOLS): only the owner trusts a key.
 */
agentKeysRouter.patch("/api/agent-keys/:id", (c) => alone(c, async () => {
  const raw = await c.req.json().catch(() => null) as { standing?: unknown } | null;
  const body = z.object({ approval: z.enum(["agent", "owner"]).optional(), standing: z.array(z.enum(STANDINGS)).max(10).optional() })
    .refine((b) => b.approval !== undefined || b.standing !== undefined).safeParse(raw);
  if (!body.success) return c.json({ error: raw && raw.standing !== undefined
    ? msg("A key can manage people and keys without you, nothing else: standing [\"people\", \"keys\"].")
    : msg("Say whether you approve this key's irreversible actions: approval \"owner\" or \"agent\".") }, 400);
  const id = c.req.param("id");
  const standing = body.data.standing ? STANDINGS.filter((x) => body.data.standing!.includes(x)) : undefined;
  let changed: AgentKey | undefined;
  let before: AgentKey | undefined;
  let notAdmin = false;
  try {
    await updateAgentKeys(c.env.BUCKET, (keys) => keys.map((k) => {
      if (k.id !== id) return k;
      before = k;
      if (standing?.length && k.level !== "admin") { notAdmin = true; return k; }
      let next: AgentKey = k;
      if (body.data.approval !== undefined) {
        const { approval: _old, ...rest } = next;
        next = body.data.approval === "owner" ? { ...rest, approval: "owner" } : rest;
      }
      if (standing !== undefined) {
        const { standing: _old, ...rest } = next;
        next = standing.length ? { ...rest, standing } : rest;
      }
      changed = next;
      return next;
    }));
  } catch (error) { return failure(c, error, msg("Saving the key")); }
  if (notAdmin) return c.json({ error: msg("Only an Admin key can manage people and keys without asking you.") }, 400);
  if (!changed) return c.json({ error: msg("No such agent key") }, 404);
  // A code this key was given before the switch no longer works on its own (review 2026-10-24); so too a code it got
  // by a standing permission now taken away.
  const lost = (before?.standing ?? []).some((x) => !(changed!.standing ?? []).includes(x));
  if (body.data.approval === "owner" || lost) await c.env.EMAIL_MCP.getByName("workspace").dropSelfConfirmations(`key:${id}`);
  if (standing !== undefined && (before?.standing ?? []).join(",") !== standing.join(","))
    await recordAudit(c.env.BUCKET, signedInEmail(c) ?? null, { kind: "key_standing_set", key: id, name: changed.name, standing, previous: before?.standing ?? [] });
  console.log(JSON.stringify({ event: "agent_key_approval", keyId: id, approval: changed.approval ?? "agent", standing: changed.standing ?? [] }));
  return c.json({ key: publicKey(changed) });
}));

/** B-38: the irreversible actions agents asked for that wait for the owner, and approved ones not yet used. */
agentKeysRouter.get("/api/agent-keys/approvals", async (c) => {
  c.header("Cache-Control", "no-store");
  try { return c.json({ approvals: await c.env.EMAIL_MCP.getByName("workspace").pendingApprovals() }); }
  catch (error) { return failure(c, error, msg("Reading what waits for your approval")); }
});

/** B-38: the owner approves (the agent's code then works once) or refuses (the code is deleted). */
agentKeysRouter.post("/api/agent-keys/approvals/:code", async (c) => {
  c.header("Cache-Control", "no-store");
  const body = z.object({ approve: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: msg("Say approve: true or false.") }, 400);
  try {
    const done = await c.env.EMAIL_MCP.getByName("workspace").decideApproval(c.req.param("code"), body.data.approve);
    if (!done) return c.json({ error: msg("Nothing is waiting under that code: it expired, or was answered already.") }, 404);
    console.log(JSON.stringify({ event: "agent_action_decided", approved: body.data.approve }));
    return c.json({ approved: body.data.approve });
  } catch (error) { return failure(c, error, msg("Saving your answer")); }
});

agentKeysRouter.get("/api/agent-keys/journal", async (c) => {
  c.header("Cache-Control", "no-store");
  const before = Number(c.req.query("before")) || undefined;
  const cursor = Number(c.req.query("cursor")) || undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  try {
    const entries = await c.env.EMAIL_MCP.getByName("workspace").journal({ before, cursor, limit });
    const last = entries.length === limit ? entries[entries.length - 1]! : null;
    // nextCursor (the last entry's id) never skips entries sharing a millisecond (B-50); nextBefore is the older form.
    return c.json({ entries, nextCursor: last ? last.id : null, nextBefore: last ? last.at : null });
  } catch (error) { return failure(c, error, msg("Reading what agents changed")); }
});

/**
 * N-4: the keys a person made stop working when they leave the server or stop being its administrator: out of the
 * registry at once, and their Cloudflare tokens deleted (a failure there is said, the key already works nowhere here).
 */
export async function revokeKeysOf(env: Env, email: string): Promise<{ revoked: string[]; warning?: string }> {
  const who = email.toLowerCase();
  let removed: AgentKey[] = [];
  await updateAgentKeys(env.BUCKET, (keys) => { removed = keys.filter((k) => k.createdBy === who); return keys.filter((k) => k.createdBy !== who); });
  if (!removed.length) return { revoked: [] };
  console.log(JSON.stringify({ event: "agent_keys_revoked_with_person", count: removed.length }));
  const api = cloudflareApi(env);
  if (!api) return { revoked: removed.map((k) => k.id), warning: msg("Their keys no longer work here, but their tokens could not be deleted in Cloudflare (no token on the server); delete them in Zero Trust → Service credentials.") };
  const cf = new AgentAccess(api, env);
  const failed = (await Promise.allSettled(removed.map((k) => cf.revoke(k.id)))).filter((r) => r.status === "rejected").length;
  return { revoked: removed.map((k) => k.id), ...(failed ? { warning: msg("Their keys no longer work here, but Cloudflare did not delete {count} of their tokens; delete them in Zero Trust → Service credentials.", { count: failed }) } : {}) };
}
