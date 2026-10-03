/**
 * The agent protocol's core (AP-2..AP-6): what a tool is, which tools a caller gets, and how a
 * call runs — the confirmation for irreversible actions, the daily send allowance, the journal.
 *
 * It has no Cloudflare imports: the app's API, the ledger and the clock are handed in, so the same
 * code runs in the Worker and in `tests/mcp-server.test.ts`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { levelAllows, type Level, type Principal } from "./keys";
import { toolFitsScope } from "./scope";

/** What a route answered: its status and parsed JSON (or text), unchanged. */
export interface ApiResponse { status: number; data: unknown; contentType: string }
export interface Api {
  request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, init?: { query?: Record<string, unknown>; body?: unknown }): Promise<ApiResponse>;
}

/** A route that answered with an error; its message is the app's own. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data: unknown) { super(message); }
}

export interface ToolContext { api: Api; principal: Principal }

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  /** For the agent: what it does, when to use it, what comes back. */
  description: string;
  level: Level;
  /** Sends mail: absent for a *Drafts only* key, and counted against the key's daily allowance. */
  sends?: boolean;
  /** Changes nothing. Tools that change something are journalled. */
  readOnly?: boolean;
  /**
   * Irreversible: the first call returns this summary and a code; the second call, with the code,
   * acts. `null` means these particular arguments change nothing irreversible and run at once.
   */
  confirm?: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<string | null> | string | null;
  /** What the change is about, for the journal (an address, a domain, a message id). */
  target?: (args: z.infer<z.ZodObject<S>>) => string;
  input: S;
  /** The routes this tool calls, as "METHOD /path" in the app's own spelling (`tests/mcp-coverage.test.ts`). */
  routes: readonly string[];
  call: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

export const defineTool = <S extends ZodRawShape>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

/** The ledger's calls the protocol makes (the `EmailMCP` Durable Object, or a fake in tests). */
export interface Ledger {
  issueConfirmation(input: { caller: string; tool: string; argsHash: string; summary: string }): Promise<{ code: string; expiresAt: number }>;
  consumeConfirmation(input: { code: string; caller: string; tool: string; argsHash: string }): Promise<boolean>;
  reserveSend(caller: string, limit: number | null): Promise<{ ok: boolean; used: number; limit: number | null }>;
  refundSend(caller: string): Promise<void>;
  record(entry: { at: number; caller: string; callerLabel: string; tool: string; target: string; outcome: "done" | "failed" | "refused" | "confirmation_asked"; detail: string }): Promise<void>;
}

/**
 * The tools a caller may see and call: its level, sending only for a key that may send, and for a
 * key limited to mailboxes only the tools that stay inside a mailbox or the feed (AP-11).
 */
export function toolsFor(principal: Principal, tools: readonly ToolDef[]): ToolDef[] {
  // An empty limit (a damaged list, or a limit on an Admin key) reaches nothing, so it lists nothing.
  if (principal.accounts && !principal.accounts.length) return [];
  return tools.filter((t) => levelAllows(principal.level, t.level) && (!t.sends || principal.send === "send") && (!principal.accounts || toolFitsScope(t)));
}

export const callerId = (p: Principal) => (p.kind === "owner" ? `owner:${p.label}` : `key:${p.keyId}`);

