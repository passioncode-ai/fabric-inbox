/**
 * B-246 W4 (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md, D-3a): what a person in a role reaches over HTTP,
 * read from the same capabilities the agent tools need. Every route the Worker serves is either a tool's or listed in
 * NOT_TOOLS (tests/mcp-coverage.test.ts), and every tool names its capability (workers/mcp/tool-capabilities.ts), so a
 * route's need is known without a second hand-kept list: a read is `read`; a change is the one capability of the tools
 * that make it. A route no tool calls is an administrator's.
 */
import { TOOLS } from "../mcp/tools";
import { TOOL_NEEDS, type ToolNeed } from "../mcp/tool-capabilities";
import { ROLE_PRESETS, type Capability } from "../mcp/grants";
import { MCP_PATH } from "../mcp/keys";
import { readsOnly, SELF_ROUTES } from "./member-gate";

interface RoutePattern { method: string; route: string; regex: RegExp; literals: number; needs: Set<ToolNeed> }

let patterns: RoutePattern[] | null = null;
/** The tools' routes, compiled once per isolate: ":name" matches one path segment. */
function routePatterns(): RoutePattern[] {
  if (patterns) return patterns;
  const byRoute = new Map<string, RoutePattern>();
  for (const tool of TOOLS) {
    const need = TOOL_NEEDS[tool.name];
    if (!need) continue;
    for (const route of tool.routes) {
      const [method, path] = [route.slice(0, route.indexOf(" ")), route.slice(route.indexOf(" ") + 1)];
      let p = byRoute.get(route);
      if (!p) {
        const segments = path.split("/").filter(Boolean);
        const regex = new RegExp(`^/${segments.map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}/?$`);
        p = { method, route, regex, literals: segments.filter((s) => !s.startsWith(":")).length, needs: new Set() };
        byRoute.set(route, p);
      }
      p.needs.add(need);
    }
  }
  patterns = [...byRoute.values()];
  return patterns;
}

/**
 * The capability a request needs, or null for a route no tool calls. Of several routes matching one path the most
 * literal wins (`/api/inbox/hidden` over `/api/inbox/:x`). A read needs `read` whichever tools read it; a change made
 * by tools of two different needs reads as `server`, the strictest, so a doubt never widens anyone's reach.
 */
export function routeNeed(method: string, pathname: string): ToolNeed | null {
  const m = method === "HEAD" ? "GET" : method;
  const matching = routePatterns().filter((p) => p.method === m && p.regex.test(pathname));
  if (!matching.length) return null;
  const best = Math.max(...matching.map((p) => p.literals));
  const needs = new Set(matching.filter((p) => p.literals === best).flatMap((p) => [...p.needs]));
  if (readsOnly(m, pathname)) return "read";
  return needs.size === 1 ? [...needs][0]! : "server";
}

/** What an architect's preset holds on every mailbox (ROLE_PRESETS, the operator's decision of 2026-11-06). */
export const ARCHITECT_CAN: ReadonlySet<Capability> = new Set(ROLE_PRESETS.architect.can);

export type RoleGate = "pass" | "refuse";

/**
 * B-246 W4b (D-3a, Delegation): the routes an architect reaches to give their agent keys access within the role. Each
 * route narrows itself for an architect (workers/routes/agent-keys.ts, grants.ts): their own keys and grants only, a key
 * that asks for access, a grant inside the preset with the role as its parent.
 */
const DELEGATION = [/^GET \/api\/agent-keys\/?$/, /^POST \/api\/agent-keys\/?$/, /^DELETE \/api\/agent-keys\/[^/]+\/?$/,
  /^GET \/api\/grants\/?$/, /^POST \/api\/grants\/?$/, /^DELETE \/api\/grants\/[^/]+\/?$/];
const delegation = (method: string, pathname: string) => DELEGATION.some((r) => r.test(`${method === "HEAD" ? "GET" : method} ${pathname}`));

/**
 * An architect's request: pages pass; the agent protocol, the operator's chat assistant and the relays stay an
 * administrator's, as for a member; an API route passes when its need is one the architect's preset holds, and the
 * delegation routes pass to narrow themselves. Sending, drafts, deleting mail, campaigns and the server's own settings
 * (people, domains, rules, other people's keys) are refused.
 */
export function architectGate(method: string, pathname: string): RoleGate {
  if (pathname === MCP_PATH || pathname.startsWith("/agents/") || pathname.startsWith("/relay/") || pathname.startsWith("/fabric/")
    || pathname === "/.well-known/fabric-service") return "refuse";
  if (!pathname.startsWith("/api/")) return "pass";
  if (SELF_ROUTES.has(`${method === "HEAD" ? "GET" : method} ${pathname}`)) return "pass";
  if (delegation(method, pathname)) return "pass";
  const need = routeNeed(method, pathname);
  return need && need !== "self" && need !== "server" && ARCHITECT_CAN.has(need) ? "pass" : "refuse";
}
