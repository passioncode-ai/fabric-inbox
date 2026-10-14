// B-118 (M5): where agent answers go. Every run that ends becomes one event of the agent-events feed
// (the fabric-service/0.1 events page: id, at, kind, level, text, data), which other agents read by
// cursor over MCP (`list_agent_events`). An event names the address, the agent and what it did, the
// question it could not answer (the model's paraphrase, written without personal data) and the
// titles of the passages it used — never the sender, the subject, or any message's text.
import type { AgentRun } from "./run";
import { messageLink } from "../../shared/mail/open-link";

/** The payload schema of `data.value`, published in this repository. */
export const AGENT_EVENT_SCHEMA = "https://github.com/passioncode-ai/fabric-inbox/blob/main/docs/agents/agent-event.schema.json";

export interface AgentEvent {
  at: string;
  kind: "agent.sent" | "agent.drafted" | "agent.skipped" | "agent.unanswered" | "agent.needs_look";
  level: "info" | "notice" | "warning";
  text: string;
  /** Opens the message and its run in the inbox (B-119): a path under the server's origin. */
  link: string;
  data: { schema: string; value: AgentEventValue };
}
export interface AgentEventValue {
  runId: string; address: string; agentId?: string; agentVersion?: number; status: string;
  intent?: string; grounded?: boolean; unanswered: boolean; question?: string; sources: string[];
}

const ENDED = new Set(["sent", "drafted", "skipped", "off", "send_failed", "send_unknown", "failed", "interrupted"]);
const TROUBLE = new Set(["send_failed", "send_unknown", "failed", "interrupted"]);
const cut = (s: string, n = 500) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The event of a run that ended, or null for one still going (B-118). */
export function runEvent(run: AgentRun & { question?: string; unanswered?: boolean }): AgentEvent | null {
  if (!ENDED.has(run.status)) return null;
  const who = run.agentId ? `Agent ${run.agentId}` : "An agent";
  const unanswered = run.unanswered === true;
  const kind: AgentEvent["kind"] = TROUBLE.has(run.status) ? "agent.needs_look"
    : unanswered ? "agent.unanswered"
    : run.status === "sent" ? "agent.sent"
    : run.status === "drafted" ? "agent.drafted" : "agent.skipped";
  const text = kind === "agent.needs_look" ? `${who} needs a look at a message to ${run.mailboxId}.`
    : kind === "agent.unanswered" ? `${who} found no answer for a question to ${run.mailboxId}.`
    : kind === "agent.sent" ? `${who} sent an answer from ${run.mailboxId}.`
    : kind === "agent.drafted" ? `${who} drafted an answer for ${run.mailboxId}.`
    : `${who} left a message to ${run.mailboxId} alone.`;
  const value: AgentEventValue = {
    runId: run.id, address: run.mailboxId,
    ...(run.agentId ? { agentId: run.agentId } : {}), ...(run.agentVersion ? { agentVersion: run.agentVersion } : {}),
    status: run.status, ...(run.intent ? { intent: cut(run.intent) } : {}),
    ...(run.grounded !== undefined ? { grounded: run.grounded } : {}),
    unanswered, ...(unanswered && run.question ? { question: cut(run.question) } : {}),
    sources: (run.sources ?? []).slice(0, 32).map((s) => cut(s.title)),
  };
  return { at: run.updatedAt, link: messageLink(`cloudflare:${run.mailboxId}`, run.emailId, run.id), kind, level: kind === "agent.needs_look" ? "warning" : kind === "agent.unanswered" ? "notice" : "info", text: cut(text), data: { schema: AGENT_EVENT_SCHEMA, value } };
}

/** Events kept: at least seven days or 1000 events, whichever is more (fabric-service/0.1). */
export const EVENTS_KEPT = 1000;
export const EVENTS_KEPT_MS = 7 * 86_400_000;
