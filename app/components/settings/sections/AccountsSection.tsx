import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CloudIcon, EnvelopeSimpleIcon, GoogleLogoIcon, MicrosoftOutlookLogoIcon, PlusIcon } from "@phosphor-icons/react";
import { fabric, accountPath, type Account } from "~/services/fabric";
import type { CloudflareAccount, DomainList } from "~/services/domains";
import { gmailSetupState, imapSetupState, outlookSetupState } from "~/lib/account-status";
import { useT } from "../../../lib/i18n";
import { englishT, type T } from "../../../../shared/i18n";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, Dialog, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout,
  SelectableList, SkeletonPanel, SkeletonRows, errorText, useConfirm, useWork,
} from "../ui";
import { DOMAINS_KEY, GMAIL_KEY, refreshMail, useDomains, useGmailAccounts } from "./data";
import { PermissionTable } from "./DomainsSection";
import { AVAILABILITY_TEXT, PROVIDERS, accountStatusText, availability, type ProviderEntry, type ProviderId } from "./providers";
import { GmailConnectStep, GmailProblem, GmailSetupWizard, useGmailSetup } from "./GmailSetup";
import { ConnectImap, ImapPanel } from "./ImapAccount";
import { MICROSOFT_SETUP_KEY, OutlookConnectStep, OutlookProblem, OutlookSetupWizard, SecretExpiryNotice, useMicrosoftSetup } from "./OutlookSetup";

/** Where a person creates a token; an account-owned one is under the account's own Manage Account page. */
const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
/**
 * Cloudflare's own names for the places the person clicks: they stay exactly as Cloudflare shows
 * them, in every language of this app, so the person finds them in the dashboard.
 */
const CLOUDFLARE_NAMES = {
  accountTokens: "Manage Account → Account API Tokens", profileTokens: "My Profile → API Tokens",
  customToken: "Create Custom Token", allZones: "All zones",
} as const;

type AccountEntry = ListEntry & ({ kind: "cloudflare"; account: CloudflareAccount } | { kind: "gmail" | "imap" | "outlook"; account: Account });

const groupsFor = (t: T) => [{ id: "cloudflare", label: "Cloudflare" }, { id: "gmail", label: "Gmail" }, { id: "outlook", label: "Outlook" }, { id: "imap", label: t("Other mail") }];
const ICONS: Record<ProviderId, typeof CloudIcon> = { cloudflare: CloudIcon, gmail: GoogleLogoIcon, "gmail-app-password": GoogleLogoIcon, imap: EnvelopeSimpleIcon, microsoft: MicrosoftOutlookLogoIcon };

/** "3 domains, 2 receiving here": a Cloudflare account's domains, in the language of `t`. */
function domainsText(a: CloudflareAccount, t: T): string {
  const domains = t.plural(a.domains, { one: "{n} domain", other: "{n} domains" });
  return a.served ? `${domains}, ${t.plural(a.served, { one: "{n} receiving here", other: "{n} receiving here" })}` : domains;
}

export function describeCloudflare(a: CloudflareAccount, t: T = englishT): string {
  const mail = a.hasMail === true ? t("Has mail") : a.hasMail === false ? t("No mail yet") : t("Mail not checked");
  const via = a.via === "account" ? t("reached with its own token") : t("reached with your server's token");
  return [mail, domainsText(a, t), via, ...(a.relay ? [t("relay installed")] : [])].join(" · ");
}

const gmailTone = (a: Account) => (a.error ? "bad" : a.status === "connected" ? "ok" : "warn") as "bad" | "ok" | "warn";

/**
 * Settings → Accounts (SCR-02, SCN-002, SCN-003, SCN-045, SCN-046, SCN-052…SCN-060): the Cloudflare
 * accounts the server has a token for, and the connected Gmail, Outlook and IMAP accounts. Connecting one more
 * opens a dialog with a card per provider (providers.ts); providers this build cannot connect say so.
 */
