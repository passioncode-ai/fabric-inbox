import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "~/lib/i18n";
import { fabric } from "~/services/fabric";
import { ApiError } from "~/services/api";
import { agentStatusOn, type AgentStatusSettings } from "../../../../shared/mail/agent-state";

const KEY = ["agent-status"];

/** B-176: the Gmail, IMAP and Outlook accounts with a reply agent join the addresses, each under its email's domain. */
export function withAccounts(groups: { domain: string; addresses: string[] }[], accounts: { email: string }[] = []): { domain: string; addresses: string[]; accounts: string[] }[] {
  const out = groups.map((g) => ({ ...g, accounts: [] as string[] }));
  for (const { email } of accounts) {
    const address = email.trim().toLowerCase(), domain = address.slice(address.lastIndexOf("@") + 1);
    if (!domain || out.some((g) => g.addresses.includes(address) || g.accounts.includes(address))) continue;
    const group = out.find((g) => g.domain === domain) ?? out[out.push({ domain, addresses: [], accounts: [] }) - 1]!;
    group.accounts.push(address);
  }
  return out;
}

/**
 * Where the inbox shows the reply status of conversations (B-138, operator 2026-10-21): for the
 * whole workspace, then a domain, then an address; each one follows the level above unless it is
 * set. Off by default. A change is saved at once and the list reads it on its next look.
 */
export default function ReplyStatusSettings({ groups }: { groups: { domain: string; addresses: string[] }[] }) {
  const t = useT();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: () => fabric<AgentStatusSettings & { accounts?: { email: string }[] }>("/api/agent-status"), retry: false });
  const save = useMutation({
    mutationFn: (change: { enabled?: boolean; domains?: Record<string, boolean | null>; addresses?: Record<string, boolean | null> }) =>
      fabric<AgentStatusSettings>("/api/agent-status", change, "PUT"),
    onSuccess: (next) => {
      client.setQueryData(KEY, (old: { accounts?: unknown } | undefined) => ({ ...next, accounts: old?.accounts }));
      void client.invalidateQueries({ queryKey: ["unified-inbox"] });
    },
  });
  const s = settings.data;
  if (settings.isPending) return <p className="fi-hint" role="status">{t("Loading…")}</p>;
  if (!s) return <p className="fi-action-result is-error" role="alert">{t("The reply status settings could not be read.")}</p>;
  const choice = (value: boolean | undefined) => (value === undefined ? "" : value ? "on" : "off");
  const parse = (v: string): boolean | null => (v === "" ? null : v === "on");
  const busy = save.isPending;
  return (
    <section className="fi-reply-status" aria-labelledby="fi-reply-status-title">
      <h3 id="fi-reply-status-title">{t("Reply status in the inbox")}</h3>
      <p className="fi-hint">{t("Marks each conversation with who answered last, or why nobody did (no reply, new after the agent, an error, missing data), and adds the Needs a reply filter. Off until you turn it on; a domain follows the workspace, an address its domain.")}</p>
      <label className="fi-switch-row">
        <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
        {t("Show it for every address")}
      </label>
      {withAccounts(groups, s.accounts).map((g) => (
        <fieldset key={g.domain} className="fi-reply-status-domain">
          <legend>
            {g.domain}
            <select aria-label={t("Reply status for {domain}", { domain: g.domain })} value={choice(s.domains[g.domain])} disabled={busy}
              onChange={(e) => save.mutate({ domains: { [g.domain]: parse(e.target.value) } })}>
              <option value="">{s.enabled ? t("As the workspace (shown)") : t("As the workspace (hidden)")}</option>
              <option value="on">{t("Shown")}</option>
              <option value="off">{t("Hidden")}</option>
            </select>
          </legend>
          {[...g.addresses.map((a) => [a, false] as const), ...g.accounts.map((a) => [a, true] as const)].map(([a, account]) => {
            const inherited = agentStatusOn({ ...s, addresses: {} }, a);
            return (
              <label key={a} className="fi-reply-status-address">
                <span>{a}{account && <span className="fi-hint"> · {t("account with a reply agent")}</span>}</span>
                <select aria-label={t("Reply status for {address}", { address: a })} value={choice(s.addresses[a])} disabled={busy}
                  onChange={(e) => save.mutate({ addresses: { [a]: parse(e.target.value) } })}>
                  <option value="">{inherited ? t("As the domain (shown)") : t("As the domain (hidden)")}</option>
                  <option value="on">{t("Shown")}</option>
                  <option value="off">{t("Hidden")}</option>
                </select>
              </label>
            );
          })}
        </fieldset>
      ))}
      {save.isError && (
        <p className="fi-action-result is-error" role="alert">
          {save.error instanceof ApiError ? t.text(save.error.message) : t("The change could not be saved. Try again.")}
        </p>
      )}
    </section>
  );
}
