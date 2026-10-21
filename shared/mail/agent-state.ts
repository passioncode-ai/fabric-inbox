/**
 * Where a conversation on an address with a reply agent stands (B-138, operator 2026-10-21): who
 * answered last, or why nobody did. Pure: the server computes it from the mailbox's rows and the
 * agent's run on the last message that came in, and the list, its filter and the agent tools read it.
 */
export const AGENT_STATES = [
  "unanswered", "new_after_agent", "error", "needs_data", "agent_draft", "working", "agent_replied", "person_replied",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const isAgentState = (value: unknown): value is AgentState => typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value);

/** States that wait for someone: the filter's "Needs attention". */
export const OPEN_STATES: readonly AgentState[] = ["unanswered", "new_after_agent", "error", "needs_data", "agent_draft"];

/** Who sent a message of the conversation: the reply agent (its answer or its waiting reply), a person, or nobody here. */
export type SentBy = "agent" | "agent_waiting" | "person";

/** The facts about one conversation the state is read from (MailboxDO.agentThreads). */
export interface ThreadFacts {
  threadId: string;
  /** The last message that came in (not sent, not a draft, not in Trash, Spam or Discarded). */
  lastInbound: { id: string; at: number } | null;
  /** The last message sent from the address, and who sent it. */
  lastSent: { id: string; at: number; by: SentBy } | null;
  /** Whether the agent answered anything in this conversation before its last inbound message. */
  agentAnsweredBefore: boolean;
}

const ERROR = new Set(["failed", "interrupted", "send_failed", "send_unknown"]);

/** The state, or null for a conversation with nothing that came in (only mail you sent). */
export function agentState(facts: ThreadFacts, runStatus: string | undefined): AgentState | null {
  const inbound = facts.lastInbound;
  if (!inbound) return null;
  const sent = facts.lastSent;
  if (sent && sent.at >= inbound.at) {
    // The agent's waiting reply says the answer is coming; the message still waits for its knowledge.
    if (sent.by === "agent_waiting") return "needs_data";
    return sent.by === "agent" ? "agent_replied" : "person_replied";
  }
  if (runStatus && ERROR.has(runStatus)) return "error";
  if (runStatus === "held") return "needs_data";
  if (runStatus === "drafted") return "agent_draft";
  if (runStatus === "running") return "working";
  // Sent, but its copy is not in Sent yet: the answer left.
  if (runStatus === "sent") return "agent_replied";
  return facts.agentAnsweredBefore ? "new_after_agent" : "unanswered";
}

/**
 * Whether the reply status is shown for an address (B-138): the address's own choice, else its
 * domain's, else the workspace's; off when nothing is chosen (operator, 2026-10-21: off by default).
 */
export interface AgentStatusSettings { enabled: boolean; domains: Record<string, boolean>; addresses: Record<string, boolean> }
export const DEFAULT_AGENT_STATUS: AgentStatusSettings = { enabled: false, domains: {}, addresses: {} };

export function agentStatusOn(settings: AgentStatusSettings, address: string): boolean {
  const a = address.toLowerCase();
  if (typeof settings.addresses[a] === "boolean") return settings.addresses[a]!;
  const domain = a.slice(a.lastIndexOf("@") + 1);
  if (typeof settings.domains[domain] === "boolean") return settings.domains[domain]!;
  return settings.enabled;
}
