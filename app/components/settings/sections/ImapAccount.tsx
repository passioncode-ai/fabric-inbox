import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { fabric, accountPath, type Account } from "~/services/fabric";
import { useT, type T } from "~/lib/i18n";
import { CUSTOM, PRESETS, preset as findPreset, presetFor, type Preset } from "../../../../shared/mail/imap-presets";
import { imapErrorText } from "~/lib/imap-errors";
import { settingsPath } from "../paths";
import { ActionMenu, ActionResult, Badge, Panel, PanelBlock, errorText, useConfirm, useWork } from "../ui";
import { GMAIL_KEY } from "./data";
import { accountStatusText } from "./providers";

/**
 * IMAP accounts in Settings → Accounts (SCN-052…SCN-056): connecting one with an address and an
 * app password (checked with the provider's IMAP and SMTP servers before the server keeps it,
 * sealed), giving it a new password, and disconnecting it. The password goes to the server once
 * and is never shown again.
 */

/** The error code of a failed request (the server answers `{ error: "<code>" }`). */
const codeOf = (error: unknown) => {
  const body = (error as { body?: { error?: unknown } } | null)?.body;
  return typeof body?.error === "string" ? body.error : "";
};
/** The sentence for a failure, with the provider's name and servers; the server's own text when the code is unknown. */
export function connectError(error: unknown, provider: string, hosts: { imapHost?: string; smtpHost?: string } = {}, t?: T) {
  return imapErrorText(codeOf(error), { provider, ...hosts }, t) ?? (t ? t.text(errorText(error)) : errorText(error));
}

const tone = (a: Account) => (a.error ? "bad" : a.status === "connected" ? "ok" : "warn") as "bad" | "ok" | "warn";

/** The preset chooser, then the form. `fixed` is a card that is one preset (Gmail with an app password). */
export function ConnectImap({ fixed, onBack, onConnected }: { fixed?: string; onBack: () => void; onConnected: (accountKey: string) => void }) {
  const t = useT();
  const [presetId, setPresetId] = useState<string | null>(fixed ?? null);
  if (!presetId) {
    return (
      <>
        <p>{t("Choose who keeps the mail. Every one of them needs an app password: a password made for one app, which you can delete there at any time.")}</p>
        <div className="fi-provider-cards">
          {[...PRESETS.filter((p) => p.id !== "gmail"), CUSTOM].map((p) => (
            <button key={p.id} type="button" className="fi-provider-card" onClick={() => setPresetId(p.id)} data-autofocus={p.id === "icloud" ? true : undefined}>
              <strong>{t.text(p.name)}</strong>
              <span>{p.domains.length ? p.domains.join(", ") : p.id === "custom" ? t("Any provider that offers IMAP and SMTP") : t("Your own domain")}</span>
            </button>
          ))}
        </div>
        <div className="fi-dialog-actions"><button type="button" className="fi-secondary" onClick={onBack}>{t("Back")}</button></div>
      </>
    );
  }
  return <ImapForm presetId={presetId} onBack={fixed ? onBack : () => setPresetId(null)} onConnected={onConnected} />;
}

