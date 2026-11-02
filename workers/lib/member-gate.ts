/**
 * What a member (B-149) may reach over HTTP. The same two rules as an agent key limited to
 * mailboxes (workers/mcp/scope.ts): a route about exactly one of their mailboxes passes; the feed
 * is answered for their mailboxes only; everything else, including every setting, is refused.
 */
import { accountOfPath, adminMailboxAction, FEED_ROUTES, normaliseAccountId, SAFETY_ROUTES } from "../mcp/scope";
import { MCP_PATH } from "../mcp/keys";

/** Routes any signed-in person may call: who they are on this server. */
export const SELF_ROUTES = new Set(["GET /api/me"]);

/**
 * `readonly`: a mailbox of theirs they may only read (B-160), asked to change something or send. `agents`: the
 * list of the server's agents, answered with their names only and for a member who may choose one (B-160 step 3).
 */
export type Gate = "pass" | "feed" | "body" | "refuse" | "readonly" | "agents";

/** Reads change nothing: GET and HEAD, and the safety check's lookup, which reads verdicts with a POST. */
export const readsOnly = (method: string, pathname: string) =>
  method === "GET" || method === "HEAD" || `${method} ${pathname}` === "POST /api/safety/lookup";

/**
 * Routes a member may call with a body narrowed to their mailboxes (`memberBody`): emptying Spam
 * in their own mailboxes, and bringing back discarded mail of their own mailboxes.
 */
export const BODY_ROUTES = new Set(["POST /api/spam/empty", "POST /api/discard/restore"]);


/**
 * B-160 step 3: the mailbox whose agent a request chooses: an address's (`PUT /api/project-addresses/<address>/agent`)
 * or an account's (`PUT /api/accounts/<id>/agent`), or null for any other request. Forwarding, the address's own
 * settings and the agents themselves are other routes, and stay an administrator's.
 */
export function agentChoiceOf(method: string, pathname: string, agentable: readonly string[]): string | null {
  if (method !== "PUT") return null;
  const m = /^\/api\/(project-addresses|accounts)\/([^/]+)\/agent\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return m[1] === "project-addresses" ? normaliseAccountId(`cloudflare:${decodeURIComponent(m[2]!)}`) : accountOfPath(pathname, new Set(agentable));
  } catch { return null; }
}

/**
 * `pass`: let the request through as it is; `feed`: answer it through the scoped API; `refuse`: 403.
 * Pages and their assets pass (they hold no data; the data comes from /api). The agent protocol,
 * the operator's chat assistant and the relays are an administrator's.
 */
export function memberGate(method: string, pathname: string, accounts: readonly string[], writable: readonly string[] = accounts, agentable: readonly string[] = []): Gate {
  if (pathname === MCP_PATH || pathname.startsWith("/agents/") || pathname.startsWith("/relay/") || pathname.startsWith("/fabric/")
    || pathname === "/.well-known/fabric-service") return "refuse";
  if (!pathname.startsWith("/api/")) return "pass";
  const route = `${method === "HEAD" ? "GET" : method} ${pathname}`;
  if (SELF_ROUTES.has(route)) return "pass";
  // The feed, and the safety check's routes (B-178), are answered for the member's mailboxes only (N-8).
  if (FEED_ROUTES.has(route) || SAFETY_ROUTES.has(route)) return "feed";
  if (BODY_ROUTES.has(route)) return "body";
  if (route === "GET /api/agents") return agentable.length ? "agents" : "refuse";
  const choice = agentChoiceOf(method, pathname, agentable);
  if (choice) return agentable.includes(choice) ? "pass" : "refuse";
  if (adminMailboxAction(method, pathname)) return "refuse";
  const allowed = new Set(accounts);
  const account = accountOfPath(pathname, allowed);
  if (!account || !allowed.has(account)) return "refuse";
  return readsOnly(method, pathname) || writable.includes(account) ? "pass" : "readonly";
}

/**
 * A member's body for a `body` route, or why it is refused. Emptying Spam empties their Cloudflare
 * mailboxes only; a restore must name their own mailboxes' messages, and never takes back a discard
 * rule, since the rules are the whole workspace's. Both change mail, so `accounts` here are the ones the
 * member may change (B-160).
 */
export function memberBody(route: string, body: unknown, accounts: readonly string[]): { body: unknown } | { refuse: true } {
  if (route === "POST /api/spam/empty")
    return { body: { addresses: accounts.filter((a) => a.startsWith("cloudflare:")).map((a) => a.slice(11)) } };
  if (route === "POST /api/discard/restore") {
    const b = (body && typeof body === "object" ? body : {}) as { messages?: unknown };
    const messages = Array.isArray(b.messages) ? b.messages : [];
    const mine = new Set(accounts);
    if (!messages.length || !messages.every((m) => !!m && typeof m === "object" && mine.has(String((m as { accountId?: unknown }).accountId)))) return { refuse: true };
    return { body: { ...b, unlearn: false } };
  }
  return { refuse: true };
}
