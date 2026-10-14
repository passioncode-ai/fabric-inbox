import { validateToolUrl } from "../automation/policy";
import { tokenFor, toolClient, toolTransport, type ToolTokens } from "../automation/mcp";
import type { ToolGrant } from "./definition";

/**
 * The input schema of a granted tool, read from its endpoint (tools/list) at save time: an
 * agent is never saved granting a tool whose schema cannot be read. The same client, limits
 * and allowlist as the run-time call (workers/automation/mcp.ts). Returns null when the
 * endpoint answers but does not list the tool; throws when the schema cannot be read at all.
 */
export async function readToolSchema(
  grant: ToolGrant,
  hosts: string,
  tokens: ToolTokens,
): Promise<unknown | null> {
  return (await readToolInfo(grant, hosts, tokens))?.schema ?? null;
}

/** What a granted tool is, from its endpoint's tools/list: its input schema and whether it only reads (B-94). */
export interface ToolInfo { schema: unknown; readOnly: boolean }

/** The tool's schema and its `readOnlyHint` (absent or false: it may act), or null when the endpoint does not list it. */
export async function readToolInfo(grant: ToolGrant, hosts: string, tokens: ToolTokens): Promise<ToolInfo | null> {
  const url = validateToolUrl(grant.endpoint, hosts);
  const token = tokenFor(tokens, grant.tokenRef, url);
  const transport = toolTransport(url, token);
  const client = toolClient();
  try {
    await client.connect(transport);
    const { tools } = await client.listTools(undefined, { timeout: 20_000 });
    const tool = tools.find((t) => t.name === grant.tool);
    return tool ? { schema: tool.inputSchema ?? null, readOnly: tool.annotations?.readOnlyHint === true } : null;
  } finally {
    await client.close();
  }
}
