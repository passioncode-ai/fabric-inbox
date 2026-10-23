/**
 * What a member (B-149) may reach over HTTP. The same two rules as an agent key limited to
 * mailboxes (workers/mcp/scope.ts): a route about exactly one of their mailboxes passes; the feed
 * is answered for their mailboxes only; everything else, including every setting, is refused.
 */
import { accountOfPath, FEED_ROUTES } from "../mcp/scope";
import { MCP_PATH } from "../mcp/keys";

/** Routes any signed-in person may call: who they are on this server. */
export const SELF_ROUTES = new Set(["GET /api/me"]);

export type Gate = "pass" | "feed" | "refuse";

/**
 * A mailbox's own settings (its forwarding, reply agent, signature), deleting it, and an account's
 * connection are an administrator's: forwarding alone could send someone else's mail away.
 */
const ADMIN_MAILBOX_ACTIONS = [
  { methods: ["PUT", "DELETE"], path: /^\/api\/v1\/mailboxes\/[^/]+\/?$/ },
  { methods: ["POST", "PUT", "DELETE"], path: /^\/api\/accounts\/[^/]+\/(disconnect|password)\/?$/ },
];

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
  if (FEED_ROUTES.has(route)) return "feed";
  if (ADMIN_MAILBOX_ACTIONS.some((a) => a.methods.includes(method) && a.path.test(pathname))) return "refuse";
  const allowed = new Set(accounts);
  const account = accountOfPath(pathname, allowed);
  return account && allowed.has(account) ? "pass" : "refuse";
}
