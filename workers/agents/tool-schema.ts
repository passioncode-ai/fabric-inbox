import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { validateToolUrl } from "../automation/policy";
import { toolTransport } from "../automation/mcp";
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
  tokens: Record<string, string>,
): Promise<unknown | null> {
  const url = validateToolUrl(grant.endpoint, hosts);
  const token = grant.tokenRef ? tokens[grant.tokenRef] : undefined;
  if (grant.tokenRef && !token) throw new Error("Tool credential is not configured");
  const transport = toolTransport(url, token);
  const client = new Client({ name: "fabric-inbox", version: "0.1.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools(undefined, { timeout: 20_000 });
    return tools.find((tool) => tool.name === grant.tool)?.inputSchema ?? null;
  } finally {
    await client.close();
  }
}
