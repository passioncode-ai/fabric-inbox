import { z } from "zod";

/**
 * A reusable agent (SCN-022): a named, versioned definition that is not tied to a
 * mailbox. Addresses point at an agent id; every run records the version it used.
 */
/** Names the runner provides itself; a granted tool cannot take them. */
export const RESERVED_TOOLS = ["search_knowledge", "submit_answer"];
const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "Tool name: lowercase letters, digits and _");

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
}).strict();
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export const ReplyPolicySchema = z.object({
  /** draft: every answer waits for the operator. auto: allowed answers are sent. */
  mode: z.enum(["draft", "auto"]).default("draft"),
  /** Intents the agent may answer without the operator. Empty in auto mode = any grounded answer. */
  allowedIntents: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /** Sends per address per UTC day; beyond it answers become drafts. */
  dailySendLimit: z.number().int().min(1).max(200).default(20),
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

export const AGENT_TEMPLATES: Record<"support" | "sales" | "billing", AgentInput> = {
  support: {
    name: "Support",
    instructions: `Answer customer questions about the product.
Answer only from the knowledge below. If the answer is not there, say you will pass the question to the team and do not invent details.
Be brief and friendly; one clear next step per reply.`,
    knowledge: "",
    collections: [],
    tools: [],
    replyPolicy: { mode: "draft", allowedIntents: ["question", "how-to", "status"], dailySendLimit: 20 },
  },
  sales: {
    name: "Sales",
    instructions: `Reply to people asking about buying, pricing or partnerships.
Share only prices and terms from the knowledge below. Offer a call for anything custom.`,
    knowledge: "",
    collections: [],
    tools: [],
    replyPolicy: { mode: "draft", allowedIntents: ["pricing", "question"], dailySendLimit: 10 },
  },
  billing: {
    name: "Billing",
    instructions: `Handle invoices, receipts and refunds.
Never promise a refund or change a charge yourself: explain the process from the knowledge below and draft the rest for the operator.`,
    knowledge: "",
    collections: [],
    tools: [],
    replyPolicy: { mode: "draft", allowedIntents: ["receipt"], dailySendLimit: 10 },
  },
};
