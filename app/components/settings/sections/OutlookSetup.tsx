/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so tests/outlook-setup-ui.test.ts (tsx) renders this file as the app does.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fabric, type Account } from "../../../services/fabric";
import { gmailReason } from "../../../../shared/mail/gmail-reasons";
import { OUTLOOK_CONNECT_PATH, type SecretExpiry } from "../../../../shared/mail/microsoft-setup";
import { useT } from "../../../lib/i18n";
import { errorText } from "../ui";
import { CopyValue, checkedText, connectHref, failureText } from "./GmailSetup";

/**
 * Outlook on this server (SCN-057…SCN-060): the owner's one-time app registration in
 * Microsoft Entra when the server has none yet, step by step with the exact values; the connect step
 * once it has one; and what a connected account that stopped working needs. Registering the app is
 * the owner's own act in Microsoft's portal (Microsoft offers no way to do it for them); the server
 * writes its own settings (workers/routes/microsoft-setup.ts), and this screen only shows the values
 * and carries the three pasted ones. The client secret ends on a date: the screen warns 30 days ahead.
 */

export const OUTLOOK_CONNECT = OUTLOOK_CONNECT_PATH;
export const MICROSOFT_SETUP_KEY = ["microsoft-setup"];

interface Check { id: string; status: "ok" | "failed" | "unknown"; message: string; fix?: string; link?: string }
export interface MicrosoftSetup {
  configured: boolean;
  missing: string[];
  values: { appName: string; origin: string; redirectUri: string; platform: string; accountTypes: string; permissions: string[] };
  permissions: readonly { name: string; type: string; why: string }[];
  clientId: string | null;
  secretExpiry: SecretExpiry | null;
  credentialKey: "present" | "missing";
  publicAppUrl: string | null;
  addressMatches: boolean | null;
  canSave: boolean;
  cannotSave?: string;
  adminConsentUrl?: string;
  links: { appRegistrations: string; adminCenter: string; freeAccount: string };
  help: Record<"registerApp" | "redirectUri" | "clientSecret" | "adminConsent" | "userConsent" | "permissions" | "basicAuthEnd" | "personalAppAccess" | "workAppAccess", string>;
}

export const useMicrosoftSetup = (enabled = true) => useQuery({
  queryKey: MICROSOFT_SETUP_KEY, enabled, staleTime: 30_000,
  queryFn: () => fabric<MicrosoftSetup>("/api/microsoft-setup"),
});

/**
 * Microsoft Entra's own names for the places and choices the owner clicks: they stay exactly as
 * Microsoft shows them, in every language of this app, so the owner finds them in the portal.
 */
const ENTRA_NAMES = {
  newRegistration: "New registration", delegated: "Delegated permissions", newSecret: "New client secret", value: "Value", expires: "Expires",
} as const;
/** The shape of an Application (client) ID, as an example in its field. */
const CLIENT_ID_EXAMPLE = "00000000-0000-0000-0000-000000000000";

function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children} ↗</a>;
}

function Checks({ checks }: { checks: Check[] }) {
  const t = useT();
  if (!checks.length) return null;
  return (
    <ul className="fi-checks">
      {checks.map((c, i) => (
        <li key={i} className={`is-${c.status}`}>
          <strong>{c.status === "ok" ? t("OK") : c.status === "failed" ? t("Not right") : t("Not checked")}</strong> {t.text(c.message)}
          {c.fix && <> {t.text(c.fix)}</>}
          {c.link && <> <External href={c.link}>{t("Open in Microsoft Entra")}</External></>}
        </li>
      ))}
    </ul>
  );
}

/** When the saved client secret ends, said once it is within 30 days (or past). */
export function SecretExpiryNotice({ expiry }: { expiry: SecretExpiry | null }) {
  const t = useT();
  if (!expiry || expiry.state === "ok") return null;
  return (
    <div className={"fi-callout " + (expiry.state === "expired" ? "is-bad" : "is-warn")} role="alert">
      <p>{expiry.state === "expired"
        ? t("The client secret on your server ended on {date}: Outlook accounts cannot sync until a new one is saved.", { date: expiry.date })
        : t.plural(expiry.daysLeft, {
          one: "The client secret on your server ends on {date}, in {n} day. Outlook accounts stop syncing that day.",
          other: "The client secret on your server ends on {date}, in {n} days. Outlook accounts stop syncing that day.",
        }, { date: expiry.date })}</p>
      <p>{t("In Microsoft Entra, open the app registration → Certificates & secrets → New client secret, then save its Value and date here with “Use another client secret…”.")}</p>
    </div>
  );
}

/**
 * The setup itself: the app registration in Microsoft Entra, each step with its place and the exact
 * values, then the Application (client) ID, the client secret's Value and its end date pasted here.
 */
