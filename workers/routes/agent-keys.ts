import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { cloudflareApi, CloudflareApiError } from "../routing/cloudflare-api";
import { AgentAccess, TOKEN_DURATIONS, type TokenDuration } from "../mcp/access";
import {
  AgentKeysConflict, DEFAULT_DAILY_SENDS, LEVELS, MAX_DAILY_SENDS, MAX_KEYS, readAgentKeys, SEND_MODES, updateAgentKeys, type AgentKey,
} from "../mcp/keys";
import { normaliseAccountId } from "../mcp/scope";

/**
 * Agent access (AP-7): the owner issues, lists and revokes the keys agents use on `/mcp`.
 * These routes are for a person in the app: a service token is refused on every path but `/mcp`
 * (workers/app.ts), and no tool of the protocol calls them.
 */
export const agentKeysRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const NewKey = z.object({
  name: z.string().trim().min(1, "Name the agent this key is for").max(80),
  level: z.enum(LEVELS),
  send: z.enum(SEND_MODES).default("drafts"),
  dailySendLimit: z.number().int().min(1).max(MAX_DAILY_SENDS).default(DEFAULT_DAILY_SENDS),
  duration: z.enum(Object.keys(TOKEN_DURATIONS) as [TokenDuration, ...TokenDuration[]]).default("1y"),
  /** Mailboxes this key may reach (AP-11); left out, the whole workspace. */
  accounts: z.array(z.string().max(400)).max(50).optional(),
}).strict();

export type NewKeyInput = Omit<z.infer<typeof NewKey>, "accounts"> & { accounts: string[] | null };

/** Validates a new key; `accounts` comes back normalised, or null for the whole workspace. */
export function validateNewKey(raw: unknown): { ok: true; value: NewKeyInput } | { ok: false; error: string } {
  const parsed = NewKey.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid key" };
  const { accounts: asked, ...rest } = parsed.data;
  if (asked === undefined) return { ok: true, value: { ...rest, accounts: null } };
  if (rest.level === "admin") return { ok: false, error: "An Admin key manages the whole workspace, so it cannot be limited to mailboxes. Choose Read or Mail." };
  if (!asked.length) return { ok: false, error: "Choose at least one mailbox, or leave the limit out for the whole workspace." };
  const accounts: string[] = [];
  for (const a of asked) {
    const id = normaliseAccountId(a);
    if (!id) return { ok: false, error: `${JSON.stringify(a.slice(0, 80))} is not an account: use "cloudflare:<address>" or "gmail:<id>".` };
    if (!accounts.includes(id)) accounts.push(id);
  }
  return { ok: true, value: { ...rest, accounts } };
}

/**
 * A read key sends nothing. An admin key can make rules and reply agents that send, so "Drafts
 * only" would promise what it cannot hold: an admin key always sends.
 */
export const sendFor = (level: AgentKey["level"], send: AgentKey["send"]): AgentKey["send"] => (level === "read" ? "drafts" : level === "admin" ? "send" : send);

const publicKey = (k: AgentKey) => ({ id: k.id, clientId: k.clientId, name: k.name, level: k.level, send: k.send, dailySendLimit: k.dailySendLimit, createdAt: k.createdAt, expiresAt: k.expiresAt, accounts: k.accounts });

function access(c: C): AgentAccess | Response {
  const api = cloudflareApi(c.env);
  if (!api) return c.json({ error: "This server has no Cloudflare token, so it cannot make agent keys. Save one as CLOUDFLARE_API_TOKEN (Domains shows the permissions)." }, 503);
  return new AgentAccess(api, c.env);
}

const KEY_LOCK = "agent-keys";
/** Runs a key change alone; a second one at the same time is told to wait. */
async function alone(c: C, run: () => Promise<Response>): Promise<Response> {
  const ledger = c.env.EMAIL_MCP.getByName("workspace");
  const holder = crypto.randomUUID();
  if (!(await ledger.acquireLock(KEY_LOCK, holder, 60_000))) return c.json({ error: "Another agent key is being made or revoked; try again in a moment." }, 409);
  try { return await run(); }
  finally { await ledger.releaseLock(KEY_LOCK, holder).catch(() => {}); }
}

