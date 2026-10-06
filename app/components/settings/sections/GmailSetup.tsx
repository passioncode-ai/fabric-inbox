/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so tests/gmail-setup-ui.test.ts (tsx) renders this file as the app does.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fabric, type Account } from "../../../services/fabric";
import { GMAIL_REASON_TEXT, gmailApiUrl, gmailReason } from "../../../../shared/mail/gmail-reasons";
import { errorText } from "../ui";

/**
 * Gmail on this server (SCN-051, SCN-002, SCN-003): the step-by-step setup in Google Cloud when the
 * server has no Google client yet, the connect step once it has, and what a connected account that
 * stopped working needs. The server checks the client with Google and writes its own settings
 * (workers/routes/gmail-setup.ts); this screen only shows the values and carries the two pasted ones.
 */

export const GMAIL_CONNECT = "/api/accounts/gmail/connect";
export const GMAIL_SETUP_KEY = ["gmail-setup"];

interface Check { id: string; status: "ok" | "failed" | "unknown"; message: string; fix?: string; link?: string }
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

const isDesktop = () => typeof window !== "undefined" && !!(window as { fabricDesktop?: unknown }).fabricDesktop;

function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children} ↗</a>;
}

/** A value the person copies into Google Cloud, with a Copy button that says whether it worked. */
export function CopyValue({ label, value }: { label: string; value: string }) {
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
      <button type="button" className="fi-text-button" onClick={copy} aria-label={`Copy ${label}`}>
        {state === "copied" ? "Copied" : "Copy"}
      </button>
      {state === "failed" && <span className="fi-hint" role="status">Copying is blocked here: select the text and copy it.</span>}
    </span>
  );
}