export function OutlookSetupWizard({ setup, onSaved }: { setup: MicrosoftSetup; onSaved: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const [clientId, setClientId] = useState(setup.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [expires, setExpires] = useState("");
  const [working, setWorking] = useState<"" | "saving" | "starting">("");
  const [result, setResult] = useState<{ tone: "status" | "alert"; text: string; checks?: Check[] } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const v = setup.values;

  async function save() {
    setWorking("saving"); setResult(null);
    try {
      const r = await fabric<{ keyCreated: boolean; note: string }>("/api/microsoft-setup", { clientId, clientSecret: secret, secretExpires: expires }, "PUT");
      setSecret("");
      setWorking("starting");
      const kept = r.keyCreated ? " " + t("The server made its own key to keep each account's access sealed.") : "";
      setResult({ tone: "status", text: `${t("Saved.")}${kept} ${t.text(r.note)}` });
      // The settings are a new version of the server: read until it answers with them.
      for (let attempt = 0; attempt < 10 && alive.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (!alive.current) return;
        const fresh = await client.fetchQuery({ queryKey: MICROSOFT_SETUP_KEY, queryFn: () => fabric<MicrosoftSetup>("/api/microsoft-setup"), staleTime: 0 }).catch(() => null);
        if (fresh?.configured && fresh.clientId === clientId.trim().toLowerCase()) {
          if (alive.current) onSaved();
          return;
        }
      }
      if (alive.current) setResult({ tone: "alert", text: t("Saved, but your server has not started using the Outlook settings yet. Reload this page in a minute.") });
    } catch (error) {
      const body = (error as { body?: { checks?: Check[] } }).body;
      setResult({ tone: "alert", text: failureText(error, t), checks: body?.checks });
      field.current?.focus();
    } finally { if (alive.current) setWorking(""); }
  }

  return (
    <form className="fi-gmail-setup" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p>{t("Outlook is connected through an app registration of your own in Microsoft Entra, so your mail goes only between Microsoft and your server. Setting it up takes about ten minutes, once; then every Outlook.com, Hotmail or Microsoft 365 account is connected with a sign-in.")}</p>
      {!setup.canSave && setup.cannotSave && <div className="fi-callout is-warn" role="status"><p>{t.text(setup.cannotSave)}</p></div>}
      <ol className="fi-setup-steps">
        <li>
          {t.rich("{title} {link}, then choose {action}.", {
            title: <strong key="title">{t("Open App registrations.")}</strong>,
            link: <External key="link" href={setup.links.appRegistrations}>{t("App registrations in Microsoft Entra")}</External>,
            action: <strong key="action">{ENTRA_NAMES.newRegistration}</strong> })}
          <p className="fi-hint">{t.rich("Sign in with a work or school account that may register apps. With only a personal account (Outlook.com, Hotmail), make a {link} first: it gives your personal account a directory to register apps in.", {
            link: <External key="link" href={setup.links.freeAccount}>{t("free Azure account")}</External> })}</p>
        </li>
        <li>
          {t.rich("{title} Name it, choose who can use it, and add the redirect URI with the platform {platform}; then Register.", {
            title: <strong key="title">{t("Register the app.")}</strong>,
            platform: <strong key="platform">{v.platform}</strong> })}
          <CopyValue label={t("Name")} value={v.appName} />
          <CopyValue label={t("Supported account types")} value={v.accountTypes} />
          <CopyValue label={t("Redirect URI")} value={v.redirectUri} />
          <p className="fi-hint">{t.rich("That account type lets both personal accounts and work or school accounts connect ({link}).", {
            link: <External key="link" href={setup.help.registerApp}>Microsoft</External> })}</p>
        </li>
        <li>
          {t.rich("{title} API permissions → Add a permission → Microsoft Graph → {delegated}, then add each of these:", {
            title: <strong key="title">{t("Allow mail.")}</strong>,
            delegated: <strong key="delegated">{ENTRA_NAMES.delegated}</strong> })}
          <ul>{setup.permissions.map((p) => <li key={p.name}><code>{p.name}</code> — {t.text(p.why)}</li>)}</ul>
          <p className="fi-hint">{t.rich("None of them needs an administrator's consent ({link}). Some organizations still let only their administrators allow apps: Fabric Inbox then gives you a link to send to yours.", {
            link: <External key="link" href={setup.help.permissions}>Microsoft</External> })}</p>
        </li>
        <li>
          {t.rich("{title} Certificates & secrets → Client secrets → {action}. Choose when it expires (at most 24 months), then Add.", {
            title: <strong key="title">{t("Make a client secret.")}</strong>,
            action: <strong key="action">{ENTRA_NAMES.newSecret}</strong> })}
          <p className="fi-hint">{t.rich("Copy its {value} at once, not the Secret ID, and note the date in its {expires} column: Microsoft shows the Value only once ({link}). Fabric Inbox reminds you 30 days before it ends.", {
            value: <strong key="value">{ENTRA_NAMES.value}</strong>,
            expires: <strong key="expires">{ENTRA_NAMES.expires}</strong>,
            link: <External key="link" href={setup.help.clientSecret}>Microsoft</External> })}</p>
        </li>
        <li>
          {t.rich("{title} The Application (client) ID is on the app's Overview page. Your server keeps them in its own settings; the secret is never shown again.", {
            title: <strong key="title">{t("Paste them here.")}</strong> })}
          <label className="fi-field">{t("Application (client) ID")}
            <input ref={field} className="fi-input" autoComplete="off" spellCheck={false} required placeholder={CLIENT_ID_EXAMPLE}
              value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!!working} />
          </label>
          <label className="fi-field">{t("Client secret Value")}
            <input className="fi-input" type="password" autoComplete="off" spellCheck={false} required
              value={secret} onChange={(e) => setSecret(e.target.value)} disabled={!!working} />
          </label>
          <label className="fi-field">{t("Expires")}
            <input className="fi-input" type="date" required value={expires} onChange={(e) => setExpires(e.target.value)} disabled={!!working} />
          </label>
        </li>
      </ol>
      {result && (
        <div className={"fi-action-result" + (result.tone === "alert" ? " is-error" : "")} role={result.tone}>
          <p>{result.text}</p>
          {result.checks && <Checks checks={result.checks} />}
        </div>
      )}
      <div className="fi-dialog-actions">
        <button type="submit" className="fi-primary" disabled={!!working || !setup.canSave || !clientId.trim() || !secret.trim() || !expires}>
          {working === "saving" ? t("Saving…") : working === "starting" ? t("Starting…") : t("Save")}
        </button>
      </div>
    </form>
  );
}

/** The connect step, once Outlook is set up: what happens in the browser, said before it happens. */
export function OutlookConnectStep({ setup, onReplace }: { setup?: MicrosoftSetup; onReplace: () => void }) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; checks: Check[] } | { error: string } | null>(null);
  async function runCheck() {
    setChecking(true); setCheck(null);
    try { setCheck(await fabric<{ ok: boolean; checks: Check[] }>("/api/microsoft-setup/check")); }
    catch (error) { setCheck({ error: t.text(errorText(error)) }); }
    finally { setChecking(false); }
  }
  return (
    <>
      <p>{t("Microsoft's sign-in opens in your browser. Choose the account, read what Fabric Inbox asks for — reading, changing and sending your mail, while you are away too — and choose Accept. The account appears here when the browser says it is connected.")}</p>
      <SecretExpiryNotice expiry={setup?.secretExpiry ?? null} />
      {setup?.addressMatches === false && (
        <div className="fi-callout is-warn" role="alert"><p>{t("Outlook is set up for {address}; connecting works only there. Open the app at that address, or set Outlook up again from here.", { address: setup.publicAppUrl ?? "" })}</p></div>
      )}
      {setup?.adminConsentUrl && (
        <details className="fi-hint">
          <summary>{t("A work or school account whose organization lets only administrators allow apps")}</summary>
          <p>{t("Microsoft stops the sign-in and says an administrator must approve. Send this link to an administrator: they sign in, read what Fabric Inbox asks for, and choose Accept for the organization. Personal accounts never need it.")}</p>
          <CopyValue label={t("Link for an administrator")} value={setup.adminConsentUrl} />
        </details>
      )}
      {check && ("error" in check
        ? <p className="fi-action-result is-error" role="alert">{check.error}</p>
        : <div className="fi-action-result" role="status"><p>{check.ok ? t("Microsoft accepts this server's app registration.") : t("Something in the setup needs attention:")}</p><Checks checks={check.checks} /></div>)}
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={() => void runCheck()} disabled={checking}>{checking ? t("Checking with Microsoft…") : t("Check the setup")}</button>
        <button type="button" className="fi-secondary" onClick={onReplace}>{t("Use another client secret…")}</button>
        <a className="fi-primary" data-autofocus href={connectHref(OUTLOOK_CONNECT, t)} target="_blank" rel="noreferrer">{t("Connect Outlook in browser ↗")}</a>
      </div>
    </>
  );
}