export default function AccountsSection({ id }: { id: string | null }) {
  const t = useT();
  const domains = useDomains();
  const gmail = useGmailAccounts();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const entries = useMemo<AccountEntry[]>(() => [
    ...(domains.data?.accounts ?? []).map((a): AccountEntry => ({ key: `cloudflare:${a.id}`, group: "cloudflare", kind: "cloudflare", account: a, text: `${a.name} cloudflare` })),
    ...(gmail.data?.accounts ?? []).map((a): AccountEntry => a.provider === "imap"
      ? { key: `imap:${a.id}`, group: "imap", kind: "imap", account: a, text: `${a.email} imap ${a.providerName ?? ""}` }
      : a.provider === "outlook"
        ? { key: `outlook:${a.id}`, group: "outlook", kind: "outlook", account: a, text: `${a.email} outlook microsoft` }
        : { key: `gmail:${a.id}`, group: "gmail", kind: "gmail", account: a, text: `${a.email} gmail google` }),
  ], [domains.data, gmail.data]);
  const groups = groupRows(visibleRows(entries, query, id), groupsFor(t));
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const connecting = params.get("connect") as ProviderId | null;
  const setConnecting = (p: ProviderId | "" | null) => setParams((old) => {
    const n = new URLSearchParams(old);
    if (p === null) n.delete("connect"); else n.set("connect", p);
    return n;
  }, { replace: true, preventScrollReset: true });

  const loading = domains.isPending && gmail.isPending;
  const listView = loading ? <SkeletonRows label={t("Loading your accounts…")} /> : (
    <>
      {domains.isError && <LoadFailure what={t("Cloudflare accounts")} error={domains.error} onRetry={() => void domains.refetch()} retrying={domains.isFetching} />}
      {gmail.isError && <LoadFailure what={t("Gmail, Outlook and IMAP accounts")} error={gmail.error} onRetry={() => void gmail.refetch()} retrying={gmail.isFetching} />}
      <SelectableList label={t("Accounts")} groups={groups} selected={id} hrefFor={(e) => settingsPath("accounts", e.key)}
        renderRow={(e) => <AccountRowContent entry={e} />}
        empty={<div className="fi-list-empty">
          <p>{query ? t("No account matches “{query}”.", { query }) : t("No account is connected yet. Connect Cloudflare for your own domains, Gmail, Outlook, or another mail account.")}</p>
          {!query && <button type="button" className="fi-primary" onClick={() => setConnecting("")}>{t("Connect an account")}</button>}
        </div>} />
      {domains.data?.problems?.map((p) => <p key={p} className="fi-load-failure" role="alert">{t.text(p)}</p>)}
    </>
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{t("Choose an account")}</h2>
      <p>{t("Mail and rules keep running in the cloud when this app is closed.")}</p>
      <button type="button" className="fi-primary" onClick={() => setConnecting("")}><PlusIcon size={16} /> {t("Connect an account")}</button>
    </PanelPlaceholder>
  ) : loading ? <SkeletonPanel label={t("Loading this account…")} /> : !selected ? (
    <PanelPlaceholder>
      <h2>{t("This account is not connected")}</h2>
      <p>{t("It may have been removed or disconnected.")}</p>
      <Link className="fi-secondary" to={settingsPath("accounts")} replace preventScrollReset>{t("All accounts")}</Link>
    </PanelPlaceholder>
  ) : selected.kind === "cloudflare" ? (
    <CloudflarePanel key={selected.key} account={selected.account} entryKey={selected.key}
      onRemoved={() => navigate(settingsPath("accounts"), { replace: true, preventScrollReset: true })} />
  ) : selected.kind === "outlook" ? (
    <OutlookPanel key={selected.key} account={selected.account} entryKey={selected.key} onSetup={() => setConnecting("microsoft")}
      onRemoved={() => navigate(settingsPath("accounts"), { replace: true, preventScrollReset: true })} />
  ) : selected.kind === "imap" ? (
    <ImapPanel key={selected.key} account={selected.account} entryKey={selected.key}
      onRemoved={() => navigate(settingsPath("accounts"), { replace: true, preventScrollReset: true })} />
  ) : (
    <GmailPanel key={selected.key} account={selected.account} entryKey={selected.key} onSetup={() => setConnecting("gmail")}
      onRemoved={() => navigate(settingsPath("accounts"), { replace: true, preventScrollReset: true })} />
  );

  return (
    <>
      <SectionLayout section="accounts" hasSelection={!!id} list={listView} panel={panel}
        toolbar={<>
          <ListSearch value={query} onChange={setQuery} placeholder={t("Find an account")} label={t("Find an account")} />
          <button type="button" className="fi-primary" onClick={() => setConnecting("")}><PlusIcon size={16} /> {t("Connect account")}</button>
        </>} />
      <ConnectDialog open={connecting !== null} provider={connecting || null} onChoose={(p) => setConnecting(p)}
        onClose={() => setConnecting(null)} list={domains.data} gmailState={gmailSetupState(gmail.data, gmail.error)}
        imapState={imapSetupState(gmail.data, gmail.error)} outlookState={outlookSetupState(gmail.data, gmail.error)}
        onConnected={(key) => { setConnecting(null); navigate(settingsPath("accounts", key), { replace: true, preventScrollReset: true }); }} />
    </>
  );
}

