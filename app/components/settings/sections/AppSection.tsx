import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { fabric } from "~/services/fabric";
import api from "~/services/api";
import { queryKeys } from "~/queries/keys";
import { applyTheme, currentTheme, type Theme } from "~/lib/theme";
import { saveLocaleChoice, useLocale, useT, type LocaleChoice } from "~/lib/i18n";
import { detectLocale, msg } from "../../../../shared/i18n";
import { parseSetup, type ApplyResult, type Setup } from "../../../../shared/setup";
import { type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import { ActionResult, Badge, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList, errorText, useNotify, useWork } from "../ui";

const ITEMS = [
  { key: "appearance", title: msg("Appearance"), meta: msg("Light or dark") },
  { key: "language", title: msg("Language"), meta: msg("System, English or Русский") },
  { key: "server", title: msg("Your server"), meta: msg("Where this app's mail and agents run") },
  { key: "setup", title: msg("Setup"), meta: msg("Apply, import or export a setup") },
  { key: "desktop", title: msg("Mac app"), meta: msg("Updates, usage counts and the server address") },
] as const;

/**
 * Settings → App (SCR-02, SCR-11, SCN-012, SCN-028, SCN-029, SCN-076): the theme, the language,
 * the server this app uses, setups, and where the Mac app's own switches are (its app menu, not
 * here).
 */
export default function AppSection({ id }: { id: string | null }) {
  const t = useT();
  const entries: (ListEntry & { title: string; meta: string })[] = ITEMS.map((i) => ({ key: i.key, group: "app", text: t.text(i.title), title: t.text(i.title), meta: t.text(i.meta) }));
  const list = (
    <SelectableList label={t("App settings")} groups={[{ id: "app", label: "", rows: entries }]} selected={id} hrefFor={(e) => settingsPath("app", e.key)}
      renderRow={(e) => <span className="fi-row-main"><span className="fi-row-title">{e.title}</span><span className="fi-row-meta">{e.meta}</span></span>} />
  );
  const panel = !id ? (
    <PanelPlaceholder><h2>{t("Choose what to change")}</h2><p>{t("The theme, the language, your server, setups and the Mac app.")}</p></PanelPlaceholder>
  ) : id === "appearance" ? <AppearancePanel /> : id === "language" ? <LanguagePanel /> : id === "server" ? <ServerPanel /> : id === "setup" ? <SetupPanel /> : id === "desktop" ? <DesktopPanel /> : (
    <PanelPlaceholder><h2>{t("There is no such page")}</h2><Link className="fi-secondary" to={settingsPath("app")} replace>{t("App")}</Link></PanelPlaceholder>
  );
  return <SectionLayout section="app" hasSelection={!!id} list={list} panel={panel} />;
}

function AppearancePanel() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>("light");
  const [kept, setKept] = useState(true);
  useEffect(() => setTheme(currentTheme()), []);
  const choose = (next: Theme) => { setKept(applyTheme(next)); setTheme(next); };
  return (
    <Panel title={t("Appearance")} closeTo={settingsPath("app")}>
      <PanelBlock>
        <fieldset>
          <legend>{t("Theme")}</legend>
          <label className="fi-check"><input type="radio" name="theme" checked={theme === "light"} onChange={() => choose("light")} /><span>{t("Light theme")}</span></label>
          <label className="fi-check"><input type="radio" name="theme" checked={theme === "dark"} onChange={() => choose("dark")} /><span>{t("Dark theme")}</span></label>
        </fieldset>
        <p className="fi-hint">{kept ? t("Kept on this device. Mail, accounts and sending do not change.") : t("This device could not keep the choice: it lasts until the app is closed.")}</p>
      </PanelBlock>
    </Panel>
  );
}

/**
 * SCN-076: the interface's language. System follows the device (its first preferred language:
 * Russian for ru and ru-*, English otherwise); a choice is kept on this device, mirrored for the
 * server and the Mac app's menus, and the page reloads to show it (L10N-01). Language names are
 * written in their own language, as every system's language list does.
 */
