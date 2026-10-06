import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import type { AgentList, ProjectAddress, ProjectAddresses, RoutingStatus } from "~/services/agents";
import type { DomainList } from "~/services/domains";
import { groupRows, stableGroup, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, Dialog, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, PanelTabs,
  SectionLayout, SelectableList, SkeletonPanel, SkeletonRows, errorText, useConfirm, useNotify, useWork,
} from "../ui";
import {
  ADDRESSES_KEY, ROUTING_TEXT, answererText, refreshMail, routingKey, useAddresses, useAgents, useDestinations, useDomains,
  useInboxAccounts, useRouting,
} from "./data";
import ConfiguredAddresses from "./ConfiguredAddresses";
import SignatureForm from "./SignatureForm";

interface AddressEntry extends ListEntry {
  address: ProjectAddress;
  /** Its domain no longer receives here. */
  orphan: boolean;
}

const assignmentValue = (a: ProjectAddress["agent"]) => (a === "off" ? "off" : a === "legacy" ? "legacy" : a.id);
const toAssignment = (value: string) => (value === "off" ? "off" as const : { id: value });
const localPart = (email: string) => email.slice(0, email.lastIndexOf("@"));

export const ADDRESS_TABS = [
  { id: "routing", label: "Routing & test" },
  { id: "copy", label: "Copy" },
  { id: "signature", label: "Name & signature" },
  { id: "rules", label: "Rules & history" },
] as const;
type AddressTab = (typeof ADDRESS_TABS)[number]["id"];
const isTab = (tab: string | null): tab is AddressTab => ADDRESS_TABS.some((t) => t.id === tab);

/**
 * Settings → Addresses (SCR-02, SCN-021, SCN-032, SCN-033): every address that receives here,
 * grouped by domain, with who answers it, its routing and its unread mail. Choosing one opens it
 * beside the list; nothing above the list moves.
 */
export default function AddressesSection({ id, tab }: { id: string | null; tab: string | null }) {
  const domains = useDomains();
  const addresses = useAddresses();
  const agents = useAgents();
  const inbox = useInboxAccounts();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const seen = useRef(new Map<string, string>());

  const served = new Set((domains.data?.domains ?? []).filter((d) => d.served).map((d) => d.domain));
  const all = addresses.data?.addresses ?? [];
  const unread = new Map((inbox.data ?? []).map((a) => [a.email.toLowerCase(), a.unread ?? 0]));

  const entries = useMemo(() => stableGroup(seen.current, [...all]
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.email.localeCompare(b.email))
    .map((a): AddressEntry => ({
      key: a.email, group: a.domain, address: a, orphan: !!domains.data && !served.has(a.domain),
      text: [a.email, a.agentName ?? "", a.forwardTo ?? ""].join(" "),
    }))), // eslint-disable-next-line react-hooks/exhaustive-deps
  [addresses.data, domains.data]);
  const groupIds = [...new Set(entries.map((e) => e.group))].sort();
  const groups = groupRows(visibleRows(entries, query, id), groupIds.map((d) => ({
    id: d, label: served.has(d) || !domains.data ? d : `${d} · not received here`,
  })));

  const adding = params.get("add") === "1";
  const closeAdd = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("add"); n.delete("domain"); n.delete("name"); return n; }, { replace: true, preventScrollReset: true });
  const openAdd = () => setParams((p) => { const n = new URLSearchParams(p); n.set("add", "1"); return n; }, { replace: true, preventScrollReset: true });

  const loading = domains.isPending || addresses.isPending;
  const failed = domains.isError ? domains : addresses.isError ? addresses : null;
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;

  const list = loading ? <SkeletonRows label="Loading your addresses…" /> : failed ? (
    <LoadFailure what="Your addresses" error={failed.error} retrying={failed.isFetching}
      onRetry={() => { void domains.refetch(); void addresses.refetch(); }} />
  ) : (
    <SelectableList label="Addresses by domain" groups={groups} selected={id}
      hrefFor={(e) => settingsPath("addresses", e.key, tab && isTab(tab) ? tab : null)}
      renderRow={(e) => <AddressRowContent entry={e} agents={agents.data} unread={unread.get(e.key.toLowerCase()) ?? 0} />}
      empty={<EmptyAddresses list={domains.data} query={query} onAdd={openAdd} />} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Choose an address</h2>
      <p>Its routing, its copy, its name and signature, and who answers it open here.</p>
      {served.size > 0 && <button type="button" className="fi-primary" onClick={openAdd}><PlusIcon size={16} /> Add address</button>}
    </PanelPlaceholder>
  ) : loading ? <SkeletonPanel label="Loading this address…" /> : !selected ? (
    <PanelPlaceholder>
      <h2>{id} is not here</h2>
      <p>It may have been removed, or its address was mistyped.</p>
      <Link className="fi-secondary" to={settingsPath("addresses")} replace preventScrollReset>All addresses</Link>
    </PanelPlaceholder>
  ) : (
    <AddressPanel key={selected.key} entry={selected} tab={isTab(tab) ? tab : "routing"} agents={agents.data}
      list={domains.data} data={addresses.data!} unread={unread.get(selected.key.toLowerCase()) ?? 0}
      onRemoved={() => navigate(settingsPath("addresses"), { replace: true, preventScrollReset: true })} />
  );

  return (
    <>
      <SectionLayout section="addresses" hasSelection={!!id}
        toolbar={<>
          <ListSearch value={query} onChange={setQuery} placeholder="Find an address or agent" label="Find an address" />
          <button type="button" className="fi-primary" onClick={openAdd} disabled={loading || !served.size}
            title={!served.size ? "Receive a domain's mail here first (Domains)" : undefined}>
            <PlusIcon size={16} /> Add address
          </button>
        </>}
        list={list} panel={panel}
        footer={<ConfiguredAddresses />} />
      <AddAddressDialog open={adding} onClose={closeAdd} list={domains.data} agents={agents.data} data={addresses.data}
        initialDomain={params.get("domain")} initialName={params.get("name")}
        onAdded={(email) => navigate(settingsPath("addresses", email), { replace: true, preventScrollReset: true })} />
    </>
  );
}

