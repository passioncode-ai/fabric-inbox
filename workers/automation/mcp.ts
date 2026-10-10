import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { validateToolUrl, type Rule } from "./policy";
import { msg } from "../../shared/i18n";

export interface McpCall {
  endpoint: string;
  tool: string;
  arguments: Record<string, unknown>;
  tokenRef?: string;
}

type CallResult = { isError?: boolean; content?: unknown };

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
 * One remote MCP tool call on an allowlisted host. The host is validated at call
 * time as well as at save time, so removing a host from the allowlist stops a
 * granted tool immediately. SDK 1.26 speaks its negotiated supported protocol.
 */
export async function callMcpTool(call: McpCall, hosts: string, tokens: Record<string, string>): Promise<CallResult> {
  const url = validateToolUrl(call.endpoint, hosts);
  const token = call.tokenRef ? tokens[call.tokenRef] : undefined;
  if (call.tokenRef && !token) throw new Error("Tool credential is not configured");
  const transport = toolTransport(url, token);
  const client = new Client({ name: "fabric-inbox", version: "0.1.0" });
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
  tokens: Record<string, string>,
): Promise<string> {
  const result = await callMcpTool(action, hosts, tokens);
  if (result.isError) throw new Error(msg("Tool returned an error"));
  return msg("Tool completed");
}