function AccountRowContent({ entry }: { entry: AccountEntry }) {
  const t = useT();
  if (entry.kind === "cloudflare") {
    const a = entry.account;
    return (
      <>
        <span className="fi-row-main">
          <span className="fi-row-title">{a.name}</span>
          <span className="fi-row-meta">{domainsText(a, t)}{a.server ? " · " + t("your server's account") : ""}</span>
        </span>
        <span className="fi-row-side">
          {a.problem ? <Badge tone="bad">{t("Problem")}</Badge> : a.shown ? null : <Badge>{t("Hidden")}</Badge>}
        </span>
      </>
    );
  }
  const a = entry.account;
  return (
    <>
      <span className="fi-row-main">
        <span className="fi-row-title">{a.email}</span>
        <span className="fi-row-meta">{a.lastSyncAt ? t("Last sync {time}", { time: t.dateTime(a.lastSyncAt) }) : t("Waiting for first sync")}</span>
      </span>
      <span className="fi-row-side"><Badge tone={gmailTone(a)}>{accountStatusText(a.status, t)}</Badge></span>
    </>
  );
}

function CloudflarePanel({ account: a, entryKey, onRemoved }: { account: CloudflareAccount; entryKey: string; onRemoved: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(entryKey);
  const choose = (shown: boolean | null) => void work.run(t("Saving…"), async () => {
    try {
      await fabric(`/api/cloudflare/accounts/${a.id}`, { shown }, "PUT");
    } finally { await refreshMail(client); }
    return shown === null ? t("{name} is back to the default: shown when it has mail.", { name: a.name })
      : shown ? t("The domains of {name} are shown.", { name: a.name }) : t("The domains of {name} are hidden.", { name: a.name });
  });
  const remove = async () => {
    const ok = await confirm({
      title: t("Remove {name} from your server?", { name: a.name }),
      body: <p>{a.relay
        ? t("Its relay Worker is deleted, and its token is deleted. Its domains are no longer listed here; connecting it again needs a new token.")
        : t("its token is deleted. Its domains are no longer listed here; connecting it again needs a new token.")}</p>,
      confirmLabel: t("Remove {name}", { name: a.name }), danger: true,
      blocked: a.served > 0 ? t.plural(a.served, { one: "Stop receiving its {n} domain here first (Domains).", other: "Stop receiving its {n} domains here first (Domains)." }) : undefined,
    });
    if (!ok) return;
    const done = await work.run(t("Removing…"), async () => {
      try {
        const r = await fabric<{ relay?: string }>(`/api/cloudflare/accounts/${a.id}`, undefined, "DELETE");
        return t("{name} was removed from your server: its token was deleted.", { name: a.name }) + (r.relay ? " " + t.text(r.relay) : "");
      } finally { await refreshMail(client); }
    });
    if (done) onRemoved();
  };
  const removable = a.via === "account" && !a.server;
  return (
    <Panel title={a.name} subtitle={a.server ? t("Your server's account") : t("Another Cloudflare account")} closeTo={settingsPath("accounts")}
      badges={<>{a.shown ? <Badge tone="ok">{t("Shown")}</Badge> : <Badge>{t("Hidden")}</Badge>}{a.relay && <Badge>{t("Relay installed")}</Badge>}</>}
      menu={removable ? <ActionMenu label={t("More actions for {name}", { name: a.name })} actions={[{ label: t("Remove {name}…", { name: a.name }), danger: true, onSelect: () => void remove() }]} /> : undefined}>
      <PanelBlock title={t("What your server sees")}>
        <p>{describeCloudflare(a, t)}.</p>
        {a.problem && <div className="fi-callout is-bad" role="alert"><p>{t.text(a.problem)}</p></div>}
        <p><Link to={settingsPath("domains")}>{t("Its domains are on Domains")}</Link>.</p>
      </PanelBlock>
      <PanelBlock title={t("Show its domains")}>
        <p className="fi-hint">{t("Accounts with mail are shown by default. A shown account's domains are listed on Domains.")}</p>
        <div className="fi-buttons">
          <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => choose(!a.shown)}
            aria-label={a.shown ? t("Hide the domains of {name}", { name: a.name }) : t("Show the domains of {name}", { name: a.name })}>{a.shown ? t("Hide") : t("Show")}</button>
          {a.choice && <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => choose(null)}>{t("Default")}</button>}
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
    </Panel>
  );
}

