/**
 * B-199: the outcome of every message an agent took, in the channel-agent standard's words (section 3,
 * "The outcome of every ticket"), and the four numbers over a period. Derived from the run alone, so it
 * costs no extra storage and an older run reads the same way. What the run cannot tell (a person answered
 * a hand-off elsewhere, a customer was asked a question) is never guessed: it is named in `notMeasured`.
 */
import type { AgentRun } from "./run";

export const ENDED = ["answered", "answered_after_question", "closed_by_person", "answered_elsewhere", "referred", "expired", "unanswered", "no_reply_owed"] as const;
export const OPEN = ["received", "handed_open", "question_open", "awaiting_approval"] as const;
export type TicketOutcome = (typeof ENDED)[number] | (typeof OPEN)[number] | "not_a_ticket";

/** Outcomes of the standard this server cannot see from a run; reported as not measured, never as 0. */
export const NOT_MEASURED = ["customer_silent", "awaiting_customer", "expired_by_decision", "promotions"] as const;

/** The days a held or drafted message waits for its final answer; the closing reply comes at the same mark (B-141). */
export const FINAL_LIMIT_MS = 30 * 24 * 3600 * 1000;

/**
 * Skips the prefilter (prefilter.ts SKIP_TEXT) or the claim (dedupe.ts) decides: mail no one wrote to be answered, or
 * a copy another address answers. Matched on the English reason the run keeps.
 */
const NOT_A_TICKET = /^(The message has no sender address|The message came from (this address itself|one of this server's own addresses)|Calendar invitation|Automatically generated message|Bulk or list precedence|Mailing list or newsletter|Automatic reply or out-of-office|Delivery report or bounce|The sender does not accept replies|Duplicate: answered from)/i;
/** prefilter.ts `already_answered`: a person replied in the thread before the agent acted. */
const ANSWERED_ELSEWHERE = /^The operator already replied in this thread/i;

/** The outcome of one run at `now`. */
export function ticketOutcomeOf(run: AgentRun, now = Date.now()): TicketOutcome {
  const age = now - (Date.parse(run.receivedAt ?? run.createdAt) || now);
  switch (run.status) {
    case "off":
      return "not_a_ticket";
    case "skipped":
      if (NOT_A_TICKET.test(run.reason)) return "not_a_ticket";
      if (ANSWERED_ELSEWHERE.test(run.reason)) return "answered_elsewhere";
      // Passed to a person before the model (a sender or topic rule), or held back by the safety check: a person owes the answer.
      if (/^Passed to a person/i.test(run.reason) || run.injection) return age > FINAL_LIMIT_MS ? "unanswered" : "handed_open";
      return "no_reply_owed";
    case "sent":
      // The policy's hand-off reply tells the customer where to write; no signal from there reaches the agent.
      if (run.handoff) return "referred";
      // The safe reply: the customer got something, never the answer.
      if (run.fallback) return "expired";
      if (run.gapClosed || run.heldFacts || (run.attempt ?? 1) > 1) return "answered_after_question";
      return "answered";
    case "drafted":
      if (run.answeredByPerson) return "closed_by_person";
      return age > FINAL_LIMIT_MS ? "unanswered" : "awaiting_approval";
    case "held":
    case "failed":
      if (run.closedAt) return run.closing?.status === "not_sent" || !run.closing ? "unanswered" : "expired";
      return run.status === "held" ? "question_open" : "received";
    case "send_failed":
      return "unanswered";
    case "send_unknown":
    case "interrupted":
    case "running":
    default:
      return "received";
  }
}

export interface OutcomeSummary {
  /** Messages that came in the period, not counting what was never a ticket. */
  arrived: number;
  notATicket: number;
  /** Of those, how each one stands now. */
  outcomes: Record<TicketOutcome, number>;
  ended: number;
  open: number;
  /** Shares of the ended ones (0 to 1; null with none ended); they overlap as the standard says. */
  four: { answered: number | null; toPerson: number | null; fallback: number | null; unanswered: number | null };
  /** Hand-offs a person is known to have answered (drafts a person answered; a referral has no signal). */
  handoffsClosedByPerson: number;
  notMeasured: string[];
}

/** The outcomes of the runs given (one per message), as the standard's daily report counts them. */
export function summarizeOutcomes(runs: AgentRun[], now = Date.now()): OutcomeSummary {
  const outcomes = Object.fromEntries([...ENDED, ...OPEN, "not_a_ticket"].map((k) => [k, 0])) as Record<TicketOutcome, number>;
  let fallbackTickets = 0;
  for (const run of runs) {
    const outcome = ticketOutcomeOf(run, now);
    outcomes[outcome] += 1;
    // The standard's fallback is the checker refusing twice: here, the safe reply sent in place of the answer.
    if (outcome !== "not_a_ticket" && run.fallback) fallbackTickets += 1;
  }
  const ended = ENDED.reduce((n, k) => n + outcomes[k], 0);
  const open = OPEN.reduce((n, k) => n + outcomes[k], 0);
  const share = (n: number) => (ended ? Math.round((n / ended) * 1000) / 1000 : null);
  return {
    arrived: ended + open,
    notATicket: outcomes.not_a_ticket,
    outcomes,
    ended,
    open,
    four: {
      answered: share(outcomes.answered + outcomes.answered_after_question),
      toPerson: share(outcomes.referred + outcomes.closed_by_person),
      fallback: share(fallbackTickets),
      unanswered: share(outcomes.unanswered + outcomes.expired),
    },
    handoffsClosedByPerson: outcomes.closed_by_person,
    notMeasured: [...NOT_MEASURED],
  };
}
