import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { fabric } from "~/services/fabric";
import { ApiError } from "~/services/api";
import type { ProjectAddresses } from "~/services/agents";
import type { DomainDetail, DomainList, DomainSummary, Step, StepsResult } from "~/services/domains";
import StepList from "~/components/domains/StepList";
import { count, groupRows, stableGroup, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout,
  SelectableList, SkeletonPanel, SkeletonRows, useConfirm, useWork,
} from "../ui";
import { detailKey, refreshMail, useAddresses, useDomains, useStepMemory } from "./data";
import { stepsFailed, stepsSummary } from "./steps";

interface DomainEntry extends ListEntry { summary: DomainSummary }

const GROUPS = [{ id: "served", label: "Receiving here" }, { id: "other", label: "Other domains on Cloudflare" }];
const CONNECT_KEY = "connect";

/**
 * Settings → Domains (SCR-02, SCN-030, SCN-031, SCN-033): every domain of the shown Cloudflare
 * accounts. A domain stays in the group it was shown in while the section is open; a change of
 * state shows on its badge, and the step list of the last action lives in its panel.
 */
export default function DomainsSection({ id }: { id: string | null }) {
  const domains = useDomains();
  const addresses = useAddresses();
  const [query, setQuery] = useState("");
  const seen = useRef(new Map<string, string>());
  const list = domains.data;
  const several = (list?.accounts.filter((a) => a.shown).length ?? 0) > 1;

  const entries = useMemo(() => stableGroup(seen.current, [...(list?.domains ?? [])]
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .map((d): DomainEntry => ({
      key: d.domain, group: d.served ? "served" : "other", summary: d,
      text: [d.domain, d.account?.name ?? ""].join(" "),
    }))), [list]);
  const groups = groupRows(visibleRows(entries, query, id), GROUPS);
  const selected = id && id !== CONNECT_KEY ? entries.find((e) => e.key === id) ?? null : null;

  const listView = domains.isPending ? <SkeletonRows label="Loading your domains…" /> : domains.isError ? (
    <LoadFailure what="Your domains" error={domains.error} onRetry={() => void domains.refetch()} retrying={domains.isFetching} />
  ) : (
    <SelectableList label="Domains" groups={groups} selected={id} hrefFor={(e) => settingsPath("domains", e.key)}
      pinned={list && !list.connected ? [{ key: CONNECT_KEY, href: settingsPath("domains", CONNECT_KEY), content: (
        <span className="fi-row-main"><span className="fi-row-title">Connect Cloudflare</span><span className="fi-row-meta">Needed to list and change your domains</span></span>
      ) }] : []}
      renderRow={(e) => <DomainRowContent entry={e} several={several} connected={!!list?.connected} />}
      empty={<div className="fi-list-empty"><p>{query ? `No domain matches “${query}”.` : "No domain is listed yet."}</p></div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Choose a domain</h2>
      <p>{list && !list.connected ? "Connect Cloudflare first: then every domain of your account is listed here." : "Its state in Cloudflare, its addresses and what can change open here."}</p>
    </PanelPlaceholder>
  ) : domains.isPending ? <SkeletonPanel label="Loading this domain…" /> : id === CONNECT_KEY && list ? (
    <ConnectCloudflarePanel list={list} />
  ) : !selected || !list ? (
    <PanelPlaceholder>
      <h2>{id} is not listed</h2>
      <p>None of the shown Cloudflare accounts has this domain. It may be hidden on Accounts.</p>
      <Link className="fi-secondary" to={settingsPath("domains")} replace preventScrollReset>All domains</Link>
    </PanelPlaceholder>
  ) : (
    <DomainPanel key={selected.key} summary={selected.summary} list={list} data={addresses.data} />
  );

  return (
    <SectionLayout section="domains" hasSelection={!!id} list={listView} panel={panel}
      toolbar={<ListSearch value={query} onChange={setQuery} placeholder="example.com" label="Find a domain" />}
      footer={list?.connected ? <p>{count(list.domains.length, "domain")}, {list.domains.filter((d) => d.served).length} receiving here.</p> : undefined} />
  );
}

function DomainRowContent({ entry, several, connected }: { entry: DomainEntry; several: boolean; connected: boolean }) {
  const d = entry.summary;
  const moved = (entry.group === "served") !== d.served;
  return (
    <>
      <span className="fi-row-main">
        <span className="fi-row-title">{d.domain}</span>
        <span className="fi-row-meta">
          {[several && d.account ? d.account.name : "", d.served ? count(d.addresses, "address", "addresses") : "Not received here"].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="fi-row-side">
        {moved && (d.served ? <Badge tone="ok">Receiving here now</Badge> : <Badge tone="warn">No longer received</Badge>)}
        {connected && d.served && !d.zoneId && <Badge tone="warn" title="None of your server's tokens can see this domain">Not visible</Badge>}
      </span>
    </>
  );
}

/** Runs a domain action, keeps its steps, and asks before what the server says needs a yes. */
function useDomainAction(domain: string) {
  const client = useQueryClient();
  const memory = useStepMemory();
  const confirm = useConfirm();
  const work = useWork(domain, "steps");
  const [local, setLocal] = useState<Step[]>([]);
  const steps = memory ? memory.get(domain) : local;
  const keep = (s: Step[]) => (memory ? memory.set(domain, s) : setLocal(s));

  async function act(path: string, label: string, body: Record<string, unknown> = {}, method = "POST"): Promise<void> {
    let needs: StepsResult["needsConfirmation"] | undefined;
    await work.run(label, async () => {
      try {
        const r = await fabric<StepsResult>(path, body, method);
        keep(r.steps);
        if (stepsFailed(r.steps)) throw new Error(stepsSummary(domain, r.steps));
        return stepsSummary(domain, r.steps);
      } catch (e) {
        const payload = (e instanceof ApiError ? e.body : {}) as Partial<StepsResult>;
        if (payload.needsConfirmation) { needs = payload.needsConfirmation; return ""; }
        if (payload.steps) { keep(payload.steps); throw new Error(stepsSummary(domain, payload.steps)); }
        throw e;
      } finally { await refreshMail(client, domain); }
    });
    if (needs?.foreignMx) {
      const ok = await confirm({
        title: `Mail for ${domain} goes to another provider today`,
        body: <>
          <p>Its MX records point at {[...new Set(needs.foreignMx)].join(", ")}. Receiving here replaces them with Cloudflare's, so mail stops reaching that provider.</p>
          <p>Forwards set up there cannot be read from Cloudflare: add those addresses here afterwards.</p>
        </>,
        confirmLabel: "Replace and receive here", cancelLabel: "Keep it as it is", danger: true,
      });
      if (ok) await act(path, label, { ...body, replaceMx: true }, method);
    } else if (needs?.zoneNotVisible) {
      const ok = await confirm({
        title: `The token cannot see ${domain}`,
        body: <p>Its routing rules cannot be sent back from here. If Cloudflare still sends its mail to this server, it will be refused once {domain} is no longer received here.</p>,
        confirmLabel: "Stop receiving anyway", cancelLabel: "Keep receiving", danger: true,
      });
      if (ok) await act(path, label, { ...body, force: true }, method);
    }
  }
  return { steps, act, busy: work.busy, result: work.result };
}

function DomainPanel({ summary, list, data }: { summary: DomainSummary; list: DomainList; data?: ProjectAddresses }) {
  const domain = summary.domain;
  const confirm = useConfirm();
  const action = useDomainAction(domain);
  const connected = list.connected;

  const release = async () => {
    const ok = await confirm({
      title: `Stop receiving ${domain} here?`,
      body: <p>Each address with a copy goes back to forwarding to it; the others stop receiving. Rules that send mail to another Worker are left as they are. The mail already here stays.</p>,
      confirmLabel: "Stop receiving here", cancelLabel: "Keep receiving", danger: true,
      blocked: summary.fixed ? `${domain} is set in this server's configuration (DOMAINS), so it is always received here.` : undefined,
    });
    if (ok) await action.act(`/api/domains/${domain}/release`, "Stopping…");
  };

  return (
    <Panel title={domain} closeTo={settingsPath("domains")}
      subtitle={[summary.account?.name ?? "No connected account can see it", summary.account && !summary.account.server ? "its relay carries the mail here" : ""].filter(Boolean).join(" · ")}
      badges={summary.served ? <Badge tone="ok">Receiving here</Badge> : <Badge>Not received here</Badge>}
      menu={summary.served && connected ? <ActionMenu label={`More actions for ${domain}`} actions={[
        { label: `Stop receiving ${domain} here…`, danger: true, onSelect: () => void release() },
      ]} /> : undefined}>
      {!summary.served ? (
        <PanelBlock title="Receive mail here">
          <p>Receiving here turns on Email Routing, brings in any address that already exists (it keeps forwarding a copy where it went before), and turns on sending. You confirm first if another provider handles the domain's mail today.</p>
          <div className="fi-buttons">
            <button type="button" className="fi-primary" disabled={!!action.busy || !connected}
              onClick={() => void action.act(`/api/domains/${domain}/connect`, "Connecting…", { replaceMx: false })}>
              {action.busy ?? "Receive mail here"}
            </button>
          </div>
          <ActionResult result={action.result} />
          <StepList steps={action.steps} />
        </PanelBlock>
      ) : (
        <ServedDomain summary={summary} list={list} data={data} action={action} />
      )}
    </Panel>
  );
}

function ServedDomain({ summary, list, data, action }: {
  summary: DomainSummary; list: DomainList; data?: ProjectAddresses; action: ReturnType<typeof useDomainAction>;
}) {
  const domain = summary.domain;
  const client = useQueryClient();
  const connected = list.connected;
  const detail = useQuery({ queryKey: detailKey(domain), enabled: connected && !!summary.zoneId, staleTime: 60_000,
    queryFn: () => fabric<DomainDetail>(`/api/domains/${domain}`) });
  const d = detail.data;
  const addresses = (data?.addresses ?? []).filter((a) => a.domain === domain);
  const unknown = (data?.unknownRecipients ?? []).filter((u) => u.domain === domain);
  const effective = data?.domains.find((x) => x.domain === domain)?.catchAll ?? null;
  const catchAll = effective?.mailbox ?? d?.catchAllMailbox ?? null;
  const catchAllFixed = effective?.source === "deployment";
  const [choice, setChoice] = useState<string | null>(null);
  const choosing = choice !== null && choice !== (catchAll ?? "");
  const catchWork = useWork(domain, "catch-all");
  const elsewhere = d?.rules.filter((r) => r.enabled && !r.toThisServer && r.action.type !== "drop") ?? [];
  const busy = !!action.busy;
  const connect = () => void action.act(`/api/domains/${domain}/connect`, "Working…");

  const applyCatchAll = () => void catchWork.run("Applying…", async () => {
    try {
      const r = await fabric<StepsResult>(`/api/domains/${domain}/catch-all`, { mailbox: choice || null }, "PUT");
      setChoice(null);
      return r.steps.map((s) => s.detail).join(" ");
    } finally { await refreshMail(client, domain); }
  });

  return (
    <>
      <PanelBlock title="In Cloudflare" aside={connected && summary.zoneId ? (
        <button type="button" className="fi-text-button" disabled={detail.isFetching} onClick={() => void detail.refetch()}>{detail.isFetching ? "Reading…" : "Read again"}</button>
      ) : undefined}>
        {!connected ? (
          <p>Connect Cloudflare to see and change how this domain's mail is routed. <Link to={settingsPath("domains", CONNECT_KEY)}>How to connect</Link></p>
        ) : !summary.zoneId ? (
          <p>None of your server's Cloudflare tokens can see {domain}. It may be in an account that is not connected (<Link to={settingsPath("accounts", null, null, { connect: "cloudflare" })}>connect another account</Link>); its addresses still receive mail if routing sends it here.</p>
        ) : detail.isPending ? <SkeletonPanel label="Reading Cloudflare…" /> : detail.isError ? (
          <LoadFailure what="Cloudflare" error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        ) : d && (
          <ul className="fi-facts" aria-label={`${domain} in Cloudflare`}>
            <li>{d.routing.enabled && d.routing.status === "ready" ? <><Badge tone="ok">Receiving</Badge> Email Routing is on.</> : <>
              <Badge tone="bad">Receiving</Badge> Email Routing is {d.routing.enabled ? d.routing.status : "off"}.
              <button type="button" className="fi-text-button" disabled={busy} onClick={connect}>Fix it</button></>}</li>
            {elsewhere.length > 0 && (
              <li><Badge tone="warn">Elsewhere</Badge> {elsewhere.length} address{elsewhere.length === 1 ? " still goes" : "es still go"} elsewhere ({elsewhere.map((r) => r.address).join(", ")}).
                <button type="button" className="fi-text-button" disabled={busy} onClick={connect}>Bring them here, keeping a copy</button></li>
            )}
            <li>{d.sending.enabled ? <><Badge tone="ok">Sending</Badge> Replies from these addresses can leave.</> : <>
              <Badge tone="bad">Sending</Badge> Off: replies from these addresses cannot leave yet.
              <button type="button" className="fi-text-button" disabled={busy} onClick={() => void action.act(`/api/domains/${domain}/sending`, "Turning on sending…")}>Turn on sending</button></>}</li>
            <li><Badge>DMARC</Badge> {d.dmarc ?? "None. Turning on sending adds a monitoring-only record."}</li>
            {d.problems.map((p) => <li key={p} role="alert"><Badge tone="warn">Problem</Badge> {p}</li>)}
          </ul>
        )}
        <ActionResult result={action.result} />
        <StepList steps={action.steps} />
      </PanelBlock>

      <PanelBlock title={`Addresses on ${domain}`} aside={addresses.length > 0 ? (
        <Link className="fi-text-button" to={settingsPath("addresses", null, null, { add: "1", domain })}>Add an address on {domain}</Link>) : undefined}>
        {!addresses.length ? (
          <div className="fi-empty-inline">
            <p>No address on {domain} yet: mail to it {catchAll ? `is kept in ${catchAll}` : "is refused, and the sender is told"}.</p>
            <Link className="fi-primary" to={settingsPath("addresses", null, null, { add: "1", domain })}>Add the first address on {domain}</Link>
          </div>
        ) : (
          <ul className="fi-plain-list">
            {addresses.map((a) => (
              <li key={a.email}>
                <Link className="fi-grow" to={settingsPath("addresses", a.email)}>{a.email}</Link>
                <span className="fi-hint">{a.email === catchAll ? "catch-all · " : ""}{a.agentName ?? (a.agent === "off" ? "Off" : "")}</span>
              </li>
            ))}
          </ul>
        )}
      </PanelBlock>

      {addresses.length > 0 && (
        <PanelBlock title="Mail for an address that does not exist">
          <label className="fi-field">
            <span className="fi-hint">Chosen, then applied: it changes Cloudflare's catch-all for {domain}.</span>
            <select className="fi-input" value={choice ?? catchAll ?? ""} disabled={!!catchWork.busy || catchAllFixed || !connected}
              onChange={(e) => setChoice(e.target.value)}>
              <option value="">Refuse it — the sender is told</option>
              {addresses.map((a) => <option key={a.email} value={a.email}>Keep it in {a.email}</option>)}
            </select>
          </label>
          {catchAllFixed && <p className="fi-hint">Set in this server's configuration (UNKNOWN_ADDRESS_POLICY); change it there.</p>}
          {choosing && (
            <>
              <p>{choice
                ? `Cloudflare's catch-all will send every other address on ${domain} here, kept in ${choice}; if it forwarded somewhere before, that becomes the mailbox's copy.`
                : `Mail for addresses that do not exist on ${domain} will be refused.`}</p>
              <div className="fi-buttons">
                <button type="button" className="fi-primary" disabled={!!catchWork.busy} onClick={applyCatchAll}>{catchWork.busy ?? "Apply"}</button>
                <button type="button" className="fi-secondary" disabled={!!catchWork.busy} onClick={() => setChoice(null)}>Cancel</button>
              </div>
            </>
          )}
          <ActionResult result={catchWork.result} />
        </PanelBlock>
      )}

      {unknown.length > 0 && (
        <PanelBlock title="Recent mail for addresses that do not exist">
          <ul className="fi-plain-list">
            {unknown.map((u) => (
              <li key={u.address}>
                <span className="fi-grow">{u.address} — {u.count} message{u.count > 1 ? "s" : ""} {u.action === "rejected" ? "refused" : "kept in the catch-all"}, last {new Date(u.lastSeen).toLocaleString()}</span>
                <Link className="fi-text-button" to={settingsPath("addresses", null, null, { add: "1", domain, name: u.address.slice(0, u.address.lastIndexOf("@")) })}>Add this address</Link>
              </li>
            ))}
          </ul>
        </PanelBlock>
      )}
      {summary.fixed && <p className="fi-hint">{domain} is set in this server's configuration (DOMAINS), so it is always received here.</p>}
    </>
  );
}

/** SCN-030 without a token: what to create in Cloudflare and where it goes. */
function ConnectCloudflarePanel({ list }: { list: DomainList }) {
  return (
    <Panel title="Connect your Cloudflare account" closeTo={settingsPath("domains")}>
      <PanelBlock>
        <p>{list.problem} With it, this screen lists every domain in your account, turns mail on for the ones you choose and creates addresses on them.</p>
        <ol>
          <li>Open <a href={list.tokenUrl} target="_blank" rel="noreferrer">Cloudflare → My Profile → API Tokens</a>, choose <strong>Create Token</strong>, then <strong>Create Custom Token</strong>.</li>
          <li>Add these permissions, and under Account and Zone resources choose your account and <strong>All zones</strong> (or only the domains you want here):
            <PermissionTable permissions={list.permissions} />
          </li>
          <li>Save the token on this server. In the Mac app choose <strong>Fabric Inbox → Connect Cloudflare account…</strong> and paste it: the app saves it on your server (and updates the server if it is older). For a server you deployed yourself, run <code>npx wrangler secret put CLOUDFLARE_API_TOKEN</code> in its folder instead. Then reload this page.</li>
        </ol>
        <p className="fi-hint">The token stays on the server and is never shown again. Without it, addresses on the domains already received here still get mail; only changing Cloudflare needs it.</p>
      </PanelBlock>
    </Panel>
  );
}

export function PermissionTable({ permissions }: { permissions: DomainList["permissions"] }) {
  return (
    <table className="fi-table">
      <thead><tr><th>Type</th><th>Permission</th><th>Access</th><th>Used to</th></tr></thead>
      <tbody>
        {permissions.map((p) => (
          <tr key={p.scope + p.name}><td>{p.scope}</td><td><strong>{p.name}</strong></td><td>{p.level}</td><td>{p.for}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
