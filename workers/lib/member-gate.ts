/**
 * What a member (B-149) may reach over HTTP. The same two rules as an agent key limited to
 * mailboxes (workers/mcp/scope.ts): a route about exactly one of their mailboxes passes; the feed
 * is answered for their mailboxes only; everything else, including every setting, is refused.
 */
import { accountOfPath, adminMailboxAction, FEED_ROUTES, SAFETY_ROUTES } from "../mcp/scope";
import { MCP_PATH } from "../mcp/keys";

/** Routes any signed-in person may call: who they are on this server. */
export const SELF_ROUTES = new Set(["GET /api/me"]);

export type Gate = "pass" | "feed" | "body" | "refuse";

/**
 * Routes a member may call with a body narrowed to their mailboxes (`memberBody`): emptying Spam
 * in their own mailboxes, and bringing back discarded mail of their own mailboxes.
 */
export const BODY_ROUTES = new Set(["POST /api/spam/empty", "POST /api/discard/restore"]);


/**
 * `pass`: let the request through as it is; `feed`: answer it through the scoped API; `refuse`: 403.
 * Pages and their assets pass (they hold no data; the data comes from /api). The agent protocol,
 * the operator's chat assistant and the relays are an administrator's.
 */
export function memberGate(method: string, pathname: string, accounts: readonly string[]): Gate {
  if (pathname === MCP_PATH || pathname.startsWith("/agents/") || pathname.startsWith("/relay/") || pathname.startsWith("/fabric/")
    || pathname === "/.well-known/fabric-service") return "refuse";
  if (!pathname.startsWith("/api/")) return "pass";
  const route = `${method === "HEAD" ? "GET" : method} ${pathname}`;
  if (SELF_ROUTES.has(route)) return "pass";
  // The feed, and the safety check's routes (B-178), are answered for the member's mailboxes only (N-8).
  if (FEED_ROUTES.has(route) || SAFETY_ROUTES.has(route)) return "feed";
  if (BODY_ROUTES.has(route)) return "body";
  if (adminMailboxAction(method, pathname)) return "refuse";
  const allowed = new Set(accounts);
  const account = accountOfPath(pathname, allowed);
  return account && allowed.has(account) ? "pass" : "refuse";
}

/**
 * A member's body for a `body` route, or why it is refused. Emptying Spam empties their Cloudflare
 * mailboxes only; a restore must name their own mailboxes' messages, and never takes back a discard
 * rule, since the rules are the whole workspace's.
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
