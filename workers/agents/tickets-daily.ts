// B-211: one `support.tickets_daily` event per agent address and closed UTC day, the channel-agent standard's
// daily ticket counts (section 5.1) in the form a chat support channel sends them, so one board reads mail and
// chat alike. A mail ticket is one message the agent took (one run); its outcome is ticket-outcome.ts's. Counts
// only: never a sender, a subject or a message's words. What mail has no source for is 0 and named in notMeasured.
import type { AgentRun } from "./run";
import { firstReplyAt, mailChannel } from "./quality";
import { FINAL_LIMIT_MS, ticketOutcomeOf, type TicketOutcome } from "./ticket-outcome";

/** The payload schema of `data.value`, kept in this repository. */
export const TICKETS_SCHEMA = "https://github.com/passioncode-ai/fabric-inbox/blob/main/docs/agents/support-tickets-daily.schema.json";
export const TICKETS_STANDARD = "channel-agent-standard/1";
/**
 * Outcomes and states mail agents have no source for: they ask the customer nothing (so no ticket waits for the
 * customer or goes silent), no decision ends a ticket early, and no message is a promotion of their own.
 */
export const TICKETS_NOT_MEASURED = ["customerSilent", "expiredByDecision", "openAwaitingCustomer", "promotions"] as const;
const DAY = 86_400_000;
/** A first reply later than this is late (the standard's hour). */
const LATE_MS = 3_600_000;
/** How far back the runs of a day are read: a ticket ends at the latest FINAL_LIMIT_MS after it arrived. */
export const TICKETS_LOOKBACK_MS = FINAL_LIMIT_MS + 2 * DAY;

export interface TicketsDaily {
  date: string; channel: string; standard: typeof TICKETS_STANDARD;
  arrived: number; ended: number;
  openHandedOpen: number; openQuestionOpen: number; openAwaitingCustomer: number; openAwaitingApproval: number;
  answered: number; answeredAfterQuestion: number; toPersonPolicy: number; toPersonInability: number; handoffsClosedByPerson: number;
  referred: number; answeredElsewhere: number; noReplyOwed: number; customerSilent: number; expiredByDecision: number;
  expired: number; unanswered: number; firstReplyLate: number; promotions: number; fallbackTickets: number; notATicket: number;
  shareAnswered: number | null; shareToPerson: number | null; shareFallback: number | null; shareUnanswered: number | null;
  notMeasured: string[];
}

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
const receivedOf = (run: AgentRun) => time(run.receivedAt ?? run.createdAt);

/** When a ticket with this outcome ended, or null while it is open. */
export function ticketEndedAt(run: AgentRun, outcome: TicketOutcome): number | null {
  switch (outcome) {
    case "answered": case "answered_after_question": case "referred":
      return time(run.repliedAt ?? run.updatedAt);
    case "expired":
      return time(run.closedAt ?? run.repliedAt ?? run.updatedAt);
    case "unanswered":
      if (run.closedAt) return time(run.closedAt);
      if (run.status === "send_failed") return time(run.updatedAt);
      // A draft or a hand-off nobody answered ends when its final answer was due.
      return receivedOf(run) + FINAL_LIMIT_MS;
    case "closed_by_person":
      // The check that saw the person's reply stamps escalatedAt.
      return time(run.escalatedAt ?? run.updatedAt);
    case "answered_elsewhere": case "no_reply_owed":
      return time(run.updatedAt);
    default:
      return null;
  }
}

type OpenState = "handed_open" | "question_open" | "awaiting_approval" | "received";

/** The open state a ticket that ended after the cutoff was in at the cutoff, read from how it ended. */
function openBefore(run: AgentRun, outcome: TicketOutcome): OpenState {
  switch (outcome) {
    case "handed_open": case "question_open": case "awaiting_approval":
      return outcome;
    case "answered_after_question":
      return "question_open";
    case "closed_by_person":
      return "awaiting_approval";
    case "expired":
      return run.closedAt ? "question_open" : "received";
    case "unanswered":
      if (run.closedAt) return "question_open";
      if (run.status === "drafted") return "awaiting_approval";
      return run.status === "skipped" ? "handed_open" : "received";
    default:
      return "received";
  }
}

