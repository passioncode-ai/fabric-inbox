import { useT } from "~/lib/i18n";
import { AGENT_STATES, type AgentState } from "../../../shared/mail/agent-state";
import { replyStateLabel } from "./reply-state";

/**
 * The list by reply status (B-138): every conversation, those waiting for someone ("Needs a reply":
 * no reply, new after the agent, an error, missing data, the agent's draft), or one state. The numbers
 * are the conversations in each state on the addresses where the status is shown.
 */
export default function ReplyFilter({ value, counts, onChange }: {
  value: string;
  counts?: Partial<Record<AgentState, number>>;
  onChange: (next: string) => void;
}) {
  const t = useT();
  const open = counts ? (["unanswered", "new_after_agent", "error", "needs_data", "agent_draft"] as const).reduce((n, s) => n + (counts[s] ?? 0), 0) : undefined;
  return (
    <div className="fi-chip-row" role="group" aria-label={t("Reply status")}>
      <button type="button" className="fi-chip" aria-pressed={value === "open"} onClick={() => onChange(value === "open" ? "" : "open")}>
        {t("Needs a reply")}{open !== undefined && <span>{open}</span>}
      </button>
      {value && (
        <select className="fi-chip fi-reply-select" aria-label={t("One reply status")} value={value === "open" ? "" : value}
          onChange={(e) => onChange(e.target.value || "open")}>
          <option value="">{t("Every status that needs a reply")}</option>
          {AGENT_STATES.map((s) => (
            <option key={s} value={s}>{replyStateLabel(s, t)}{counts?.[s] !== undefined ? ` (${counts[s]})` : ""}</option>
          ))}
        </select>
      )}
    </div>
  );
}