function LanguagePanel() {
  const t = useT();
  const { choice } = useLocale();
  const [selected, setSelected] = useState<LocaleChoice>(choice);
  const [failed, setFailed] = useState(false);
  const [system, setSystem] = useState<"en" | "ru" | null>(null);
  useEffect(() => setSystem(detectLocale(navigator.languages?.length ? navigator.languages : [navigator.language])), []);
  const choose = async (next: LocaleChoice) => {
    setSelected(next);
    const kept = await saveLocaleChoice(next);
    setFailed(!kept);
    if (kept) window.location.reload();
  };
  const systemName = system === "ru" ? "Русский" : system === "en" ? "English" : null;
  return (
    <Panel title={t("Language")} closeTo={settingsPath("app")}>
      <PanelBlock>
        <fieldset>
          <legend>{t("Language")}</legend>
          <label className="fi-check"><input type="radio" name="language" checked={selected === "system"} onChange={() => void choose("system")} />
            <span>{systemName ? t("System ({language})", { language: systemName }) : t("System")}</span></label>
          <label className="fi-check" lang="en"><input type="radio" name="language" checked={selected === "en"} onChange={() => void choose("en")} /><span>English</span></label>
          <label className="fi-check" lang="ru"><input type="radio" name="language" checked={selected === "ru"} onChange={() => void choose("ru")} /><span>Русский</span></label>
        </fieldset>
        <p className="fi-hint">{t("The interface follows the language of this device unless you choose one here. The choice is kept on this device; the page reloads to show it.")}</p>
        <p className="fi-hint">{t("Mail you send, agents' answers and what agents read stay as they are: only the interface changes language.")}</p>
        {typeof window !== "undefined" && window.fabricDesktop && <p className="fi-hint">{t("On the Mac, the app's menus and windows follow the same choice.")}</p>}
        {failed && <p className="fi-action-result is-error" role="alert">{t("This device could not keep the choice.")}</p>}
      </PanelBlock>
    </Panel>
  );
}

function ServerPanel() {
  const t = useT();
  const config = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: 60_000 });
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const desktop = typeof window !== "undefined" && !!window.fabricDesktop;
  return (
    <Panel title={t("Your server")} closeTo={settingsPath("app")}>
      <PanelBlock>
        <p>{t("Your mail, agents and rules run on your server, a Worker in your own Cloudflare account. They keep running when this app is closed.")}</p>
        <p className="fi-hint">{t("Drafts you are writing live on this device; an uninstaller that removes this app's data loses them.")}</p>
        <ul className="fi-facts">
          <li><strong>{t("Address")}</strong> <code>{origin || "…"}</code></li>
          <li><strong>{t("Domains in its configuration")}</strong> {config.isPending ? "…" : config.isError ? t("unknown ({error})", { error: t.text(errorText(config.error)) }) : config.data.domains.length ? t.list(config.data.domains) : t("none — domains are chosen on Domains")}</li>
        </ul>
        <p className="fi-hint">{desktop
          ? t("To open another server, choose Fabric Inbox → Server address… in the menu bar.")
          : t("The Mac app chooses its server under Fabric Inbox → Server address….")}</p>
        <div className="fi-buttons">
          <Link className="fi-secondary" to={settingsPath("domains")}>{t("Domains")}</Link>
          <Link className="fi-secondary" to={settingsPath("accounts")}>{t("Accounts")}</Link>
        </div>
      </PanelBlock>
    </Panel>
  );
}

