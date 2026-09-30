import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import { ApiError } from "~/services/api";
import type { AgentList, ProjectAddresses } from "~/services/agents";
import type { DomainDetail, DomainSummary, Step, StepsResult } from "~/services/domains";
import AddressRow, { toAssignment } from "./AddressRow";
import StepList from "./StepList";
import { useDestinations } from "./Destinations";

const inputClass = "mt-1 w-full rounded-lg border border-kumo-line bg-transparent px-3 py-2 text-sm";
export const DOMAINS_KEY = ["domains"];
const detailKey = (domain: string) => ["domain", domain];

/**
 * Steps of the last action per domain, kept by the page: connecting or releasing moves a
 * domain between the two lists, which unmounts its card (audit finding 10).
 */
export const StepMemory = createContext<{ get(domain: string): Step[]; set(domain: string, steps: Step[]): void } | null>(null);

/** Runs a domain action and keeps its steps, including the steps of a refused (409/502) answer. */
function useStepAction(domain: string) {
  const client = useQueryClient();
  const memory = useContext(StepMemory);
  const [local, setLocal] = useState<Step[]>([]);
  const steps = memory ? memory.get(domain) : local;
  const setSteps = (s: Step[]) => (memory ? memory.set(domain, s) : setLocal(s));
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(path: string, body: unknown = {}, method = "POST") {
    setBusy(true); setError(""); setConfirm(null); setConfirmRelease(false);
    try {
      const r = await fabric<StepsResult>(path, body, method);
      setSteps(r.steps);
    } catch (e) {
      const payload = e instanceof ApiError ? (e.body as Partial<StepsResult>) : {};
      if (payload.needsConfirmation?.foreignMx) setConfirm(payload.needsConfirmation.foreignMx);
      if (payload.needsConfirmation?.zoneNotVisible) setConfirmRelease(true);
      if (payload.steps) setSteps(payload.steps); else if (!payload.needsConfirmation) setError((e as Error).message);
    } finally {
      setBusy(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: DOMAINS_KEY }), client.invalidateQueries({ queryKey: detailKey(domain) }),
        client.invalidateQueries({ queryKey: ["project-addresses"] }), client.invalidateQueries({ queryKey: ["unified-inbox"] }),
      ]);
    }
  }
  return { steps, confirm, confirmRelease, busy, error, act, dismiss: () => { setConfirm(null); setConfirmRelease(false); } };
}

function MxConfirmation({ domain, hosts, busy, onConfirm, onCancel }: { domain: string; hosts: string[]; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-labelledby={"mx-" + domain} className="mt-3 rounded-lg border border-kumo-line p-3 text-sm">
      <p id={"mx-" + domain} className="font-medium">Mail for {domain} goes to another provider today</p>
      <p className="mt-1">
        Its MX records point at {[...new Set(hosts)].join(", ")}. Receiving here replaces them with Cloudflare's, so mail stops reaching
        that provider. Forwards set up there cannot be read from Cloudflare: add those addresses here afterwards.
      </p>
      <div className="mt-2 flex gap-3">
        <button className="fi-primary" disabled={busy} onClick={onConfirm}>{busy ? "Working…" : "Replace and receive here"}</button>
        <button className="fi-secondary" disabled={busy} onClick={onCancel}>Keep it as it is</button>
      </div>
    </div>
  );
}

