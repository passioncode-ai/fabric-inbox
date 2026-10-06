import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { fabric } from "~/services/fabric";
import api from "~/services/api";
import { queryKeys } from "~/queries/keys";
import { applyTheme, currentTheme, type Theme } from "~/lib/theme";
import { parseSetup, type ApplyResult, type Setup } from "../../../../shared/setup";
import { type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import { ActionResult, Badge, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList, errorText, useNotify, useWork } from "../ui";

declare global {
  interface Window {
    /** Present only in the desktop app's mail window (desktop/mail-preload.cjs). */
    fabricDesktop?: { pendingSetup(): Promise<unknown>; pendingSetupDone(): Promise<unknown> };
  }
}

const ITEMS = [
  { key: "appearance", title: "Appearance", meta: "Light or dark" },
  { key: "server", title: "Your server", meta: "Where this app's mail and agents run" },
  { key: "setup", title: "Setup", meta: "Apply, import or export a setup" },
  { key: "desktop", title: "Mac app", meta: "Updates, usage counts and the server address" },
] as const;

/**
 * Settings → App (SCR-02, SCR-11, SCN-012, SCN-028, SCN-029): the theme, the server this app
 * uses, setups, and where the Mac app's own switches are (its app menu, not here).
 */
export default function AppSection({ id }: { id: string | null }) {
  const entries: (ListEntry & { title: string; meta: string })[] = ITEMS.map((i) => ({ key: i.key, group: "app", text: i.title, title: i.title, meta: i.meta }));
  const list = (
    <SelectableList label="App settings" groups={[{ id: "app", label: "", rows: entries }]} selected={id} hrefFor={(e) => settingsPath("app", e.key)}
      renderRow={(e) => <span className="fi-row-main"><span className="fi-row-title">{e.title}</span><span className="fi-row-meta">{e.meta}</span></span>} />
  );
  const panel = !id ? (
    <PanelPlaceholder><h2>Choose what to change</h2><p>The theme, your server, setups and the Mac app.</p></PanelPlaceholder>
  ) : id === "appearance" ? <AppearancePanel /> : id === "server" ? <ServerPanel /> : id === "setup" ? <SetupPanel /> : id === "desktop" ? <DesktopPanel /> : (
    <PanelPlaceholder><h2>There is no such page</h2><Link className="fi-secondary" to={settingsPath("app")} replace>App</Link></PanelPlaceholder>
  );
  return <SectionLayout section="app" hasSelection={!!id} list={list} panel={panel} />;
}

function AppearancePanel() {
  const [theme, setTheme] = useState<Theme>("light");
  const [kept, setKept] = useState(true);
  useEffect(() => setTheme(currentTheme()), []);
  const choose = (t: Theme) => { setKept(applyTheme(t)); setTheme(t); };
  return (
    <Panel title="Appearance" closeTo={settingsPath("app")}>
      <PanelBlock>
        <fieldset>
          <legend>Theme</legend>
          <label className="fi-check"><input type="radio" name="theme" checked={theme === "light"} onChange={() => choose("light")} /><span>Light theme</span></label>
          <label className="fi-check"><input type="radio" name="theme" checked={theme === "dark"} onChange={() => choose("dark")} /><span>Dark theme</span></label>
        </fieldset>
        <p className="fi-hint">{kept ? "Kept on this device. Mail, accounts and sending do not change." : "This device could not keep the choice: it lasts until the app is closed."}</p>
      </PanelBlock>
    </Panel>
  );
}

function ServerPanel() {
  const config = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: 60_000 });
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const desktop = typeof window !== "undefined" && !!window.fabricDesktop;
  return (
    <Panel title="Your server" closeTo={settingsPath("app")}>
      <PanelBlock>
        <p>Your mail, agents and rules run on your server, a Worker in your own Cloudflare account. They keep running when this app is closed.</p>
        <ul className="fi-facts">
          <li><strong>Address</strong> <code>{origin || "…"}</code></li>
          <li><strong>Domains in its configuration</strong> {config.isPending ? "…" : config.isError ? `unknown (${errorText(config.error)})` : config.data.domains.length ? config.data.domains.join(", ") : "none — domains are chosen on Domains"}</li>
        </ul>
        <p className="fi-hint">{desktop
          ? "To open another server, choose Fabric Inbox → Server Address… in the menu bar."
          : "The Mac app chooses its server under Fabric Inbox → Server Address…."}</p>
        <div className="fi-buttons">
          <Link className="fi-secondary" to={settingsPath("domains")}>Domains</Link>
          <Link className="fi-secondary" to={settingsPath("accounts")}>Accounts</Link>
        </div>
      </PanelBlock>
    </Panel>
  );
}