function AddressRowContent({ entry, agents, unread }: { entry: AddressEntry; agents?: AgentList; unread: number }) {
  const a = entry.address;
  // Routing is shown once it has been read (opening the address reads it); never guessed.
  const routing = useRouting(a.email, false);
  return (
    <>
      <span className="fi-row-main">
        <span className="fi-row-title">{localPart(a.email)}<span className="fi-hint">@{a.domain}</span></span>
        <span className="fi-row-meta">{answererText(a.agent, a.agentName, agents)}{a.forwardTo ? ` · copy to ${a.forwardTo}` : ""}</span>
      </span>
      <span className="fi-row-side">
        {a.deliveryIssue ? <Badge tone="bad" title={a.deliveryIssue.problem}>Copy failing</Badge>
          : entry.orphan ? <Badge tone="warn">Not received</Badge>
          : routing.data ? <RoutingBadge state={routing.data.state} /> : null}
        {unread > 0 && <span className="fi-unread-count" aria-label={`${unread} unread`}>{unread}</span>}
      </span>
    </>
  );
}

function RoutingBadge({ state }: { state: RoutingStatus["state"] }) {
  return <Badge tone={state === "verified" ? "ok" : state === "missing" ? "bad" : "warn"}>{ROUTING_TEXT[state]}</Badge>;
}

function EmptyAddresses({ list, query, onAdd }: { list?: DomainList; query: string; onAdd: () => void }) {
  if (query) return <div className="fi-list-empty"><p>No address matches “{query}”.</p></div>;
  const served = list?.domains.filter((d) => d.served) ?? [];
  if (!served.length) {
    return (
      <div className="fi-list-empty">
        <p>No address yet. An address lives on a domain that receives its mail here: choose one of your domains first.</p>
        <Link className="fi-secondary" to={settingsPath("domains")}>Go to Domains</Link>
      </div>
    );
  }
  return (
    <div className="fi-list-empty">
      <p>No address on {served.map((d) => d.domain).join(", ")} yet.</p>
      <button type="button" className="fi-primary" onClick={onAdd}>Add the first address</button>
    </div>
  );
}

/* ---------------------------------------------------------------- the panel */

