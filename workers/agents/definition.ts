import { z } from "zod";
import { msg } from "../../shared/i18n";

/**
 * A reusable agent (SCN-022): a named, versioned definition that is not tied to a
 * mailbox. Addresses point at an agent id; every run records the version it used.
 */
/** Names the runner provides itself; a granted tool cannot take them. */
export const RESERVED_TOOLS = ["search_knowledge", "submit_answer"];
const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "Tool name: lowercase letters, digits and _");

export const SCHEMA_LIMIT = 8_000;

export const ToolGrantSchema = z.object({
  /** The name the model sees; unique within the agent. */
  name: ToolName,
  /** What the operator allows the tool to be used for; shown to the model. */
  description: z.string().trim().min(1).max(500),
  endpoint: z.string().url().max(1000),
  /** The remote MCP tool invoked at the endpoint. */
  tool: z.string().min(1).max(100),
  /** Name of a Worker secret entry in AUTOMATION_TOOL_TOKENS; never the value. */
  tokenRef: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  /**
   * The tool's input schema as its endpoint listed it at save time (B-85), as JSON text: an
   * object type here is not RPC-serializable and turns the registry's types into never. The
   * registry writes it; a value sent by the editor is replaced. Absent on older grants.
   */
  inputSchema: z.string().max(SCHEMA_LIMIT).optional(),
  /** Arguments the operator pins (e.g. a knowledge domain): merged into every call, over the model's. */
  fixed: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).optional()
    .refine((f) => !f || Object.keys(f).length <= 10, "At most 10 fixed arguments"),
  /** Call the tool once before the model, with the message's subject and opening as this argument. */
  prefetch: z.object({ argument: z.string().min(1).max(64) }).strict().optional(),
  /**
   * Use the output only when every item carrying a `class` says "public" (a reply goes to
   * someone outside); anything else is withheld from the model and keeps the answer a draft.
   */
  publicOnly: z.boolean().optional(),
  /**
   * B-85: a tool on the same endpoint that records a question the knowledge could not answer. When
   * the call before the model answers `abstained: true`, it is called once per message with the run's
   * id, kind "unanswered", the fixed `channel` (or "email") and the model's paraphrase of the question.
   */
  gaps: z.object({ tool: z.string().min(1).max(100) }).strict().optional(),
  /**
   * B-94: whether the endpoint marks the tool read-only (MCP `readOnlyHint`), read at save time like
   * `inputSchema`; a value sent by the editor is replaced. A run re-run after it was interrupted calls
   * only read-only tools again: one that may act could act twice.
   */
  readOnly: z.boolean().optional(),
}).strict();
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

/**
 * The schema the model is offered for a grant: the endpoint's, without the fixed arguments.
 * Null when there is none usable (an older grant, not an object schema, or over 8 KB), and the
 * model then gets the generic `{arguments}` wrapper.
 */
export function modelSchema(grant: ToolGrant): Record<string, unknown> | null {
  let schema: Record<string, unknown>;
  try { schema = JSON.parse(grant.inputSchema ?? "null"); } catch { return null; }
  if (!schema || typeof schema !== "object" || schema.type !== "object") return null;
  // A reference the provider may not resolve would fail every run of the agent; the wrapper is safer.
  if (/"\$ref"\s*:/.test(grant.inputSchema ?? "")) return null;
  const fixed = Object.keys(grant.fixed ?? {});
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const key of fixed) delete properties[key];
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k) => typeof k === "string" && !fixed.includes(k)) : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

/** The arguments sent to the endpoint: the model's, then the operator's fixed ones over them. */
export const callArguments = (grant: ToolGrant, args: Record<string, unknown>): Record<string, unknown> => ({ ...args, ...(grant.fixed ?? {}) });

/** What a grant's own settings require of its endpoint's schema; empty when they fit. */
export function grantSchemaProblems(grant: ToolGrant, schema: Record<string, unknown>): string[] {
  const properties = (schema.properties as Record<string, { type?: unknown }> | undefined) ?? {};
  const problems: string[] = [];
  for (const key of Object.keys(grant.fixed ?? {})) if (!Object.hasOwn(properties, key)) problems.push(msg('fixed argument "{key}" is not in the tool\'s schema', { key }));
  const argument = grant.prefetch?.argument;
  if (argument && (!Object.hasOwn(properties, argument) || properties[argument]?.type !== "string")) problems.push(msg('"{argument}" is not a text argument of the tool', { argument }));
  // The fixed value would replace the message, so the call before the model would never see it.
  if (argument && Object.hasOwn(grant.fixed ?? {}, argument)) problems.push(msg('"{argument}" is fixed, so it cannot carry the message', { argument }));
  return problems;
}

/**
 * The public-only gate (B-85, D4): the output is used only if it is JSON and every value in it
 * (text, number, true/false) sits inside an object marked `class: "public"`, its own or an
 * enclosing one's. An unlabelled field beside public items fails it too: a synthesized answer
 * could repeat a confidential source. No partial filtering.
 */
