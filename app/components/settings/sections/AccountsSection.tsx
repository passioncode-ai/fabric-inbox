import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CloudIcon, EnvelopeSimpleIcon, GoogleLogoIcon, MicrosoftOutlookLogoIcon, PlusIcon } from "@phosphor-icons/react";
import { fabric, accountPath, type Account } from "~/services/fabric";
import type { CloudflareAccount, DomainList } from "~/services/domains";
import { gmailSetupState } from "~/lib/account-status";
import { count, groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, Dialog, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout,
  SelectableList, SkeletonPanel, SkeletonRows, errorText, useConfirm, useWork,
} from "../ui";
import { DOMAINS_KEY, GMAIL_KEY, refreshMail, useDomains, useGmailAccounts } from "./data";
import { PermissionTable } from "./DomainsSection";
import { AVAILABILITY_TEXT, PROVIDERS, availability, type ProviderEntry, type ProviderId } from "./providers";
import { GmailConnectStep, GmailProblem, GmailSetupWizard, useGmailSetup } from "./GmailSetup";

/** Where a person creates a token; an account-owned one is under the account's own Manage Account page. */
const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

type AccountEntry = ListEntry & ({ kind: "cloudflare"; account: CloudflareAccount } | { kind: "gmail"; account: Account });

const GROUPS = [{ id: "cloudflare", label: "Cloudflare" }, { id: "gmail", label: "Gmail" }];
const ICONS: Record<ProviderId, typeof CloudIcon> = { cloudflare: CloudIcon, gmail: GoogleLogoIcon, "gmail-app-password": GoogleLogoIcon, imap: EnvelopeSimpleIcon, microsoft: MicrosoftOutlookLogoIcon };

export function describeCloudflare(a: CloudflareAccount): string {
  const mail = a.hasMail === true ? "Has mail" : a.hasMail === false ? "No mail yet" : "Mail not checked";
  const domains = `${count(a.domains, "domain")}${a.served ? `, ${a.served} receiving here` : ""}`;
  const via = a.via === "account" ? "its own token" : "your server's token";
  return [mail, domains, `reached with ${via}`, ...(a.relay ? ["relay installed"] : [])].join(" · ");
}

const gmailStatus = (a: Account) => a.status.replaceAll("_", " ");
const gmailTone = (a: Account) => (a.error ? "bad" : a.status === "connected" ? "ok" : "warn") as "bad" | "ok" | "warn";

/**
 * Settings → Accounts (SCR-02, SCN-002, SCN-003, SCN-045, SCN-046): the Cloudflare accounts the
 * server has a token for, and the connected Gmail accounts. Connecting one more opens a dialog with
 * a card per provider (providers.ts); providers this build cannot connect say so.
 */