export interface TicketsInput {
  address: string;
  /** The closed UTC day, YYYY-MM-DD. */
  day: string;
  /** Every run of the address created from TICKETS_LOOKBACK_MS before the day to now. */
  runs: AgentRun[];
  /** The reply mode of an agent version, "draft" or "auto"; unknown counts as auto. */
  modeOf: (run: AgentRun) => "draft" | "auto";
  now: number;
}

/** The day's event value for one address. Pure: every count comes from the input. */
export function ticketsDay(input: TicketsInput): TicketsDaily {
  const start = Date.parse(`${input.day}T00:00:00.000Z`), cutoff = start + DAY;
  const counts = { arrived: 0, ended: 0, handed_open: 0, question_open: 0, awaiting_approval: 0, received: 0,
    answered: 0, answered_after_question: 0, policy: 0, inability: 0, closed_by_person: 0, referred: 0, answered_elsewhere: 0,
    no_reply_owed: 0, expired: 0, unanswered: 0, late: 0, fallback: 0, notATicket: 0 };
  for (const run of input.runs) {
    const received = receivedOf(run);
    if (!Number.isFinite(received) || received >= cutoff) continue;
    const outcome = ticketOutcomeOf(run, input.now);
    const arrivedToday = received >= start;
    if (outcome === "not_a_ticket") { if (arrivedToday) counts.notATicket += 1; continue; }
    if (arrivedToday) {
      counts.arrived += 1;
      const replied = firstReplyAt(run);
      if (replied !== null && replied - received > LATE_MS) counts.late += 1;
    }
    const end = ticketEndedAt(run, outcome);
    if (end === null || !Number.isFinite(end) || end >= cutoff) { counts[openBefore(run, outcome)] += 1; continue; }
    if (end < start) continue;
    counts.ended += 1;
    if (run.fallback) counts.fallback += 1;
    switch (outcome) {
      case "referred": counts.referred += 1; counts.policy += 1; break;
      case "closed_by_person": counts.closed_by_person += 1; counts[input.modeOf(run) === "draft" ? "policy" : "inability"] += 1; break;
      case "answered": case "answered_after_question": case "answered_elsewhere": case "no_reply_owed": case "expired": case "unanswered":
        counts[outcome] += 1; break;
    }
  }
  const share = (n: number) => (counts.ended ? Math.round((n / counts.ended) * 1000) / 1000 : null);
  return {
    date: input.day, channel: mailChannel(input.address), standard: TICKETS_STANDARD,
    arrived: counts.arrived, ended: counts.ended,
    // A ticket the agent was still working on at the cutoff (running, failed to be retried) has arrived and not
    // been handed anywhere yet: the standard has no state for it, so it is in no open count.
    openHandedOpen: counts.handed_open, openQuestionOpen: counts.question_open, openAwaitingCustomer: 0, openAwaitingApproval: counts.awaiting_approval,
    answered: counts.answered, answeredAfterQuestion: counts.answered_after_question,
    toPersonPolicy: counts.policy, toPersonInability: counts.inability, handoffsClosedByPerson: counts.closed_by_person,
    referred: counts.referred, answeredElsewhere: counts.answered_elsewhere, noReplyOwed: counts.no_reply_owed,
    customerSilent: 0, expiredByDecision: 0, expired: counts.expired, unanswered: counts.unanswered,
    firstReplyLate: counts.late, promotions: 0, fallbackTickets: counts.fallback, notATicket: counts.notATicket,
    shareAnswered: share(counts.answered + counts.answered_after_question),
    shareToPerson: share(counts.referred + counts.closed_by_person),
    shareFallback: share(counts.fallback),
    shareUnanswered: share(counts.unanswered + counts.expired),
    notMeasured: [...TICKETS_NOT_MEASURED],
  };
}
