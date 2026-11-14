/** @jsxRuntime automatic @jsxImportSource react */
/**
 * B-160 step 3 (SCN-082): a member chooses which of the server's agents answers a mailbox an administrator
 * gave them at "Read, send and choose its agent", or Off. The agents are listed by name only
 * (GET /api/agents, narrowed by the server); editing them stays the administrators'.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { accountPath, fabric } from "../../services/fabric";
import { useT } from "../../lib/i18n";
import { agentChoicesOf, useMe } from "../../lib/me";
import { errorText } from "./ui";

interface Choice { id: string; name: string; replyPolicy?: { mode?: string }; addresses?: string[]; accounts?: string[] }
export const MEMBER_AGENTS_KEY = ["member-agents"];

/** The agent answering a mailbox now, or "off": an address is named by its email, an account by its id. */
export const currentAgent = (agents: readonly Choice[], accountId: string) => {
  const email = accountId.startsWith("cloudflare:") ? accountId.slice("cloudflare:".length) : null;
  return agents.find((a) => (email ? a.addresses?.includes(email) : a.accounts?.includes(accountId)))?.id ?? "off";
};

/** Where a choice is saved: an address's route, or an account's (its id without the provider). */
export const agentPathOf = (accountId: string) => accountId.startsWith("cloudflare:")
  ? `/api/project-addresses/${encodeURIComponent(accountId.slice("cloudflare:".length))}/agent`
  : `${accountPath(accountId.slice(accountId.indexOf(":") + 1))}/agent`;

export function MemberAgents() {
  const t = useT();
  const client = useQueryClient();
  const me = useMe();
  const mine = agentChoicesOf(me);
  const agents = useQuery({ queryKey: MEMBER_AGENTS_KEY, enabled: mine.length > 0, queryFn: () => fabric<{ agents: Choice[] }>("/api/agents") });
  const names = useQuery({ queryKey: ["member-agents-mailboxes"], enabled: mine.length > 0,
    queryFn: () => fabric<{ accounts: { id: string; email?: string }[] }>("/api/inbox?limit=1") });
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!mine.length) return null;

  const label = (accountId: string) => names.data?.accounts.find((a) => a.id === accountId)?.email ?? accountId.replace(/^cloudflare:/, "");
  async function choose(accountId: string, value: string) {
    setBusy(accountId); setResult(null);
    try {
      await fabric(agentPathOf(accountId), { agent: value === "off" ? "off" : { id: value } }, "PUT");
      const mailbox = label(accountId);
      setResult({ ok: true, text: value === "off" ? t("{email} is Off. New mail stays for you.", { email: mailbox })
        : t("{email} is answered by {agent}.", { email: mailbox, agent: agents.data?.agents.find((a) => a.id === value)?.name ?? value }) });
    } catch (error) {
      setResult({ ok: false, text: t.text(errorText(error)) });
    } finally {
      setBusy(null);
      await client.invalidateQueries({ queryKey: MEMBER_AGENTS_KEY });
    }
  }

  return (
    <section aria-labelledby="fi-member-agents-title" className="fi-member-agents">
      <h3 id="fi-member-agents-title">{t("Who answers your mailboxes")}</h3>
      <p className="fi-hint">{t("An administrator lets you choose which of this server's agents answers these mailboxes. The agents themselves, their knowledge and rules stay with the administrators.")}</p>
      {agents.isPending ? <p role="status" className="fi-hint">{t("Loading agents…")}</p>
        : agents.isError ? (
          <p className="fi-action-result is-error" role="alert">
            {t.text(errorText(agents.error))}{" "}
            <button type="button" className="fi-secondary" onClick={() => void agents.refetch()} disabled={agents.isFetching}>{t("Retry")}</button>
          </p>
        ) : mine.map((accountId) => (
          <label key={accountId} className="fi-field">
            {label(accountId)}
            <select className="fi-input" aria-label={t("Who answers {mailbox}", { mailbox: label(accountId) })}
              value={currentAgent(agents.data.agents, accountId)} disabled={busy !== null} onChange={(e) => void choose(accountId, e.target.value)}>
              <option value="off">{t("Off: I read it myself")}</option>
              {agents.data.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        ))}
      {busy && <p role="status" className="fi-hint">{t("Saving…")}</p>}
      {result && <p className={result.ok ? "fi-action-result" : "fi-action-result is-error"} role={result.ok ? "status" : "alert"}>{result.text}</p>}
    </section>
  );
}
