// B-118 (M5): where agent answers go. Every run that ends becomes one event of the agent-events feed
// (the fabric-service/0.1 events page: id, at, kind, level, text, data), which other agents read by
// cursor over MCP (`list_agent_events`). An event names the address, the agent and what it did, the
// question it could not answer (the model's paraphrase, written without personal data) and the
// titles of the passages it used — never the sender, the subject, or any message's text.
import type { AgentRun } from "./run";
import { messageLink } from "../../shared/mail/open-link";
import { QUALITY_SCHEMA, type QualityDaily } from "./quality";
import type { KnowledgeLearned, KnowledgeRetracted } from "./knowledge-events";
import type { AnswerCited, SupportDiagnosed } from "./learning-events";

/** The payload schema of `data.value`, published in this repository. */
export const AGENT_EVENT_SCHEMA = "https://github.com/passioncode-ai/fabric-inbox/blob/main/docs/agents/agent-event.schema.json";

export interface AgentEvent {
  at: string;
  kind: "agent.sent" | "agent.drafted" | "agent.skipped" | "agent.unanswered" | "agent.needs_look" | "agent.not_helped" | "agent.handoff" | "agent.waiting" | "agent.abandoned" | "support.quality_daily"
    | "knowledge.learned" | "knowledge.retracted" | "answer.cited" | "support.diagnosed";
  level: "info" | "notice" | "warning";
  text: string;
  /** Opens the message and its run in the inbox (B-119): a path under the server's origin. */
  link: string;
  /**
   * `AgentEventValue` for agent.* kinds; the quality standard's day for support.quality_daily (B-130); a knowledge
   * change for knowledge.* (B-161); what a sent answer cited, or why a message was not answered (B-162).
   */
  data: { schema: string; value: AgentEventValue | QualityDaily | KnowledgeLearned | KnowledgeRetracted | AnswerCited | SupportDiagnosed };
}
export interface AgentEventValue {
  runId: string; address: string; agentId?: string; agentVersion?: number; status: string;
  intent?: string; grounded?: boolean; unanswered: boolean; question?: string; sources: string[];
  topic?: string; summary?: string;
  /** The policy category of the message; whether it was handed to a person, got the safe reply, or said an earlier answer did not help. */
  category?: string; handoff?: boolean; fallback?: boolean; dissatisfied?: boolean;
  /** B-131: the message has waited for a person past the SLA (event kind agent.waiting), in whole hours. */
  waitingHours?: number;
  /** B-141: the second agent.waiting of a message: its retries ended after 30 days; whether a closing reply naming another route went out. */
  closed?: boolean; closingSent?: boolean;
  /** B-170 (agent.abandoned): where the conversation stands and how many whole hours its last message has waited. */
  state?: string; abandonedHours?: number;
}

/**
 * Removes what could identify a person from a model's paraphrase before it leaves the server: e-mail
 * addresses, links, @usernames and phone numbers (seven or more digits). Version numbers stay.
 */
export function scrubPersonal(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[…]")
    .replace(/\bhttps?:\/\/\S+/gi, "[…]")
    .replace(/(^|[\s(,;])@\w{3,}/g, "$1[…]")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, (m) => (m.replace(/\D/g, "").length >= 7 && !/^\d+(\.\d+){1,3}$/.test(m.trim()) ? "[…]" : m));
}

const ENDED = new Set(["sent", "drafted", "held", "skipped", "off", "send_failed", "send_unknown", "failed", "interrupted"]);
const TROUBLE = new Set(["send_failed", "send_unknown", "failed", "interrupted"]);
const cut = (s: string, n = 500) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The event of a run that ended, or null for one still going (B-118). */
export function runEvent(run: AgentRun): AgentEvent | null {
  if (!ENDED.has(run.status)) return null;
  const who = run.agentId ? `Agent ${run.agentId}` : "An agent";
  const unanswered = run.unanswered === true;
  const kind: AgentEvent["kind"] = TROUBLE.has(run.status) ? "agent.needs_look"
    : run.dissatisfied ? "agent.not_helped"
    : run.handoff ? "agent.handoff"
    : unanswered ? "agent.unanswered"
    : run.status === "sent" ? "agent.sent"
    : run.status === "drafted" ? "agent.drafted" : "agent.skipped";
  const text = kind === "agent.needs_look" ? `${who} needs a look at a message to ${run.mailboxId}.`
    : kind === "agent.not_helped" ? `A reply to ${run.mailboxId} says an earlier answer from ${run.agentId ?? "its agent"} did not help.`
    : kind === "agent.handoff" ? `${who} passed a message to ${run.mailboxId} to a person${run.category ? ` (${run.category})` : ""}.`
    : kind === "agent.unanswered" ? `${who} found no answer for a question to ${run.mailboxId}.`
    : kind === "agent.sent" ? `${who} sent an answer from ${run.mailboxId}.`
    : kind === "agent.drafted" ? `${who} drafted an answer for ${run.mailboxId}.`
    : `${who} left a message to ${run.mailboxId} alone.`;
  const value: AgentEventValue = {
    runId: run.id, address: run.mailboxId,
    ...(run.agentId ? { agentId: run.agentId } : {}), ...(run.agentVersion ? { agentVersion: run.agentVersion } : {}),
    status: run.status, ...(run.intent ? { intent: cut(run.intent) } : {}),
    ...(run.grounded !== undefined ? { grounded: run.grounded } : {}),
    unanswered, ...(unanswered && run.question ? { question: cut(scrubPersonal(run.question)) } : {}),
    sources: (run.sources ?? []).slice(0, 32).map((s) => cut(s.title)),
    ...(run.topic ? { topic: cut(scrubPersonal(run.topic), 60) } : {}),
    ...(run.summary ? { summary: cut(scrubPersonal(run.summary), 300) } : {}),
    ...(run.category ? { category: cut(run.category, 60) } : {}),
    ...(run.handoff ? { handoff: true } : {}), ...(run.fallback ? { fallback: true } : {}), ...(run.dissatisfied ? { dissatisfied: true } : {}),
  };
  return { at: run.updatedAt, link: messageLink(`cloudflare:${run.mailboxId}`, run.emailId, run.id), kind, level: kind === "agent.needs_look" || kind === "agent.not_helped" ? "warning" : kind === "agent.unanswered" || kind === "agent.handoff" ? "notice" : "info", text: cut(text), data: { schema: AGENT_EVENT_SCHEMA, value } };
}