function AddressPanel({ entry, tab, agents, list, data, unread, onRemoved }: {
  entry: AddressEntry; tab: AddressTab; agents?: AgentList; list?: DomainList; data: ProjectAddresses; unread: number; onRemoved: () => void;
}) {
  const a = entry.address;
  const client = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const work = useWork(a.email, "answers");
  const removeWork = useWork(a.email, "remove");
  const path = "/api/project-addresses/" + encodeURIComponent(a.email);
  const catchAll = data.domains.find((d) => d.domain === a.domain)?.catchAll?.mailbox === a.email;
  const routing = useRouting(a.email, true);
  const current = assignmentValue(a.agent);

  const setAnswerer = (value: string) => void work.run("Saving…", async () => {
    try {
      await fabric(path + "/agent", { agent: toAssignment(value) }, "PUT");
    } finally { await refreshMail(client); }
    return value === "off" ? `${a.email} is Off. New mail stays for you.`
      : `${a.email} is answered by ${agents?.agents.find((x) => x.id === value)?.name ?? value}.`;
  });

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${a.email} and delete its mail?`,
      body: <p>Its routing rule in Cloudflare is removed too. This cannot be undone.</p>,
      confirmLabel: "Remove and delete mail", danger: true,
      blocked: catchAll ? `${a.email} keeps the mail for every other address on ${a.domain}. Choose another catch-all on Domains first.` : undefined,
    });
    if (!ok) return;
    const done = await removeWork.run("Removing…", async () => {
      try {
        const r = await fabric<{ routing: string; afterwards: string }>(path, undefined, "DELETE");
        return `${a.email} was removed. ${r.routing} ${r.afterwards}`;
      } finally { await refreshMail(client); }
    });
    if (done) onRemoved();
  };

  return (
    <Panel title={a.email} closeTo={settingsPath("addresses")}
      subtitle={<>On {a.domain}{entry.orphan ? " — this domain no longer receives here, so new mail is refused" : ""}</>}
      badges={<>
        {routing.data && <RoutingBadge state={routing.data.state} />}
        {catchAll && <Badge>Catch-all for {a.domain}</Badge>}
        {unread > 0 && <Badge>{unread} unread</Badge>}
      </>}
      menu={<ActionMenu label={`More actions for ${a.email}`} actions={[
        { label: "Open its mail", onSelect: () => navigate("/?account=" + encodeURIComponent("cloudflare:" + a.email)) },
        { label: `Remove ${a.email}…`, danger: true, onSelect: () => void remove() },
      ]} />}>
      <PanelBlock title="Who answers">
        <label className="fi-field">
          <span className="fi-hint">An agent answers new mail within its reply policy; Off keeps the mail for you.</span>
          <select className="fi-input" value={current} disabled={!!work.busy} onChange={(e) => setAnswerer(e.target.value)}>
            {current === "legacy" && <option value="legacy" disabled>Drafts with its old prompt (set on next message)</option>}
            <option value="off">Off — I read it myself</option>
            {agents?.agents.map((x) => <option key={x.id} value={x.id}>{x.name} (v{x.version})</option>)}
            {/* Agents that could not be listed still show the one answering, never a false "Off". */}
            {typeof a.agent === "object" && !agents && <option value={a.agent.id}>{a.agentName ?? a.agent.id}</option>}
            {typeof a.agent === "object" && agents && !a.agentName && <option value={a.agent.id} disabled>Deleted agent — Off</option>}
          </select>
        </label>
        <ActionResult result={work.result} />
      </PanelBlock>
      <PanelTabs label={`Settings of ${a.email}`} tabs={[...ADDRESS_TABS]} current={tab}
        hrefFor={(t) => settingsPath("addresses", a.email, t === "routing" ? null : t)} />
      {tab === "routing" && <RoutingTab address={a} catchAll={catchAll} connected={!!list?.connected} />}
      {tab === "copy" && <CopyTab address={a} list={list} />}
      {tab === "signature" && <SignatureForm email={a.email} />}
      {tab === "rules" && (
        <PanelBlock>
          <p>Rules act on new mail to {a.email}: they can archive, label, forward or call a tool, after approval or by themselves. Every run is kept with what it did.</p>
          <Link className="fi-secondary" to={"/automation/" + encodeURIComponent(a.email)}>Open rules and history</Link>
        </PanelBlock>
      )}
      <ActionResult result={removeWork.result} />
    </Panel>
  );
}

function RoutingTab({ address: a, catchAll, connected }: { address: ProjectAddress; catchAll: boolean; connected: boolean }) {
  const client = useQueryClient();
  const routing = useRouting(a.email, true);
  const work = useWork(a.email, "routing");
  const path = "/api/project-addresses/" + encodeURIComponent(a.email);
  const sendHere = () => void work.run("Changing routing…", async () => {
    const status = await fabric<RoutingStatus>(path + "/routing", {});
    await client.invalidateQueries({ queryKey: routingKey(a.email) });
    return status.detail;
  });
  const test = () => void work.run("Sending a test…", async () => {
    const result = await fabric<{ subject: string; status: string }>(path + "/test", {});
    return result.status === "accepted"
      ? `Test message accepted by the provider: “${result.subject}”. It should appear in ${a.email} within a minute if routing works.`
      : `Test message ${result.status}: “${result.subject}”. Check the address's outbox.`;
  });
  return (
    <>
      <PanelBlock title="Does mail arrive here?" aside={
        <button type="button" className="fi-text-button" disabled={routing.isFetching}
          onClick={() => void client.invalidateQueries({ queryKey: routingKey(a.email) })}>{routing.isFetching ? "Checking…" : "Check again"}</button>}>
        {routing.isPending ? <p role="status" className="fi-hint">Reading Cloudflare Email Routing…</p> : routing.isError ? (
          <p role="alert">Routing unknown: {errorText(routing.error)}</p>
        ) : (
          <p><RoutingBadge state={routing.data.state} /> {routing.data.detail}</p>
        )}
        {catchAll && <p className="fi-hint">It also keeps the mail for every other address on {a.domain}.</p>}
        {a.deliveryIssue && (
          <div className="fi-callout is-bad" role="alert">
            <p>The copy to {a.deliveryIssue.target} failed {a.deliveryIssue.count} time{a.deliveryIssue.count > 1 ? "s" : ""}, last {new Date(a.deliveryIssue.lastAt).toLocaleString()}: {a.deliveryIssue.problem}. The mail itself is kept here.</p>
          </div>
        )}
        <div className="fi-buttons">
          {connected && routing.data?.state === "missing" && !routing.data.detail.includes("somewhere else") && (
            <button type="button" className="fi-primary" disabled={!!work.busy} onClick={sendHere}>Send it here</button>
          )}
          <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={test}>Send test message</button>
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
    </>
  );
}

