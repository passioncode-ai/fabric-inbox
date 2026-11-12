import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fabric } from "../../../services/fabric";
import { useT } from "../../../lib/i18n";
import { msg, type T } from "../../../../shared/i18n";
import { LoadFailure, PanelBlock, SkeletonRows, errorText } from "../ui";
import { KEYS_KEY, mailboxDomains, type AgentKey } from "./AgentAccessSection";

/**
 * B-246 W2c (SCN-101; docs/app-store/tasks/2026-11-12-inbox-agent-grants.md): access per mailbox. An administrator gives
 * an agent key or a person capabilities on mailboxes, and revokes them. While the grants are checked beside today's
 * key levels and member levels (`decides: false`), the screen says that they do not change anyone's access yet.
 */
type Capability = "read" | "draft" | "send" | "organize" | "delete" | "create" | "remove" | "agents" | "campaign";
interface Grant {
  id: string; holder: { kind: "key"; id: string } | { kind: "person"; email: string }; mailboxes: string[]; can: Capability[];
  expiresAt: string | null; grantedBy: string; grantedAt: string; why: string;
}
interface GrantsState { grants: Grant[]; decides: boolean }
export const GRANTS_KEY = ["grants"];

const CAPABILITIES: { id: Capability; title: string; hint: string }[] = [
  { id: "read", title: msg("Read"), hint: msg("open and search mail") },
  { id: "draft", title: msg("[capability] Draft"), hint: msg("write drafts for a person to send") },
  { id: "send", title: msg("[capability] Send"), hint: msg("send mail now") },
  { id: "organize", title: msg("Organize"), hint: msg("move, mark and file mail") },
  { id: "delete", title: msg("[capability] Delete"), hint: msg("delete mail for good, with a second call") },
  { id: "create", title: msg("[capability] Create addresses"), hint: msg("on the domains chosen") },
  { id: "remove", title: msg("Remove addresses"), hint: msg("on the domains chosen") },
  { id: "agents", title: msg("Reply agents"), hint: msg("set up the mailboxes' agents") },
  { id: "campaign", title: msg("[capability] Campaigns"), hint: msg("prepare and send campaigns within their caps") },
];

/** A mailbox id as a person reads it. */
function mailboxText(id: string, t: T): string {
  if (id === "*") return t("Every mailbox");
  if (id.startsWith("domain:")) return t("Every address at {domain}", { domain: id.slice(7) });
  return id.replace(/^cloudflare:/, "");
}

