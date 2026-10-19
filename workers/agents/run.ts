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
  /** Not sure, so not answered: the question went to the knowledge owner; answer_again answers it once the knowledge has it. */
  | "held"
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
  /** B-117: what the person wanted to know, as the model paraphrased it (no personal data) — kept only when no answer was found. */
  question?: string;
  /** B-117: the knowledge had no confident answer, or the model could not ground its answer. */
  unanswered?: boolean;
  /** B-117: the message's conversation. */
  threadId?: string;
  /** The how-many-th answer to this message: 2 and up after "answer again"; its draft gets its own id. */
  attempt?: number;
  /** Run again after an earlier worker on it was interrupted (B-94): tools that may act are not called again. */
  rerun?: boolean;
  /** The model that wrote the answer, and the one that approved it before it was sent. */
  model?: string;
  checkedBy?: string;
  /** The policy category the model chose. */
  category?: string;
  /** Answered with the policy's hand-off reply (a person handles it), or its safe reply (nothing confident to say). */
  handoff?: boolean;
  fallback?: boolean;
  /** A reply saying an earlier answer did not help (reported to the knowledge as outdated). */
  dissatisfied?: boolean;
  /** The confident tool answers this run rested on (request id, cited items, revision): a sent answer is traceable. */
  evidence?: { tool: string; requestId?: string; items?: string[]; revision?: string }[];
  /** What the message is about (a few English words) and what the sender wants (one sentence); no personal data. */
  topic?: string;
  summary?: string;
  /** B-131: when the run was escalated once for waiting on a person past the SLA (WAIT_SLA_MS). */
  escalatedAt?: string;
  /**
   * B-131: the waiting reply sent to a held message past SAFE_DEFAULT_MS (a fixed text that states no
   * fact); the run stays held, so the real answer still goes out when the knowledge has it.
   */
  acknowledged?: { at: string; status: "accepted" | "unknown"; text: string };
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
  /** B-117: any status, filtered by the run's `unanswered` mark instead. */
  unanswered: [],
} as const satisfies Record<string, readonly AgentRun["status"][]>;
export type RunOutcome = keyof typeof RUN_OUTCOMES;