function CopyTab({ address: a, list }: { address: ProjectAddress; list?: DomainList }) {
  const client = useQueryClient();
  const work = useWork(a.email, "copy");
  const summary = list?.domains.find((d) => d.domain === a.domain);
  const connected = !!list?.connected;
  // A copy is forwarded by the domain's own Cloudflare account, so its destinations are that account's.
  const destinations = useDestinations(connected, summary?.account && !summary.account.server ? summary.account.id : undefined);
  const confirmed = destinations.data?.filter((d) => d.verified).map((d) => d.email) ?? [];
  const options = [...new Set([...confirmed, ...(a.forwardTo ? [a.forwardTo] : [])])];
  const [copy, setCopy] = useState(a.forwardTo ?? "");
  useEffect(() => setCopy(a.forwardTo ?? ""), [a.forwardTo]);
  const save = () => void work.run("Saving…", async () => {
    try {
      const r = await fabric<{ warning?: string }>(`/api/project-addresses/${encodeURIComponent(a.email)}/copy`, { forwardTo: copy || null }, "PUT");
      return [copy ? `A copy of ${a.email}'s mail now goes to ${copy}.` : `${a.email} no longer forwards a copy.`, r.warning].filter(Boolean).join(" ");
    } finally { await client.invalidateQueries({ queryKey: ADDRESSES_KEY }); }
  });
  return (
    <PanelBlock title="Forward a copy">
      <p>{a.forwardTo ? `A copy of each message is forwarded to ${a.forwardTo}.` : "No copy is forwarded."} The mail itself always stays here.</p>
      {!connected ? (
        <p className="fi-hint">Changing the copy needs Cloudflare: connect it on <Link to={settingsPath("domains")}>Domains</Link>.</p>
      ) : destinations.isPending ? <p role="status" className="fi-hint">Loading forwarding destinations…</p> : destinations.isError ? (
        <LoadFailure what="Forwarding destinations" error={destinations.error} onRetry={() => void destinations.refetch()} retrying={destinations.isFetching} />
      ) : (
        <>
          <label className="fi-field">Forward a copy to
            <select className="fi-input" value={copy} onChange={(e) => setCopy(e.target.value)} disabled={!!work.busy}>
              <option value="">No copy</option>
              {options.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          {!confirmed.length && (
            <p className="fi-hint">Cloudflare only forwards to a confirmed destination. <Link to={settingsPath("destinations", null, null, { add: "1" })}>Add a forwarding destination</Link> first.</p>
          )}
          <div className="fi-buttons">
            <button type="button" className="fi-primary" disabled={!!work.busy || copy === (a.forwardTo ?? "")} onClick={save}>{work.busy ? "Saving…" : "Save"}</button>
          </div>
        </>
      )}
      <ActionResult result={work.result} />
    </PanelBlock>
  );
}

/* ----------------------------------------------------------- add an address */

const NAME_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9._+\\-]{0,62}[A-Za-z0-9])?";