function GmailPanel({ account: a, entryKey, onRemoved, onSetup }: { account: Account; entryKey: string; onRemoved: () => void; onSetup: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(entryKey);
  const setup = useGmailSetup(!!a.reason);
  const retry = () => void work.run(t("Retrying…"), async () => {
    try {
      await fabric(accountPath(a.id) + "/sync", {});
      return t("{email} synced.", { email: a.email });
    } finally {
      await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
    }
  });
  const disconnect = async () => {
    const ok = await confirm({
      title: t("Disconnect {email}?", { email: a.email }),
      body: <p>{t("Its access is revoked and its cached mail leaves this app. Its mail stays in Gmail; connecting it again starts a new sync.")}</p>,
      confirmLabel: t("Disconnect {email}", { email: a.email }), danger: true,
    });
    if (!ok) return;
    const done = await work.run(t("Disconnecting…"), async () => {
      try {
        const r = await fabric<{ revoked: boolean }>(accountPath(a.id) + "/disconnect", {});
        return r.revoked ? t("{email} was disconnected.", { email: a.email }) : t("{email} was removed here. Revoke its access in your Google account too.", { email: a.email });
      } finally {
        await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
      }
    });
    if (done) onRemoved();
  };
  return (
    <Panel title={a.email} subtitle="Gmail" closeTo={settingsPath("accounts")} badges={<Badge tone={gmailTone(a)}>{accountStatusText(a.status, t)}</Badge>}
      menu={<ActionMenu label={t("More actions for {email}", { email: a.email })} actions={[{ label: t("Disconnect {email}…", { email: a.email }), danger: true, onSelect: () => void disconnect() }]} />}>
      <PanelBlock title={t("Sync")}>
        <p>{a.lastSyncAt ? t("Last sync {time}.", { time: t.dateTime(a.lastSyncAt) }) : t("Waiting for the first sync.")}</p>
        <GmailProblem account={a} projectNumber={setup.data?.projectNumber ?? null} onRetry={retry} onSetup={onSetup} busy={!!work.busy} />
        <div className="fi-buttons">
          <Link className="fi-secondary" to={"/?account=" + encodeURIComponent("gmail:" + a.id)}>{t("Open its mail")}</Link>
          <Link className="fi-secondary" to={"/automation/" + encodeURIComponent("gmail:" + a.id)}>{t("Rules and history")}</Link>
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
    </Panel>
  );
}

/** An Outlook account (SCN-058, SCN-060): its sync, why it stopped, and disconnecting it. */
function OutlookPanel({ account: a, entryKey, onRemoved, onSetup }: { account: Account; entryKey: string; onRemoved: () => void; onSetup: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(entryKey);
  const setup = useMicrosoftSetup();
  const retry = () => void work.run(t("Retrying…"), async () => {
    try {
      await fabric(accountPath(a.id) + "/sync", {});
      return t("{email} synced.", { email: a.email });
    } finally {
      await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
    }
  });
  const disconnect = async () => {
    const ok = await confirm({
      title: t("Disconnect {email}?", { email: a.email }),
      body: <p>{t("Its access is deleted from your server and its cached mail leaves this app. Its mail stays in Outlook. Microsoft has no way for an app to give its access back, so remove Fabric Inbox in your Microsoft account too; connecting it again starts a new sync.")}</p>,
      confirmLabel: t("Disconnect {email}", { email: a.email }), danger: true,
    });
    if (!ok) return;
    const help = setup.data?.help;
    const done = await work.run(t("Disconnecting…"), async () => {
      try {
        await fabric(accountPath(a.id) + "/disconnect", {});
        return help
          ? t("{email} was removed here. Remove Fabric Inbox in your Microsoft account too: {personal} for a personal account, {work} for a work or school one.",
            { email: a.email, personal: help.personalAppAccess, work: help.workAppAccess })
          : t("{email} was removed here. Remove Fabric Inbox in your Microsoft account too.", { email: a.email });
      } finally {
        await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
      }
    });
    if (done) onRemoved();
  };
  return (
    <Panel title={a.email} subtitle="Outlook" closeTo={settingsPath("accounts")} badges={<Badge tone={gmailTone(a)}>{accountStatusText(a.status, t)}</Badge>}
      menu={<ActionMenu label={t("More actions for {email}", { email: a.email })} actions={[{ label: t("Disconnect {email}…", { email: a.email }), danger: true, onSelect: () => void disconnect() }]} />}>
      <PanelBlock title={t("Sync")}>
        <p>{a.lastSyncAt ? t("Last sync {time}.", { time: t.dateTime(a.lastSyncAt) }) : t("Waiting for the first sync.")}{a.importing !== undefined ? " " + t("Importing: {percent}%.", { percent: a.importing }) : ""}</p>
        <OutlookProblem account={a} onRetry={retry} onSetup={onSetup} busy={!!work.busy} />
        <SecretExpiryNotice expiry={setup.data?.secretExpiry ?? null} />
        <div className="fi-buttons">
          <Link className="fi-secondary" to={"/?account=" + encodeURIComponent("outlook:" + a.id)}>{t("Open its mail")}</Link>
          <Link className="fi-secondary" to={"/automation/" + encodeURIComponent("outlook:" + a.id)}>{t("Rules and history")}</Link>
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
    </Panel>
  );
}

/* ------------------------------------------------------------ connecting */

function ConnectDialog({ open, provider, onChoose, onClose, list, gmailState, imapState, outlookState, onConnected }: {
  open: boolean; provider: ProviderId | null; onChoose: (p: ProviderId | "") => void; onClose: () => void;
  list?: DomainList; gmailState: ReturnType<typeof gmailSetupState>; imapState: ReturnType<typeof imapSetupState>;
  outlookState: ReturnType<typeof outlookSetupState>; onConnected: (accountKey: string) => void;
}) {
  const t = useT();
  const state = { cloudflareConnected: list ? list.connected : null, gmail: gmailState, imap: imapState, outlook: outlookState };
  const chosen = PROVIDERS.find((p) => p.id === provider) ?? null;
  const tradeoff = chosen?.tradeoff ? t("Compared with connecting through Google: {tradeoff}", { tradeoff: t.text(chosen.tradeoff) }) : null;
  return (
    <Dialog open={open} title={chosen ? t("Connect {name}", { name: t.text(chosen.name) }) : t("Connect an account")} onClose={onClose} wide>
      {!chosen ? (
        <div className="fi-provider-cards">
          {PROVIDERS.map((p) => <ProviderCard key={p.id} provider={p} state={availability(p, state)} onChoose={() => onChoose(p.id)} />)}
        </div>
      ) : chosen.id === "gmail" ? (
        <ConnectGmail state={gmailState} onBack={() => onChoose("")} onClose={onClose} />
      ) : chosen.id === "microsoft" ? (
        <ConnectOutlook state={outlookState} onBack={() => onChoose("")} onClose={onClose} />
      ) : chosen.id === "cloudflare" ? (
        <ConnectCloudflareAccount list={list} onBack={() => onChoose("")} onClose={onClose} />
      ) : chosen.connect === "app-password" && availability(chosen, state) === "available" ? (
        <>
          {tradeoff && <p className="fi-hint">{tradeoff}</p>}
          <ConnectImap fixed={chosen.preset} onBack={() => onChoose("")} onConnected={onConnected} />
        </>
      ) : chosen.connect === "app-password" ? (
        <>
          {imapState === "not-configured" ? <CreateCredentialKey onBack={() => onChoose("")} /> : (
            <>
              <p role={imapState === "loading" ? "status" : "alert"}>{imapState === "loading" ? t("Checking your server…")
                : t("Whether your server can keep IMAP accounts is unknown: the accounts did not load.")}</p>
              <div className="fi-dialog-actions"><button type="button" className="fi-secondary" data-autofocus onClick={() => onChoose("")}>{t("Back")}</button></div>
            </>
          )}
        </>
      ) : (
        <>
          <p>{t("{name} connections are not available in this build.", { name: t.text(chosen.name) })} {t.text(chosen.summary)}</p>
          {tradeoff && <p className="fi-hint">{tradeoff}</p>}
          {chosen.helpUrl && <p><a href={chosen.helpUrl} target="_blank" rel="noreferrer">{t("What it needs, on the provider's help page ↗")}</a></p>}
          <div className="fi-dialog-actions"><button type="button" className="fi-secondary" data-autofocus onClick={() => onChoose("")}>{t("Back")}</button></div>
        </>
      )}
    </Dialog>
  );
}

/**
 * A server without a credential key cannot keep an app password (SCN-053). The server makes its own
 * key and writes it into its settings (POST /api/credential-key); the dialog then waits until the
 * server reports IMAP as available, which takes a few seconds while Cloudflare applies the change.
 */
function CreateCredentialKey({ onBack }: { onBack: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const [state, setState] = useState<"idle" | "saving" | "waiting" | "failed">("idle");
  const [error, setError] = useState("");
  const create = async () => {
    setState("saving"); setError("");
    try {
      await fabric<{ created: boolean }>("/api/credential-key", {});
      setState("waiting");
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const fresh = await client.fetchQuery({ queryKey: GMAIL_KEY, queryFn: () => fabric<{ providers?: { id: string; status: string }[] }>("/api/accounts"), staleTime: 0 }).catch(() => null);
        if (fresh?.providers?.find((p) => p.id === "imap")?.status === "configured") return;
      }
      setState("failed");
      setError(t("The key was saved, but your server has not started using it yet. Close this and try again in a minute."));
    } catch (e) {
      setState("failed");
      setError(e instanceof Error ? t.text(e.message) : t("Your server could not save its credential key. Nothing was changed; try again."));
    }
  };
  return (
    <>
      <p>{t("Your server needs a credential key before it can keep an app password: it seals every saved password and token with it. Your server can make one now and keep it in its own settings; the key never leaves the server.")}</p>
      {state === "waiting" && <p role="status">{t("Key saved. Waiting for your server to start using it…")}</p>}
      {state === "failed" && <p role="alert">{error}</p>}
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={onBack}>{t("Back")}</button>
        <button type="button" className="fi-primary" data-autofocus disabled={state === "saving" || state === "waiting"} onClick={() => void create()}>
          {state === "saving" ? t("Saving…") : state === "waiting" ? t("Waiting…") : t("Make the key")}
        </button>
      </div>
    </>
  );
}

function ProviderCard({ provider, state, onChoose }: { provider: ProviderEntry; state: ReturnType<typeof availability>; onChoose: () => void }) {
  const t = useT();
  const Icon = ICONS[provider.id];
  return (
    <button type="button" className="fi-provider-card" disabled={state === "unavailable"} onClick={onChoose}
      data-autofocus={provider.id === "cloudflare" ? true : undefined}>
      <strong><Icon size={18} aria-hidden="true" /> {t.text(provider.name)}</strong>
      <span>{t.text(provider.summary)}</span>
      {AVAILABILITY_TEXT[state] && <span className="fi-hint">{t.text(AVAILABILITY_TEXT[state])}</span>}
    </button>
  );
}

/**
 * SCN-051 then SCN-002: a server without Google set up shows the setup steps; one with it set up
 * connects an account in the browser. "Use another Google client…" opens the steps again.
 */
function ConnectGmail({ state, onBack, onClose }: { state: ReturnType<typeof gmailSetupState>; onBack: () => void; onClose: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const setup = useGmailSetup(state === "configured" || state === "not-configured");
  const [replacing, setReplacing] = useState(false);
  if (state === "loading" || (state !== "unavailable" && setup.isPending))
    return <p role="status">{t("Checking Gmail setup…")}</p>;
  if (state === "unavailable" || setup.isError)
    return (
      <>
        <p role="alert">{t("Gmail setup is unknown: {reason}", { reason: setup.isError ? t.text(errorText(setup.error)) : t("the accounts did not load.") })}</p>
        <div className="fi-dialog-actions"><button type="button" className="fi-secondary" data-autofocus onClick={onBack}>{t("Back")}</button></div>
      </>
    );
  const data = setup.data!;
  if (state === "configured" && data.configured && !replacing)
    return (
      <>
        <GmailConnectStep setup={data} onReplace={() => setReplacing(true)} />
        <div className="fi-dialog-actions"><button type="button" className="fi-secondary" onClick={onBack}>{t("Back")}</button></div>
      </>
    );
  return (
    <>
      <GmailSetupWizard setup={data} onSaved={() => { setReplacing(false); void client.invalidateQueries({ queryKey: GMAIL_KEY }); }} />
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={replacing ? () => setReplacing(false) : onBack}>{t("Back")}</button>
        <button type="button" className="fi-secondary" onClick={onClose}>{t("Later")}</button>
      </div>
    </>
  );
}

/**
 * SCN-057, SCN-058: a server without Microsoft set up shows the app registration steps; one with it set up
 * connects an account in the browser. "Use another client secret…" opens the steps again (a secret
 * that ends, or one that leaked, is replaced the same way).
 */
function ConnectOutlook({ state, onBack, onClose }: { state: ReturnType<typeof outlookSetupState>; onBack: () => void; onClose: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const setup = useMicrosoftSetup(state === "configured" || state === "not-configured");
  const [replacing, setReplacing] = useState(false);
  if (state === "loading" || (state !== "unavailable" && setup.isPending))
    return <p role="status">{t("Checking the Outlook setup…")}</p>;
  if (state === "unavailable" || setup.isError)
    return (
      <>
        <p role="alert">{t("The Outlook setup is unknown: {reason}", { reason: setup.isError ? t.text(errorText(setup.error)) : t("the accounts did not load.") })}</p>
        <div className="fi-dialog-actions"><button type="button" className="fi-secondary" data-autofocus onClick={onBack}>{t("Back")}</button></div>
      </>
    );
  const data = setup.data!;
  if (state === "configured" && data.configured && !replacing)
    return (
      <>
        <OutlookConnectStep setup={data} onReplace={() => setReplacing(true)} />
        <div className="fi-dialog-actions"><button type="button" className="fi-secondary" onClick={onBack}>{t("Back")}</button></div>
      </>
    );
  return (
    <>
      <OutlookSetupWizard setup={data} onSaved={() => { setReplacing(false); void client.invalidateQueries({ queryKey: GMAIL_KEY }); void client.invalidateQueries({ queryKey: MICROSOFT_SETUP_KEY }); }} />
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={replacing ? () => setReplacing(false) : onBack}>{t("Back")}</button>
        <button type="button" className="fi-secondary" onClick={onClose}>{t("Later")}</button>
      </div>
    </>
  );
}

/** SCN-046: a token for one more account, checked and kept on the server; never shown again. */
function ConnectCloudflareAccount({ list, onBack, onClose }: { list?: DomainList; onBack: () => void; onClose: () => void }) {
  const t = useT();
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
        <p>{t("Your server has no Cloudflare token of its own yet. Connect your own Cloudflare account first; then other accounts can be added here.")}</p>
        <div className="fi-dialog-actions">
          <button type="button" className="fi-secondary" onClick={onBack}>{t("Back")}</button>
          <Link className="fi-primary" to={settingsPath("domains", "connect")} onClick={onClose}>{t("How to connect Cloudflare")}</Link>
        </div>
      </>
    );
  }

  async function connect() {
    setWorking(true); setResult(null);
    try {
      const r = await fabric<{ connected: { id: string; name: string }[]; skipped: { name: string; reason: string }[]; failed?: { name: string; reason: string }[] }>("/api/cloudflare/accounts", { token });
      setToken("");
      const failed = (r.failed ?? []).map((f) => `${f.name}: ${t.text(f.reason)}`).join("; ");
      if (!r.connected.length) {
        setResult({ tone: "alert", text: failed ? t("Not connected. {failed}", { failed })
          : t("Nothing new to connect: {accounts}.", { accounts: r.skipped.map((s) => `${s.name} (${t.text(s.reason)})`).join("; ") }) });
        return;
      }
      const names = r.connected.map((a) => a.name).join(", ");
      const also = failed ? " " + t("Not connected: {failed}.", { failed }) : "";
      setResult({ tone: "status", text: t("Connected {names}. Your server starts using the token within a few seconds…", { names }) + also });
      // A saved token is a new version of the server: read the accounts again until each account is
      // reached with its own token. A read that fails while the new version starts is not the answer.
      for (let attempt = 0; attempt < 10 && alive.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (!alive.current) return;
        const fresh = await client.fetchQuery({ queryKey: DOMAINS_KEY, queryFn: () => fabric<DomainList>("/api/domains"), staleTime: 0 }).catch(() => null);
        if (fresh && r.connected.every((c) => fresh.accounts.some((a) => a.id === c.id && a.via === "account" && !a.problem))) {
          setResult({ tone: "status", text: t("Connected {names}. Its domains with mail are listed on Domains.", { names }) + also });
          return;
        }
      }
      if (alive.current) setResult({ tone: "alert", text: t("Connected {names}, but your server has not started using the token yet. Reload this page in a minute.", { names }) + also });
    } catch (error) {
      setResult({ tone: "alert", text: t.text(errorText(error)) });
      field.current?.focus();
    } finally { if (alive.current) setWorking(false); }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void connect(); }}>
      <ol>
        <li>{t.rich("In Cloudflare, open the other account and create a token there: {account}, or {profile}. Choose {create}.", {
          account: <strong key="account">{CLOUDFLARE_NAMES.accountTokens}</strong>,
          profile: <a key="profile" href={TOKEN_PAGE} target="_blank" rel="noreferrer">{CLOUDFLARE_NAMES.profileTokens}</a>,
          create: <strong key="create">{CLOUDFLARE_NAMES.customToken}</strong> })}</li>
        <li>{t.rich("Add these permissions, and under Account and Zone resources choose that account and {all}:", {
          all: <strong key="all">{CLOUDFLARE_NAMES.allZones}</strong> })}
          {list ? <PermissionTable permissions={list.accountPermissions} /> : <p role="status" className="fi-hint">{t("Loading the permissions…")}</p>}
        </li>
        <li>{t("Paste the token here. Your server keeps it as its own secret; it is not shown again.")}</li>
      </ol>
      <label className="fi-field">{t("Token")}
        <input ref={field} data-autofocus className="fi-input" type="password" autoComplete="off" spellCheck={false} required
          value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      {result && <p className={"fi-action-result" + (result.tone === "alert" ? " is-error" : "")} role={result.tone}>{result.text}</p>}
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={onBack} disabled={working}>{t("Back")}</button>
        <button type="submit" className="fi-primary" disabled={working || !token.trim()}>{working ? t("Connecting…") : t("[action] Connect")}</button>
      </div>
    </form>
  );
}