function Checks({ checks }: { checks: Check[] }) {
  if (!checks.length) return null;
  return (
    <ul className="fi-checks">
      {checks.map((c, i) => (
        <li key={i} className={`is-${c.status}`}>
          <strong>{c.status === "ok" ? "OK" : c.status === "failed" ? "Not right" : "Not checked"}</strong> {c.message}
          {c.fix && <> {c.fix}</>}
          {c.link && <> <External href={c.link}>Open in Google Cloud</External></>}
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
      const kept = r.keyCreated ? " The server made its own key to keep each account's access sealed." : "";
      setResult({ tone: r.warning ? "alert" : "status", text: `Saved.${kept} Your server starts using it within a few seconds…${r.warning ? ` One thing is left: ${r.warning}` : ""}`, checks: r.checks });
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
      if (alive.current) setResult({ tone: "alert", text: "Saved, but your server has not started using the Gmail settings yet. Reload this page in a minute.", checks: r.checks });
    } catch (error) {
      const body = (error as { body?: { checks?: Check[] } }).body;
      setResult({ tone: "alert", text: errorText(error), checks: body?.checks });
      field.current?.focus();
    } finally { if (alive.current) setWorking(""); }
  }

  return (
    <form className="fi-gmail-setup" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p>Gmail is connected through a Google Cloud app of your own, so your mail goes only between Google and your server. Setting it up takes about ten minutes, once; then every Gmail account is connected with a sign-in.</p>
      {!setup.canSave && setup.cannotSave && <div className="fi-callout is-warn" role="status"><p>{setup.cannotSave}</p></div>}
      <ol className="fi-setup-steps">
        <li>
          <strong>Create a project.</strong> <External href={l.createProject}>New project in Google Cloud</External>. Any name; use it only for Fabric Inbox.
        </li>
        <li>
          <strong>Turn on the Gmail API.</strong> <External href={l.gmailApi}>Gmail API</External>, check that your new project is selected at the top, and choose Enable.
        </li>
        <li>
          <strong>Describe the app.</strong> <External href={l.branding}>Branding</External> (choose Get started if Google asks): the app name and your email as the support email, then under Authorized domains add this server's domain.
          <CopyValue label="App name" value={v.appName} />
          <CopyValue label="Authorized domain" value={v.authorizedDomain} />
        </li>
        <li>
          <strong>Choose who can connect.</strong> <External href={l.audience}>Audience</External>:
          <ul>
            <li>A Google Workspace account (your company's): choose <strong>Internal</strong>.</li>
            <li>A personal Gmail account: choose <strong>External</strong>, then <strong>Publish app</strong>.</li>
          </ul>
          <p className="fi-hint">Why: Google ends a Testing app's access after 7 days, and the account would need connecting again every week (<External href={setup.help.testingExpiry}>Google</External>). Your own app with fewer than 100 users needs no verification (<External href={setup.help.personalUse}>Google</External>); when you connect, Google says it “hasn't verified this app”: choose Advanced, then continue.</p>
        </li>
        <li>
          <strong>Allow Gmail.</strong> <External href={l.dataAccess}>Data Access</External> → Add or remove scopes → add this scope by hand, then Update and Save.
          <CopyValue label="Scope" value={v.scope} />
          <p className="fi-hint">Google lists it as restricted (<External href={setup.help.restrictedScope}>Google</External>); that limits apps published to the public, not your own.</p>
        </li>
        <li>
          <strong>Create the OAuth client.</strong> <External href={l.createClient}>Create client</External>: type <strong>Web application</strong>, any name, and under Authorized redirect URIs add exactly:
          <CopyValue label="Redirect URI" value={v.redirectUri} />
          Then Create; Google shows the client ID and the client secret.
        </li>
        <li>
          <strong>Paste them here.</strong> Your server checks them with Google and keeps them in its own settings; the secret is never shown again.
          <label className="fi-field">Client ID
            <input ref={field} className="fi-input" autoComplete="off" spellCheck={false} required placeholder="…apps.googleusercontent.com"
              value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!!working} />
          </label>
          <label className="fi-field">Client secret
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
          {working === "saving" ? "Checking with Google…" : working === "starting" ? "Starting…" : "Save and check"}
        </button>
      </div>
    </form>
  );
}

/** The connect step, once Gmail is set up: what happens in the browser, said before it happens. */
export function GmailConnectStep({ setup, onReplace }: { setup?: GmailSetup; onReplace: () => void }) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; checks: Check[] } | { error: string } | null>(null);
  async function runCheck() {
    setChecking(true); setCheck(null);
    try { setCheck(await fabric<{ ok: boolean; checks: Check[] }>("/api/gmail-setup/check")); }
    catch (error) { setCheck({ error: errorText(error) }); }
    finally { setChecking(false); }
  }
  return (
    <>
      <p>Google's sign-in opens in your browser: Google does not allow it inside apps. Choose the Google account, tick the Gmail box, and allow access. The account appears here when the browser says it is connected.</p>
      {isDesktop() && (
        <div className="fi-callout" role="note">
          <p><strong>The first time, your browser asks you to sign in to your server</strong> with a code Cloudflare emails you, as this app did. It is the same server; after that, Google's page follows.</p>
        </div>
      )}
      {setup?.addressMatches === false && (
        <div className="fi-callout is-warn" role="alert"><p>Gmail is set up for {setup.publicAppUrl}; connecting works only there. Open the app at that address, or set Gmail up again from here.</p></div>
      )}
      {check && ("error" in check
        ? <p className="fi-action-result is-error" role="alert">{check.error}</p>
        : <div className="fi-action-result" role="status"><p>{check.ok ? "Google accepts this server's client and redirect URI." : "Something in the setup needs attention:"}</p><Checks checks={check.checks} /></div>)}
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={() => void runCheck()} disabled={checking}>{checking ? "Checking with Google…" : "Check the setup"}</button>
        <button type="button" className="fi-secondary" onClick={onReplace}>Use another Google client…</button>
        <a className="fi-primary" data-autofocus href={GMAIL_CONNECT} target="_blank" rel="noreferrer">Connect Gmail in browser ↗</a>
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
  const reason = gmailReason(account);
  const until = account.accessUntil && account.accessUntil > Date.now() ? new Date(account.accessUntil) : null;
  if (!reason && !account.error && !until) return null;
  if (!reason && !account.error && until)
    return (
      <div className="fi-callout is-warn" role="note">
        <p>Google ends this access on {until.toLocaleString()}: {GMAIL_REASON_TEXT.testing_expiry.explain}</p>
        <p>Publish the app in Google Cloud → Audience, then reconnect it, and it will last.</p>
      </div>
    );
  return (
    <div className="fi-callout is-bad" role="alert">
      {reason ? (<><p>{reason.explain}</p><p>{reason.fix}</p></>)
        : <p>{account.status === "reconnect_required" ? "Google no longer accepts this account's access. Reconnect it." : `The last sync failed (${account.error}). It is tried again on its own.`}</p>}
      <div className="fi-buttons">
        {(!reason || reason.action === "reconnect") && account.status === "reconnect_required" && (
          <a className="fi-primary" href={GMAIL_CONNECT} target="_blank" rel="noreferrer">Reconnect in browser ↗</a>
        )}
        {reason?.action === "enable_api" && (
          <>
            <a className="fi-primary" href={gmailApiUrl(projectNumber)} target="_blank" rel="noreferrer">Enable the Gmail API ↗</a>
            <button type="button" className="fi-secondary" onClick={onRetry} disabled={busy}>Retry</button>
          </>
        )}
        {reason?.action === "setup" && <button type="button" className="fi-primary" onClick={onSetup}>Check the Gmail setup</button>}
        {!reason && account.status !== "reconnect_required" && <button type="button" className="fi-secondary" onClick={onRetry} disabled={busy}>Retry now</button>}
      </div>
    </div>
  );
}
