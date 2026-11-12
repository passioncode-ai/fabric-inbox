/**
 * Agent keys (AP-1, AP-7): which Cloudflare Access service tokens may use the agent protocol,
 * at which level, and how they send. One R2 object for the workspace, written conditionally on
 * the version read so two changes at once never lose one. It holds no secret: a Client Secret
 * is shown once when the key is made and is kept only by Cloudflare and the agent.
 */
import { normaliseAccounts } from "./scope";
import { bodyForUpdate } from "../lib/r2-json";

export const AGENT_KEYS_KEY = "config/agent-keys.json";

export const LEVELS = ["read", "mail", "admin"] as const;
export type Level = (typeof LEVELS)[number];
export const SEND_MODES = ["drafts", "send"] as const;
export type SendMode = (typeof SEND_MODES)[number];
export const DEFAULT_DAILY_SENDS = 50;
export const MAX_DAILY_SENDS = 1000;
export const MAX_KEYS = 50;
/** B-215: the standing permissions a key may hold. */
export const STANDINGS = ["people", "keys"] as const;
export type Standing = (typeof STANDINGS)[number];
/** The standing permissions in a stored value, known ones only, each once, in a fixed order. */
export const normaliseStanding = (raw: unknown): Standing[] =>
  Array.isArray(raw) ? STANDINGS.filter((s) => raw.includes(s)) : [];

export interface AgentKey {
  /** The Cloudflare service token's id. */
  id: string;
  /** The service token's Client ID; Access puts it in the JWT as `common_name`. */
  clientId: string;
  name: string;
  level: Level;
  send: SendMode;
  dailySendLimit: number;
  createdAt: string;
  expiresAt: string | null;
  /**
   * The mailboxes this key may reach ("cloudflare:<address>" or "gmail:<id>"), or null for the whole
   * workspace (AP-11). Only Read and Mail keys can be limited; an empty list reaches nothing.
   */
  accounts: string[] | null;
  /**
   * B-38: "owner" when an irreversible action of this key waits for the owner's approval in Agent
   * access before its confirmation code works; absent, the agent confirms with the code alone (AP-4).
   */
  approval?: "owner";
  /**
   * B-215: what the owner lets this key do without the owner's approval that `save_member`, `remove_member`,
   * `create_agent_key` and `revoke_agent_key` otherwise always wait for: "people" (a member's mailboxes and
   * sign-in) and "keys" (issuing and revoking keys). Only the owner sets it (PATCH, or the account's token through
   * scripts/agent-standing.mjs); a key never passes it on.
   */
  standing?: Standing[];
  /** N-4: the person who made it (their sign-in email); their keys go when they leave or stop being an administrator. */
  createdBy?: string;
  /**
   * B-246 W3: a key that reaches no mailbox and may only ask for access (`request_access`) and read what it holds
   * (`list_my_access`). Approved requests give it grants; until the cut-over it reaches mail only through those.
   */
  requestOnly?: true;
}

/** Who is calling the protocol, after Access and the key registry. */
export type Principal =
  | { kind: "owner"; label: string; level: "admin"; send: "send"; dailySendLimit: null; keyId: null; accounts: null }
  | { kind: "agent"; label: string; level: Level; send: SendMode; dailySendLimit: number; keyId: string; accounts: readonly string[] | null; approval?: "owner"; standing?: readonly Standing[]; requestOnly?: true };

const rank: Record<Level, number> = { read: 0, mail: 1, admin: 2 };
export const levelAllows = (have: Level, need: Level) => rank[have] >= rank[need];

function normaliseKey(raw: unknown): AgentKey | null {
  if (!raw || typeof raw !== "object") return null;
  const k = raw as Record<string, unknown>;
  if (typeof k.id !== "string" || typeof k.clientId !== "string" || !k.id || !k.clientId) return null;
  const level = LEVELS.includes(k.level as Level) ? (k.level as Level) : "read";
  const send = SEND_MODES.includes(k.send as SendMode) ? (k.send as SendMode) : "drafts";
  const limit = Number(k.dailySendLimit);
  const accounts = normaliseAccounts(k.accounts);
  return {
    id: k.id, clientId: k.clientId,
    name: typeof k.name === "string" && k.name ? k.name : k.clientId,
    level, send,
    dailySendLimit: Number.isInteger(limit) && limit >= 0 ? Math.min(limit, MAX_DAILY_SENDS) : DEFAULT_DAILY_SENDS,
    createdAt: typeof k.createdAt === "string" ? k.createdAt : new Date(0).toISOString(),
    expiresAt: typeof k.expiresAt === "string" ? k.expiresAt : null,
    // A limit on an Admin key cannot hold (admin tools act on the whole workspace): it reaches nothing.
    accounts: accounts && level === "admin" ? [] : accounts,
    ...(k.approval === "owner" ? { approval: "owner" as const } : {}),
    // Standing permissions act on the whole server (people, keys): only an Admin key holds them.
    ...(level === "admin" && normaliseStanding(k.standing).length ? { standing: normaliseStanding(k.standing) } : {}),
    ...(typeof k.createdBy === "string" && k.createdBy ? { createdBy: k.createdBy.toLowerCase() } : {}),
    // B-246 W3: only a Read key that reaches no mailbox can be a requester.
    ...(k.requestOnly === true && level === "read" && Array.isArray(k.accounts) && k.accounts.length === 0 ? { requestOnly: true as const } : {}),
  };
}

