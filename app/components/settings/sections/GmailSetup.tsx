/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so tests/gmail-setup-ui.test.ts (tsx) renders this file as the app does.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fabric, type Account } from "../../../services/fabric";
import { GMAIL_REASON_TEXT, gmailApiUrl, gmailReason } from "../../../../shared/mail/gmail-reasons";
import type { T } from "../../../../shared/i18n";
import { useT } from "../../../lib/i18n";
import { errorText } from "../ui";

/**
 * Gmail on this server (SCN-051, SCN-002, SCN-003): the step-by-step setup in Google Cloud when the
 * server has no Google client yet, the connect step once it has, and what a connected account that
 * stopped working needs. The server checks the client with Google and writes its own settings
 * (workers/routes/gmail-setup.ts); this screen only shows the values and carries the two pasted ones.
 */

export const GMAIL_CONNECT = "/api/accounts/gmail/connect";
export const GMAIL_SETUP_KEY = ["gmail-setup"];

/**
 * A sign-in link for the system browser, which has none of this app's cookies: in Russian it says
 * its language (`?lang=ru`) so the server's pages after the sign-in speak it; English stays bare.
 */
export const connectHref = (path: string, t: T) => (t.locale === "en" ? path : `${path}?lang=${t.locale}`);

export interface Check { id: string; status: "ok" | "failed" | "unknown"; message: string; fix?: string; link?: string }
export interface GmailSetup {
  configured: boolean;
  missing: string[];
  values: { appName: string; origin: string; redirectUri: string; authorizedDomain: string; scope: string };
  clientId: string | null;
  projectNumber: string | null;
  credentialKey: "present" | "missing";
  publicAppUrl: string | null;
  addressMatches: boolean | null;
  canSave: boolean;
  cannotSave?: string;
  links: Record<"createProject" | "gmailApi" | "overview" | "branding" | "audience" | "dataAccess" | "clients" | "createClient", string>;
  help: Record<"testingExpiry" | "personalUse" | "restrictedScope" | "appPasswords", string>;
}

export const useGmailSetup = (enabled = true) => useQuery({
  queryKey: GMAIL_SETUP_KEY, enabled, staleTime: 30_000,
  queryFn: () => fabric<GmailSetup>("/api/gmail-setup"),
});

/**
 * Google Cloud's own names for the places and choices the person clicks: they stay exactly as
 * Google shows them, in every language of this app, so the person finds them on Google's pages.
 */
const GOOGLE_NAMES = {
  gmailApi: "Gmail API", branding: "Branding", audience: "Audience", internal: "Internal", external: "External",
  publishApp: "Publish app", dataAccess: "Data Access", createClient: "Create client", webApplication: "Web application",
} as const;
/** The shape of a client ID, as an example in its field. */
const CLIENT_ID_EXAMPLE = "…apps.googleusercontent.com";

const isDesktop = () => typeof window !== "undefined" && !!(window as { fabricDesktop?: unknown }).fabricDesktop;

function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children} ↗</a>;
}

/**
 * A sentence the server built from its checks (each check's message and fix, joined) in the
 * interface's language: the whole sentence when the dictionary knows it, else each check's own words
 * translated where they stand. English comes back unchanged.
 */
export function checkedText(text: string, checks: readonly Check[] | undefined, t: T): string {
  const whole = t.text(text);
  if (whole !== text || !checks?.length) return whole;
  let out = text;
  for (const c of checks) for (const part of [c.message, c.fix]) if (part) out = out.replace(part, () => t.text(part));
  return out;
}

/** A failed request's words (with the checks it carried), in the interface's language. */
export function failureText(error: unknown, t: T): string {
  return checkedText(errorText(error), (error as { body?: { checks?: Check[] } } | null)?.body?.checks, t);
}

