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
import { NARROWING, NARROWING_CAPABILITY, toolFitsScope } from "./scope";

/** What a route answered: its status and parsed JSON (or text), unchanged. */
export interface ApiResponse { status: number; data: unknown; contentType: string }
export interface Api {
  request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, init?: { query?: Record<string, unknown>; body?: unknown }): Promise<ApiResponse>;
}

/** A route that answered with an error; its message is the app's own. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data: unknown) { super(message); }
}

/**
 * B-154 (DEC-0121 AP-4): a step only the person takes (a consent, a typed secret). The tool that stands
 * for the button refuses with the contract's `human-step-required` and the direct link to that step, so
 * the agent hands the person the exact place instead of a description.
 */
export type HumanStep = "sign-in" | "consent" | "payment" | "secret" | "spend-above-limit" | "passkey";
export class HumanStepRequired extends Error {
  constructor(readonly humanStep: HumanStep, readonly url: string, message: string) { super(message); }
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
  /** B-178: its confirmation always waits for the owner's approval (B-38), whatever the key's setting. */
  ownerApproval?: boolean;
  /** Changes nothing. Tools that change something are journalled. */
  readOnly?: boolean;
  /** Only adds (an address, a sent message): told to clients as not destructive. Every other changing tool is. */
  additive?: boolean;
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
  issueConfirmation(input: { caller: string; tool: string; argsHash: string; summary: string; owner?: boolean; callerLabel?: string }): Promise<{ code: string; expiresAt: number }>;
  /** True once spent; "waiting" while the owner has not approved it (B-38). */
  consumeConfirmation(input: { code: string; caller: string; tool: string; argsHash: string }): Promise<boolean | "waiting">;
  reserveSend(caller: string, limit: number | null): Promise<{ ok: boolean; used: number; limit: number | null }>;
  refundSend(caller: string): Promise<void>;
  record(entry: { at: number; caller: string; callerLabel: string; tool: string; target: string; outcome: "done" | "failed" | "refused" | "confirmation_asked"; detail: string }): Promise<void>;
}

/**
 * The tools a caller may see and call: its level, sending only for a key that may send, and for a
 * key limited to mailboxes only the tools that stay inside a mailbox or the feed (AP-11).
 */
/**
 * The hints a client reads (MCP sweep 2026-10-12). The spec reads destructiveHint: false as "only
 * additive updates", so a tool that changes something is destructive unless it is marked `additive`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function annotationsFor(tool: Pick<ToolDef<any>, "title" | "readOnly" | "additive" | "confirm" | "sends">) {
  return {
    title: tool.title,
    readOnlyHint: !!tool.readOnly,
    destructiveHint: !tool.readOnly && (!tool.additive || !!tool.confirm),
    // Sending mail reaches outside this server.
    openWorldHint: !!tool.sends,
  };
}

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

/**
 * What a refusing route knew that the agent needs next (a send's outbox id and status, a batch's
 * failed items); named fields only.
 */
const DETAIL_FIELDS = ["status", "errorCode", "code", "attempts", "idempotencyKey", "providerMessageId", "threadId", "failed"] as const;
function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== "object" || Array.isArray(error.data)) return undefined;
  const data = error.data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // A Cloudflare send answers with its outbox entry, named by its id.
  if (typeof data.id === "string" && typeof data.mailboxId === "string") out.outboxId = data.id;
  for (const key of DETAIL_FIELDS) if (data[key] !== undefined && data[key] !== null) out[key] = data[key];
  return Object.keys(out).length ? out : undefined;
}

/**
 * B-155: whether a send that did not succeed left. `not_sent` only when nothing can have left: a route
 * that refused before handing the message over (4xx), or a transport that refused it outright (an
 * outbox entry `failed`). Everything else, an outcome the server marked unknown, a server error or an
 * answer that never came, is `unknown`: the message may have left, so a client must never send it
 * again under a new key.
 */
