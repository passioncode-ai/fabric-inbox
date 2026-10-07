import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { fabric } from "~/services/fabric";
import { ApiError } from "~/services/api";
import { useT } from "../../../lib/i18n";
import type { ProjectAddresses } from "~/services/agents";
import type { DomainDetail, DomainList, DomainSummary, Step, StepsResult } from "~/services/domains";
import StepList from "~/components/domains/StepList";
import { groupRows, stableGroup, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout,
  SelectableList, SkeletonPanel, SkeletonRows, useConfirm, useWork,
} from "../ui";
import { detailKey, refreshMail, useAddresses, useDomains, useStepMemory } from "./data";
import { stepsFailed, stepsSummary } from "./steps";
import { addAddressText } from "./add-address-text";

interface DomainEntry extends ListEntry { summary: DomainSummary }

const CONNECT_KEY = "connect";

/** Names in Cloudflare's own dashboard, which is in English: the person looks for these words there. */
const CLOUDFLARE_UI = {
  tokensPage: "Cloudflare → My Profile → API Tokens",
  createToken: "Create Token",
  customToken: "Create Custom Token",
  allZones: "All zones",
};
/** A command, typed as it is in every language. */
const SAVE_TOKEN_COMMAND = "npx wrangler secret put CLOUDFLARE_API_TOKEN";

/**
 * Settings → Domains (SCR-02, SCN-030, SCN-031, SCN-033): every domain of the shown Cloudflare
 * accounts. A domain stays in the group it was shown in while the section is open; a change of
 * state shows on its badge, and the step list of the last action lives in its panel.
 */