/** A value the person copies into Google Cloud, with a Copy button that says whether it worked. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [state, setState] = useState<"" | "copied" | "failed">("");
  const copy = () => {
    const done = navigator.clipboard?.writeText(value);
    if (!done) { setState("failed"); return; }
    void done.then(() => setState("copied"), () => setState("failed"));
  };
  return (
    <span className="fi-copy-value">
      <span className="fi-hint">{label}</span>
      <code>{value}</code>
      <button type="button" className="fi-text-button" onClick={copy} aria-label={t("Copy {label}", { label })}>
        {state === "copied" ? t("Copied") : t("Copy")}
      </button>
      {state === "failed" && <span className="fi-hint" role="status">{t("Copying is blocked here: select the text and copy it.")}</span>}
    </span>
  );
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
          {c.link && <> <External href={c.link}>{t("Open in Google Cloud")}</External></>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The setup itself: seven steps in Google Cloud, each with its page and the exact values, then the
 * client ID and secret pasted here. Shown when Gmail is not set up, and again to replace a client.
 */
export function GmailSetupWizard({ setup, onSaved }: { setup: GmailSetup; onSaved: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [working, setWorking] = useState<"" | "saving" | "starting">("");
  const [result, setResult] = useState<{ tone: "status" | "alert"; text: string; checks?: Check[] } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const v = setup.values;
  const l = setup.links;

  async function save() {
    setWorking("saving"); setResult(null);
    try {
      const r = await fabric<{ keyCreated: boolean; checks: Check[]; warning?: string }>("/api/gmail-setup", { clientId, clientSecret: secret }, "PUT");
      setSecret("");
      setWorking("starting");
      const kept = r.keyCreated ? " " + t("The server made its own key to keep each account's access sealed.") : "";
      const left = r.warning ? " " + t("One thing is left: {warning}", { warning: checkedText(r.warning, r.checks, t) }) : "";
      setResult({ tone: r.warning ? "alert" : "status", text: `${t("Saved.")}${kept} ${t("Your server starts using it within a few seconds…")}${left}`, checks: r.checks });
      // The settings are a new version of the server: read until it answers with them.
      for (let attempt = 0; attempt < 10 && alive.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (!alive.current) return;
        const fresh = await client.fetchQuery({ queryKey: GMAIL_SETUP_KEY, queryFn: () => fabric<GmailSetup>("/api/gmail-setup"), staleTime: 0 }).catch(() => null);
        if (fresh?.configured) {
          if (alive.current) onSaved();
          return;
        }
      }
      if (alive.current) setResult({ tone: "alert", text: t("Saved, but your server has not started using the Gmail settings yet. Reload this page in a minute."), checks: r.checks });
    } catch (error) {
      const body = (error as { body?: { checks?: Check[] } }).body;
      setResult({ tone: "alert", text: failureText(error, t), checks: body?.checks });
      field.current?.focus();
    } finally { if (alive.current) setWorking(""); }
  }

  return (
    <form className="fi-gmail-setup" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p>{t("Gmail is connected through a Google Cloud app of your own, so your mail goes only between Google and your server. Setting it up takes about ten minutes, once; then every Gmail account is connected with a sign-in.")}</p>
      {!setup.canSave && setup.cannotSave && <div className="fi-callout is-warn" role="status"><p>{t.text(setup.cannotSave)}</p></div>}
      <ol className="fi-setup-steps">
        <li>
          {t.rich("{title} {link}. Any name; use it only for Fabric Inbox.", {
            title: <strong key="title">{t("Create a project.")}</strong>,
            link: <External key="link" href={l.createProject}>{t("New project in Google Cloud")}</External> })}
        </li>
        <li>
          {t.rich("{title} {link}, check that your new project is selected at the top, and choose Enable.", {
            title: <strong key="title">{t("Turn on the Gmail API.")}</strong>,
            link: <External key="link" href={l.gmailApi}>{GOOGLE_NAMES.gmailApi}</External> })}
        </li>
        <li>
          {t.rich("{title} {link} (choose Get started if Google asks): the app name and your email as the support email, then under Authorized domains add this server's domain.", {
            title: <strong key="title">{t("Describe the app.")}</strong>,
            link: <External key="link" href={l.branding}>{GOOGLE_NAMES.branding}</External> })}
          <CopyValue label={t("App name")} value={v.appName} />
          <CopyValue label={t("Authorized domain")} value={v.authorizedDomain} />
        </li>
        <li>
          {t.rich("{title} {link}:", {
            title: <strong key="title">{t("Choose who can connect.")}</strong>,
            link: <External key="link" href={l.audience}>{GOOGLE_NAMES.audience}</External> })}
          <ul>
            <li>{t.rich("A Google Workspace account (your company's): choose {internal}.", { internal: <strong key="internal">{GOOGLE_NAMES.internal}</strong> })}</li>
            <li>{t.rich("A personal Gmail account: choose {external}, then {publish}.", { external: <strong key="external">{GOOGLE_NAMES.external}</strong>, publish: <strong key="publish">{GOOGLE_NAMES.publishApp}</strong> })}</li>
          </ul>
          <p className="fi-hint">{t.rich("Why: Google ends a Testing app's access after 7 days, and the account would need connecting again every week ({expiry}). Your own app with fewer than 100 users needs no verification ({personal}); when you connect, Google says it “hasn't verified this app”: choose Advanced, then continue.", {
            expiry: <External key="expiry" href={setup.help.testingExpiry}>Google</External>,
            personal: <External key="personal" href={setup.help.personalUse}>Google</External> })}</p>
        </li>
        <li>
          {t.rich("{title} {link} → Add or remove scopes → add this scope by hand, then Update and Save.", {
            title: <strong key="title">{t("Allow Gmail.")}</strong>,
            link: <External key="link" href={l.dataAccess}>{GOOGLE_NAMES.dataAccess}</External> })}
          <CopyValue label={t("Scope")} value={v.scope} />
          <p className="fi-hint">{t.rich("Google lists it as restricted ({link}); that limits apps published to the public, not your own.", {
            link: <External key="link" href={setup.help.restrictedScope}>Google</External> })}</p>
        </li>
        <li>
          {t.rich("{title} {link}: type {type}, any name, and under Authorized redirect URIs add exactly:", {
            title: <strong key="title">{t("Create the OAuth client.")}</strong>,
            link: <External key="link" href={l.createClient}>{GOOGLE_NAMES.createClient}</External>,
            type: <strong key="type">{GOOGLE_NAMES.webApplication}</strong> })}
          <CopyValue label={t("Redirect URI")} value={v.redirectUri} />
          {t("Then Create; Google shows the client ID and the client secret.")}
        </li>
        <li>
          {t.rich("{title} Your server checks them with Google and keeps them in its own settings; the secret is never shown again.", {
            title: <strong key="title">{t("Paste them here.")}</strong> })}
          <label className="fi-field">{t("Client ID")}
            <input ref={field} className="fi-input" autoComplete="off" spellCheck={false} required placeholder={CLIENT_ID_EXAMPLE}
              value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!!working} />
          </label>
          <label className="fi-field">{t("Client secret")}
            <input className="fi-input" type="password" autoComplete="off" spellCheck={false} required
              value={secret} onChange={(e) => setSecret(e.target.value)} disabled={!!working} />
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
        <button type="submit" className="fi-primary" disabled={!!working || !setup.canSave || !clientId.trim() || !secret.trim()}>
          {working === "saving" ? t("Checking with Google…") : working === "starting" ? t("Starting…") : t("Save and check")}
        </button>
      </div>
    </form>
  );
}

