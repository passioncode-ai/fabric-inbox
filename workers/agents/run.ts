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
  sources?: { ref: string; collectionId: string; title: string; sourceUri: string; /** B-130: the document's revision the passage came from. */ revision?: string }[];
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
  /** Queued again on purpose (answer_again, a held retry, a held message released): a fresh attempt, not an interrupted one (A-3). */
  requeued?: boolean;
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
  evidence?: { tool: string; requestId?: string; items?: string[]; coverage?: (number | null)[]; revision?: string }[];
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
  /** B-131: a drafted run whose conversation had a reply sent after the message when it was supervised. */
  answeredByPerson?: boolean;
  /** Review 2026-10-21: when a waiting check whose mailbox could not be read is tried again. */
  waitCheckAt?: string;
  /** Review 2026-10-21: when an escalated draft is looked at again for a person's answer. */
  personCheckAt?: string;
  /** B-130: when the message came (its Date when plausible, else when the run began), and when its answer was accepted. */
  receivedAt?: string;
  repliedAt?: string;
  /** B-130: model calls this run made (writer, fallback, checker), how many failed, and turns a fallback recovered. */
  modelCalls?: { calls: number; failed: number; recovered: number };
  /** B-147: one receipt per model call (writer, fallback, checker): tokens and the provider's charge, no content. */
  usage?: import("./usage").UsageReceipt[];
  /** B-130: drafted because a daily or rate limit was reached, not for what the answer says. */
  limited?: boolean;
  /** B-132: the daily judge's verdict on the answer this run sent (rubric v1); counts leave, the note stays here. */
  judgement?: import("./judge").JudgeVerdict;
  /** B-189: a person's grade of the answer on the judge's rubric, what the judge is measured against. */
  personGrade?: import("./calibration").PersonGrade;
  /** B-130: the sender, subject and texts were removed 30 days after the run began; counts stay. */
  redacted?: boolean;
  /**
   * Review 2026-10-21 (B-141): why a run failed before anything was sent (the model, the safety check, reading
   * the agent or the message, completing or saving the answer). Such a run is retried like a held one and
   * escalated at 4 hours; a failure after the send began is never marked, so it is never retried.
   */
  failure?: "model" | "safety" | "agent" | "read" | "answer" | "save";
  /** B-141: skipped because the message looked like an attempt to steer the agent; escalated at 4 hours, never retried. */
  injection?: boolean;
  /** B-141: the revision each knowledge endpoint answered with in this run (its `revision`), by endpoint. */
  factsRevisions?: Record<string, string>;
  /**
   * B-141: held for missing knowledge (the tool abstained or the answer was not grounded) with these revisions,
   * this agent version and question. A retry while every revision is the same is held again without the model;
   * a revision seen to change answers it again at once. Kept across retries; answer_again by a person drops it.
   */
  heldFacts?: { agent: string; revisions: Record<string, string>; question?: string };
  /**
   * B-153: the one second look at a held message: `running` while its attempt is queued or going, `done` after;
   * `firstCited` the items the first turn cited, `cause` and `rescued` what the look found (cause null: a knowledge
   * lookup failed, or a person answered meanwhile).
   */
  secondLook?: { at: string; state: "running" | "done"; firstCited: string[]; cause?: import("./learning-events").Cause | null; rescued?: boolean };
  /** B-141: gap kinds already reported for this message; a retry does not report them again. */
  gapsReported?: string[];
  /** B-141: when the retries ended (HELD_FOR_MS) and the closing reply was handled; set once per message. */
  closedAt?: string;
  closing?: { status: "accepted" | "unknown" | "not_sent"; reason?: string };
  /** B-141: when a closing that could not go out (send limit, unreadable mailbox) is tried again. */
  closeCheckAt?: string;
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
