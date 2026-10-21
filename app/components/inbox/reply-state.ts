import type { T } from "../../../shared/i18n";
import { OPEN_STATES, type AgentState } from "../../../shared/mail/agent-state";

/** A conversation's reply status in a few words (B-138): the list's mark and the filter's chips. */
export function replyStateLabel(state: AgentState, t: T): string {
  switch (state) {
    case "unanswered": return t("No reply");
    case "new_after_agent": return t("New after the agent");
    case "error": return t("Agent error");
    case "needs_data": return t("Agent lacks data");
    case "agent_draft": return t("Agent's draft waits");
    case "working": return t("Agent is answering");
    case "agent_replied": return t("Agent replied");
    case "person_replied": return t("You replied");
  }
}
/** A state that waits for someone, shown louder. */
export const replyStateOpen = (state: AgentState) => OPEN_STATES.includes(state);