function DesktopPanel() {
  const desktop = typeof window !== "undefined" && !!window.fabricDesktop;
  return (
    <Panel title="Mac app" closeTo={settingsPath("app")}>
      <PanelBlock>
        <p>{desktop ? "These switches belong to this Mac, so they live in the app menu (Fabric Inbox in the menu bar):" : "In the Mac app, these switches live in the app menu (Fabric Inbox in the menu bar), because they belong to the Mac:"}</p>
        <ul className="fi-facts">
          <li><strong>Check for Updates…</strong> looks for a newer version now.</li>
          <li><strong>Install Updates Automatically</strong> downloads a new version in the background and installs it when the app quits.</li>
          <li><strong>Share Anonymous Usage Counts</strong> and <strong>About Usage Counts…</strong> say what is counted and turn it off or on.</li>
          <li><strong>Server Address…</strong> chooses the server this app opens.</li>
          <li><strong>Connect Cloudflare account…</strong> saves your Cloudflare API token on your server.</li>
          <li><strong>Settings…</strong> (⌘,) opens this screen.</li>
        </ul>
      </PanelBlock>
    </Panel>
  );
}

type Source = "desktop" | "file" | "cloudflare";
const OUTCOME_TEXT = { created: "Created", updated: "Updated", unchanged: "Already there", refused: "Not created" } as const;

