import type { ReplyPolicy } from "./definition";
import { msg } from "../../shared/i18n";

/** What the model proposes; the policy below decides what actually happens. */
export interface ModelDecision {
  decision: "send" | "draft" | "skip";
  /** A short label for what the sender wants, e.g. "pricing", "how-to". */
  intent: string;
  /** The answer rests on the agent's knowledge or a tool result, not on a guess. */
  grounded: boolean;
  body: string;
  reason: string;
  /** When nothing answered the question: a one-sentence paraphrase with no personal data (B-85 gaps). */
  question?: string;
  /** What the message is about, in a few English words (the voice-of-the-customer theme). */
  topic?: string;
  /** What the sender wants, one English sentence without personal data (the voice-of-the-customer paraphrase). */
  summary?: string;
}

export interface PolicyContext {
  sentToday: number;
  toolFailures: number;
  /** MailboxDO.checkSendRateLimit text when the mailbox is over its limit. */
  rateLimited: string | null;
  /** Why the agent's knowledge could not be searched in this run; such an answer is never sent. */
  knowledgeProblem?: string | null;
  /** The knowledge tool asked before the model found no confident answer (abstained); never sent. */
  abstained?: boolean;
  /** A reply or forward, or a message in a conversation this address already answered. */
  followUp?: boolean;
  /** The draftTopics entry the message matched, if any. */
  topic?: string | null;
  /** A granted tool gave a confident answer in this run. */
  evidence?: boolean;
}

/** Re:, Fwd:, AW:, Отв:… at the start of a subject, any number of them, as mail clients write them. */
const FOLLOW_UP_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|sv|tr|отв|ответ|пересл)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;
export const isFollowUpSubject = (subject: string) => FOLLOW_UP_PREFIX.test(subject);

/** The first draftTopics entry the text matches: every " + " group needs one of its "|" words. */
export function matchedTopic(topics: readonly string[], text: string): string | null {
  const haystack = text.toLowerCase();
  for (const entry of topics) {
    const groups = entry.split(" + ").map((g) => g.split("|").map((w) => w.trim().toLowerCase()).filter(Boolean)).filter((g) => g.length);
    if (groups.length && groups.every((words) => words.some((w) => haystack.includes(w)))) return entry;
  }
  return null;
}

export type PolicyOutcome =
  | { action: "send"; reason: string }
  | { action: "draft"; reason: string }
  | { action: "skip"; reason: string };

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * The only place an answer becomes a send (REQ-P3). Everything that is not
 * positively allowed is a draft with its reason; text inside the email cannot
 * reach this function except through the model's proposal, which it only narrows.
 */
export function decide(policy: ReplyPolicy, proposal: ModelDecision, context: PolicyContext): PolicyOutcome {
  if (proposal.decision === "skip")
    return { action: "skip", reason: proposal.reason.trim() || msg("The agent found nothing to answer") };
  if (!proposal.body.trim()) return { action: "skip", reason: msg("The agent produced no answer") };
  if (policy.mode === "draft") return { action: "draft", reason: msg("This agent drafts only") };
  if (context.knowledgeProblem) return { action: "draft", reason: msg("The knowledge could not be searched ({problem})", { problem: context.knowledgeProblem }) };
  if (context.abstained) return { action: "draft", reason: msg("No confident answer in the knowledge; a person checks it") };
  if (policy.draftFollowUps && context.followUp) return { action: "draft", reason: msg("A reply, a forward or a follow-up to an earlier answer: a person answers it") };
  if (context.topic) return { action: "draft", reason: msg("It is about a topic a person answers ({topic})", { topic: context.topic.slice(0, 80) }) };
  if (proposal.decision === "draft")
    return { action: "draft", reason: proposal.reason.trim() || msg("The agent asked for review") };
  if (context.toolFailures > 0) return { action: "draft", reason: msg("A tool call failed during this answer") };
  if (!proposal.grounded) return { action: "draft", reason: msg("The answer is not grounded in the agent's knowledge") };
  if (policy.requireEvidence && !context.evidence) return { action: "draft", reason: msg("No tool gave a confident answer to rest it on") };
  const allowed = policy.allowedIntents.map(normalize);
  if (allowed.length && !allowed.includes(normalize(proposal.intent)))
    return { action: "draft", reason: proposal.intent ? msg('Intent "{intent}" is not allowed to send', { intent: proposal.intent }) : msg('Intent "unknown" is not allowed to send') };
  if (policy.dailySendLimit !== null && context.sentToday >= policy.dailySendLimit)
    return { action: "draft", reason: msg("Daily send limit of {limit} reached", { limit: policy.dailySendLimit }) };
  if (context.rateLimited) return { action: "draft", reason: context.rateLimited };
  return { action: "send", reason: proposal.intent ? msg("Allowed: {intent}", { intent: proposal.intent }) : msg("Allowed: grounded answer") };
}