export function publicOnlyProblem(output: string): string | null {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return "the output is not JSON, so its data class is unknown"; }
  let unmarked = 0, tooDeep = false;
  const walk = (node: unknown, inherited: unknown, depth: number) => {
    if (depth > 20) { tooDeep = true; return; }
    if (node === null) return;
    if (typeof node !== "object") { if (inherited !== "public") unmarked++; return; }
    if (Array.isArray(node)) { for (const child of node) walk(child, inherited, depth + 1); return; }
    const record = node as Record<string, unknown>;
    const own = Object.hasOwn(record, "class") ? record.class : inherited;
    for (const [key, child] of Object.entries(record)) if (key !== "class") walk(child, own, depth + 1);
    if (Object.hasOwn(record, "class") && record.class !== "public") unmarked++;
  };
  walk(value, undefined, 0);
  if (tooDeep) return "the output is nested too deep to check its data class";
  return unmarked ? `${unmarked} value(s) are not marked public` : null;
}

/** Whether the model's arguments fit a granted tool's schema: a plain object with its required keys. */
export function toolArgumentsValid(schema: Record<string, unknown>, args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  return required.every((k) => Object.hasOwn(args, k));
}

export const ReplyPolicySchema = z.object({
  /** draft: every answer waits for the operator. auto: allowed answers are sent. */
  mode: z.enum(["draft", "auto"]).default("draft"),
  /** Intents the agent may answer without the operator. Empty in auto mode = any grounded answer. */
  allowedIntents: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /** Sends per address per UTC day; beyond it answers become drafts. null: no limit (operator 2026-10-13); left out, 20. */
  dailySendLimit: z.number().int().min(1).max(200).nullable().default(20),
}).strict();
export type ReplyPolicy = z.infer<typeof ReplyPolicySchema>;

export const AgentInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(20_000),
  /** Plain-text knowledge (FAQ, prices, links) the answers must be grounded in. */
  knowledge: z.string().max(50_000).default(""),
  /** Knowledge collections the agent may search (KN-3); nothing else is ever searched for it. */
  collections: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "Unknown collection")).max(10).default([])
    .refine((ids) => new Set(ids).size === ids.length, "A collection is named twice"),
  tools: z.array(ToolGrantSchema).max(10).default([])
    .refine((tools) => new Set(tools.map((t) => t.name)).size === tools.length, "Tool names must be unique")
    .refine((tools) => !tools.some((t) => RESERVED_TOOLS.includes(t.name)), "search_knowledge and submit_answer are built in; choose another tool name"),
  replyPolicy: ReplyPolicySchema.default({}),
}).strict();
export type AgentInput = z.infer<typeof AgentInputSchema>;

export interface AgentVersion extends AgentInput {
  id: string;
  version: number;
  createdAt: string;
}
export interface AgentSummary extends AgentVersion {
  updatedAt: string;
}

/** Assignment stored in a mailbox's settings: an agent id, or Off. */
export type AgentAssignment = { id: string } | "off";

export function readAssignment(settings: Record<string, unknown> | null | undefined): AgentAssignment | undefined {
  const value = settings?.agent;
  if (value === "off") return "off";
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string")
    return { id: (value as { id: string }).id };
  return undefined;
}

/** Ids are stable slugs; a name change never changes the id addresses point at. */
export function agentId(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "agent";
}

/** The id of the agent a pre-registry mailbox is migrated to. Deterministic, so a race creates one. */
export function legacyAgentId(mailboxId: string): string {
  return ("mailbox-" + mailboxId.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 64);
}

/**
 * The instructions every mailbox used before the registry. A migrated mailbox keeps
 * this behaviour: it drafts and never sends.
 */
export const LEGACY_INSTRUCTIONS = `Draft replies to incoming mail for the operator to review.
Write like a real person: short, direct plain text, no markdown, no lists, no meta-commentary.
Read the thread before answering and never repeat what was already said.
Use the name the sender signs with.`;

/**
 * The starting points of a new agent. Name and instructions are dictionary keys (msg), so the
 * editor fills them in the interface's language (B-113); the server keeps them in English.
 */
export const AGENT_TEMPLATES: Record<"support" | "sales" | "billing", AgentInput> = {
  support: {
    name: msg("Support"),
    instructions: msg(`Answer customer questions about the product.
Answer only from the knowledge below. If the answer is not there, say you will pass the question to the team and do not invent details.
Be brief and friendly; one clear next step per reply.`),
    knowledge: "",
    collections: [],
    tools: [],
    replyPolicy: { mode: "draft", allowedIntents: ["question", "how-to", "status"], dailySendLimit: 20 },
  },
  sales: {
    name: msg("Sales"),
    instructions: msg(`Reply to people asking about buying, pricing or partnerships.
Share only prices and terms from the knowledge below. Offer a call for anything custom.`),
    knowledge: "",
    collections: [],
    tools: [],
    replyPolicy: { mode: "draft", allowedIntents: ["pricing", "question"], dailySendLimit: 10 },
  },
  billing: {
    name: msg("Billing"),
    instructions: msg(`Handle invoices, receipts and refunds.
Never promise a refund or change a charge yourself: explain the process from the knowledge below and draft the rest for the operator.`),
    knowledge: "",
    collections: [],
    tools: [],
    replyPolicy: { mode: "draft", allowedIntents: ["receipt"], dailySendLimit: 10 },
  },
};