function DesktopPanel() {
  const t = useT();
  const desktop = typeof window !== "undefined" && !!window.fabricDesktop;
  return (
    <Panel title={t("Mac app")} closeTo={settingsPath("app")}>
      <PanelBlock>
        <p>{desktop ? t("These switches belong to this Mac, so they live in the app menu (Fabric Inbox in the menu bar):") : t("In the Mac app, these switches live in the app menu (Fabric Inbox in the menu bar), because they belong to the Mac:")}</p>
        <ul className="fi-facts">
          <li>{t.rich("{item} looks for a newer version now.", { item: <strong key="i">{t("Check for Updates…")}</strong> })}</li>
          <li>{t.rich("{item} downloads a new version in the background and installs it when the app quits.", { item: <strong key="i">{t("Install Updates Automatically")}</strong> })}</li>
          <li>{t.rich("{share} and {about} say what is counted and turn it off or on.", { share: <strong key="s">{t("Share Anonymous Usage Counts")}</strong>, about: <strong key="a">{t("About Usage Counts…")}</strong> })}</li>
          <li>{t.rich("{item} chooses the server this app opens.", { item: <strong key="i">{t("Server address…")}</strong> })}</li>
          <li>{t.rich("{item} saves your Cloudflare API token on your server.", { item: <strong key="i">{t("Connect Cloudflare account…")}</strong> })}</li>
          <li>{t.rich("{item} (⌘,) opens this screen.", { item: <strong key="i">{t("Settings…")}</strong> })}</li>
        </ul>
      </PanelBlock>
    </Panel>
  );
}

type Source = "desktop" | "file" | "cloudflare";
const OUTCOME_TEXT = { created: msg("Created"), updated: msg("Updated"), unchanged: msg("Already there"), refused: msg("Not created") } as const;