export default function GrantsPanel() {
  const t = useT();
  const client = useQueryClient();
  const grants = useQuery({ queryKey: GRANTS_KEY, queryFn: () => fabric<GrantsState>("/api/grants") });
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: () => fabric<{ keys: AgentKey[] }>("/api/agent-keys") });
  const mailboxes = useQuery({ queryKey: ["agent-access-mailboxes"], queryFn: () => fabric<{ accounts: { id: string; email?: string }[] }>("/api/inbox?limit=1") });
  const blank = { holderKind: "key" as "key" | "person", holderKey: "", holderEmail: "", mailboxes: [] as string[], can: ["read"] as Capability[], why: "" };
  const [form, setForm] = useState(blank);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const keyName = (id: string) => keys.data?.keys.find((k) => k.id === id)?.name ?? id;
  const toggle = <V,>(list: V[], v: V, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  async function give() {
    setWorking(true); setProblem("");
    try {
      await fabric("/api/grants", {
        holder: form.holderKind === "key" ? { kind: "key", id: form.holderKey } : { kind: "person", email: form.holderEmail.trim() },
        mailboxes: form.mailboxes, can: form.can, why: form.why.trim(),
      });
      setForm(blank);
      await client.invalidateQueries({ queryKey: GRANTS_KEY });
    } catch (error) { setProblem(t.text(errorText(error))); } finally { setWorking(false); }
  }
  async function revoke(id: string) {
    setProblem("");
    try { await fabric(`/api/grants/${encodeURIComponent(id)}`, undefined, "DELETE"); await client.invalidateQueries({ queryKey: GRANTS_KEY }); }
    catch (error) { setProblem(t.text(errorText(error))); }
  }
  const ready = form.mailboxes.length > 0 && form.can.length > 0 && !!form.why.trim() && (form.holderKind === "key" ? !!form.holderKey : /.+@.+/.test(form.holderEmail));

  return (
    <>
      {grants.data && !grants.data.decides && (
        <p className="fi-hint">{t("These grants are recorded and checked beside each key's level and each person's role. They do not change anyone's access yet.")}</p>
      )}
      <PanelBlock title={t("Access given")}>
        {grants.isPending ? <SkeletonRows label={t("Loading access…")} /> : grants.isError ? (
          <LoadFailure what={t("Access by mailbox")} error={grants.error} onRetry={() => void grants.refetch()} retrying={grants.isFetching} />
        ) : !grants.data.grants.length ? <p>{t("Nobody has access given here yet.")}</p> : (
          <ul className="fi-plain-list">
            {grants.data.grants.map((g) => (
              <li key={g.id}>
                <strong>{g.holder.kind === "key" ? t("Agent key {name}", { name: keyName(g.holder.id) }) : g.holder.email}</strong>
                {": "}{g.can.map((c) => t.text(CAPABILITIES.find((x) => x.id === c)?.title ?? c)).join(", ")}
                {" · "}{g.mailboxes.map((m) => mailboxText(m, t)).join(", ")}
                <br /><span className="fi-hint">{t("Why: {reason}", { reason: g.why })} · {g.grantedBy}</span>{" "}
                <button type="button" className="fi-text-button" onClick={() => void revoke(g.id)}>{t("Revoke")}</button>
              </li>
            ))}
          </ul>
        )}
      </PanelBlock>
      <PanelBlock title={t("Give access")}>
        <form onSubmit={(e) => { e.preventDefault(); void give(); }}>
          <fieldset>
            <legend>{t("Who")}</legend>
            <label className="fi-check"><input type="radio" name="holder" checked={form.holderKind === "key"} onChange={() => setForm({ ...form, holderKind: "key" })} />
              <span>{t("An agent key")}</span></label>
            {form.holderKind === "key" && (
              <select className="fi-input" aria-label={t("Agent key")} value={form.holderKey} onChange={(e) => setForm({ ...form, holderKey: e.target.value })}>
                <option value="">{t("Choose a key")}</option>
                {(keys.data?.keys ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            )}
            <label className="fi-check"><input type="radio" name="holder" checked={form.holderKind === "person"} onChange={() => setForm({ ...form, holderKind: "person" })} />
              <span>{t("A person")}</span></label>
            {form.holderKind === "person" && (
              <input className="fi-input" type="email" aria-label={t("Their email")} placeholder={t("Their email")} value={form.holderEmail}
                onChange={(e) => setForm({ ...form, holderEmail: e.target.value })} />
            )}
          </fieldset>
          <fieldset>
            <legend>{t("Mailboxes")}</legend>
            <label className="fi-check"><input type="checkbox" checked={form.mailboxes.includes("*")} onChange={(e) => setForm({ ...form, mailboxes: toggle(form.mailboxes, "*", e.target.checked) })} />
              <span><strong>{t("Every mailbox")}</strong></span></label>
            {mailboxes.isError && <LoadFailure what={t("Mailboxes")} error={mailboxes.error} onRetry={() => void mailboxes.refetch()} retrying={mailboxes.isFetching} />}
            {mailboxDomains(mailboxes.data?.accounts ?? []).map((domain) => (
              <label key={domain} className="fi-check"><input type="checkbox" checked={form.mailboxes.includes(`domain:${domain}`)}
                onChange={(e) => setForm({ ...form, mailboxes: toggle(form.mailboxes, `domain:${domain}`, e.target.checked) })} />
                <span>{t("Every address at {domain}", { domain })}</span></label>
            ))}
            {(mailboxes.data?.accounts ?? []).map((m) => (
              <label key={m.id} className="fi-check"><input type="checkbox" checked={form.mailboxes.includes(m.id)}
                onChange={(e) => setForm({ ...form, mailboxes: toggle(form.mailboxes, m.id, e.target.checked) })} />
                <span>{m.email ?? m.id}</span></label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t("What they may do")}</legend>
            {CAPABILITIES.map((c) => (
              <label key={c.id} className="fi-check"><input type="checkbox" checked={form.can.includes(c.id)} onChange={(e) => setForm({ ...form, can: toggle(form.can, c.id, e.target.checked) })} />
                <span><strong>{t.text(c.title)}</strong>: {t.text(c.hint)}</span></label>
            ))}
          </fieldset>
          <label className="fi-field">{t("Why")}
            <input className="fi-input" maxLength={500} value={form.why} placeholder={t("Outreach from the sales address")} onChange={(e) => setForm({ ...form, why: e.target.value })} />
          </label>
          {problem && <p className="fi-action-result is-error" role="alert">{problem}</p>}
          <div className="fi-dialog-actions">
            <button type="submit" className="fi-primary" disabled={working || !ready}>{working ? t("Giving access…") : t("Give access")}</button>
          </div>
        </form>
      </PanelBlock>
    </>
  );
}