function AddAddressDialog({ open, onClose, list, agents, data, initialDomain, initialName, onAdded }: {
  open: boolean; onClose: () => void; list?: DomainList; agents?: AgentList; data?: ProjectAddresses;
  initialDomain: string | null; initialName: string | null; onAdded: (email: string) => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const served = list?.domains.filter((d) => d.served) ?? [];
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("off");
  const [copy, setCopy] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (!open) return;
    setDomain(served.some((d) => d.domain === initialDomain) ? initialDomain! : served[0]?.domain ?? "");
    setName(initialName ?? ""); setAgent("off"); setCopy(""); setProblem("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const summary = served.find((d) => d.domain === domain);
  const connected = !!list?.connected;
  const destinations = useDestinations(open && connected && !!summary, summary?.account && !summary.account.server ? summary.account.id : undefined);
  const confirmed = destinations.data?.filter((d) => d.verified) ?? [];
  const unknown = (data?.unknownRecipients ?? []).filter((u) => u.domain === domain).slice(0, 5);
  const email = name ? `${name.toLowerCase()}@${domain}` : "";

  async function submit() {
    setWorking(true); setProblem("");
    try {
      const r = await fabric<{ email: string; routing: { detail: string } | null; warning?: string }>("/api/project-addresses", {
        // A zone the token cannot see gets no rule: the address still receives through the catch-all.
        localPart: name, domain, agent: toAssignment(agent), createRoute: connected && !!summary?.zoneId,
        ...(copy ? { forwardTo: copy } : {}),
      });
      notify([`${r.email} is ready.`, r.routing?.detail ?? "Send it here from Cloudflare Email Routing, then send a test message.", r.warning].filter(Boolean).join(" "));
      await refreshMail(client);
      onClose();
      onAdded(r.email);
    } catch (error) {
      setProblem(errorText(error));
    } finally { setWorking(false); }
  }

  return (
    <Dialog open={open} title="Add an address" onClose={onClose} busy={working}>
      {!served.length ? (
        <p>No domain receives mail here yet. <Link to={settingsPath("domains")}>Choose one on Domains</Link> first.</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="fi-field-row">
            <label className="fi-field">Name
              <input className="fi-input" data-autofocus required value={name} pattern={NAME_PATTERN} placeholder="support"
                onChange={(e) => setName(e.target.value)} aria-describedby="add-address-at" />
            </label>
            <label className="fi-field">Domain
              <select className="fi-input" value={domain} onChange={(e) => { setDomain(e.target.value); setCopy(""); }} id="add-address-at">
                {served.map((d) => <option key={d.domain} value={d.domain}>@{d.domain}</option>)}
              </select>
            </label>
          </div>
          {unknown.length > 0 && (
            <p className="fi-hint">Mail arrived recently for addresses on {domain} that do not exist:{" "}
              {unknown.map((u, i) => (
                <span key={u.address}>{i > 0 && ", "}<button type="button" className="fi-text-button" onClick={() => setName(localPart(u.address))}>{localPart(u.address)}</button> ({u.count})</span>
              ))}.
            </p>
          )}
          <label className="fi-field">Who answers
            <select className="fi-input" value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="off">Off — I read it myself</option>
              {agents?.agents.map((x) => <option key={x.id} value={x.id}>{x.name} (v{x.version})</option>)}
            </select>
          </label>
          <label className="fi-field">Also forward a copy to
            <select className="fi-input" value={copy} onChange={(e) => setCopy(e.target.value)} disabled={!connected || !confirmed.length}>
              <option value="">No copy</option>
              {confirmed.map((x) => <option key={x.id} value={x.email}>{x.email}</option>)}
            </select>
            {connected && destinations.isSuccess && !confirmed.length && <span className="fi-hint">No confirmed forwarding destination in this domain's Cloudflare account yet.</span>}
          </label>
          {problem && <p className="fi-action-result is-error" role="alert">{problem}</p>}
          <div className="fi-dialog-actions">
            <button type="button" className="fi-secondary" onClick={onClose} disabled={working}>Cancel</button>
            <button type="submit" className="fi-primary" disabled={working || !name || !domain}>{working ? "Adding…" : email ? `Add ${email}` : "Add address"}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
