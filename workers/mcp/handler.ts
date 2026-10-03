/**
 * `/mcp` — the agent protocol's endpoint (docs/agents/mcp.md). Access has already verified the
 * caller; this resolves its level from the key registry, builds a server with the tools that level
 * allows, and serves one Streamable HTTP exchange without a session.
 */
import { createMcpHandler } from "agents/mcp";
import { api } from "../api";
import type { Env } from "../types";
import { principalFor, readAgentKeys, type AccessClaims, type Principal } from "./keys";
import { ApiError, buildServer, type Api, type Ledger } from "./protocol";
import { NARROW_HEADER, narrowPrincipal, scopedApi } from "./scope";
import { TOOLS } from "./tools";
import { instructionsFor, PROTOCOL_NAME } from "./instructions";
import { version } from "../../package.json";
import { configuration } from "../providers/google-oauth";

/** Calls the app's own routes in-process, with no Origin header (the same-origin rule does not apply). */
export function inProcessApi(origin: string, env: Env, ctx: ExecutionContext): Api {
  return {
    async request(method, path, init = {}) {
      const url = new URL(path, origin);
      // A "." or ".." in an argument would be collapsed by the URL parser into another route.
      if (url.pathname !== path.split("?")[0]) throw new ApiError(400, "An id in the arguments is not valid (it contains . or .. as a path part)", null);
      for (const [k, v] of Object.entries(init.query ?? {})) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
      }
      const headers: Record<string, string> = init.body === undefined ? {} : { "Content-Type": "application/json" };
      // The Gmail routes take changes only from their configured origin (accounts.ts); this call
      // comes from the server itself, after the agent protocol's own checks.
      if (method !== "GET" && url.pathname.startsWith("/api/accounts/")) {
        const gmail = configuration(env);
        if (gmail.status === "configured") headers.Origin = gmail.origin;
      }
      const response = await api.fetch(new Request(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }), env, ctx);
      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("json") ? await response.json().catch(() => null)
        : contentType.startsWith("text/") ? await response.text()
        : new Uint8Array(await response.arrayBuffer());
      return { status: response.status, data, contentType };
    },
  };
}

export function ledgerFor(env: Env): Ledger {
  const stub = () => env.EMAIL_MCP.getByName("workspace");
  return {
    issueConfirmation: (input) => stub().issueConfirmation(input),
    consumeConfirmation: (input) => stub().consumeConfirmation(input),
    reserveSend: (caller, limit) => stub().reserveSend(caller, limit),
    refundSend: (caller) => stub().refundSend(caller),
    record: (entry) => stub().record(entry),
  };
}

const refuse = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), { status, headers: { "Content-Type": "application/json" } });

export async function resolvePrincipal(claims: AccessClaims | null, env: Env, dev: boolean): Promise<Principal | null> {
  if (!claims) return dev ? { kind: "owner", label: "local development", level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null } : null;
  const keys = claims.common_name ? await readAgentKeys(env.BUCKET) : [];
  return principalFor(claims, keys);
}

/**
 * Requests a browser could make on another site's behalf are refused before anything runs: the
 * owner's Access cookie would otherwise let any page they visit call tools as the owner. MCP
 * clients send no Origin; a browser always does on a cross-site POST. A simple (no-preflight)
 * request cannot carry an exact `application/json` content type, so that is required too. GET
 * would open a server-to-client stream this stateless server never uses.
 */
export function refuseUnsafe(request: Request): Response | null {
  if (request.method !== "POST")
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server takes POST only" }, id: null }),
      { status: 405, headers: { Allow: "POST", "Content-Type": "application/json" } });
  const origin = request.headers.get("Origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("Sec-Fetch-Site") === "cross-site")
    return refuse(403, "Cross-origin request refused");
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "Content-Type must be application/json");
  return null;
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext, claims: AccessClaims | null): Promise<Response> {
  const unsafe = refuseUnsafe(request);
  if (unsafe) return unsafe;
  let principal: Principal | null;
  try {
    principal = narrowPrincipal(await resolvePrincipal(claims, env, import.meta.env.DEV), request.headers.get(NARROW_HEADER));
  } catch (error) {
    console.error(JSON.stringify({ event: "mcp.keys_unreadable", error: String(error) }));
    return refuse(503, "The agent keys could not be read; try again");
  }
  if (!principal) {
    console.warn(JSON.stringify({ event: "mcp.refused", reason: claims?.common_name ? "unknown_or_expired_key" : "no_identity" }));
    return refuse(403, "This Access service token is not an agent key of this Fabric Inbox, or it has expired. Ask the owner for a key (Settings → Agent access).");
  }
  // A limit that names nothing (a damaged list, or a narrowing header with no valid mailbox) reaches
  // nothing: say so at the door rather than serve a server with no tools.
  if (principal.accounts && !principal.accounts.length) {
    console.warn(JSON.stringify({ event: "mcp.refused", reason: "empty_scope" }));
    return refuse(403, "This key is limited to no mailbox here (its list, or the X-Fabric-Accounts header, names none that is valid).");
  }
  const origin = new URL(request.url).origin;
  const server = buildServer(
    { name: PROTOCOL_NAME, version, instructions: instructionsFor(principal, origin) },
    TOOLS,
    { api: principal.accounts ? scopedApi(inProcessApi(origin, env, ctx), principal.accounts) : inProcessApi(origin, env, ctx), principal },
    ledgerFor(env),
  );
  return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
}
