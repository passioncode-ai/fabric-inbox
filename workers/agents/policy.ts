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
}

export interface PolicyContext {
  sentToday: number;
  toolFailures: number;
  /** MailboxDO.checkSendRateLimit text when the mailbox is over its limit. */
  rateLimited: string | null;
  /** Why the agent's knowledge could not be searched in this run; such an answer is never sent. */
  knowledgeProblem?: string | null;
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
  if (proposal.decision === "draft")
    return { action: "draft", reason: proposal.reason.trim() || msg("The agent asked for review") };
  if (context.toolFailures > 0) return { action: "draft", reason: msg("A tool call failed during this answer") };
  if (!proposal.grounded) return { action: "draft", reason: msg("The answer is not grounded in the agent's knowledge") };
  const allowed = policy.allowedIntents.map(normalize);
  if (allowed.length && !allowed.includes(normalize(proposal.intent)))
    return { action: "draft", reason: proposal.intent ? msg('Intent "{intent}" is not allowed to send', { intent: proposal.intent }) : msg('Intent "unknown" is not allowed to send') };
  if (context.sentToday >= policy.dailySendLimit)
    return { action: "draft", reason: msg("Daily send limit of {limit} reached", { limit: policy.dailySendLimit }) };
  if (context.rateLimited) return { action: "draft", reason: context.rateLimited };
  return { action: "send", reason: proposal.intent ? msg("Allowed: {intent}", { intent: proposal.intent }) : msg("Allowed: grounded answer") };
}
