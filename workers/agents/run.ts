/**
 * One agent run per incoming message on a Cloudflare address (SCN-024). The run
 * is the single record of what the agent decided and exactly what left the
 * mailbox; it never holds tokens, and tool results are bounded.
 */
export type AgentRunStatus =
  | "running"
  | "off"
  | "skipped"
  | "drafted"
  | "sent"
  | "send_failed"
  | "send_unknown"
  | "failed"
  | "interrupted";

export interface ToolCallRecord {
  name: string;
  host: string;
  ok: boolean;
  ms: number;
  /** The first characters of the result or the error, never credentials. */
  result: string;
}

export interface AgentRun {
  /** Derived from mailbox and message: one run per incoming message. */
  id: string;
  mailboxId: string;
  emailId: string;
  sender: string;
  subject: string;
  agentId?: string;
  agentVersion?: number;
  status: AgentRunStatus;
  reason: string;
  /** "sending" while the send is in flight: a run cut off there is reported, one cut off earlier is retried. */
  phase?: "sending";
  intent?: string;
  grounded?: boolean;
  toolCalls: ToolCallRecord[];
  /** Knowledge passages given to the model in this run (KN-4), by reference — never their text. */
  sources?: { ref: string; collectionId: string; title: string; sourceUri: string }[];
  draftId?: string;
  sent?: { to: string; subject: string; body: string; outboxId: string };
  createdAt: string;
  updatedAt: string;
}

/**
 * A copy of a message that waits for another address of the workspace to answer it (B-22).
 * Nothing is recorded yet: the queue looks again before `until`, and at `until` the copy
 * either reads as a duplicate or, if the other address never took the message, answers it.
 */
export interface AwaitingAnswer {
  status: "waiting";
  owner: string;
  until: number;
}

export const RESULT_PREVIEW_CHARS = 2000;
export const SENT_BODY_CHARS = 12_000;

export async function runIdFor(mailboxId: string, emailId: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([mailboxId.toLowerCase(), emailId])));
  return "agent-" + Array.from(new Uint8Array(bytes).slice(0, 16), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** History filters by what happened, in the words the Agents screen uses. */
export const RUN_OUTCOMES = {
  answered: ["sent", "drafted"],
  attention: ["send_failed", "send_unknown", "failed", "interrupted"],
  skipped: ["skipped", "off"],
} as const satisfies Record<string, readonly AgentRun["status"][]>;
export type RunOutcome = keyof typeof RUN_OUTCOMES;
