import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { validateToolUrl, type Rule } from "./policy";
import { msg } from "../../shared/i18n";
import { ActionRejected } from "./engine";

export interface McpCall {
  endpoint: string;
  tool: string;
  arguments: Record<string, unknown>;
  tokenRef?: string;
}

type CallResult = { isError?: boolean; content?: unknown };

/**
 * The MCP client every tool call and schema read uses. The SDK's default validator compiles a
 * tool's outputSchema with ajv (new Function), which Workers refuse ("Code generation from strings
 * disallowed for this context"): a server that declares output schemas could not be granted at all
 * (the Acme data agent, 2026-10-12). The cfworker validator interprets schemas without codegen.
 */
export const toolClient = () => new Client({ name: "fabric-inbox", version: "0.1.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });

/**
 * Every request to a tool endpoint: one 20-second deadline, and no redirect followed. Workers'
 * fetch refuses `redirect: "error"` before any request leaves ("Invalid redirect value"), which
 * made every tool call fail without reaching its host; "manual" plus this check refuses a redirect
 * the same way.
 */
export async function toolFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]),
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new Error("Tool endpoint answered with a redirect; redirects are not followed");
  }
  return response;
}

/** The MCP transport for one allowlisted endpoint: no reconnection, no retry, toolFetch for every request. */
export function toolTransport(url: URL, token: string | undefined): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    fetch: toolFetch,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
}

/**
 * AUTOMATION_TOOL_TOKENS: each entry is `{ host, token }`, a token bound to the one host it is for,
 * or (configured before hosts were named) a bare token. A grant names an entry by `tokenRef`.
 */
export type ToolTokens = Record<string, string | { host: string; token: string }>;

/**
 * The bearer a call to `url` may carry. A token bound to a host goes only to that host: before
 * 2026-10-12 any grant could send any named token to any allowlisted host (bug hunt). A bare token
 * still works, and its use is logged so it can be bound.
 */
export function tokenFor(tokens: ToolTokens, ref: string | undefined, url: URL): string | undefined {
  if (!ref) return undefined;
  const entry = tokens[ref];
  if (entry === undefined || entry === "") throw new Error("Tool credential is not configured");
  if (typeof entry === "string") {
    console.warn(JSON.stringify({ event: "tool_token_unbound", ref }));
    return entry;
  }
  if (!entry || typeof entry !== "object" || typeof entry.host !== "string" || typeof entry.token !== "string" || !entry.token)
    throw new Error("Tool credentials are misconfigured");
  if (url.hostname.toLowerCase() !== entry.host.toLowerCase()) throw new Error("This credential belongs to another tool host");
  return entry.token;
}

/**
 * One remote MCP tool call on an allowlisted host. The host is validated at call
 * time as well as at save time, so removing a host from the allowlist stops a
 * granted tool immediately. SDK 1.26 speaks its negotiated supported protocol.
 */
export async function callMcpTool(call: McpCall, hosts: string, tokens: ToolTokens): Promise<CallResult> {
  const url = validateToolUrl(call.endpoint, hosts);
  const token = tokenFor(tokens, call.tokenRef, url);
  const transport = toolTransport(url, token);
  const client = toolClient();
  try {
    await client.connect(transport);
    return (await client.callTool({ name: call.tool, arguments: call.arguments }, undefined, { timeout: 20_000 })) as CallResult;
  } finally {
    await client.close();
  }
}

/** The text a tool returned, for a model that must read the result. */
export function toolResultText(result: CallResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Rule action: the result is not journaled, so private tool output never reaches run history. */
export async function invokeTool(
  action: Extract<Rule["action"], { type: "mcp" }>,
  hosts: string,
  tokens: ToolTokens | string,
): Promise<string> {
  // What fails before a request leaves (a host no longer allowed, a missing or foreign credential,
  // malformed credentials) and a tool that answers isError are refusals: nothing happened, so the run
  // is failed, not "outcome uncertain" with nothing the person can settle (bug hunt 2026-10-12).
  let parsed: ToolTokens;
  try {
    parsed = typeof tokens === "string" ? JSON.parse(tokens || "{}") : tokens;
    tokenFor(parsed, action.tokenRef, validateToolUrl(action.endpoint, hosts));
  } catch (error) {
    throw new ActionRejected(error instanceof SyntaxError ? msg("Tool credentials are misconfigured") : (error as Error).message);
  }
  const result = await callMcpTool(action, hosts, parsed);
  if (result.isError) throw new ActionRejected(msg("Tool returned an error"));
  return msg("Tool completed");
}
