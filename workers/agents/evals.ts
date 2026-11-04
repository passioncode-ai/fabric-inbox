/**
 * B-199 step 4 (channel-agent standard 5.3): eval tickets. Every message an agent got wrong becomes an invented
 * ticket kept per agent: its text is the model's paraphrase of what the sender wanted (the run's `question`, else
 * its `summary`), with personal details removed, never the customer's words. After every new version of the agent
 * each ticket runs through the preview (nothing sent, drafted or stored) and is judged by what it expects; a ticket
 * that starts failing is reported once (`agent.eval_failed`) until it passes again.
 */
import type { AgentRun } from "./run";
import { scrubPersonal } from "./events";
import { ticketOutcomeOf } from "./ticket-outcome";

/** Why a run became a ticket. */
export type EvalReason = "unhelpful" | "unanswered" | "expired" | "handed_with_knowledge" | "person";
/** answer: the agent answers it itself; handoff: the right answer is a person's. */
export type EvalExpect = "answer" | "handoff";

export interface EvalResult {
  at: string;
  /** The agent version the ticket ran against. */
  version: number;
  verdict: "pass" | "fail" | "error";
  /** What the preview did: its status, and whether the reply was the hand-off or the safe reply. */
  got: { status: string; handoff: boolean; fallback: boolean; grounded: boolean | null };
  /** The first characters of the reply it would send, or the error. */
  reply: string;
}

export interface EvalTicket {
  id: string;
  agentId: string;
  /** The address the ticket is previewed on. */
  address: string;
  subject: string;
  text: string;
  expect: EvalExpect;
  reason: EvalReason;
  /** The run it came from; null for a ticket a person wrote. */
  sourceRun: string | null;
  createdAt: string;
  last: EvalResult | null;
  /** When the current failing episode began; null while it passes or has not run. */
  failingSince: string | null;
}

/** At most this many tickets per agent: every one costs a preview after each change. */
export const EVAL_MAX = 25;
/** Runs this old or newer become tickets. */
export const EVAL_WINDOW_MS = 30 * 86_400_000;
/** Previews per alarm pass; the rest run in the next pass a second later. */
export const EVAL_PER_PASS = 4;
/** The sender a ticket is previewed as: outside every domain of a server, so the run treats it as a customer. */
export const EVAL_SENDER = "eval@customer.invalid";

const ASKED_A_PERSON = new Set(["referred", "handed_open", "closed_by_person", "question_open"]);

/** Why a run is a ticket, or null when it is not one (answered well, not a ticket, no paraphrase kept, still open). */
export function evalReasonOf(run: AgentRun, now = Date.now()): EvalReason | null {
  if (!run.agentId || run.redacted || !evalTextOf(run)) return null;
  if (run.judgement?.helped === "no" || run.personGrade?.helped === "no") return "unhelpful";
  const outcome = ticketOutcomeOf(run, now);
  if (outcome === "unanswered") return "unanswered";
  if (outcome === "expired") return "expired";
  // The knowledge had the answer and the first search missed it (B-153's second look), yet a person got the message.
  if (ASKED_A_PERSON.has(outcome) && run.secondLook?.cause === "retrieval") return "handed_with_knowledge";
  return null;
}

/** The ticket's text: the paraphrase, scrubbed; null when the run kept none worth a ticket. */
export function evalTextOf(run: AgentRun): string | null {
  const text = scrubPersonal((run.question ?? run.summary ?? "").trim()).slice(0, 2000);
  return text.length >= 8 ? text : null;
}

/** Judges one preview against what the ticket expects. */
export function evalVerdict(expect: EvalExpect, preview: { status: string; run: Partial<AgentRun> | null; reply: { text: string } | null; draft: { text: string } | null }, version: number, at: string): EvalResult {
  const run = preview.run ?? {};
  const got = { status: preview.status, handoff: run.handoff === true, fallback: run.fallback === true, grounded: typeof run.grounded === "boolean" ? run.grounded : null };
  const answered = preview.status === "sent" && !!preview.reply && !got.handoff && !got.fallback && got.grounded !== false;
  const toPerson = got.handoff || ["drafted", "held", "skipped"].includes(preview.status);
  const pass = expect === "answer" ? answered : toPerson;
  return { at, version, verdict: pass ? "pass" : "fail", got, reply: (preview.reply?.text ?? preview.draft?.text ?? "").slice(0, 500) };
}

/** The result of a preview that could not run (the model, the agent or the address could not be read). */
export function evalError(error: unknown, version: number, at: string): EvalResult {
  return { at, version, verdict: "error", got: { status: "error", handoff: false, fallback: false, grounded: null }, reply: String((error as Error)?.message ?? error).slice(0, 200) };
}