/** Unknown fields and unreadable entries are dropped; a damaged file reads as no keys (fails closed). */
export function normaliseKeys(raw: unknown): AgentKey[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { keys?: unknown }).keys) ? (raw as { keys: unknown[] }).keys : [];
  return list.map(normaliseKey).filter((k): k is AgentKey => !!k);
}

export async function readAgentKeys(bucket: R2Bucket): Promise<AgentKey[]> {
  const object = await bucket.get(AGENT_KEYS_KEY);
  if (!object) return [];
  return normaliseKeys(await object.json().catch(() => null));
}

export class AgentKeysConflict extends Error {}

export async function updateAgentKeys(bucket: R2Bucket, change: (keys: AgentKey[]) => AgentKey[]): Promise<AgentKey[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(AGENT_KEYS_KEY);
    const current = object ? normaliseKeys(await bodyForUpdate(object)) : [];
    const next = change(current);
    const written = await bucket.put(AGENT_KEYS_KEY, JSON.stringify({ keys: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new AgentKeysConflict("The agent keys changed several times at once; try again");
}

/** The verified Access JWT's claims this module reads. */
export interface AccessClaims { email?: unknown; common_name?: unknown; sub?: unknown; aud?: unknown }

/**
 * An email is a person signed in through Access: the owner, at every level. A `common_name`
 * (a service token) is an agent only while its key is registered and not expired; any other
 * token — one made for another app in the same account — gets nothing.
 */
export function principalFor(claims: AccessClaims, keys: AgentKey[], now = Date.now()): Principal | null {
  if (typeof claims.email === "string" && claims.email)
    return { kind: "owner", label: claims.email, level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null };
  if (typeof claims.common_name !== "string" || !claims.common_name) return null;
  const key = keys.find((k) => k.clientId === claims.common_name);
  if (!key) return null;
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return null;
  // An admin key can make rules and reply agents that send; it is never Drafts only (agent-keys.ts sendFor).
  return { kind: "agent", label: key.name, level: key.level, send: key.level === "admin" ? "send" : key.send, dailySendLimit: key.dailySendLimit, keyId: key.id, accounts: key.accounts,
    ...(key.approval === "owner" ? { approval: "owner" as const } : {}), ...(key.standing?.length ? { standing: key.standing } : {}),
    ...(key.requestOnly ? { requestOnly: true as const } : {}) };
}

/** A service token: no person behind it. */
export function isServiceIdentity(claims: AccessClaims): boolean {
  return !(typeof claims.email === "string" && claims.email) && typeof claims.common_name === "string" && !!claims.common_name;
}

export const MCP_PATH = "/mcp";

/**
 * Whether Access's verified identity may reach this path. Anything but a signed-in person opens the
 * agent protocol only, where its level is checked; anywhere else it would act with the owner's rights.
 */
export function identityMayUse(claims: AccessClaims, pathname: string): boolean {
  // Only a person opens the app; anything else Access admits (a service token, or a policy
  // added later that admits by network or country) is limited to the agent protocol, where its
  // key is checked, and to a relay's hand-over (workers/relay/ingress.ts), where its relay is.
  // The fabric-service routes (B-87 part 4) read only: the well-known document, events and usage; each checks the key.
  return (typeof claims.email === "string" && !!claims.email) || pathname === MCP_PATH || RELAY_PATHS.includes(pathname)
    || FABRIC_SERVICE_READS.includes(pathname);
}

/** The fabric-service routes an agent key may read (workers/routes/fabric-service.ts). */
export const FABRIC_SERVICE_READS: readonly string[] = ["/.well-known/fabric-service", "/fabric/v1/events", "/fabric/v1/usage"];

/** Where a relay in another account hands over mail; kept here so the gate reads one list. */
export const RELAY_PATHS: readonly string[] = ["/relay/incoming", "/relay/forwarded"];