/** A zone in the account that does not receive here yet (SCN-031 entry). */
export function OtherDomainRow({ summary, showAccount = false }: { summary: DomainSummary; showAccount?: boolean }) {
  const { steps, confirm, busy, error, act, dismiss } = useStepAction(summary.domain);
  const connect = (replaceMx: boolean) => act(`/api/domains/${summary.domain}/connect`, { replaceMx });
  return (
    <li className="p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span><span className="font-medium">{summary.domain}</span>
          {showAccount && summary.account && <span className="text-kumo-subtle"> · {summary.account.name}{summary.account.server ? "" : " (its relay carries the mail here)"}</span>}</span>
        <button className="fi-secondary" disabled={busy} onClick={() => void connect(false)}>{busy ? "Working…" : "Receive mail here"}</button>
      </div>
      {confirm && <MxConfirmation domain={summary.domain} hosts={confirm} busy={busy} onConfirm={() => void connect(true)} onCancel={dismiss} />}
      {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
      <StepList steps={steps} />
    </li>
  );
}

/** A domain that receives here: its state in Cloudflare, its addresses, and what can change (SCN-031..033). */
export function ServedDomainCard({ summary, connected, addresses, agents, unknown, open, onToggle, busy, run, effectiveCatchAll, showAccount = false }: {
  summary: DomainSummary; connected: boolean;
  /** Name the domain's Cloudflare account (when more than one is shown). */
  showAccount?: boolean; addresses: ProjectAddresses["addresses"]; agents?: AgentList;
  unknown: ProjectAddresses["unknownRecipients"]; open: boolean; onToggle: () => void;
  busy: boolean; run: (action: () => Promise<string>) => Promise<void>;
  /** From the addresses list, so it is right even when Cloudflare cannot be read. */
  effectiveCatchAll?: { mailbox: string; source: "deployment" | "stored" } | null;
}) {
  const domain = summary.domain;
  const detail = useQuery({ queryKey: detailKey(domain), enabled: open && connected && !!summary.zoneId, staleTime: 60_000,
    queryFn: () => fabric<DomainDetail>(`/api/domains/${domain}`) });
  // A copy is forwarded by the domain's own Cloudflare account, so its destinations are that account's.
  const destinations = useDestinations(open && connected, summary.account && !summary.account.server ? summary.account.id : undefined);
  const action = useStepAction(domain);
  const [form, setForm] = useState({ localPart: "", forwardTo: "", agent: "off" });
  const [confirmRelease, setConfirmRelease] = useState(false);
  const d = detail.data;
  const catchAll = effectiveCatchAll?.mailbox ?? d?.catchAllMailbox ?? null;
  const catchAllFixed = effectiveCatchAll?.source === "deployment";
  const [catchAllChoice, setCatchAllChoice] = useState<string | null>(null);
  const choosing = catchAllChoice !== null && catchAllChoice !== (catchAll ?? "");
  const elsewhere = d?.rules.filter((r) => r.enabled && !r.toThisServer && r.action.type !== "drop") ?? [];
  const confirmed = destinations.data?.filter((x) => x.verified) ?? [];
  const busyAny = busy || action.busy;

  return (
    <section className="mt-3 rounded-xl border border-kumo-line" aria-labelledby={"domain-" + domain}>
      <button className="flex w-full items-center gap-2 p-4 text-left" aria-expanded={open} onClick={onToggle}>
        {open ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
        <h3 id={"domain-" + domain} className="text-lg font-medium">{domain}</h3>
        {showAccount && summary.account && <span className="text-sm text-kumo-subtle">{summary.account.name}</span>}
        <span className="ml-auto text-sm text-kumo-subtle">{addresses.length} address{addresses.length === 1 ? "" : "es"}</span>
      </button>
      {open && (
        <div className="border-t border-kumo-line p-4">
          {!connected ? (
            <p className="text-sm text-kumo-subtle">Connect Cloudflare above to see and change how this domain's mail is routed.</p>
          ) : !summary.zoneId ? (
            <p className="text-sm">None of your server's Cloudflare tokens can see {domain}. It may be in an account that is not connected (Connect another account above); its addresses still receive mail if routing sends it here.</p>
          ) : detail.isPending ? <p role="status" className="text-sm">Reading Cloudflare…</p> : detail.isError ? (
            <p role="alert" className="text-sm">Cloudflare could not be read: {(detail.error as Error).message} <button className="underline" onClick={() => void detail.refetch()}>Retry</button></p>
          ) : d && (
            <ul className="grid gap-1 text-sm" aria-label={`${domain} in Cloudflare`}>
              <li>{d.routing.enabled && d.routing.status === "ready" ? "Receiving: Email Routing is on." : <strong>Receiving: Email Routing is {d.routing.enabled ? d.routing.status : "off"}. </strong>}
                {!(d.routing.enabled && d.routing.status === "ready") && <button className="underline" disabled={busyAny} onClick={() => void action.act(`/api/domains/${domain}/connect`)}>Fix it</button>}</li>
              {elsewhere.length > 0 && (
                <li><strong>{elsewhere.length} address{elsewhere.length === 1 ? " still goes" : "es still go"} elsewhere</strong> ({elsewhere.map((r) => r.address).join(", ")}).{" "}
                  <button className="underline" disabled={busyAny} onClick={() => void action.act(`/api/domains/${domain}/connect`)}>Bring them here, keeping a copy</button></li>
              )}
              <li>{d.sending.enabled ? "Sending: on." : <><strong>Sending: off.</strong> Replies from these addresses cannot leave yet. <button className="underline" disabled={busyAny} onClick={() => void action.act(`/api/domains/${domain}/sending`)}>Turn on sending</button></>}</li>
              <li>{d.dmarc ? `DMARC: ${d.dmarc}` : "DMARC: none. Turning on sending adds a monitoring-only record."}</li>
              {d.problems.map((p) => <li key={p} role="alert">{p}</li>)}
            </ul>
          )}
          {action.confirm && <MxConfirmation domain={domain} hosts={action.confirm} busy={action.busy} onConfirm={() => void action.act(`/api/domains/${domain}/connect`, { replaceMx: true })} onCancel={action.dismiss} />}
          {action.error && <p role="alert" className="mt-2 text-sm">{action.error}</p>}
          <StepList steps={action.steps} />

          <h4 className="mt-5 font-medium">Addresses</h4>
          {!addresses.length && <p className="mt-1 text-sm">No address on {domain} yet. Add the first one below.</p>}
          {addresses.map((a) => (
            <AddressRow key={a.email} address={a} agents={agents} busy={busyAny} routingConfigured={connected} isCatchAll={a.email === catchAll}
              destinations={connected ? confirmed.map((x) => x.email) : null} run={run} />
          ))}

          <form className="mt-4 rounded-xl border border-dashed border-kumo-line p-4" aria-label={`Add an address on ${domain}`}
            onSubmit={(e) => { e.preventDefault(); void run(async () => {
              const r = await fabric<{ email: string; routing: { detail: string } | null; warning?: string }>("/api/project-addresses", {
                // A zone the token cannot see gets no rule: the address still receives through the catch-all.
                localPart: form.localPart, domain, agent: toAssignment(form.agent), createRoute: connected && !!summary.zoneId,
                ...(form.forwardTo ? { forwardTo: form.forwardTo } : {}),
              });
              setForm({ ...form, localPart: "" });
              return [`${r.email} is ready.`, r.routing?.detail ?? "Send it here from Cloudflare Email Routing, then send a test message.", r.warning].filter(Boolean).join(" ");
            }); }}>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="block text-sm font-medium">New address
                <span className="mt-1 flex items-center gap-1">
                  <input className={inputClass + " mt-0"} required placeholder="support" value={form.localPart}
                    pattern="[A-Za-z0-9](?:[A-Za-z0-9._+\-]{0,62}[A-Za-z0-9])?" aria-describedby={"at-" + domain}
                    onChange={(e) => setForm({ ...form, localPart: e.target.value })} />
                  <span id={"at-" + domain} className="text-sm">@{domain}</span>
                </span>
              </label>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium">Who answers
                <select className={inputClass} value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
                  <option value="off">Off — I read it myself</option>
                  {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name} (v{a.version})</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium">Also forward a copy to
                <select className={inputClass} value={form.forwardTo} onChange={(e) => setForm({ ...form, forwardTo: e.target.value })} disabled={!connected}>
                  <option value="">No copy</option>
                  {confirmed.map((x) => <option key={x.id} value={x.email}>{x.email}</option>)}
                </select>
              </label>
            </div>
            <button type="submit" className="fi-primary mt-4" disabled={busyAny || !form.localPart}>Add {form.localPart ? `${form.localPart.toLowerCase()}@${domain}` : "address"}</button>
          </form>

          {addresses.length > 0 && (
            <div className="mt-4">
              <label className="block text-sm font-medium">Mail for an address that does not exist
                {/* Chosen, then applied: it changes Cloudflare's catch-all, so a stray arrow key must not (audit finding 16). */}
                <select className={inputClass} value={catchAllChoice ?? catchAll ?? ""} disabled={busyAny || catchAllFixed}
                  onChange={(e) => setCatchAllChoice(e.target.value)}>
                  <option value="">Refuse it — the sender is told</option>
                  {addresses.map((a) => <option key={a.email} value={a.email}>Keep it in {a.email}</option>)}
                </select>
              </label>
              {catchAllFixed && <p className="mt-1 text-xs text-kumo-subtle">Set in this server's configuration (UNKNOWN_ADDRESS_POLICY); change it there.</p>}
              {choosing && (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                  <span>{catchAllChoice
                    ? `Cloudflare's catch-all will send every other address on ${domain} here, kept in ${catchAllChoice}; if it forwarded somewhere before, that becomes the mailbox's copy.`
                    : `Mail for addresses that do not exist on ${domain} will be refused.`}</span>
                  <button type="button" className="fi-primary" disabled={busyAny} onClick={() => void run(async () => {
                    const r = await fabric<StepsResult>(`/api/domains/${domain}/catch-all`, { mailbox: catchAllChoice || null }, "PUT");
                    setCatchAllChoice(null);
                    await detail.refetch();
                    return r.steps.map((s) => s.detail).join(" ");
                  })}>Apply</button>
                  <button type="button" className="fi-secondary" onClick={() => setCatchAllChoice(null)}>Cancel</button>
                </div>
              )}
            </div>
          )}

          {unknown.length > 0 && (
            <div className="mt-4 rounded-xl border border-kumo-line p-4">
              <h4 className="font-medium">Mail for addresses that do not exist</h4>
              <ul className="mt-2 text-sm">
                {unknown.map((u) => (
                  <li key={u.address} className="flex flex-wrap items-center justify-between gap-2 py-1">
                    <span>{u.address} — {u.count} message{u.count > 1 ? "s" : ""} {u.action === "rejected" ? "refused" : "kept in the catch-all"}, last {new Date(u.lastSeen).toLocaleString()}</span>
                    <button className="fi-secondary" disabled={busyAny} onClick={() => setForm({ ...form, localPart: u.address.slice(0, u.address.lastIndexOf("@")) })}>Use this name</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {connected && !summary.fixed && (
            <div className="mt-6 text-sm">
              {!confirmRelease ? (
                <button className="underline" disabled={busyAny} onClick={() => setConfirmRelease(true)}>Stop receiving {domain} here…</button>
              ) : (
                <div role="group" aria-label={`Stop receiving ${domain} here`} className="rounded-lg border border-kumo-line p-3">
                  <p className="font-medium">Send {domain}'s mail back where it went before?</p>
                  <p className="mt-1 text-kumo-subtle">Each address with a copy goes back to forwarding to it; the others stop receiving. Rules that send mail to another Worker are left as they are. The mail already here stays.</p>
                  <div className="mt-2 flex gap-3">
                    <button className="fi-primary" disabled={busyAny} onClick={() => { setConfirmRelease(false); void action.act(`/api/domains/${domain}/release`); }}>Stop receiving here</button>
                    <button className="fi-secondary" onClick={() => setConfirmRelease(false)}>Keep receiving</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {action.confirmRelease && (
            <div role="alertdialog" aria-labelledby={"release-" + domain} className="mt-3 rounded-lg border border-kumo-line p-3 text-sm">
              <p id={"release-" + domain} className="font-medium">The token cannot see {domain}</p>
              <p className="mt-1">Its routing rules cannot be sent back from here. If Cloudflare still sends its mail to this server, it will be refused once {domain} is no longer received here.</p>
              <div className="mt-2 flex gap-3">
                <button className="fi-primary" disabled={busyAny} onClick={() => void action.act(`/api/domains/${domain}/release`, { force: true })}>Stop receiving anyway</button>
                <button className="fi-secondary" onClick={action.dismiss}>Keep receiving</button>
              </div>
            </div>
          )}
          {summary.fixed && <p className="mt-6 text-sm text-kumo-subtle">{domain} is set in this server's configuration (DOMAINS), so it is always received here.</p>}
        </div>
      )}
    </section>
  );
}