export default function AccountsSection({ id }: { id: string | null }) {
  const domains = useDomains();
  const gmail = useGmailAccounts();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const entries = useMemo<AccountEntry[]>(() => [
    ...(domains.data?.accounts ?? []).map((a): AccountEntry => ({ key: `cloudflare:${a.id}`, group: "cloudflare", kind: "cloudflare", account: a, text: `${a.name} cloudflare` })),
    ...(gmail.data?.accounts ?? []).map((a): AccountEntry => ({ key: `gmail:${a.id}`, group: "gmail", kind: "gmail", account: a, text: `${a.email} gmail google` })),
  ], [domains.data, gmail.data]);
  const groups = groupRows(visibleRows(entries, query, id), GROUPS);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const connecting = params.get("connect") as ProviderId | null;
  const setConnecting = (p: ProviderId | "" | null) => setParams((old) => {
    const n = new URLSearchParams(old);
    if (p === null) n.delete("connect"); else n.set("connect", p);
    return n;
  }, { replace: true, preventScrollReset: true });

  const loading = domains.isPending && gmail.isPending;
  const listView = loading ? <SkeletonRows label="Loading your accounts…" /> : (
    <>
      {domains.isError && <LoadFailure what="Cloudflare accounts" error={domains.error} onRetry={() => void domains.refetch()} retrying={domains.isFetching} />}
      {gmail.isError && <LoadFailure what="Gmail accounts" error={gmail.error} onRetry={() => void gmail.refetch()} retrying={gmail.isFetching} />}
      <SelectableList label="Accounts" groups={groups} selected={id} hrefFor={(e) => settingsPath("accounts", e.key)}
        renderRow={(e) => <AccountRowContent entry={e} />}
        empty={<div className="fi-list-empty">
          <p>{query ? `No account matches “${query}”.` : "No account is connected yet. Connect Cloudflare for your own domains, or a Gmail account."}</p>
          {!query && <button type="button" className="fi-primary" onClick={() => setConnecting("")}>Connect an account</button>}
        </div>} />
      {domains.data?.problems?.map((p) => <p key={p} className="fi-load-failure" role="alert">{p}</p>)}
    </>
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Choose an account</h2>
      <p>Mail and rules keep running in the cloud when this app is closed.</p>
      <button type="button" className="fi-primary" onClick={() => setConnecting("")}><PlusIcon size={16} /> Connect an account</button>
    </PanelPlaceholder>
  ) : loading ? <SkeletonPanel label="Loading this account…" /> : !selected ? (
    <PanelPlaceholder>
      <h2>This account is not connected</h2>
      <p>It may have been removed or disconnected.</p>
      <Link className="fi-secondary" to={settingsPath("accounts")} replace preventScrollReset>All accounts</Link>
    </PanelPlaceholder>
  ) : selected.kind === "cloudflare" ? (
    <CloudflarePanel key={selected.key} account={selected.account} entryKey={selected.key}
      onRemoved={() => navigate(settingsPath("accounts"), { replace: true, preventScrollReset: true })} />
  ) : (
    <GmailPanel key={selected.key} account={selected.account} entryKey={selected.key} onSetup={() => setConnecting("gmail")}
      onRemoved={() => navigate(settingsPath("accounts"), { replace: true, preventScrollReset: true })} />
  );

  return (
    <>
      <SectionLayout section="accounts" hasSelection={!!id} list={listView} panel={panel}
        toolbar={<>
          <ListSearch value={query} onChange={setQuery} placeholder="Find an account" label="Find an account" />
          <button type="button" className="fi-primary" onClick={() => setConnecting("")}><PlusIcon size={16} /> Connect account</button>
        </>} />
      <ConnectDialog open={connecting !== null} provider={connecting || null} onChoose={(p) => setConnecting(p)}
        onClose={() => setConnecting(null)} list={domains.data} gmailState={gmailSetupState(gmail.data, gmail.error)} />
    </>
  );
}

function AccountRowContent({ entry }: { entry: AccountEntry }) {
  if (entry.kind === "cloudflare") {
    const a = entry.account;
    return (
      <>
        <span className="fi-row-main">
          <span className="fi-row-title">{a.name}</span>
          <span className="fi-row-meta">{count(a.domains, "domain")}{a.served ? `, ${a.served} receiving here` : ""}{a.server ? " · your server's account" : ""}</span>
        </span>
        <span className="fi-row-side">
          {a.problem ? <Badge tone="bad">Problem</Badge> : a.shown ? null : <Badge>Hidden</Badge>}
        </span>
      </>
    );
  }
  const a = entry.account;
  return (
    <>
      <span className="fi-row-main">
        <span className="fi-row-title">{a.email}</span>
        <span className="fi-row-meta">{a.lastSyncAt ? `Last sync ${new Date(a.lastSyncAt).toLocaleString()}` : "Waiting for first sync"}</span>
      </span>
      <span className="fi-row-side"><Badge tone={gmailTone(a)}>{gmailStatus(a)}</Badge></span>
    </>
  );
}

