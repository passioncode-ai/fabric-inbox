import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import type { Destination } from "~/services/domains";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  Badge, Dialog, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList, SkeletonPanel,
  SkeletonRows, errorText, useNotify,
} from "../ui";
import { DESTINATIONS_KEY, useAddresses, useDestinations, useDomains } from "./data";

interface DestinationEntry extends ListEntry { destination: Destination }

/**
 * Settings → Forwarding destinations (SCN-033): the outside addresses a copy of each message may
 * go to. Cloudflare delivers a copy only to a confirmed one, and sends the confirmation link
 * itself. Destinations belong to one Cloudflare account each.
 */
export default function DestinationsSection({ id }: { id: string | null }) {
  const domains = useDomains();
  const addresses = useAddresses();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const accounts = domains.data?.accounts.filter((a) => a.shown) ?? [];
  const chosen = params.get("account");
  const current = accounts.find((a) => a.id === chosen) ?? accounts.find((a) => a.server) ?? accounts[0];
  const account = current && !current.server ? current.id : undefined;
  const connected = !!domains.data?.connected;
  const list = useDestinations(connected, account);
  const entries = (list.data ?? []).map((d): DestinationEntry => ({ key: d.id, group: "all", destination: d, text: d.email }));
  const groups = groupRows(visibleRows(entries, query, id), [{ id: "all", label: "" }]);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const adding = params.get("add") === "1";
  const setParam = (key: string, value: string | null) => setParams((old) => {
    const n = new URLSearchParams(old);
    if (value === null) n.delete(key); else n.set(key, value);
    return n;
  }, { replace: true, preventScrollReset: true });
  const hrefFor = (key: string | null) => settingsPath("destinations", key, null, chosen ? { account: chosen } : undefined);

  const listView = domains.isPending ? <SkeletonRows label="Loading forwarding destinations…" /> : domains.isError ? (
    <LoadFailure what="Your Cloudflare accounts" error={domains.error} onRetry={() => void domains.refetch()} retrying={domains.isFetching} />
  ) : !connected ? (
    <div className="fi-list-empty">
      <p>Forwarding destinations live in Cloudflare. Connect it first.</p>
      <Link className="fi-secondary" to={settingsPath("domains", "connect")}>How to connect Cloudflare</Link>
    </div>
  ) : list.isPending ? <SkeletonRows rows={3} label="Loading forwarding destinations…" /> : list.isError ? (
    <LoadFailure what="Forwarding destinations" error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
  ) : (
    <SelectableList label="Forwarding destinations" groups={groups} selected={id} hrefFor={(e) => hrefFor(e.key)}
      renderRow={(e) => (
        <>
          <span className="fi-row-main"><span className="fi-row-title">{e.destination.email}</span></span>
          <span className="fi-row-side">{e.destination.verified ? <Badge tone="ok">Confirmed</Badge> : <Badge tone="warn">Waiting</Badge>}</span>
        </>
      )}
      empty={<div className="fi-list-empty">
        <p>{query ? `No destination matches “${query}”.` : "No destination yet. Add the address you read today, for example your Gmail."}</p>
        {!query && <button type="button" className="fi-primary" onClick={() => setParam("add", "1")}>Add a destination</button>}
      </div>} />
  );

  const copiers = (email: string) => (addresses.data?.addresses ?? []).filter((a) => a.forwardTo === email);
  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Choose a destination</h2>
      <p>An address can keep forwarding a copy of each message to a confirmed destination; choose it on the address's Copy tab.</p>
    </PanelPlaceholder>
  ) : list.isPending ? <SkeletonPanel label="Loading this destination…" /> : !selected ? (
    <PanelPlaceholder>
      <h2>This destination is not listed</h2>
      <p>It may belong to another Cloudflare account.</p>
      <Link className="fi-secondary" to={hrefFor(null)} replace preventScrollReset>All destinations</Link>
    </PanelPlaceholder>
  ) : (
    <Panel key={selected.key} title={selected.destination.email} closeTo={hrefFor(null)}
      badges={selected.destination.verified ? <Badge tone="ok">Confirmed</Badge> : <Badge tone="warn">Waiting for confirmation</Badge>}
      subtitle={current ? `In ${current.name}` : undefined}>
      <PanelBlock title="Confirmation">
        <p>{selected.destination.verified
          ? `Confirmed on ${new Date(selected.destination.verified).toLocaleDateString()}. Cloudflare delivers copies to it.`
          : "Cloudflare sent a link to this address. Copies reach it once the link is opened; until then nothing is forwarded to it."}</p>
      </PanelBlock>
      <PanelBlock title="Addresses that send a copy here">
        {!copiers(selected.destination.email).length ? <p>None yet. Choose it on an address's Copy tab.</p> : (
          <ul className="fi-plain-list">
            {copiers(selected.destination.email).map((a) => (
              <li key={a.email}><Link className="fi-grow" to={settingsPath("addresses", a.email, "copy")}>{a.email}</Link></li>
            ))}
          </ul>
        )}
      </PanelBlock>
    </Panel>
  );

  return (
    <>
      <SectionLayout section="destinations" hasSelection={!!id} list={listView} panel={panel}
        toolbar={<>
          {accounts.length > 1 && (
            <select className="fi-input" aria-label="Cloudflare account" value={current?.id ?? ""}
              onChange={(e) => setParams({ account: e.target.value }, { replace: true, preventScrollReset: true })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <ListSearch value={query} onChange={setQuery} placeholder="you@gmail.com" label="Find a destination" />
          <button type="button" className="fi-primary" disabled={!connected} onClick={() => setParam("add", "1")}><PlusIcon size={16} /> Add</button>
        </>}
        footer={accounts.length > 1 ? <p>A destination belongs to one Cloudflare account; an address can copy only to one in its domain's account.</p> : undefined} />
      <AddDestinationDialog open={adding && connected} account={account} accountName={current?.name}
        onClose={() => setParam("add", null)} onAdded={(d) => navigate(hrefFor(d.id), { replace: true, preventScrollReset: true })} />
    </>
  );
}

function AddDestinationDialog({ open, account, accountName, onClose, onAdded }: {
  open: boolean; account?: string; accountName?: string; onClose: () => void; onAdded: (d: Destination) => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  async function submit() {
    setWorking(true); setProblem("");
    try {
      const r = await fabric<{ destination: Destination; created: boolean }>(`/api/domains/destinations${account ? `?account=${account}` : ""}`, { email });
      await client.invalidateQueries({ queryKey: DESTINATIONS_KEY });
      notify(r.created ? `Cloudflare sent a confirmation link to ${r.destination.email}. It can receive copies once the link is opened.`
        : `${r.destination.email} is already a destination${r.destination.verified ? "" : ", still waiting for confirmation"}.`);
      setEmail("");
      onClose();
      onAdded(r.destination);
    } catch (error) { setProblem(errorText(error)); } finally { setWorking(false); }
  }
  return (
    <Dialog open={open} title="Add a forwarding destination" onClose={onClose} busy={working}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p>Cloudflare sends a confirmation link to this address{accountName ? ` (in ${accountName})` : ""}. Copies reach it once the link is opened.</p>
        <label className="fi-field">Address
          <input className="fi-input" data-autofocus type="email" required placeholder="you@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {problem && <p className="fi-action-result is-error" role="alert">{problem}</p>}
        <div className="fi-dialog-actions">
          <button type="button" className="fi-secondary" onClick={onClose} disabled={working}>Cancel</button>
          <button type="submit" className="fi-primary" disabled={working || !email}>{working ? "Sending…" : "Send confirmation"}</button>
        </div>
      </form>
    </Dialog>
  );
}
