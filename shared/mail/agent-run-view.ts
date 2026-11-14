/**
 * A reply agent's run as the inbox and the thread carry it (B-115, B-138): enough for the list to mark a message and for
 * the reader to show what the agent did. S06, S07 (B-271, B-272): the thread also carries why a draft waits, where its
 * facts came from, the person's copy of it and how the conversation ended (`outcome`), never the run's texts or tools.
 */
export interface AgentRunView {
  id: string;
  status: string;
  agentId?: string;
  agentVersion?: number;
  draftId?: string;
  /** The person's copy of the agent's text, made under a new id (R6-4). */
  personDraftId?: string;
  reason?: string;
  /** Drafted because a daily or rate limit was reached. */
  limited?: boolean;
  /** Whether the answer rested on the agent's knowledge. */
  grounded?: boolean;
  sources?: { ref: string; title: string }[];
  /** The sent answer's id in the mailbox, when the agent's own answer was accepted. */
  sentMessageId?: string;
  /** How the conversation ended once the draft waited (S07). */
  outcome?: { kind: "answered_by_person" | "approved_by_person" | "answered_by_agent" | "superseded"; sentMessageId?: string; at: string; edited?: boolean };
  /** The run keeps the draft's whole text, so it can be made a draft again. */
  draftKept?: boolean;
}