function CloudflarePanel({ account: a, entryKey, onRemoved }: { account: CloudflareAccount; entryKey: string; onRemoved: () => void }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(entryKey);
  const choose = (shown: boolean | null) => void work.run("Saving…", async () => {
    try {
      await fabric(`/api/cloudflare/accounts/${a.id}`, { shown }, "PUT");
    } finally { await refreshMail(client); }
    return shown === null ? `${a.name} is back to the default: shown when it has mail.` : shown ? `The domains of ${a.name} are shown.` : `The domains of ${a.name} are hidden.`;
  });
  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${a.name} from your server?`,
      body: <p>{a.relay ? "Its relay Worker is deleted, and " : ""}its token is deleted. Its domains are no longer listed here; connecting it again needs a new token.</p>,
      confirmLabel: `Remove ${a.name}`, danger: true,
      blocked: a.served > 0 ? `Stop receiving its ${count(a.served, "domain")} here first (Domains).` : undefined,
    });
    if (!ok) return;
    const done = await work.run("Removing…", async () => {
      try {
        const r = await fabric<{ relay?: string }>(`/api/cloudflare/accounts/${a.id}`, undefined, "DELETE");
        return `${a.name} was removed from your server: its token was deleted.${r.relay ? ` ${r.relay}` : ""}`;
      } finally { await refreshMail(client); }
    });
    if (done) onRemoved();
  };
  const removable = a.via === "account" && !a.server;
  return (
    <Panel title={a.name} subtitle={a.server ? "Your server's account" : "Another Cloudflare account"} closeTo={settingsPath("accounts")}
      badges={<>{a.shown ? <Badge tone="ok">Shown</Badge> : <Badge>Hidden</Badge>}{a.relay && <Badge>Relay installed</Badge>}</>}
      menu={removable ? <ActionMenu label={`More actions for ${a.name}`} actions={[{ label: `Remove ${a.name}…`, danger: true, onSelect: () => void remove() }]} /> : undefined}>
      <PanelBlock title="What your server sees">
        <p>{describeCloudflare(a)}.</p>
        {a.problem && <div className="fi-callout is-bad" role="alert"><p>{a.problem}</p></div>}
        <p><Link to={settingsPath("domains")}>Its domains are on Domains</Link>.</p>
      </PanelBlock>
      <PanelBlock title="Show its domains">
        <p className="fi-hint">Accounts with mail are shown by default. A shown account's domains are listed on Domains.</p>
        <div className="fi-buttons">
          <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => choose(!a.shown)}
            aria-label={`${a.shown ? "Hide" : "Show"} the domains of ${a.name}`}>{a.shown ? "Hide" : "Show"}</button>
          {a.choice && <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => choose(null)}>Default</button>}
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
    </Panel>
  );
}

function GmailPanel({ account: a, entryKey, onRemoved, onSetup }: { account: Account; entryKey: string; onRemoved: () => void; onSetup: () => void }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(entryKey);
  const setup = useGmailSetup(!!a.reason);
  const retry = () => void work.run("Retrying…", async () => {
    try {
      await fabric(accountPath(a.id) + "/sync", {});
      return `${a.email} synced.`;
    } finally {
      await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
    }
  });
  const disconnect = async () => {
    const ok = await confirm({
      title: `Disconnect ${a.email}?`,
      body: <p>Its access is revoked and its cached mail leaves this app. Its mail stays in Gmail; connecting it again starts a new sync.</p>,
      confirmLabel: `Disconnect ${a.email}`, danger: true,
    });
    if (!ok) return;
    const done = await work.run("Disconnecting…", async () => {
      try {
        const r = await fabric<{ revoked: boolean }>(accountPath(a.id) + "/disconnect", {});
        return r.revoked ? `${a.email} was disconnected.` : `${a.email} was removed here. Revoke its access in your Google account too.`;
      } finally {
        await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
      }
    });
    if (done) onRemoved();
  };
  return (
    <Panel title={a.email} subtitle="Gmail" closeTo={settingsPath("accounts")} badges={<Badge tone={gmailTone(a)}>{gmailStatus(a)}</Badge>}
      menu={<ActionMenu label={`More actions for ${a.email}`} actions={[{ label: `Disconnect ${a.email}…`, danger: true, onSelect: () => void disconnect() }]} />}>
      <PanelBlock title="Sync">
        <p>{a.lastSyncAt ? `Last sync ${new Date(a.lastSyncAt).toLocaleString()}.` : "Waiting for the first sync."}</p>
        <GmailProblem account={a} projectNumber={setup.data?.projectNumber ?? null} onRetry={retry} onSetup={onSetup} busy={!!work.busy} />
        <div className="fi-buttons">
          <Link className="fi-secondary" to={"/?account=" + encodeURIComponent("gmail:" + a.id)}>Open its mail</Link>
          <Link className="fi-secondary" to={"/automation/" + encodeURIComponent("gmail:" + a.id)}>Rules and history</Link>
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
    </Panel>
  );
}

/* ------------------------------------------------------------ connecting */

function ConnectDialog({ open, provider, onChoose, onClose, list, gmailState }: {
  open: boolean; provider: ProviderId | null; onChoose: (p: ProviderId | "") => void; onClose: () => void;
  list?: DomainList; gmailState: ReturnType<typeof gmailSetupState>;
}) {
  const state = { cloudflareConnected: list ? list.connected : null, gmail: gmailState };
  const chosen = PROVIDERS.find((p) => p.id === provider) ?? null;
  return (
    <Dialog open={open} title={chosen ? `Connect ${chosen.name}` : "Connect an account"} onClose={onClose} wide>
      {!chosen ? (
        <div className="fi-provider-cards">
          {PROVIDERS.map((p) => <ProviderCard key={p.id} provider={p} state={availability(p, state)} onChoose={() => onChoose(p.id)} />)}
        </div>
      ) : chosen.id === "gmail" ? (
        <ConnectGmail state={gmailState} onBack={() => onChoose("")} onClose={onClose} />
      ) : chosen.id === "cloudflare" ? (
        <ConnectCloudflareAccount list={list} onBack={() => onChoose("")} onClose={onClose} />
      ) : (
        <>
          <p>{chosen.name} connections are not available in this build. {chosen.summary}</p>
          {chosen.tradeoff && <p className="fi-hint">Compared with connecting through Google: {chosen.tradeoff}</p>}
          {chosen.helpUrl && <p><a href={chosen.helpUrl} target="_blank" rel="noreferrer">What it needs, on the provider's help page ↗</a></p>}
          <div className="fi-dialog-actions"><button type="button" className="fi-secondary" data-autofocus onClick={() => onChoose("")}>Back</button></div>
        </>
      )}
    </Dialog>
  );
}

function ProviderCard({ provider, state, onChoose }: { provider: ProviderEntry; state: ReturnType<typeof availability>; onChoose: () => void }) {
  const Icon = ICONS[provider.id];
  return (
    <button type="button" className="fi-provider-card" disabled={state === "unavailable"} onClick={onChoose}
      data-autofocus={provider.id === "cloudflare" ? true : undefined}>
      <strong><Icon size={18} aria-hidden="true" /> {provider.name}</strong>
      <span>{provider.summary}</span>
      {AVAILABILITY_TEXT[state] && <span className="fi-hint">{AVAILABILITY_TEXT[state]}</span>}
    </button>
  );
}

/**
 * SCN-051 then SCN-002: a server without Google set up shows the setup steps; one with it set up
 * connects an account in the browser. "Use another Google client…" opens the steps again.
 */
function ConnectGmail({ state, onBack, onClose }: { state: ReturnType<typeof gmailSetupState>; onBack: () => void; onClose: () => void }) {
  const client = useQueryClient();
  const setup = useGmailSetup(state === "configured" || state === "not-configured");
  const [replacing, setReplacing] = useState(false);
  if (state === "loading" || (state !== "unavailable" && setup.isPending))
    return <p role="status">Checking Gmail setup…</p>;
  if (state === "unavailable" || setup.isError)
    return (
      <>
        <p role="alert">Gmail setup is unknown: {setup.isError ? errorText(setup.error) : "the accounts did not load."}</p>
        <div className="fi-dialog-actions"><button type="button" className="fi-secondary" data-autofocus onClick={onBack}>Back</button></div>
      </>
    );
  const data = setup.data!;
  if (state === "configured" && data.configured && !replacing)
    return (
      <>
        <GmailConnectStep setup={data} onReplace={() => setReplacing(true)} />
        <div className="fi-dialog-actions"><button type="button" className="fi-secondary" onClick={onBack}>Back</button></div>
      </>
    );
  return (
    <>
      <GmailSetupWizard setup={data} onSaved={() => { setReplacing(false); void client.invalidateQueries({ queryKey: GMAIL_KEY }); }} />
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={replacing ? () => setReplacing(false) : onBack}>Back</button>
        <button type="button" className="fi-secondary" onClick={onClose}>Later</button>
      </div>
    </>
  );
}

/** SCN-046: a token for one more account, checked and kept on the server; never shown again. */
function ConnectCloudflareAccount({ list, onBack, onClose }: { list?: DomainList; onBack: () => void; onClose: () => void }) {
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // Polling stops when the dialog closes or the screen is left.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  if (list && !list.connected) {
    return (
      <>
        <p>Your server has no Cloudflare token of its own yet. Connect your own Cloudflare account first; then other accounts can be added here.</p>
        <div className="fi-dialog-actions">
          <button type="button" className="fi-secondary" onClick={onBack}>Back</button>
          <Link className="fi-primary" to={settingsPath("domains", "connect")} onClick={onClose}>How to connect Cloudflare</Link>
        </div>
      </>
    );
  }

  async function connect() {
    setWorking(true); setResult(null);
    try {
      const r = await fabric<{ connected: { id: string; name: string }[]; skipped: { name: string; reason: string }[]; failed?: { name: string; reason: string }[] }>("/api/cloudflare/accounts", { token });
      setToken("");
      const failed = (r.failed ?? []).map((f) => `${f.name}: ${f.reason}`).join("; ");
      if (!r.connected.length) {
        setResult({ tone: "alert", text: failed ? `Not connected. ${failed}` : `Nothing new to connect: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.` });
        return;
      }
      const names = r.connected.map((a) => a.name).join(", ");
      const also = failed ? ` Not connected: ${failed}.` : "";
      setResult({ tone: "status", text: `Connected ${names}. Your server starts using the token within a few seconds…${also}` });
      // A saved token is a new version of the server: read the accounts again until each account is
      // reached with its own token. A read that fails while the new version starts is not the answer.
      for (let attempt = 0; attempt < 10 && alive.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (!alive.current) return;
        const fresh = await client.fetchQuery({ queryKey: DOMAINS_KEY, queryFn: () => fabric<DomainList>("/api/domains"), staleTime: 0 }).catch(() => null);
        if (fresh && r.connected.every((c) => fresh.accounts.some((a) => a.id === c.id && a.via === "account" && !a.problem))) {
          setResult({ tone: "status", text: `Connected ${names}. Its domains with mail are listed on Domains.${also}` });
          return;
        }
      }
      if (alive.current) setResult({ tone: "alert", text: `Connected ${names}, but your server has not started using the token yet. Reload this page in a minute.${also}` });
    } catch (error) {
      setResult({ tone: "alert", text: errorText(error) });
      field.current?.focus();
    } finally { if (alive.current) setWorking(false); }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void connect(); }}>
      <ol>
        <li>In Cloudflare, open the other account and create a token there: <strong>Manage Account → Account API Tokens</strong>, or{" "}
          <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">My Profile → API Tokens</a>. Choose <strong>Create Custom Token</strong>.</li>
        <li>Add these permissions, and under Account and Zone resources choose that account and <strong>All zones</strong>:
          {list ? <PermissionTable permissions={list.accountPermissions} /> : <p role="status" className="fi-hint">Loading the permissions…</p>}
        </li>
        <li>Paste the token here. Your server keeps it as its own secret; it is not shown again.</li>
      </ol>
      <label className="fi-field">Token
        <input ref={field} data-autofocus className="fi-input" type="password" autoComplete="off" spellCheck={false} required
          value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      {result && <p className={"fi-action-result" + (result.tone === "alert" ? " is-error" : "")} role={result.tone}>{result.text}</p>}
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={onBack} disabled={working}>Back</button>
        <button type="submit" className="fi-primary" disabled={working || !token.trim()}>{working ? "Connecting…" : "Connect"}</button>
      </div>
    </form>
  );
}