export function sendOutcome(error: unknown): "not_sent" | "unknown" {
  if (!(error instanceof ApiError)) return "unknown";
  const status = (error.data as { status?: unknown } | null)?.status;
  if (status === "failed") return "not_sent";
  if (typeof status === "string") return "unknown";
  return error.status < 500 ? "not_sent" : "unknown";
}

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
      // B-38: a key whose irreversible actions the owner approves gets a code that works only once approved.
      const owner = ctx.principal.kind === "agent" && (ctx.principal.approval === "owner" || !!tool.ownerApproval);
      const { code, expiresAt } = await ledger.issueConfirmation({ caller, tool: tool.name, argsHash: hash, summary, ...(owner ? { owner, callerLabel: ctx.principal.label } : {}) });
      await journal("confirmation_asked", summary);
      if (owner)
        return text({ needsApproval: true, summary, confirm: code, expiresAt: new Date(expiresAt).toISOString(),
          next: `Nothing has changed yet. The person you work for approves this in Fabric Inbox, Settings → Agent access (Waiting for your approval). Once they have, call ${tool.name} again with the same arguments and confirm: "${code}". Tell them what you asked for.` });
      return text({ needsConfirmation: true, summary, confirm: code, expiresAt: new Date(expiresAt).toISOString(),
        next: `Nothing has changed yet. To do this, call ${tool.name} again with the same arguments and confirm: "${code}".` });
    }
    else {
      const spent = await ledger.consumeConfirmation({ code: confirm, caller, tool: tool.name, argsHash: hash });
      if (spent === "waiting")
        return text({ waitingForApproval: true, error: "The person you work for has not approved this yet (Settings → Agent access, Waiting for your approval). Nothing has changed; call again with the same code once they have." }, true);
      if (!spent) {
        await journal("refused", "confirmation code not valid");
        return text({ error: "The confirmation code is not valid: it expired, was used, was refused by the owner, or was issued for other arguments. Call without confirm to get a new one." }, true);
      }
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
    // A batch that did some of its items says how many it did not.
    const batch = result as { done?: unknown; failed?: unknown } | null;
    const failed = batch && typeof batch === "object" && Array.isArray(batch.failed) ? batch.failed.length : 0;
    if (!(await journal("done", failed ? `${failed} of ${failed + Number(batch!.done ?? 0)} failed` : ""))) {
      // Done, but the owner would not see it: say so rather than let it pass unrecorded.
      const warning = "Done, but the change could not be written to the owner's journal; tell the owner what you changed.";
      return text(result && typeof result === "object" && !Array.isArray(result) ? { ...(result as object), warning } : { result: result ?? { ok: true }, warning });
    }
    return text(result ?? { ok: true });
  } catch (error) {
    if (error instanceof HumanStepRequired) {
      const refusal = { error: { code: "human-step-required", message: error.message, data: { humanStep: error.humanStep, url: error.url } } };
      return { ...text(refusal, true), structuredContent: refusal };
    }
    // A route that refused (4xx) sent nothing; an unknown failure keeps the send counted — and so does
    // a 409 whose answer says the outcome is unknown: the message may have left (B-50).
    const outcomeUnknown = error instanceof ApiError && (error.data as { status?: unknown } | null)?.status === "unknown";
    if (tool.sends && error instanceof ApiError && error.status < 500 && !outcomeUnknown) await ledger.refundSend(caller).catch(() => {});
    await journal("failed", errorText(error));
    const details = errorDetails(error);
    const traced = tool.sends && (details?.outboxId || details?.idempotencyKey);
    // B-155: a send says whether anything left, so a refusal never reads like an outcome nobody knows.
    const outcome = tool.sends ? sendOutcome(error) : undefined;
    const next = outcome === "unknown"
      ? `It may have left. ${traced ? "Whether it went out is in get_send_status (outboxId for a Cloudflare mailbox, idempotencyKey for Gmail, IMAP or Outlook), or in Sent. " : "Check Sent. "}Retry only with the same idempotencyKey, never a new one.`
      : outcome === "not_sent" ? "Nothing left. Fix what the error names, then send again." : undefined;
    return text({ error: errorText(error), ...(error instanceof ApiError ? { status: error.status } : {}), ...(outcome ? { outcome } : {}), ...(details ? { details } : {}),
      ...(next ? { next } : {}) }, true);
  }
}

export interface ServerInfo { name: string; version: string; instructions: string }

/** One server per request, with only the caller's tools. */
export function buildServer(info: ServerInfo, tools: readonly ToolDef[], ctx: ToolContext, ledger: Ledger): McpServer {
  const server = new McpServer({ name: info.name, version: info.version },
    { instructions: info.instructions, capabilities: { experimental: { [NARROWING_CAPABILITY]: { ...NARROWING } } } });
  for (const tool of toolsFor(ctx.principal, tools)) {
    const input = tool.confirm ? { ...tool.input, confirm: CONFIRM_FIELD } : tool.input;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: input,
      annotations: annotationsFor(tool),
    }, (async (args: Record<string, unknown>) => runTool(tool, args, ctx, ledger)) as never);
  }
  return server;
}

/** Turns a route's answer into data, or an ApiError carrying the app's own message. */
/** A bare error code from a route (`account_not_found`) as a sentence an agent can act on, the code kept. */
const readableCode = (error: string) =>
  /^[a-z]+(_[a-z]+)+$/.test(error) ? `${error[0].toUpperCase()}${error.slice(1).replace(/_/g, " ")} (${error})` : error;
export function unwrap(response: ApiResponse): unknown {
  if (response.status >= 200 && response.status < 300) return response.data;
  const data = response.data as { error?: unknown; message?: unknown } | string | null;
  const message = typeof data === "string" ? data
    : typeof data?.error === "string" ? readableCode(data.error)
    : typeof data?.message === "string" ? data.message
    : `The server answered ${response.status}`;
  throw new ApiError(response.status, message, response.data);
}