/** Stable JSON: the same arguments in any key order hash the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function argsHash(args: Record<string, unknown>): Promise<string> {
  const { confirm: _confirm, ...rest } = args;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(rest)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});
const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);

const CONFIRM_FIELD = z.string().min(4).max(40).optional()
  .describe("Leave out on the first call. The first call returns what will happen and a code; call again with the same arguments and that code (valid 5 minutes) to do it.");

/** Runs one tool call with the protocol's rules around it. */
export async function runTool(tool: ToolDef, rawArgs: Record<string, unknown>, ctx: ToolContext, ledger: Ledger, now = () => Date.now()): Promise<ToolResult> {
  const caller = callerId(ctx.principal);
  const journal = async (outcome: "done" | "failed" | "refused" | "confirmation_asked", detail: string): Promise<boolean> => {
    if (tool.readOnly) return true;
    let target = "";
    try { target = tool.target?.(rawArgs as never) ?? ""; } catch { target = ""; }
    try {
      await ledger.record({ at: now(), caller, callerLabel: ctx.principal.label, tool: tool.name, target, outcome, detail });
      return true;
    } catch (e) {
      console.error(JSON.stringify({ event: "mcp.journal_failed", tool: tool.name, outcome, error: String(e) }));
      return false;
    }
  };
  // A caller outside the tool's level never gets here (the tool is not registered), but the check stays
  // so a registration mistake fails closed.
  if (!toolsFor(ctx.principal, [tool]).length) {
    await journal("refused", "not allowed for this key");
    return text({ error: `This key may not use ${tool.name}.` }, true);
  }
  const { confirm, ...args } = rawArgs as Record<string, unknown> & { confirm?: string };
  if (tool.confirm) {
    const hash = await argsHash(args);
    let summary: string | null;
    try { summary = await tool.confirm(args as never, ctx); }
    catch (error) { await journal("failed", errorText(error)); return text({ error: errorText(error) }, true); }
    if (summary === null) { /* nothing irreversible in these arguments */ }
    else if (!confirm) {
      const { code, expiresAt } = await ledger.issueConfirmation({ caller, tool: tool.name, argsHash: hash, summary });
      await journal("confirmation_asked", summary);
      return text({ needsConfirmation: true, summary, confirm: code, expiresAt: new Date(expiresAt).toISOString(),
        next: `Nothing has changed yet. To do this, call ${tool.name} again with the same arguments and confirm: "${code}".` });
    }
    else if (!(await ledger.consumeConfirmation({ code: confirm, caller, tool: tool.name, argsHash: hash }))) {
      await journal("refused", "confirmation code not valid");
      return text({ error: "The confirmation code is not valid: it expired, was used, or was issued for other arguments. Call without confirm to get a new one." }, true);
    }
  }
  if (tool.sends) {
    const allowance = await ledger.reserveSend(caller, ctx.principal.dailySendLimit);
    if (!allowance.ok) {
      await journal("refused", `daily send limit ${allowance.limit} reached`);
      return text({ error: `This key has sent its ${allowance.limit} messages for today (UTC). Save a draft instead, or try tomorrow.` }, true);
    }
  }
  try {
    const result = await tool.call(args as never, ctx);
    if (!(await journal("done", ""))) {
      // Done, but the owner would not see it: say so rather than let it pass unrecorded.
      const warning = "Done, but the change could not be written to the owner's journal; tell the owner what you changed.";
      return text(result && typeof result === "object" && !Array.isArray(result) ? { ...(result as object), warning } : { result: result ?? { ok: true }, warning });
    }
    return text(result ?? { ok: true });
  } catch (error) {
    // A route that refused (4xx) sent nothing; an unknown failure keeps the send counted.
    if (tool.sends && error instanceof ApiError && error.status < 500) await ledger.refundSend(caller).catch(() => {});
    await journal("failed", errorText(error));
    return text({ error: errorText(error), ...(error instanceof ApiError ? { status: error.status } : {}) }, true);
  }
}

export interface ServerInfo { name: string; version: string; instructions: string }

/** One server per request, with only the caller's tools. */
export function buildServer(info: ServerInfo, tools: readonly ToolDef[], ctx: ToolContext, ledger: Ledger): McpServer {
  const server = new McpServer({ name: info.name, version: info.version }, { instructions: info.instructions });
  for (const tool of toolsFor(ctx.principal, tools)) {
    const input = tool.confirm ? { ...tool.input, confirm: CONFIRM_FIELD } : tool.input;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: input,
      annotations: {
        title: tool.title,
        readOnlyHint: !!tool.readOnly,
        destructiveHint: !!tool.confirm,
        // Sending mail and changing Cloudflare reach outside this server.
        openWorldHint: !!tool.sends,
      },
    }, (async (args: Record<string, unknown>) => runTool(tool, args, ctx, ledger)) as never);
  }
  return server;
}

/** Turns a route's answer into data, or an ApiError carrying the app's own message. */
export function unwrap(response: ApiResponse): unknown {
  if (response.status >= 200 && response.status < 300) return response.data;
  const data = response.data as { error?: unknown; message?: unknown } | string | null;
  const message = typeof data === "string" ? data
    : typeof data?.error === "string" ? data.error
    : typeof data?.message === "string" ? data.message
    : `The server answered ${response.status}`;
  throw new ApiError(response.status, message, response.data);
}
