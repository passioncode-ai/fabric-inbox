/**
 * A recording stand-in for the app's API, and one tool call as the MCP server makes it, for tests
 * of what each tool asks the routes and what the agent gets back (the routes have their own tests).
 */
import { z } from "zod";
import type { Principal } from "../workers/mcp/keys";
import { runTool, type Api, type ApiResponse, type Ledger } from "../workers/mcp/protocol";
import { TOOLS } from "../workers/mcp/tools";

export const owner: Principal = { kind: "owner", label: "owner@shop.invalid", level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null };
export type Call = { method: string; path: string; query?: Record<string, unknown>; body?: unknown };
export type Answer = ApiResponse | ((call: Call) => ApiResponse);

/** Answers "METHOD /path" (the exact path, before any query) as the app would; anything else is a 404. */
export function fakeApi(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const api: Api = {
    async request(method, path, init = {}) {
      const call = { method, path, query: init.query, body: init.body };
      calls.push(call);
      const answer = answers[`${method} ${path}`];
      if (!answer) return { status: 404, data: { error: `no route ${method} ${path}` }, contentType: "application/json" };
      return typeof answer === "function" ? answer(call) : answer;
    },
  };
  return { api, calls };
}
export const ok = (data: unknown, status = 200): ApiResponse => ({ status, data, contentType: "application/json" });

export function ledger() {
  const journal: { tool: string; outcome: string; detail: string }[] = [];
  const l: Ledger = {
    issueConfirmation: async () => ({ code: "CODE", expiresAt: 0 }), consumeConfirmation: async () => true,
    reserveSend: async () => ({ ok: true, used: 1, limit: null }), refundSend: async () => {},
    record: async (e) => { journal.push({ tool: e.tool, outcome: e.outcome, detail: e.detail }); },
  };
  return { ledger: l, journal };
}

/** One tool call: the arguments parsed with their defaults (a schema error throws), then runTool. */
export async function call(api: Api, name: string, args: Record<string, unknown>, principal: Principal = owner) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const { ledger: l, journal } = ledger();
  const parsed = z.object(tool.input).parse(args);
  const result = await runTool(tool, parsed, { api, principal }, l);
  return { isError: !!result.isError, data: JSON.parse(result.content[0]!.text), journal };
}

export const CF = "support@shop.invalid";
export const CF_BOX = `/api/v1/mailboxes/${encodeURIComponent(CF)}`;
export const cfEmail = (over: Record<string, unknown> = {}) => ({
  id: "m1", thread_id: "t1", message_id: "orig@x.invalid", subject: "Order", sender: "ann@customer.invalid", recipient: CF,
  cc: null, bcc: null, in_reply_to: null, date: "2026-10-05T10:00:00Z", folder_id: "inbox", read: false, starred: false, body: "<p>Where is my order?</p>",
  raw_headers: null, attachments: [], ...over,
});
export const gmailMessage = (over: Record<string, unknown> = {}) => ({
  providerMessageId: "m1", threadId: "t1", rfcMessageId: "<orig@x.invalid>", references: "", subject: "Order",
  from: "Ann <ann@customer.invalid>", to: "me@gmail.invalid", date: "Mon, 5 Oct 2026 10:00:00 +0000",
  text: "Where is my order?", html: "", read: false, labels: ["INBOX"], attachments: [], ...over,
});
export const GMAIL_ACCOUNTS = ok({ configuration: "configured", accounts: [{ id: "g1", email: "Me@Gmail.invalid", status: "connected" }] });
/** The bytes "hi" as an attachment answer of each provider. */
export const HI_BASE64 = "aGk=";