function failure(c: C, error: unknown, action: string) {
  if (error instanceof AgentKeysConflict) return c.json({ error: error.message }, 409);
  // A refusal of the token is the owner's to fix (403, with the permission named); Cloudflare being down is 502.
  if (error instanceof CloudflareApiError) return c.json({ error: error.message }, error.status === 404 ? 404 : error.status === 400 || error.status === 409 ? error.status : error.status === 401 || error.status === 403 ? 403 : 502);
  console.error(JSON.stringify({ event: "agent_keys_failed", action, error: (error as Error)?.message?.slice(0, 300) }));
  return c.json({ error: `${action} could not be completed: ${(error as Error)?.message ?? "unknown error"}` }, 502);
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
    const keys = await readAgentKeys(c.env.BUCKET);
    return c.json({ keys: keys.map(publicKey), mcpUrl: `${new URL(c.req.url).origin}/mcp`, levels: LEVELS, durations: Object.keys(TOKEN_DURATIONS), canIssue: !!cloudflareApi(c.env) });
  } catch (error) { return failure(c, error, "Reading the agent keys"); }
});

agentKeysRouter.post("/api/agent-keys", async (c) => {
  c.header("Cache-Control", "no-store");
  const parsed = validateNewKey(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const input = parsed.value;
  const cf = access(c);
  if (cf instanceof Response) return cf;
  return alone(c, async () => {
  if ((await readAgentKeys(c.env.BUCKET)).length >= MAX_KEYS) return c.json({ error: `At most ${MAX_KEYS} agent keys; revoke one first` }, 400);
  let token: Awaited<ReturnType<AgentAccess["create"]>>;
  try { token = await cf.create(input.name, input.duration); }
  catch (error) { return failure(c, error, "Making the key in Cloudflare"); }
  const key: AgentKey = {
    id: token.id, clientId: token.client_id, name: input.name, level: input.level, send: sendFor(input.level, input.send),
    dailySendLimit: input.dailySendLimit, createdAt: new Date().toISOString(), expiresAt: token.expires_at ?? null, accounts: input.accounts,
  };
  try {
    await updateAgentKeys(c.env.BUCKET, (keys) => [...keys.filter((k) => k.id !== key.id), key]);
  } catch (error) {
    // The server does not know this token, so it must not exist either.
    await cf.revoke(token.id).catch((e) => console.error(JSON.stringify({ event: "agent_key_rollback_failed", tokenId: token.id, error: String(e) })));
    return failure(c, error, "Saving the key");
  }
  console.log(JSON.stringify({ event: "agent_key_created", keyId: key.id, level: key.level, send: key.send, limitedTo: key.accounts?.length ?? null }));
  const mcpUrl = `${new URL(c.req.url).origin}/mcp`;
  return c.json({ key: publicKey(key), clientSecret: token.client_secret, mcpUrl, configs: clientConfigs(mcpUrl, token.client_id, token.client_secret) }, 201);
  });
});

agentKeysRouter.delete("/api/agent-keys/:id", (c) => alone(c, async () => {
  const id = c.req.param("id");
  let removed: AgentKey | undefined;
  try {
    // Out of the registry first: the key stops working on this server at once.
    await updateAgentKeys(c.env.BUCKET, (keys) => { removed = keys.find((k) => k.id === id); return keys.filter((k) => k.id !== id); });
  } catch (error) { return failure(c, error, "Revoking the key"); }
  if (!removed) return c.json({ error: "No such agent key" }, 404);
  console.log(JSON.stringify({ event: "agent_key_revoked", keyId: id }));
  const cf = access(c);
  if (cf instanceof Response) return c.json({ revoked: id, warning: "The key no longer works here, but its token could not be deleted in Cloudflare (no token on the server); delete it in Zero Trust → Service credentials." });
  try { await cf.revoke(id); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return c.json({ revoked: id, warning: `The key no longer works here, but Cloudflare did not delete its token: ${reason} Delete it in Zero Trust → Service credentials.` });
  }
  return c.json({ revoked: id });
}));

agentKeysRouter.get("/api/agent-keys/journal", async (c) => {
  c.header("Cache-Control", "no-store");
  const before = Number(c.req.query("before")) || undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  try {
    const entries = await c.env.EMAIL_MCP.getByName("workspace").journal({ before, limit });
    return c.json({ entries, nextBefore: entries.length === limit ? entries[entries.length - 1]!.at : null });
  } catch (error) { return failure(c, error, "Reading what agents changed"); }
});