/** The connect step, once Gmail is set up: what happens in the browser, said before it happens. */
export function GmailConnectStep({ setup, onReplace }: { setup?: GmailSetup; onReplace: () => void }) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; checks: Check[] } | { error: string } | null>(null);
  async function runCheck() {
    setChecking(true); setCheck(null);
    try { setCheck(await fabric<{ ok: boolean; checks: Check[] }>("/api/gmail-setup/check")); }
    catch (error) { setCheck({ error: t.text(errorText(error)) }); }
    finally { setChecking(false); }
  }
  return (
    <>
      <p>{t("Google's sign-in opens in your browser: Google does not allow it inside apps. Choose the Google account, tick the Gmail box, and allow access. The account appears here when the browser says it is connected.")}</p>
      {isDesktop() && (
        <div className="fi-callout" role="note">
          <p>{t.rich("{first} with a code Cloudflare emails you, as this app did. It is the same server; after that, Google's page follows.", {
            first: <strong key="first">{t("The first time, your browser asks you to sign in to your server")}</strong> })}</p>
        </div>
      )}
      {setup?.addressMatches === false && (
        <div className="fi-callout is-warn" role="alert"><p>{t("Gmail is set up for {address}; connecting works only there. Open the app at that address, or set Gmail up again from here.", { address: setup.publicAppUrl ?? "" })}</p></div>
      )}
      {check && ("error" in check
        ? <p className="fi-action-result is-error" role="alert">{check.error}</p>
        : <div className="fi-action-result" role="status"><p>{check.ok ? t("Google accepts this server's client and redirect URI.") : t("Something in the setup needs attention:")}</p><Checks checks={check.checks} /></div>)}
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={() => void runCheck()} disabled={checking}>{checking ? t("Checking with Google…") : t("Check the setup")}</button>
        <button type="button" className="fi-secondary" onClick={onReplace}>{t("Use another Google client…")}</button>
        <a className="fi-primary" data-autofocus href={connectHref(GMAIL_CONNECT, t)} target="_blank" rel="noreferrer">{t("Connect Gmail in browser ↗")}</a>
      </div>
    </>
  );
}

