// B-161: when a person or an agent key changes what a reply agent answers from, the change goes on the
// server's events feed (`/fabric/v1/events`, `list_agent_events`) for the agents
// that keep one shared knowledge base: `knowledge.learned` for a document added or changed and for an
// agent's own knowledge text, `knowledge.retracted` for a document removed. The event names the addresses
// whose agents read it, so a reader takes only its own mailboxes; it never names a sender or a message.
import type { Env } from "../types";
import type { AgentEvent } from "./events";
import { readAssignment } from "./definition";
import { readAllSettings } from "../lib/mailbox-store";
import { agentAccounts } from "../lib/agent-status";

/** The payload schema of `data.value`, published in this repository. */
export const KNOWLEDGE_EVENT_SCHEMA = "https://github.com/passioncode-ai/fabric-inbox/blob/main/docs/agents/knowledge-event.schema.json";
/** The longest `answer` an event carries; a longer text is cut and marked `truncated`. */
export const ANSWER_CHARS = 8000;

/** Who stood behind a change: a person signed in to the server, an agent key, or unknown (local development). */
export type Validator = "operator" | "agent" | "unknown";

export interface KnowledgeLearned {
  /** `doc:<collection>/<document>@<revision>` or `agent:<agent>@<version>`: a new version is a new ref. */
  ref: string;
  source: "document" | "agent";
  collectionId?: string; documentId?: string; agentId?: string; version?: number;
  /** The addresses whose reply agents read this knowledge (Cloudflare addresses and connected accounts). */
  addresses: string[];
  /** What the text answers: a document's title; none for an agent's own knowledge text. */
  questions: string[];
  answer: string;
  truncated: boolean;
  validatedAt: string;
  validatedBy: Validator;
}
export interface KnowledgeRetracted {
  ref: string;
  source: "document";
  collectionId: string; documentId: string;
  addresses: string[];
  retractedAt: string;
  retractedBy: Validator;
}

/** `actorOf` (workers/lib/audit.ts): a person's email or `owner:…` is the operator, `key:…` an agent key. */
export function validatorOf(actor: string | null): Validator {
  if (!actor) return "unknown";
  return actor.startsWith("key:") ? "agent" : "operator";
}

/** Which addresses each agent answers, its Cloudflare addresses and its connected accounts' emails. */
export async function addressesByAgent(env: Env): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const add = (agentId: string, address: string) => map.set(agentId, [...new Set([...(map.get(agentId) ?? []), address.toLowerCase()])].sort());
  for (const { email, settings } of await readAllSettings(env.BUCKET)) {
    const assignment = readAssignment(settings);
    if (assignment && assignment !== "off") add(assignment.id, email);
  }
  for (const account of await agentAccounts(env).catch(() => [])) add(account.agentId, account.email);
  return map;
}

/** The addresses of the agents that read a collection. */
export function readersOf(collectionId: string, agents: { id: string; collections?: string[] }[], byAgent: Map<string, string[]>): string[] {
  return [...new Set(agents.filter((a) => (a.collections ?? []).includes(collectionId)).flatMap((a) => byAgent.get(a.id) ?? []))].sort();
}

const cutAnswer = (text: string) => (text.length > ANSWER_CHARS ? { answer: text.slice(0, ANSWER_CHARS), truncated: true } : { answer: text, truncated: false });

export function documentLearned(doc: { collectionId: string; id: string; revision: string; title: string; text: string }, addresses: string[], at: string, by: Validator): AgentEvent {
  const value: KnowledgeLearned = { ref: `doc:${doc.collectionId}/${doc.id}@${doc.revision}`, source: "document", collectionId: doc.collectionId, documentId: doc.id,
    addresses, questions: doc.title ? [doc.title] : [], ...cutAnswer(doc.text), validatedAt: at, validatedBy: by };
  return { at, kind: "knowledge.learned", level: "info", text: `Knowledge document "${doc.title}" changed`, link: `/settings/knowledge/${encodeURIComponent(doc.collectionId)}`,
    data: { schema: KNOWLEDGE_EVENT_SCHEMA, value } };
}

export function agentLearned(agent: { id: string; version: number; knowledge: string }, addresses: string[], at: string, by: Validator): AgentEvent {
  const value: KnowledgeLearned = { ref: `agent:${agent.id}@${agent.version}`, source: "agent", agentId: agent.id, version: agent.version,
    addresses, questions: [], ...cutAnswer(agent.knowledge), validatedAt: at, validatedBy: by };
  return { at, kind: "knowledge.learned", level: "info", text: `Agent ${agent.id}'s knowledge changed (version ${agent.version})`, link: `/settings/agents/${encodeURIComponent(agent.id)}`,
    data: { schema: KNOWLEDGE_EVENT_SCHEMA, value } };
}

export function documentRetracted(doc: { collectionId: string; id: string; revision: string; title: string }, addresses: string[], at: string, by: Validator): AgentEvent {
  const value: KnowledgeRetracted = { ref: `doc:${doc.collectionId}/${doc.id}@${doc.revision}`, source: "document", collectionId: doc.collectionId, documentId: doc.id,
    addresses, retractedAt: at, retractedBy: by };
  return { at, kind: "knowledge.retracted", level: "info", text: `Knowledge document "${doc.title}" removed`, link: `/settings/knowledge/${encodeURIComponent(doc.collectionId)}`,
    data: { schema: KNOWLEDGE_EVENT_SCHEMA, value } };
}

/** Appends the events; a failure is logged and never undoes the change it reports. */
export async function publishKnowledge(env: Env, events: AgentEvent[]): Promise<void> {
  if (!events.length || !env.AGENT_REGISTRY) return;
  try {
    await env.AGENT_REGISTRY.getByName("workspace").appendKnowledgeEvents(events);
  } catch (error) {
    console.error(JSON.stringify({ event: "knowledge_event_failed", count: events.length, error: (error as Error).message?.slice(0, 200) }));
  }
}
