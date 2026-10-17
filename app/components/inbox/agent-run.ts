import type { T } from "../../../shared/i18n";

const ATTENTION = new Set(["send_failed", "send_unknown", "failed", "interrupted"]);

/** What a reply agent did with a message, in a few words (B-115): the list's mark and the panel's title. */
export function agentRunLabel(status: string, t: T): string {
  if (status === "sent") return t("Agent replied");
  if (status === "drafted") return t("Agent's draft");
  if (status === "held") return t("Waiting for the knowledge");
  if (status === "skipped") return t("Agent left it alone");
  if (status === "running") return t("Agent is answering");
  if (ATTENTION.has(status)) return t("Agent: needs a look");
  return t("Agent");
}
export const agentRunNeedsLook = (status: string) => ATTENTION.has(status);

/** A draft a reply agent left (B-115): its id is the run's id with `-draft` (workers/agents/runner.ts). */
export const isAgentDraft = (serverId: string) => /^agent-[0-9a-f]{32}-draft(-\d+)?$/.test(serverId);