/**
 * Why a connected Outlook account stopped working, and the one action that fixes it (SCN-060):
 * reconnect in the browser, or a new client secret saved in the setup.
 */
export function OutlookProblem({ account, onRetry, onSetup, busy }: { account: Account; onRetry: () => void; onSetup: () => void; busy: boolean }) {
  const t = useT();
  const reason = gmailReason(account);
  if (!reason && !account.error) return null;
  return (
    <div className="fi-callout is-bad" role="alert">
      {reason ? (<><p>{t.text(reason.explain)}</p><p>{t.text(reason.fix)}</p></>)
        : <p>{account.status === "reconnect_required" ? t("Microsoft no longer accepts this account's access. Reconnect it.") : t("The last sync failed ({error}). It is tried again on its own.", { error: account.error ?? "" })}</p>}
      <div className="fi-buttons">
        {(!reason || reason.action === "reconnect") && account.status === "reconnect_required" && (
          <a className="fi-primary" href={connectHref(OUTLOOK_CONNECT, t)} target="_blank" rel="noreferrer">{t("Reconnect in browser ↗")}</a>
        )}
        {reason?.action === "setup" && <button type="button" className="fi-primary" onClick={onSetup}>{t("Open the Outlook setup")}</button>}
        {!reason && account.status !== "reconnect_required" && <button type="button" className="fi-secondary" onClick={onRetry} disabled={busy}>{t("Retry now")}</button>}
      </div>
    </div>
  );
}