/** SCR-11: apply a setup, bring existing Cloudflare addresses in, or export the current setup. */
function SetupPanel() {
  const [params] = useSearchParams();
  const notify = useNotify();
  const work = useWork("setup");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const fromDesktop = params.get("source") === "desktop";

  useEffect(() => {
    if (!window.fabricDesktop) return;
    window.fabricDesktop.pendingSetup().then((value) => {
      if (!value) return;
      const parsed = parseSetup(value);
      if (parsed.ok) { setSetup(parsed.setup); setSource("desktop"); } else setProblems(parsed.problems);
    }).catch(() => notify("The setup chosen in the app could not be read. Open it as a file instead.", "error"));
  }, [notify]);
  // The result's heading takes the focus once, when an apply finishes (never on every render).
  useEffect(() => { if (result) resultHeading.current?.focus(); }, [result]);

  function load(value: unknown, from: Source) {
    setResult(null);
    const parsed = parseSetup(value);
    if (parsed.ok) { setSetup(parsed.setup); setSource(from); setProblems([]); } else { setSetup(null); setProblems(parsed.problems); }
  }
  async function openFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) { setProblems(["This file is too large to be a setup."]); return; }
    try { load(JSON.parse(await file.text()), "file"); } catch { setSetup(null); setProblems(["This file is not a Fabric Inbox setup (not readable JSON)."]); }
  }
  const readCloudflare = () => void work.run("Reading Cloudflare…", async () => {
    load(await fabric<unknown>("/api/setup/from-cloudflare"), "cloudflare");
    return "";
  });
  const apply = () => void work.run("Applying…", async () => {
    if (!setup) return "";
    let applied: ApplyResult;
    try { applied = await fabric<ApplyResult>("/api/setup/apply", setup); }
    catch (error) { throw new Error(`${errorText(error)} Applying the same setup again is safe.`); }
    setResult(applied);
    // Whatever the source, a successful apply ends the desktop's pending setup;
    // otherwise the app reopens this page on every launch.
    if (window.fabricDesktop) {
      try { await window.fabricDesktop.pendingSetupDone(); } catch { return "Applied. The app could not clear its saved setup; it may open this page again once."; }
    }
    const refused = applied.mailboxes.filter((m) => m.outcome === "refused").length;
    return refused ? `Setup applied, ${refused} not created.` : "Setup applied.";
  });

  const byDomain = setup?.domains.map((domain) => ({ domain, boxes: setup.mailboxes.filter((m) => m.address.endsWith("@" + domain)) })) ?? [];
  const refused = result?.mailboxes.filter((m) => m.outcome === "refused") ?? [];

  return (
    <Panel title="Setup" closeTo={settingsPath("app")}
      subtitle="A setup lists the domains this server receives mail for and the addresses on them, with where each one keeps forwarding a copy. Applying it creates what is missing and changes nothing else; it never deletes.">
      {fromDesktop && !setup && !problems.length && !result && <p role="status" className="fi-hint">Reading the setup chosen in the app…</p>}
      {!setup && !result && (
        <PanelBlock title="Load a setup">
          <div className="fi-buttons">
            <label className="fi-secondary" style={{ cursor: "pointer" }}>
              Open a setup file…
              <input type="file" accept="application/json,.json" className="fi-visually-hidden" onChange={(e) => void openFile(e.target.files?.[0])} />
            </label>
            <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={readCloudflare}>{work.busy ?? "Read from Cloudflare Email Routing"}</button>
            <a className="fi-text-button" href="/api/setup/export" download="fabric-inbox-setup.json">Export the current setup</a>
          </div>
        </PanelBlock>
      )}
      {problems.length > 0 && (
        <div role="alert" className="fi-callout is-bad">
          <p><strong>This is not a usable setup. Nothing was changed.</strong></p>
          <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {setup && !result && (
        <PanelBlock title={setup.name}>
          <p className="fi-hint">
            {source === "desktop" ? "Chosen in the app." : source === "cloudflare" ? "Read from your domains' Email Routing; routing rules are not changed." : "Opened from a file."}{" "}
            {setup.domains.length} domains, {setup.mailboxes.length} addresses.
          </p>
          <ul className="fi-plain-list">
            {byDomain.map(({ domain, boxes }) => (
              <li key={domain} style={{ display: "block" }}>
                <strong>{domain}</strong>
                {setup.catchAll.some((c) => c.domain === domain) && <span className="fi-hint"> · other addresses go to the catch-all</span>}
                <ul className="fi-hint">{boxes.map((b) => <li key={b.address}>{b.address}{b.forwardTo ? ` → a copy keeps going to ${b.forwardTo}` : ""}</li>)}</ul>
              </li>
            ))}
          </ul>
          {setup.notServed.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Stays as it is</h3>
              <ul className="fi-hint">{setup.notServed.map((n) => <li key={n.domain}><strong>{n.domain}</strong> — {n.reason}</li>)}</ul>
            </>
          )}
          <div className="fi-buttons">
            <button type="button" className="fi-primary" disabled={!!work.busy} onClick={apply}>{work.busy ?? "Apply setup"}</button>
            <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => { setSetup(null); setSource(null); }}>Choose another</button>
          </div>
        </PanelBlock>
      )}
      {result && (
        <PanelBlock>
          <h3 ref={resultHeading} tabIndex={-1}>{refused.length ? `Applied, ${refused.length} not created` : "Setup applied"}</h3>
          <p className="fi-hint">
            {result.domainsAdded.length ? `Now receiving for ${result.domainsAdded.join(", ")}. ` : ""}
            {result.catchAllSet.length ? `Catch-all set on ${result.catchAllSet.join(", ")}. ` : ""}
          </p>
          <ul className="fi-plain-list">
            {result.mailboxes.map((m) => (
              <li key={m.address}>
                <span className="fi-grow">{m.address}</span>
                {m.outcome === "refused" ? <Badge tone="bad">{OUTCOME_TEXT[m.outcome]}</Badge> : <Badge tone="ok">{OUTCOME_TEXT[m.outcome]}</Badge>}
                {m.reason && <span className="fi-hint">{m.reason}</span>}
              </li>
            ))}
          </ul>
          <div className="fi-callout">
            <p><strong>One step remains for each domain</strong></p>
            <p>Mail reaches these addresses once Cloudflare Email Routing sends it to this server. On Domains, open each domain and choose Bring them here: every address keeps forwarding a copy where its mail went before. Until then mail keeps going where it went before.</p>
          </div>
          <div className="fi-buttons">
            <Link className="fi-primary" to={settingsPath("domains")}>Go to Domains</Link>
            <Link className="fi-secondary" to="/">Open the inbox</Link>
          </div>
        </PanelBlock>
      )}
      <ActionResult result={work.result} />
    </Panel>
  );
}
