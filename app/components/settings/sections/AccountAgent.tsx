/**
 * Who answers a Gmail, IMAP or Outlook account (SCN-086, B-171): Off, or one reply agent, saved with
 * PUT /api/accounts/:id/agent. The agents list says which accounts each agent answers.
 */
import { useQueryClient } from "@tanstack/react-query";
import { fabric, accountPath, type Account } from "../../../services/fabric";
import { useT } from "../../../lib/i18n";
import { ActionResult, LoadFailure, PanelBlock, useWork } from "../ui";
import { AGENTS_KEY, useAgents } from "./data";
import { agentLine } from "./add-address-model";

export function AccountAgent({ account: a, provider }: { account: Account; provider: "gmail" | "imap" | "outlook" }) {
  const t = useT();
  const client = useQueryClient();
  const agents = useAgents();
  const work = useWork(a.id, "answers");
  const accountId = `${provider}:${a.id}`;
  const current = agents.data?.agents.find((x) => x.accounts?.includes(accountId))?.id ?? "off";
  const chosen = agents.data?.agents.find((x) => x.id === current);
  const drafts = a.capabilities?.drafts !== false;
  const choose = (value: string) => void work.run(t("Saving…"), async () => {
    try {
      await fabric(accountPath(a.id) + "/agent", { agent: value === "off" ? "off" : { id: value } }, "PUT");
    } finally { await client.invalidateQueries({ queryKey: AGENTS_KEY }); }
    return value === "off" ? t("{email} is Off. New mail stays for you.", { email: a.email })
      : t("{email} is answered by {agent}.", { email: a.email, agent: agents.data?.agents.find((x) => x.id === value)?.name ?? value });
  });
  return (
    <PanelBlock title={t("Who answers")}>
      {agents.isError ? (
        <LoadFailure what={t("Agents")} error={agents.error} onRetry={() => void agents.refetch()} retrying={agents.isFetching} />
      ) : (
        <label className="fi-field">
          <span className="fi-hint">{t("An agent answers new mail in this account's inbox within its reply policy, from the account itself; Off keeps the mail for you.")}</span>
          <select className="fi-input" aria-label={t("Who answers")} value={current} disabled={!!work.busy || agents.isPending} onChange={(e) => choose(e.target.value)}>
            <option value="off">{t("Off — I read it myself")}</option>
            {agents.data?.agents.map((x) => {
              const blocked = x.replyPolicy.mode === "draft" && !drafts;
              return <option key={x.id} value={x.id} disabled={blocked}>{blocked ? t("{agent} (drafts; this account keeps no drafts)", { agent: x.name }) : x.name}</option>;
            })}
          </select>
          {chosen && <span className="fi-hint">{agentLine(chosen, t)}</span>}
        </label>
      )}
      <ActionResult result={work.result} />
    </PanelBlock>
  );
}