function ImapForm({ presetId, onBack, onConnected }: { presetId: string; onBack: () => void; onConnected: (accountKey: string) => void }) {
  const t = useT();
  const client = useQueryClient();
  const chosen = findPreset(presetId);
  const custom = presetId === "custom";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState({ imapHost: "", imapPort: "993", smtpHost: "", smtpSecurity: "tls" as "tls" | "starttls", smtpPort: "465", username: "" });
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const name = chosen ? t.text(chosen.name) : t("your provider");
  // An address of another provider's domain is said before connecting, not after a refused login.
  const suggested = !custom && email.includes("@") ? presetFor(email) : undefined;
  const mismatch = suggested && chosen && suggested.id !== chosen.id ? suggested : undefined;
  const steps = chosen?.steps ?? CUSTOM.steps;
  // An example address of the provider's own domain: an address reads the same in every language.
  const example = chosen?.domains[0] ? `you@${chosen.domains[0]}` : "you@example.com";

  async function connect() {
    setWorking(true); setResult(null);
    try {
      const body = custom
        ? { preset: "custom", email, password, imapHost: server.imapHost, imapPort: Number(server.imapPort) || 993, smtpHost: server.smtpHost,
            smtpPort: Number(server.smtpPort) || (server.smtpSecurity === "starttls" ? 587 : 465), smtpSecurity: server.smtpSecurity, ...(server.username.trim() ? { username: server.username.trim() } : {}) }
        : { preset: presetId, email, password };
      const account = await fabric<Account>("/api/accounts/imap", body);
      setPassword("");
      await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
      if (alive.current) onConnected(`imap:${account.id}`);
    } catch (error) {
      if (!alive.current) return;
      setResult(connectError(error, name, custom ? { imapHost: server.imapHost || undefined, smtpHost: server.smtpHost || undefined }
        : chosen ? { imapHost: chosen.imap.host, smtpHost: chosen.smtp.host } : {}, t));
      passwordField.current?.focus();
    } finally { if (alive.current) setWorking(false); }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void connect(); }}>
      <p>{t("Mail is read and sent by your server, also while this app is closed. The app password is checked with {name} now, then kept on your server, encrypted; it is not shown again.", { name })}</p>
      <ol>
        {steps.map((s) => <li key={s}>{t.text(s)}</li>)}
        <li>{t("Enter the address and paste the app password here.")}</li>
      </ol>
      {chosen?.appPasswordUrl && <p><a href={chosen.appPasswordUrl} target="_blank" rel="noreferrer">{t("How {name} makes an app password ↗", { name })}</a></p>}
      <label className="fi-field">{t("Address")}
        <input data-autofocus className="fi-input" type="email" required autoComplete="off" spellCheck={false} placeholder={example}
          value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {mismatch && <p className="fi-hint" role="status">{t("This looks like a {name} address. Go back and choose {name} if it is.", { name: t.text(mismatch.name) })}</p>}
      <label className="fi-field">{t("App password")}
        <input ref={passwordField} className="fi-input" type="password" required autoComplete="off" spellCheck={false}
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {custom && (
        <>
          <div className="fi-field-row">
            <label className="fi-field">{t("Incoming server (IMAP, SSL/TLS)")}
              <input className="fi-input" required placeholder="imap.example.com" autoComplete="off" spellCheck={false} value={server.imapHost} onChange={(e) => setServer({ ...server, imapHost: e.target.value })} />
            </label>
            <label className="fi-field">{t("Port")}
              <input className="fi-input" inputMode="numeric" value={server.imapPort} onChange={(e) => setServer({ ...server, imapPort: e.target.value })} />
            </label>
          </div>
          <div className="fi-field-row">
            <label className="fi-field">{t("Sending server (SMTP)")}
              <input className="fi-input" required placeholder="smtp.example.com" autoComplete="off" spellCheck={false} value={server.smtpHost} onChange={(e) => setServer({ ...server, smtpHost: e.target.value })} />
            </label>
            <label className="fi-field">{t("Security")}
              <select className="fi-input" value={server.smtpSecurity}
                onChange={(e) => { const v = e.target.value as "tls" | "starttls"; setServer({ ...server, smtpSecurity: v, smtpPort: v === "starttls" ? "587" : "465" }); }}>
                <option value="tls">{t("SSL/TLS (port 465)")}</option>
                <option value="starttls">{t("STARTTLS (port 587)")}</option>
              </select>
            </label>
            <label className="fi-field">{t("Port")}
              <input className="fi-input" inputMode="numeric" value={server.smtpPort} onChange={(e) => setServer({ ...server, smtpPort: e.target.value })} />
            </label>
          </div>
          <label className="fi-field">{t("User name")} <span className="fi-hint">{t("Only when the server's sign-in name is not the address.")}</span>
            <input className="fi-input" autoComplete="off" spellCheck={false} value={server.username} onChange={(e) => setServer({ ...server, username: e.target.value })} />
          </label>
        </>
      )}
      {result && (
        <div className="fi-callout is-bad" role="alert">
          <p>{result}</p>
          {chosen?.appPasswordUrl && <p><a href={chosen.appPasswordUrl} target="_blank" rel="noreferrer">{t("{name}'s help page ↗", { name })}</a></p>}
        </div>
      )}
      <div className="fi-dialog-actions">
        <button type="button" className="fi-secondary" onClick={onBack} disabled={working}>{t("Back")}</button>
        <button type="submit" className="fi-primary" disabled={working || !email.trim() || !password}>{working ? t("Checking with {name}…", { name }) : t("[action] Connect")}</button>
      </div>
    </form>
  );
}