/**
 * Why a connected account stopped working, and the one action that fixes it (SCN-003): reconnect,
 * switch the Gmail API on and retry, or fix the server's setup.
 */
export function GmailProblem({ account, projectNumber, onRetry, onSetup, busy }: {
  account: Account; projectNumber: string | null; onRetry: () => void; onSetup: () => void; busy: boolean;
}) {
  const t = useT();
  const reason = gmailReason(account);
  const until = account.accessUntil && account.accessUntil > Date.now() ? new Date(account.accessUntil) : null;
  if (!reason && !account.error && !until) return null;
  if (!reason && !account.error && until)
    return (
      <div className="fi-callout is-warn" role="note">
        <p>{t("Google ends this access on {date}: {why}", { date: t.dateTime(until), why: t.text(GMAIL_REASON_TEXT.testing_expiry.explain) })}</p>
        <p>{t("Publish the app in Google Cloud → Audience, then reconnect it, and it will last.")}</p>
      </div>
    );
  return (
    <div className="fi-callout is-bad" role="alert">
      {reason ? (<><p>{t.text(reason.explain)}</p><p>{t.text(reason.fix)}</p></>)
        : <p>{account.status === "reconnect_required" ? t("Google no longer accepts this account's access. Reconnect it.") : t("The last sync failed ({error}). It is tried again on its own.", { error: account.error ?? "" })}</p>}
      <div className="fi-buttons">
        {(!reason || reason.action === "reconnect") && account.status === "reconnect_required" && (
          <a className="fi-primary" href={connectHref(GMAIL_CONNECT, t)} target="_blank" rel="noreferrer">{t("Reconnect in browser ↗")}</a>
        )}
        {reason?.action === "enable_api" && (
          <>
            <a className="fi-primary" href={gmailApiUrl(projectNumber)} target="_blank" rel="noreferrer">{t("Enable the Gmail API ↗")}</a>
            <button type="button" className="fi-secondary" onClick={onRetry} disabled={busy}>{t("Retry")}</button>
          </>
        )}
        {reason?.action === "setup" && <button type="button" className="fi-primary" onClick={onSetup}>{t("Check the Gmail setup")}</button>}
        {!reason && account.status !== "reconnect_required" && <button type="button" className="fi-secondary" onClick={onRetry} disabled={busy}>{t("Retry now")}</button>}
      </div>
    </div>
  );
}
