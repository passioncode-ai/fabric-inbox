// B-162: two events for the agents that keep one shared learning loop over every channel's answers, in the
// flat shape the board agreed (thread of 2026-10-24, the support bot's 2.10.1): `answer.cited` for every answer
// a reply agent sent from its knowledge (the ids of the items it cited and each one's coverage, at the same
// index), and `support.diagnosed` once per message an agent did not answer, with the cause it reads at the
// turn. Neither carries a sender, a subject or any text of the message or the reply; the question is the
// model's English restatement with personal data removed. A second look that rescues an answer is B-153's.
import type { AgentRun } from "./run";
import type { AgentEvent } from "./events";
import { scrubPersonal } from "./events";
import { messageLink } from "../../shared/mail/open-link";

/** The payload schemas of `data.value`, published in this repository. */
export const ANSWER_CITED_SCHEMA = "https://github.com/passioncode-ai/fabric-inbox/blob/main/docs/agents/answer-cited.schema.json";
export const SUPPORT_DIAGNOSED_SCHEMA = "https://github.com/passioncode-ai/fabric-inbox/blob/main/docs/agents/support-diagnosed.schema.json";
/** At most this many cited items an event names; the question is cut to QUESTION_CHARS. */
export const CITED_MAX = 12;
export const QUESTION_CHARS = 300;

/**
 * Why a message was not answered, as the turn reads it: `data` (the knowledge has no answer), `draft-or-check`
 * (the material was there but the answer was not sure or the checker refused it), `person` (only a person can
 * act). `retrieval` (the knowledge answers it but the turn's search missed it) needs a wider second search,
 * so only a second look names it.
 */
export type Cause = "retrieval" | "draft-or-check" | "data" | "person";

export interface AnswerCited {
  at: string;
  channel: "email";
  address: string;
  runId: string;
  agentId?: string;
  agentVersion?: number;
  category: string | null;
  /** `answered`: it cited knowledge items; `general`: it rested on the agent's own knowledge text and instructions. */
  status: "answered" | "general";
  question: string | null;
  cited: string[];
  /** Each cited item's share of the question at the same index as `cited`; null when the tool gave none. */
  coverage: (number | null)[];
  revision: string | null;
}

export interface SupportDiagnosed {
  at: string;
  channel: "email";
  address: string;
  runId: string;
  agentId?: string;
  agentVersion?: number;
  category: string | null;
  question: string | null;
  cause: Cause;
  /** Always false at the turn: a rescued answer comes from a second look. */
  rescued: boolean;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The model's English restatement of what the sender asks, without personal data, or null. */
function questionOf(run: AgentRun): string | null {
  const text = (run.unanswered && run.question) || run.summary || run.question || "";
  const clean = scrubPersonal(text.trim());
  return clean ? cut(clean, QUESTION_CHARS) : null;
}

function common(run: AgentRun, at: string) {
  return {
    at, channel: "email" as const, address: run.mailboxId, runId: run.id,
    ...(run.agentId ? { agentId: run.agentId } : {}), ...(run.agentVersion ? { agentVersion: run.agentVersion } : {}),
    category: run.category ? cut(run.category, 60) : null,
    question: questionOf(run),
  };
}

/** The items a run's answer cited, each once, in the order the tools gave them, with their coverage. */
export function citedOf(run: AgentRun): { cited: string[]; coverage: (number | null)[]; revision: string | null } {
  const cited: string[] = [];
  const coverage: (number | null)[] = [];
  for (const trace of run.evidence ?? []) {
    (trace.items ?? []).forEach((id, i) => {
      if (cited.length >= CITED_MAX || cited.includes(id)) return;
      cited.push(cut(id, 200));
      const c = trace.coverage?.[i];
      coverage.push(typeof c === "number" ? c : null);
    });
  }
  const revision = (run.evidence ?? []).find((t) => t.revision)?.revision ?? null;
  return { cited, coverage, revision: revision ? cut(revision, 200) : null };
}

/** The event of an answer a reply agent sent from its knowledge, or null (not sent, a hand-off or the safe reply). */
export function answerCitedEvent(run: AgentRun): AgentEvent | null {
  if (run.status !== "sent" || run.handoff || run.fallback) return null;
  const at = run.repliedAt ?? run.updatedAt;
  const { cited, coverage, revision } = citedOf(run);
  const value: AnswerCited = { ...common(run, at), status: cited.length ? "answered" : "general", cited, coverage, revision };
  const who = run.agentId ? `Agent ${run.agentId}` : "An agent";
  return { at, kind: "answer.cited", level: "info", link: messageLink(`cloudflare:${run.mailboxId}`, run.emailId, run.id),
    text: cited.length ? `${who}'s answer from ${run.mailboxId} cited ${cited.length} knowledge item${cited.length === 1 ? "" : "s"}.`
      : `${who}'s answer from ${run.mailboxId} cited no knowledge item.`,
    data: { schema: ANSWER_CITED_SCHEMA, value } };
}

/**
 * The cause the turn reads for a message it did not answer, or null when there is nothing to diagnose: answered,
 * still running, failed (a run that failed is retried), or a knowledge lookup that failed (an outage is not a gap,
 * so it names no cause).
 */
export function causeOf(run: AgentRun): Cause | null {
  const unanswered = run.status === "held" || (run.status === "sent" && (run.handoff || run.fallback));
  if (!unanswered) return null;
  if (run.handoff) return "person";
  const lookupFailed = (run.toolCalls ?? []).some((c) => !c.ok && c.name !== "check" && !c.name.endsWith(":gap"));
  if (lookupFailed) return null;
  return run.unanswered ? "data" : "draft-or-check";
}

export function supportDiagnosedEvent(run: AgentRun, cause: Cause): AgentEvent {
  const at = run.updatedAt;
  const value: SupportDiagnosed = { ...common(run, at), cause, rescued: false };
  const who = run.agentId ? `Agent ${run.agentId}` : "An agent";
  const why = cause === "person" ? "only a person can act" : cause === "data" ? "the knowledge has no answer"
    : cause === "retrieval" ? "the knowledge has an answer the search missed" : "the answer was not sure or not approved";
  return { at, kind: "support.diagnosed", level: "notice", link: messageLink(`cloudflare:${run.mailboxId}`, run.emailId, run.id),
    text: `${who} did not answer a message to ${run.mailboxId}: ${why}.`,
    data: { schema: SUPPORT_DIAGNOSED_SCHEMA, value } };
}
