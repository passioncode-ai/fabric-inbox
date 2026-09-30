import { useEffect, useState } from "react";
import { Link } from "react-router";
import { fabric } from "~/services/fabric";
import { parseSetup, type ApplyResult, type Setup } from "../../shared/setup";

export function meta() {
  return [{ title: "Setup · Fabric Inbox" }];
}

declare global {
  interface Window {
    /** Present only in the desktop app's mail window (desktop/mail-preload.cjs). */
    fabricDesktop?: { pendingSetup(): Promise<unknown>; pendingSetupDone(): Promise<unknown> };
  }
}

type Source = "desktop" | "file" | "cloudflare";
const OUTCOME_TEXT = { created: "Created", updated: "Updated", unchanged: "Already there", refused: "Not created" } as const;

/** SCR-11: apply a setup, bring existing Cloudflare addresses in, or export the current setup. */
export default function SetupPage() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<ApplyResult | null>(null);

  useEffect(() => {
    if (!window.fabricDesktop) return;
    window.fabricDesktop.pendingSetup().then((value) => {
      if (!value) return;
      const parsed = parseSetup(value);
      if (parsed.ok) { setSetup(parsed.setup); setSource("desktop"); }
      else setProblems(parsed.problems);
    }).catch(() => setNotice("The setup chosen in the app could not be read. Open it as a file instead."));
  }, []);

  function load(value: unknown, from: Source) {
    setResult(null); setNotice("");
    const parsed = parseSetup(value);
    if (parsed.ok) { setSetup(parsed.setup); setSource(from); setProblems([]); }
    else { setSetup(null); setProblems(parsed.problems); }
  }

  async function openFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) { setProblems(["This file is too large to be a setup."]); return; }
    try { load(JSON.parse(await file.text()), "file"); }
    catch { setSetup(null); setProblems(["This file is not a Fabric Inbox setup (not readable JSON)."]); }
  }

  async function readCloudflare() {
    setBusy(true); setNotice("");
    try { load(await fabric<unknown>("/api/setup/from-cloudflare"), "cloudflare"); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!setup) return;
    setBusy(true); setNotice("");
    try {
      const applied = await fabric<ApplyResult>("/api/setup/apply", setup);
      setResult(applied);
      // Whatever the source, a successful apply ends the desktop's pending setup;
      // otherwise the app reopens this page on every launch.
      if (window.fabricDesktop) {
        await window.fabricDesktop.pendingSetupDone().catch(() =>
          setNotice("Applied. The app could not clear its saved setup; it may open this page again once."));
      }
    } catch (error) {
      setNotice(`${(error as Error).message} Applying the same setup again is safe.`);
    } finally { setBusy(false); }
  }

  const byDomain = setup?.domains.map((domain) => ({ domain, boxes: setup.mailboxes.filter((m) => m.address.endsWith("@" + domain)) })) ?? [];
  const refused = result?.mailboxes.filter((m) => m.outcome === "refused") ?? [];

  return (
    <main className="mx-auto max-w-4xl p-6 text-kumo-default">
      <nav className="flex gap-4 text-sm">
        <Link to="/">← Fabric Inbox</Link>
        <Link to="/projects" className="underline">Domains &amp; addresses</Link>
      </nav>
      <h1 className="mt-8 text-3xl font-semibold">Setup</h1>
      <p className="my-3 text-kumo-subtle">
        A setup lists the domains this server receives mail for and the addresses on them, with where each one keeps forwarding a copy.
        Applying it creates what is missing and changes nothing else; it never deletes.
      </p>
      {notice && <p role="status" className="my-4 rounded-lg border border-kumo-line p-3">{notice}</p>}

      {!setup && (
        <section className="my-6 flex flex-wrap items-center gap-3" aria-label="Load a setup">
          <label className="fi-secondary cursor-pointer">
            Open a setup file…
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void openFile(e.target.files?.[0])} />
          </label>
          <button className="fi-secondary" disabled={busy} onClick={() => void readCloudflare()}>
            {busy ? "Reading Cloudflare…" : "Read from Cloudflare Email Routing"}
          </button>
          <a className="underline" href="/api/setup/export" download="fabric-inbox-setup.json">Export the current setup</a>
        </section>
      )}

      {problems.length > 0 && (
        <div role="alert" className="my-4 rounded-lg border border-kumo-line p-4">
          <p className="font-medium">This is not a usable setup. Nothing was changed.</p>
          <ul className="mt-2 list-disc pl-5 text-sm">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      {setup && !result && (
        <section className="my-6" aria-labelledby="review-heading">
          <h2 id="review-heading" className="text-xl font-medium">{setup.name}</h2>
          <p className="mt-1 text-sm text-kumo-subtle">
            {source === "desktop" ? "Chosen in the app." : source === "cloudflare" ? "Read from your domains' Email Routing; routing rules are not changed." : "Opened from a file."}{" "}
            {setup.domains.length} domains, {setup.mailboxes.length} addresses.
          </p>
          <ul className="mt-4 divide-y divide-kumo-line rounded-xl border border-kumo-line">
            {byDomain.map(({ domain, boxes }) => (
              <li key={domain} className="p-3 text-sm">
                <strong>{domain}</strong>
                {setup.catchAll.some((c) => c.domain === domain) && <span className="ml-2 text-kumo-subtle">· other addresses go to catch-all@{domain}</span>}
                <ul className="mt-1 text-kumo-subtle">
                  {boxes.map((b) => (
                    <li key={b.address}>{b.address}{b.forwardTo ? ` → a copy keeps going to ${b.forwardTo}` : ""}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {setup.notServed.length > 0 && (
            <>
              <h3 className="mt-4 font-medium">Stays as it is</h3>
              <ul className="mt-1 list-disc pl-5 text-sm text-kumo-subtle">
                {setup.notServed.map((n) => <li key={n.domain}><strong>{n.domain}</strong> — {n.reason}</li>)}
              </ul>
            </>
          )}
          <div className="mt-6 flex gap-3">
            <button className="fi-primary" disabled={busy} onClick={() => void apply()}>{busy ? "Applying…" : "Apply setup"}</button>
            <button className="fi-secondary" disabled={busy} onClick={() => { setSetup(null); setSource(null); }}>Choose another</button>
          </div>
        </section>
      )}

      {result && (
        <section className="my-6" aria-labelledby="result-heading">
          <h2 id="result-heading" className="text-xl font-medium" tabIndex={-1} ref={(el) => el?.focus()}>
            {refused.length ? `Applied, ${refused.length} not created` : "Setup applied"}
          </h2>
          <p className="mt-1 text-sm text-kumo-subtle">
            {result.domainsAdded.length ? `Now receiving for ${result.domainsAdded.join(", ")}. ` : ""}
            {result.catchAllSet.length ? `Catch-all set on ${result.catchAllSet.join(", ")}. ` : ""}
          </p>
          <ul className="mt-3 divide-y divide-kumo-line rounded-xl border border-kumo-line text-sm">
            {result.mailboxes.map((m) => (
              <li key={m.address} className="flex flex-wrap justify-between gap-2 p-3">
                <span>{m.address}</span>
                <span className={m.outcome === "refused" ? "font-medium" : "text-kumo-subtle"}>{OUTCOME_TEXT[m.outcome]}{m.reason ? ` — ${m.reason}` : ""}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6 rounded-xl border border-kumo-line p-4 text-sm">
            <p className="font-medium">One step remains for each domain</p>
            <p className="mt-1">
              Mail reaches these addresses once Cloudflare Email Routing sends it to this server. On{" "}
              <Link className="underline" to="/projects">Domains &amp; addresses</Link>, open each domain and choose Bring them here: every
              address keeps forwarding a copy where its mail went before. Until then mail keeps going where it went before.
            </p>
          </div>
          <div className="mt-6 flex gap-3">
            <Link className="fi-primary" to="/projects">Go to Domains &amp; addresses</Link>
            <Link className="fi-secondary" to="/">Open the inbox</Link>
          </div>
        </section>
      )}
    </main>
  );
}