/** SCR-11: apply a setup, bring existing Cloudflare addresses in, or export the current setup. */
function SetupPanel() {
  const t = useT();
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
    }).catch(() => notify(t("The setup chosen in the app could not be read. Open it as a file instead."), "error"));
  }, [notify, t]);
  // The result's heading takes the focus once, when an apply finishes (never on every render).
  useEffect(() => { if (result) resultHeading.current?.focus(); }, [result]);

  function load(value: unknown, from: Source) {
    setResult(null);
    const parsed = parseSetup(value);
    if (parsed.ok) { setSetup(parsed.setup); setSource(from); setProblems([]); } else { setSetup(null); setProblems(parsed.problems); }
  }
  async function openFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) { setProblems([t("This file is too large to be a setup.")]); return; }
    try { load(JSON.parse(await file.text()), "file"); } catch { setSetup(null); setProblems([t("This file is not a Fabric Inbox setup (not readable JSON).")]); }
  }
  const readCloudflare = () => void work.run(t("Reading Cloudflare…"), async () => {
    load(await fabric<unknown>("/api/setup/from-cloudflare"), "cloudflare");
    return "";
  });
  const apply = () => void work.run(t("Applying…"), async () => {
    if (!setup) return "";
    let applied: ApplyResult;
    try { applied = await fabric<ApplyResult>("/api/setup/apply", setup); }
    catch (error) { throw new Error(t("{error} Applying the same setup again is safe.", { error: t.text(errorText(error)) })); }
    setResult(applied);
    // Whatever the source, a successful apply ends the desktop's pending setup;
    // otherwise the app reopens this page on every launch.
    if (window.fabricDesktop) {
      try { await window.fabricDesktop.pendingSetupDone(); } catch { return t("Applied. The app could not clear its saved setup; it may open this page again once."); }
    }
    const refused = applied.mailboxes.filter((m) => m.outcome === "refused").length;
    return refused ? t.plural(refused, { one: "Setup applied, {n} not created.", other: "Setup applied, {n} not created." }) : t("Setup applied.");
  });

  const byDomain = setup?.domains.map((domain) => ({ domain, boxes: setup.mailboxes.filter((m) => m.address.endsWith("@" + domain)) })) ?? [];
  const refused = result?.mailboxes.filter((m) => m.outcome === "refused") ?? [];

  return (
    <Panel title={t("Setup")} closeTo={settingsPath("app")}
      subtitle={t("A setup lists the domains this server receives mail for and the addresses on them, with where each one keeps forwarding a copy. Applying it creates what is missing and changes nothing else; it never deletes.")}>
      {fromDesktop && !setup && !problems.length && !result && <p role="status" className="fi-hint">{t("Reading the setup chosen in the app…")}</p>}
      {!setup && !result && (
        <PanelBlock title={t("Load a setup")}>
          <div className="fi-buttons">
            <label className="fi-secondary" style={{ cursor: "pointer" }}>
              {t("Open a setup file…")}
              <input type="file" accept="application/json,.json" className="fi-visually-hidden" onChange={(e) => void openFile(e.target.files?.[0])} />
            </label>
            <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={readCloudflare}>{work.busy ?? t("Read from Cloudflare Email Routing")}</button>
            <a className="fi-text-button" href="/api/setup/export" download="fabric-inbox-setup.json">{t("Export the current setup")}</a>
          </div>
        </PanelBlock>
      )}
      {problems.length > 0 && (
        <div role="alert" className="fi-callout is-bad">
          <p><strong>{t("This is not a usable setup. Nothing was changed.")}</strong></p>
          <ul>{problems.map((p) => <li key={p}>{t.text(p)}</li>)}</ul>
        </div>
      )}
      {setup && !result && (
        <PanelBlock title={setup.name}>
          <p className="fi-hint">
            {source === "desktop" ? t("Chosen in the app.") : source === "cloudflare" ? t("Read from your domains' Email Routing; routing rules are not changed.") : t("Opened from a file.")}{" "}
            {t("{domains}, {addresses}.", {
              domains: t.plural(setup.domains.length, { one: "{n} domain", other: "{n} domains" }),
              addresses: t.plural(setup.mailboxes.length, { one: "{n} address", other: "{n} addresses" }),
            })}
          </p>
          <ul className="fi-plain-list">
            {byDomain.map(({ domain, boxes }) => (
              <li key={domain} style={{ display: "block" }}>
                <strong>{domain}</strong>
                {setup.catchAll.some((c) => c.domain === domain) && <span className="fi-hint"> · {t("other addresses go to the catch-all")}</span>}
                <ul className="fi-hint">{boxes.map((b) => <li key={b.address}>{b.forwardTo ? t("{address} → a copy keeps going to {destination}", { address: b.address, destination: b.forwardTo }) : b.address}</li>)}</ul>
              </li>
            ))}
          </ul>
          {setup.notServed.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>{t("Stays as it is")}</h3>
              <ul className="fi-hint">{setup.notServed.map((n) => <li key={n.domain}><strong>{n.domain}</strong> — {t.text(n.reason)}</li>)}</ul>
            </>
          )}
          <div className="fi-buttons">
            <button type="button" className="fi-primary" disabled={!!work.busy} onClick={apply}>{work.busy ?? t("Apply setup")}</button>
            <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => { setSetup(null); setSource(null); }}>{t("Choose another")}</button>
          </div>
        </PanelBlock>
      )}
      {result && (
        <PanelBlock>
          <h3 ref={resultHeading} tabIndex={-1}>{refused.length ? t.plural(refused.length, { one: "Applied, {n} not created", other: "Applied, {n} not created" }) : t("Setup applied")}</h3>
          <p className="fi-hint">
            {result.domainsAdded.length ? t("Now receiving for {domains}.", { domains: t.list(result.domainsAdded) }) + " " : ""}
            {result.catchAllSet.length ? t("Catch-all set on {domains}.", { domains: t.list(result.catchAllSet) }) + " " : ""}
          </p>
          <ul className="fi-plain-list">
            {result.mailboxes.map((m) => (
              <li key={m.address}>
                <span className="fi-grow">{m.address}</span>
                {m.outcome === "refused" ? <Badge tone="bad">{t.text(OUTCOME_TEXT[m.outcome])}</Badge> : <Badge tone="ok">{t.text(OUTCOME_TEXT[m.outcome])}</Badge>}
                {m.reason && <span className="fi-hint">{t.text(m.reason)}</span>}
              </li>
            ))}
          </ul>
          <div className="fi-callout">
            <p><strong>{t("One step remains for each domain")}</strong></p>
            <p>{t("Mail reaches these addresses once Cloudflare Email Routing sends it to this server. On Domains, open each domain and choose Bring them here: every address keeps forwarding a copy where its mail went before. Until then mail keeps going where it went before.")}</p>
          </div>
          <div className="fi-buttons">
            <Link className="fi-primary" to={settingsPath("domains")}>{t("Go to Domains")}</Link>
            <Link className="fi-secondary" to="/">{t("Open the inbox")}</Link>
          </div>
        </PanelBlock>
      )}
      <ActionResult result={work.result} />
    </Panel>
  );
}
