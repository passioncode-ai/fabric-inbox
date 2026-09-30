import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { useMemo, useState } from "react";
import { fabric } from "~/services/fabric";
import type { AgentList, ProjectAddresses } from "~/services/agents";
import type { DomainList } from "~/services/domains";
import ConnectCloudflare from "~/components/domains/ConnectCloudflare";
import Destinations from "~/components/domains/Destinations";
import Accounts from "~/components/domains/Accounts";
import AddressRow from "~/components/domains/AddressRow";
import { DOMAINS_KEY, OtherDomainRow, ServedDomainCard, StepMemory } from "~/components/domains/DomainCard";
import type { Step } from "~/services/domains";

export function meta() {
  return [{ title: "Domains & addresses · Fabric Inbox" }];
}

/**
 * SCR-09 Domains & addresses: the connected Cloudflare account's domains, the
 * ones received here with their addresses, and the rest one action away
 * (SCN-021, SCN-025, SCN-030..033). `?domain=` opens one domain.
 */
export default function ProjectAddressesPage() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const domains = useQuery({ queryKey: DOMAINS_KEY, queryFn: () => fabric<DomainList>("/api/domains") });
  const data = useQuery({ queryKey: ["project-addresses"], queryFn: () => fabric<ProjectAddresses>("/api/project-addresses") });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => fabric<AgentList>("/api/agents") });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [stepsByDomain, setStepsByDomain] = useState<Record<string, Step[]>>({});
  const stepMemory = useMemo(() => ({
    get: (domain: string) => stepsByDomain[domain] ?? [],
    set: (domain: string, steps: Step[]) => setStepsByDomain((m) => ({ ...m, [domain]: steps })),
  }), [stepsByDomain]);

  async function run(action: () => Promise<string>) {
    setBusy(true); setNotice("");
    try {
      setNotice(await action());
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      // A failed action may still have changed something: everything it touches is read again,
      // including each address's routing and the inbox list (audit finding 14).
      await Promise.all([
        client.invalidateQueries({ queryKey: ["project-addresses"] }), client.invalidateQueries({ queryKey: DOMAINS_KEY }),
        client.invalidateQueries({ queryKey: ["routing"] }), client.invalidateQueries({ queryKey: ["unified-inbox"] }),
      ]);
      setBusy(false);
    }
  }

  const openDomain = params.get("domain") ?? "";
  const toggle = (domain: string) => setParams((p) => { const n = new URLSearchParams(p); if (n.get("domain") === domain) n.delete("domain"); else n.set("domain", domain); return n; }, { replace: true });
  const list = domains.data;
  const served = list?.domains.filter((d) => d.served) ?? [];
  const others = (list?.domains.filter((d) => !d.served) ?? []).filter((d) => !filter || d.domain.includes(filter.toLowerCase()));
  const addresses = data.data?.addresses ?? [];
  const shownAccounts = list?.accounts?.filter((a) => a.shown) ?? [];
  const several = shownAccounts.length > 1;
  const orphaned = addresses.filter((a) => !served.some((d) => d.domain === a.domain));

  return (
    <StepMemory.Provider value={stepMemory}>
    <main className="mx-auto max-w-4xl p-6 text-kumo-default">
      <nav className="flex gap-4 text-sm">
        <Link to="/">← Fabric Inbox</Link>
        <Link to="/ai-agents" className="underline">Agents</Link>
        <Link to="/setup" className="underline">Setup</Link>
      </nav>
      <h1 className="mt-8 text-3xl font-semibold">Domains & addresses</h1>
      <p className="my-3 text-kumo-subtle">
        Your domains on Cloudflare, and the addresses on them that arrive here. Give each address an agent, or leave it Off to read it
        yourself.
      </p>
      {notice && <p role="status" className="my-4 rounded-lg border border-kumo-line p-3">{notice}</p>}

      {domains.isPending || data.isPending ? (
        <p role="status" className="my-6 text-kumo-subtle">Loading your domains…</p>
      ) : domains.isError || data.isError ? (
        <p role="alert" className="my-6">
          Domains could not load: {((domains.error ?? data.error) as Error).message}{" "}
          <button className="underline" onClick={() => { void domains.refetch(); void data.refetch(); }}>Retry</button>
        </p>
      ) : (
        <>
          {list && !list.connected && <ConnectCloudflare list={list} />}
          {list?.connected && (
            <p className="text-sm text-kumo-subtle">
              Connected to Cloudflare{shownAccounts.length > 1 ? `: ${shownAccounts.length} accounts shown` : list.account ? ` (${list.account})` : ""}, {list.domains.length} domain{list.domains.length === 1 ? "" : "s"}, {served.length} receiving here.
            </p>
          )}
          {list?.connected && <Accounts list={list} busy={busy} run={run} />}

          <section className="my-6" aria-labelledby="served-heading">
            <h2 id="served-heading" className="text-xl font-medium">Receiving here</h2>
            {!served.length && <p className="mt-2 text-sm">No domain receives mail here yet. Choose one from your Cloudflare domains below.</p>}
            {served.map((d) => (
              <ServedDomainCard key={d.domain} summary={d} connected={!!list?.connected}
                addresses={addresses.filter((a) => a.domain === d.domain)} agents={agents.data}
                unknown={data.data.unknownRecipients.filter((u) => u.domain === d.domain)}
                open={openDomain === d.domain || served.length === 1} onToggle={() => toggle(d.domain)} busy={busy} run={run} showAccount={several}
                effectiveCatchAll={data.data.domains.find((x) => x.domain === d.domain)?.catchAll ?? null} />
            ))}
          </section>

          {list?.connected && (
            <section className="my-8" aria-labelledby="others-heading">
              <h2 id="others-heading" className="text-xl font-medium">Your other domains on Cloudflare</h2>
              <p className="mt-1 text-sm text-kumo-subtle">
                Receiving here turns on Email Routing, brings in any address that already exists (it keeps forwarding a copy where it
                went before), and turns on sending. You confirm first if another provider handles the domain's mail today.
              </p>
              {list.domains.length - served.length > 8 && (
                <label className="mt-3 block text-sm font-medium">Find a domain
                  <input className="mt-1 w-72 max-w-full rounded-lg border border-kumo-line bg-transparent px-3 py-2 text-sm" value={filter}
                    onChange={(e) => setFilter(e.target.value)} placeholder="example.com" />
                </label>
              )}
              {others.length ? (
                <ul className="mt-3 divide-y divide-kumo-line rounded-xl border border-kumo-line">
                  {others.map((d) => <OtherDomainRow key={d.domain} summary={d} showAccount={several} />)}
                </ul>
              ) : <p className="mt-3 text-sm">{filter ? `No domain matches "${filter}".` : "Every domain in the shown accounts already receives here."}</p>}
            </section>
          )}

          {list?.connected && <Destinations busy={busy} run={run} accounts={shownAccounts} />}

          {orphaned.length > 0 && (
            <section className="my-8" aria-labelledby="orphaned-heading">
              <h2 id="orphaned-heading" className="text-xl font-medium">Other mailboxes</h2>
              <p className="text-sm text-kumo-subtle">Their domain no longer receives here, so new mail to them is refused. Their mail stays until you remove them.</p>
              {orphaned.map((a) => (
                <AddressRow key={a.email} address={a} agents={agents.data} busy={busy} routingConfigured={!!list?.connected} isCatchAll={false} run={run} />
              ))}
            </section>
          )}
        </>
      )}
    </main>
    </StepMemory.Provider>
  );
}