export default function DomainsSection({ id }: { id: string | null }) {
  const t = useT();
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
  const groups = groupRows(visibleRows(entries, query, id), [
    { id: "served", label: t("Receiving here") }, { id: "other", label: t("Other domains on Cloudflare") },
  ]);
  const selected = id && id !== CONNECT_KEY ? entries.find((e) => e.key === id) ?? null : null;

  const listView = domains.isPending ? <SkeletonRows label={t("Loading your domains…")} /> : domains.isError ? (
    <LoadFailure what={t("Your domains")} error={domains.error} onRetry={() => void domains.refetch()} retrying={domains.isFetching} />
  ) : (
    <SelectableList label={t("Domains")} groups={groups} selected={id} hrefFor={(e) => settingsPath("domains", e.key)}
      pinned={list && !list.connected ? [{ key: CONNECT_KEY, href: settingsPath("domains", CONNECT_KEY), content: (
        <span className="fi-row-main"><span className="fi-row-title">{t("Connect Cloudflare")}</span><span className="fi-row-meta">{t("Needed to list and change your domains")}</span></span>
      ) }] : []}
      renderRow={(e) => <DomainRowContent entry={e} several={several} connected={!!list?.connected} />}
      empty={<div className="fi-list-empty"><p>{query ? t("No domain matches “{query}”.", { query }) : t("No domain is listed yet.")}</p></div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{t("Choose a domain")}</h2>
      <p>{list && !list.connected ? t("Connect Cloudflare first: then every domain of your account is listed here.") : t("Its state in Cloudflare, its addresses and what can change open here.")}</p>
    </PanelPlaceholder>
  ) : domains.isPending ? <SkeletonPanel label={t("Loading this domain…")} /> : id === CONNECT_KEY && list ? (
    <ConnectCloudflarePanel list={list} />
  ) : !selected || !list ? (
    <PanelPlaceholder>
      <h2>{t("{domain} is not listed", { domain: id })}</h2>
      <p>{t("None of the shown Cloudflare accounts has this domain. It may be hidden on Accounts.")}</p>
      <Link className="fi-secondary" to={settingsPath("domains")} replace preventScrollReset>{t("All domains")}</Link>
    </PanelPlaceholder>
  ) : (
    <DomainPanel key={selected.key} summary={selected.summary} list={list} data={addresses.data} />
  );

  return (
    <SectionLayout section="domains" hasSelection={!!id} list={listView} panel={panel}
      toolbar={<ListSearch value={query} onChange={setQuery} placeholder="example.com" label={t("Find a domain")} />}
      footer={list?.connected ? <p>{t.plural(list.domains.length, {
        one: "{n} domain, {served} receiving here.",
        other: "{n} domains, {served} receiving here.",
      }, { served: list.domains.filter((d) => d.served).length })}</p> : undefined} />
  );
}

function DomainRowContent({ entry, several, connected }: { entry: DomainEntry; several: boolean; connected: boolean }) {
  const t = useT();
  const d = entry.summary;
  const moved = (entry.group === "served") !== d.served;
  return (
    <>
      <span className="fi-row-main">
        <span className="fi-row-title">{d.domain}</span>
        <span className="fi-row-meta">
          {[several && d.account ? d.account.name : "", d.served ? t.plural(d.addresses, { one: "{n} address", other: "{n} addresses" }) : t("Not received here")].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="fi-row-side">
        {moved && (d.served ? <Badge tone="ok">{t("Receiving here now")}</Badge> : <Badge tone="warn">{t("No longer received")}</Badge>)}
        {connected && d.served && !d.zoneId && <Badge tone="warn" title={t("None of your server's tokens can see this domain")}>{t("Not visible")}</Badge>}
      </span>
    </>
  );
}

/** Runs a domain action, keeps its steps, and asks before what the server says needs a yes. */
function useDomainAction(domain: string) {
  const t = useT();
  const client = useQueryClient();
  const memory = useStepMemory();
  const confirm = useConfirm();
  const work = useWork(domain, "steps");
  const [local, setLocal] = useState<Step[]>([]);
  const steps = memory ? memory.get(domain) : local;
  const keep = (s: Step[]) => (memory ? memory.set(domain, s) : setLocal(s));
  const summary = (s: readonly Step[]) => stepsSummary(domain, s, t);

  async function act(path: string, label: string, body: Record<string, unknown> = {}, method = "POST"): Promise<void> {
    let needs: StepsResult["needsConfirmation"] | undefined;
    await work.run(label, async () => {
      try {
        const r = await fabric<StepsResult>(path, body, method);
        keep(r.steps);
        if (stepsFailed(r.steps)) throw new Error(summary(r.steps));
        return summary(r.steps);
      } catch (e) {
        const payload = (e instanceof ApiError ? e.body : {}) as Partial<StepsResult>;
        if (payload.needsConfirmation) { needs = payload.needsConfirmation; return ""; }
        if (payload.steps) { keep(payload.steps); throw new Error(summary(payload.steps)); }
        throw e;
      } finally { await refreshMail(client, domain); }
    });
    if (needs?.foreignMx) {
      const ok = await confirm({
        title: t("Mail for {domain} goes to another provider today", { domain }),
        body: <>
          <p>{t("Its MX records point at {hosts}. Receiving here replaces them with Cloudflare's, so mail stops reaching that provider.", { hosts: [...new Set(needs.foreignMx)].join(", ") })}</p>
          <p>{t("Forwards set up there cannot be read from Cloudflare: add those addresses here afterwards.")}</p>
        </>,
        confirmLabel: t("Replace and receive here"), cancelLabel: t("Keep it as it is"), danger: true,
      });
      if (ok) await act(path, label, { ...body, replaceMx: true }, method);
    } else if (needs?.zoneNotVisible) {
      const ok = await confirm({
        title: t("The token cannot see {domain}", { domain }),
        body: <p>{t("Its routing rules cannot be sent back from here. If Cloudflare still sends its mail to this server, it will be refused once {domain} is no longer received here.", { domain })}</p>,
        confirmLabel: t("Stop receiving anyway"), cancelLabel: t("Keep receiving"), danger: true,
      });
      if (ok) await act(path, label, { ...body, force: true }, method);
    }
  }
  return { steps, act, busy: work.busy, result: work.result };
}

function DomainPanel({ summary, list, data }: { summary: DomainSummary; list: DomainList; data?: ProjectAddresses }) {
  const t = useT();
  const domain = summary.domain;
  const confirm = useConfirm();
  const action = useDomainAction(domain);
  const connected = list.connected;

  const release = async () => {
    const ok = await confirm({
      title: t("Stop receiving {domain} here?", { domain }),
      body: <p>{t("Each address with a copy goes back to forwarding to it; the others stop receiving. Rules that send mail to another Worker are left as they are. The mail already here stays.")}</p>,
      confirmLabel: t("Stop receiving here"), cancelLabel: t("Keep receiving"), danger: true,
      blocked: summary.fixed ? t("{domain} is set in this server's configuration (DOMAINS), so it is always received here.", { domain }) : undefined,
    });
    if (ok) await action.act(`/api/domains/${domain}/release`, t("Stopping…"));
  };

  return (
    <Panel title={domain} closeTo={settingsPath("domains")}
      subtitle={[summary.account?.name ?? t("No connected account can see it"), summary.account && !summary.account.server ? t("its relay carries the mail here") : ""].filter(Boolean).join(" · ")}
      badges={summary.served ? <Badge tone="ok">{t("Receiving here")}</Badge> : <Badge>{t("Not received here")}</Badge>}
      menu={summary.served && connected ? <ActionMenu label={t("More actions for {name}", { name: domain })} actions={[
        { label: t("Stop receiving {domain} here…", { domain }), danger: true, onSelect: () => void release() },
      ]} /> : undefined}>
      {!summary.served ? (
        <PanelBlock title={t("Receive mail here")}>
          <p>{t("Receiving here turns on Email Routing, brings in any address that already exists (it keeps forwarding a copy where it went before), and turns on sending. You confirm first if another provider handles the domain's mail today.")}</p>
          <div className="fi-buttons">
            <button type="button" className="fi-primary" disabled={!!action.busy || !connected}
              onClick={() => void action.act(`/api/domains/${domain}/connect`, t("Connecting…"), { replaceMx: false })}>
              {action.busy ?? t("Receive mail here")}
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
  const t = useT();
  const ADD_TEXT = addAddressText(t);
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
  const connect = () => void action.act(`/api/domains/${domain}/connect`, t("Working…"));

  const applyCatchAll = () => void catchWork.run(t("Applying…"), async () => {
    try {
      const r = await fabric<StepsResult>(`/api/domains/${domain}/catch-all`, { mailbox: choice || null }, "PUT");
      setChoice(null);
      return r.steps.map((s) => t.text(s.detail)).join(" ");
    } finally { await refreshMail(client, domain); }
  });

  return (
    <>
      <PanelBlock title={t("In Cloudflare")} aside={connected && summary.zoneId ? (
        <button type="button" className="fi-text-button" disabled={detail.isFetching} onClick={() => void detail.refetch()}>{detail.isFetching ? t("Reading…") : t("Read again")}</button>
      ) : undefined}>
        {!connected ? (
          <p>{t.rich("Connect Cloudflare to see and change how this domain's mail is routed. {link}", {
            link: <Link key="how" to={settingsPath("domains", CONNECT_KEY)}>{t("How to connect")}</Link>,
          })}</p>
        ) : !summary.zoneId ? (
          <p>{t.rich("None of your server's Cloudflare tokens can see {domain}. It may be in an account that is not connected ({link}); its addresses still receive mail if routing sends it here.", {
            domain,
            link: <Link key="connect" to={settingsPath("accounts", null, null, { connect: "cloudflare" })}>{t("connect another account")}</Link>,
          })}</p>
        ) : detail.isPending ? <SkeletonPanel label={t("Reading Cloudflare…")} /> : detail.isError ? (
          <LoadFailure what="Cloudflare" error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        ) : d && (
          <ul className="fi-facts" aria-label={t("{domain} in Cloudflare", { domain })}>
            <li>{d.routing.enabled && d.routing.status === "ready" ? <><Badge tone="ok">{t("Receiving")}</Badge> {t("Email Routing is on.")}</> : <>
              <Badge tone="bad">{t("Receiving")}</Badge> {d.routing.enabled ? t("Email Routing is {status}.", { status: d.routing.status }) : t("Email Routing is off.")}
              <button type="button" className="fi-text-button" disabled={busy} onClick={connect}>{t("Fix it")}</button></>}</li>
            {elsewhere.length > 0 && (
              <li><Badge tone="warn">{t("Elsewhere")}</Badge> {t.plural(elsewhere.length, {
                one: "{n} address still goes elsewhere ({addresses}).",
                other: "{n} addresses still go elsewhere ({addresses}).",
              }, { addresses: elsewhere.map((r) => r.address).join(", ") })}
                <button type="button" className="fi-text-button" disabled={busy} onClick={connect}>{t("Bring them here, keeping a copy")}</button></li>
            )}
            <li>{d.sending.enabled ? <><Badge tone="ok">{t("Sending")}</Badge> {t("Replies from these addresses can leave.")}</> : <>
              <Badge tone="bad">{t("Sending")}</Badge> {t("Off: replies from these addresses cannot leave yet.")}
              <button type="button" className="fi-text-button" disabled={busy} onClick={() => void action.act(`/api/domains/${domain}/sending`, t("Turning on sending…"))}>{t("Turn on sending")}</button></>}</li>
            <li><Badge>DMARC</Badge> {d.dmarc ?? t("None. Turning on sending adds a monitoring-only record.")}</li>
            {d.problems.map((p) => <li key={p} role="alert"><Badge tone="warn">{t("Problem")}</Badge> {t.text(p)}</li>)}
          </ul>
        )}
        <ActionResult result={action.result} />
        <StepList steps={action.steps} />
      </PanelBlock>

      <PanelBlock title={t("Addresses on {domain}", { domain })} aside={addresses.length > 0 ? (
        <Link className="fi-text-button" to={settingsPath("addresses", null, null, { add: "1", domain })}>{ADD_TEXT.addOnDomain(domain)}</Link>) : undefined}>
        {!addresses.length ? (
          <div className="fi-empty-inline">
            <p>{ADD_TEXT.domainEmpty(domain, catchAll)}</p>
            <Link className="fi-primary" to={settingsPath("addresses", null, null, { add: "1", domain })}>{ADD_TEXT.addFirstOnDomain(domain)}</Link>
          </div>
        ) : (
          <ul className="fi-plain-list">
            {addresses.map((a) => (
              <li key={a.email}>
                <Link className="fi-grow" to={settingsPath("addresses", a.email)}>{a.email}</Link>
                <span className="fi-hint">{a.email === catchAll ? `${t("catch-all")} · ` : ""}{a.agentName ?? (a.agent === "off" ? t("Off") : "")}</span>
              </li>
            ))}
          </ul>
        )}
      </PanelBlock>

      {addresses.length > 0 && (
        <PanelBlock title={t("Mail for an address that does not exist")}>
          <label className="fi-field">
            <span className="fi-hint">{t("Chosen, then applied: it changes Cloudflare's catch-all for {domain}.", { domain })}</span>
            <select className="fi-input" value={choice ?? catchAll ?? ""} disabled={!!catchWork.busy || catchAllFixed || !connected}
              onChange={(e) => setChoice(e.target.value)}>
              <option value="">{t("Refuse it — the sender is told")}</option>
              {addresses.map((a) => <option key={a.email} value={a.email}>{t("Keep it in {email}", { email: a.email })}</option>)}
            </select>
          </label>
          {catchAllFixed && <p className="fi-hint">{t("Set in this server's configuration (UNKNOWN_ADDRESS_POLICY); change it there.")}</p>}
          {choosing && (
            <>
              <p>{choice
                ? t("Cloudflare's catch-all will send every other address on {domain} here, kept in {mailbox}; if it forwarded somewhere before, that becomes the mailbox's copy.", { domain, mailbox: choice })
                : t("Mail for addresses that do not exist on {domain} will be refused.", { domain })}</p>
              <div className="fi-buttons">
                <button type="button" className="fi-primary" disabled={!!catchWork.busy} onClick={applyCatchAll}>{catchWork.busy ?? t("Apply")}</button>
                <button type="button" className="fi-secondary" disabled={!!catchWork.busy} onClick={() => setChoice(null)}>{t("Cancel")}</button>
              </div>
            </>
          )}
          <ActionResult result={catchWork.result} />
        </PanelBlock>
      )}

      {unknown.length > 0 && (
        <PanelBlock title={t("Recent mail for addresses that do not exist")}>
          <ul className="fi-plain-list">
            {unknown.map((u) => (
              <li key={u.address}>
                <span className="fi-grow">{u.action === "rejected"
                  ? t.plural(u.count, {
                    one: "{address} — {n} message refused, last {when}",
                    other: "{address} — {n} messages refused, last {when}",
                  }, { address: u.address, when: t.dateTime(u.lastSeen) })
                  : t.plural(u.count, {
                    one: "{address} — {n} message kept in the catch-all, last {when}",
                    other: "{address} — {n} messages kept in the catch-all, last {when}",
                  }, { address: u.address, when: t.dateTime(u.lastSeen) })}</span>
                <Link className="fi-text-button" to={settingsPath("addresses", null, null, { add: "1", domain, name: u.address.slice(0, u.address.lastIndexOf("@")) })}>{t("Add this address")}</Link>
              </li>
            ))}
          </ul>
        </PanelBlock>
      )}
      {summary.fixed && <p className="fi-hint">{t("{domain} is set in this server's configuration (DOMAINS), so it is always received here.", { domain })}</p>}
    </>
  );
}

/** SCN-030 without a token: what to create in Cloudflare and where it goes. */
function ConnectCloudflarePanel({ list }: { list: DomainList }) {
  const t = useT();
  return (
    <Panel title={t("Connect your Cloudflare account")} closeTo={settingsPath("domains")}>
      <PanelBlock>
        <p>{t.text(list.problem ?? "")}{t("With it, this screen lists every domain in your account, turns mail on for the ones you choose and creates addresses on them.")}</p>
        <ol>
          <li>{t.rich("Open {page}, choose {createToken}, then {customToken}.", {
            page: <a key="page" href={list.tokenUrl} target="_blank" rel="noreferrer">{CLOUDFLARE_UI.tokensPage}</a>,
            createToken: <strong key="create">{CLOUDFLARE_UI.createToken}</strong>,
            customToken: <strong key="custom">{CLOUDFLARE_UI.customToken}</strong>,
          })}</li>
          <li>{t.rich("Add these permissions, and under Account and Zone resources choose your account and {allZones} (or only the domains you want here):", {
            allZones: <strong key="zones">{CLOUDFLARE_UI.allZones}</strong>,
          })}
            <PermissionTable permissions={list.permissions} />
          </li>
          <li>{t.rich("Save the token on this server. In the Mac app choose {menu} and paste it: the app saves it on your server (and updates the server if it is older). For a server you deployed yourself, run {command} in its folder instead. Then reload this page.", {
            menu: <strong key="menu">{t("Fabric Inbox → Connect Cloudflare account…")}</strong>,
            command: <code key="command">{SAVE_TOKEN_COMMAND}</code>,
          })}</li>
        </ol>
        <p className="fi-hint">{t("The token stays on the server and is never shown again. Without it, addresses on the domains already received here still get mail; only changing Cloudflare needs it.")}</p>
      </PanelBlock>
    </Panel>
  );
}

/**
 * The permissions a token needs. Type, permission and access are Cloudflare's own words, kept in
 * English as its dashboard shows them; what each is used for is ours, in the interface's language.
 */
export function PermissionTable({ permissions }: { permissions: DomainList["permissions"] }) {
  const t = useT();
  return (
    <table className="fi-table">
      <thead><tr><th>{t("Type")}</th><th>{t("Permission")}</th><th>{t("Access")}</th><th>{t("Used to")}</th></tr></thead>
      <tbody>
        {permissions.map((p) => (
          <tr key={p.scope + p.name}><td>{p.scope}</td><td><strong>{p.name}</strong></td><td>{p.level}</td><td>{t.text(p.for)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