/** One IMAP account: its sync, what it can do, a new app password, disconnect. */
export function ImapPanel({ account: a, entryKey, onRemoved }: { account: Account; entryKey: string; onRemoved: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(entryKey);
  const [changing, setChanging] = useState(a.status === "reconnect_required");
  const p: Preset | undefined = findPreset(a.preset);
  const name = t.text(a.providerName ?? p?.name ?? "IMAP");
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
  const retry = () => void work.run(t("Syncing…"), async () => {
    try { await fabric(accountPath(a.id) + "/sync", {}); return t("{email} synced.", { email: a.email }); }
    catch (error) { throw new Error(connectError(error, name, {}, t)); }
    finally { await refresh(); }
  });
  const disconnect = async () => {
    const ok = await confirm({
      title: t("Disconnect {email}?", { email: a.email }),
      body: <p>{t("Its app password is deleted from your server and its mail synced here leaves this app. Its mail stays with {name}. To end the app password itself, delete it in your {name} account.", { name })}</p>,
      confirmLabel: t("Disconnect {email}", { email: a.email }), danger: true,
    });
    if (!ok) return;
    const done = await work.run(t("Disconnecting…"), async () => {
      try {
        await fabric(accountPath(a.id) + "/disconnect", {});
        return t("{email} was disconnected. Delete its app password at {name} too.", { email: a.email, name });
      } finally { await refresh(); }
    });
    if (done) onRemoved();
  };
  const caps = a.capabilities;
  const missing = caps ? [!caps.archive && t("Archive"), !caps.spam && t("Report spam"), !caps.drafts && t("drafts kept at the provider")].filter(Boolean) as string[] : [];
  const unknown = t("unknown");
  return (
    <Panel title={a.email} subtitle={name} closeTo={settingsPath("accounts")} badges={<Badge tone={tone(a)}>{accountStatusText(a.status, t)}</Badge>}
      menu={<ActionMenu label={t("More actions for {email}", { email: a.email })} actions={[
        { label: t("Enter a new app password…"), onSelect: () => setChanging(true) },
        { label: t("Disconnect {email}…", { email: a.email }), danger: true, onSelect: () => void disconnect() },
      ]} />}>
      <PanelBlock title={t("Sync")}>
        <p>{a.lastSyncAt ? t("Last sync {time}.", { time: t.dateTime(a.lastSyncAt) }) : t("Waiting for the first sync.")}
          {a.status === "syncing" && typeof a.importing === "number" ? " " + t("Older mail is being read: {percent}%. New mail already arrives.", { percent: a.importing }) : ""}</p>
        {a.status === "reconnect_required" ? (
          <div className="fi-callout is-bad" role="alert"><p>{imapErrorText("reconnect_required", { provider: name }, t)}</p></div>
        ) : a.error ? (
          <div className="fi-callout" role="status">
            <p>{imapErrorText(a.error, { provider: name, imapHost: a.server?.imap.host, smtpHost: a.server?.smtp.host }, t) ?? t("The last sync failed ({error}). It is tried again on its own.", { error: a.error })}</p>
            <div className="fi-buttons"><button type="button" className="fi-secondary" disabled={!!work.busy} onClick={retry}>{t("Retry now")}</button></div>
          </div>
        ) : null}
        <div className="fi-buttons">
          <Link className="fi-secondary" to={"/?account=" + encodeURIComponent("imap:" + a.id)}>{t("Open its mail")}</Link>
          <Link className="fi-secondary" to={"/automation/" + encodeURIComponent("imap:" + a.id)}>{t("Rules and history")}</Link>
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
      {changing && <NewPassword account={a} name={name} helpUrl={p?.appPasswordUrl} onDone={() => setChanging(false)} />}
      <PanelBlock title={t("Servers")}>
        <p>{t("Incoming: {imap} (SSL/TLS, port {imapPort}). Sending: {smtp} ({security}, port {smtpPort}).", {
          imap: a.server?.imap.host ?? unknown, imapPort: a.server?.imap.port ?? 993,
          smtp: a.server?.smtp.host ?? unknown, security: a.server?.smtp.security === "starttls" ? "STARTTLS" : "SSL/TLS", smtpPort: a.server?.smtp.port ?? 465,
        })}</p>
        {missing.length > 0 && <p className="fi-hint">{t("This account's server has no folder for {list}, so the app does not offer it here.", { list: t.list(missing) })}</p>}
        {caps?.organization === "folders" && <p className="fi-hint">{t("Folders are read by their role: Inbox, Sent, Drafts, Trash, Spam and Archive.")}</p>}
      </PanelBlock>
    </Panel>
  );
}

function NewPassword({ account: a, name, helpUrl, onDone }: { account: Account; name: string; helpUrl?: string; onDone: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  async function save() {
    setWorking(true); setResult(null);
    try {
      await fabric(accountPath(a.id) + "/password", { password }, "PUT");
      setPassword("");
      setResult({ tone: "status", text: t("{name} took the new app password. Mail is read again now.", { name }) });
      await Promise.all([client.invalidateQueries({ queryKey: GMAIL_KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);
    } catch (error) {
      setResult({ tone: "alert", text: connectError(error, name, { imapHost: a.server?.imap.host, smtpHost: a.server?.smtp.host }, t) });
    } finally { setWorking(false); }
  }
  return (
    <PanelBlock title={t("New app password")}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="fi-hint">{t("It is checked with {name} first; the one your server has now stays until the new one works.", { name })}</p>
        {helpUrl && <p><a href={helpUrl} target="_blank" rel="noreferrer">{t("How {name} makes an app password ↗", { name })}</a></p>}
        <label className="fi-field">{t("App password")}
          <input className="fi-input" type="password" required autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {result && <p className={"fi-action-result" + (result.tone === "alert" ? " is-error" : "")} role={result.tone}>{result.text}</p>}
        <div className="fi-buttons">
          <button type="submit" className="fi-primary" disabled={working || !password}>{working ? t("Checking with {name}…", { name }) : t("Save")}</button>
          <button type="button" className="fi-secondary" onClick={onDone} disabled={working}>{t("Close")}</button>
        </div>
      </form>
    </PanelBlock>
  );
}