/** Events kept: at least seven days or 1000 events, whichever is more (fabric-service/0.1). */
export const EVENTS_KEPT = 1000;
export const EVENTS_KEPT_MS = 7 * 86_400_000;

/**
 * B-131: the one escalation of a message still waiting for a person past the SLA: held (the agent
 * was not sure) or drafted (a person sends it). Emitted once per run, at `at`.
 */
export function waitingEvent(run: AgentRun, at: string, closing?: { closed: true; sent: boolean }): AgentEvent {
  const hours = Math.max(1, Math.floor((Date.parse(at) - Date.parse(run.createdAt)) / 3_600_000));
  const what = run.status === "drafted" ? "a draft a person has not sent"
    : run.status === "failed" ? "no answer after an agent error"
    : run.status === "skipped" ? "no answer: the safety check held it back" : "no answer yet";
  const value: AgentEventValue = {
    runId: run.id, address: run.mailboxId,
    ...(run.agentId ? { agentId: run.agentId } : {}), ...(run.agentVersion ? { agentVersion: run.agentVersion } : {}),
    status: run.status, unanswered: run.unanswered === true,
    ...(run.unanswered && run.question ? { question: cut(scrubPersonal(run.question)) } : {}),
    sources: (run.sources ?? []).slice(0, 32).map((s) => cut(s.title)),
    ...(run.category ? { category: cut(run.category, 60) } : {}),
    waitingHours: hours,
    ...(closing ? { closed: true, closingSent: closing.sent } : {}),
  };
  const days = Math.floor(hours / 24);
  const text = closing
    ? `A message to ${run.mailboxId} got no answer in ${days} days; the agent stopped trying${closing.sent ? " and sent a reply naming another route" : " and sent nothing"}.`
    : `A message to ${run.mailboxId} has waited ${hours} hours with ${what}.`;
  return { at, link: messageLink(`cloudflare:${run.mailboxId}`, run.emailId, run.id), kind: "agent.waiting", level: "warning",
    text: cut(text), data: { schema: AGENT_EVENT_SCHEMA, value } };
}

/**
 * B-170 (operator, 2026-10-25): a conversation on an agent address still waits for someone two days
 * after its last message came in. Emitted once per message by the registry's hourly look; `run` is the
 * reply agent's run on that message when there is one.
 */
export function abandonedEvent(input: { address: string; emailId: string; runId: string; run?: AgentRun; agentId?: string; state: string; receivedAt: number }, at: string): AgentEvent {
  const hours = Math.max(48, Math.floor((Date.parse(at) - input.receivedAt) / 3_600_000));
  const run = input.run;
  const agentId = run?.agentId ?? input.agentId;
  const value: AgentEventValue = {
    runId: input.runId, address: input.address,
    ...(agentId ? { agentId } : {}), ...(run?.agentVersion ? { agentVersion: run.agentVersion } : {}),
    status: run?.status ?? "none", unanswered: run?.unanswered === true,
    ...(run?.unanswered && run.question ? { question: cut(scrubPersonal(run.question)) } : {}),
    sources: (run?.sources ?? []).slice(0, 32).map((s) => cut(s.title)),
    ...(run?.category ? { category: cut(run.category, 60) } : {}),
    state: input.state, abandonedHours: hours,
  };
  return { at, link: messageLink(`cloudflare:${input.address}`, input.emailId, run?.id), kind: "agent.abandoned", level: "warning",
    text: cut(`A conversation on ${input.address} has had no reply for ${Math.floor(hours / 24)} days (${input.state.replace(/_/g, " ")}).`),
    data: { schema: AGENT_EVENT_SCHEMA, value } };
}

/** B-130: the day's quality of one agent address (support.quality_daily); counts only. */
export function qualityEvent(address: string, value: QualityDaily, at: string): AgentEvent {
  const people = (value.autonomy.toPersonPolicy ?? 0) + (value.autonomy.toPersonInability ?? 0);
  return { at, link: "/settings/agents", kind: "support.quality_daily", level: "info",
    text: cut(`Quality of ${address} on ${value.date}: ${value.coverage.turns ?? "unknown"} messages, ${value.autonomy.answered ?? 0} answered by the agent, ${people} for a person, ${value.autonomy.personQueueWaiting ?? 0} waiting.`),
    data: { schema: QUALITY_SCHEMA, value } };
}
