/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so tests/automation-ui.test.ts (tsx) renders this file as the app does.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams, type MetaArgs } from "react-router";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { metaT, useT, type T } from "../lib/i18n";
import { fabric } from "../services/fabric";
import { ApiError } from "../services/api";
import { useWindowActive } from "../hooks/useWindowActive";
import { AUTOMATION_POLL_MS, pollInterval } from "../lib/window-activity";
import { useInboxAccounts } from "../components/settings/sections/data";
import { enableLocked, ruleReviewKey, switchOnStep } from "../lib/rule-gate";
import {
  actionParts, defaultRuleName, hasCondition, ruleSentence, testRunSentence, toolHost, type Part, type TestRunResult,
} from "../lib/rule-sentence";
import type { OutboxEntry } from "../../shared/mail/outbox";
import type { Rule, Run } from "../../workers/automation/policy";
import type { RunCheck } from "../../workers/automation/index";

export { enableLocked, ruleReviewKey } from "../lib/rule-gate";

/**
 * The Rules screen (S10, B-275; SCN-014..017): one account's or address's rules said as sentences,
 * the four-step editor (When, Do, How, Test run), what the rules did (History) and, for a
 * Cloudflare address, what is still being sent (Sending). The rule model and the routes are the
 * API's (`/api/automation/:account`); only the words and the layout are this screen's.
 */
const REMOTE = /^(gmail|imap|outlook):/;
type Tab = "rules" | "history" | "sending";
type Step = "when" | "test";
/** Where the person came from, as the links into this screen say it (`state.from`). */
type From = "mail" | "settings";

const fresh = (over: Partial<Rule> = {}): Rule => ({
  id: crypto.randomUUID(),
  version: 1,
  name: "",
  enabled: false,
  mode: "approval",
  conditions: {},
  action: { type: "archive" },
  dailyLimit: 20,
  ...over,
});

/** The empty screen's three starting points, each a filled-in editor. */
export function startingPoints(t: T): { label: string; rule: () => Rule }[] {
  return [
    { label: t("Archive newsletters from a sender"), rule: () => fresh({ name: t("Newsletters"), conditions: { from: "" }, action: { type: "archive" } }) },
    {
      label: t("Prepare a reply draft when a customer asks about something"),
      rule: () => fresh({ name: t("Customer questions"), conditions: { ai: t("a customer asks a question about our product") }, action: { type: "draft" } }),
    },
    { label: t("Forward invoices to another address"), rule: () => fresh({ name: t("Invoices"), conditions: { subject: t("[subject] invoice") }, action: { type: "forward", to: "" } }) },
  ];
}

/** The unified feed names a Cloudflare mailbox `cloudflare:<address>`; other accounts already carry their provider. */
export function feedAccount(account: string): string {
  return /^(gmail|imap|outlook|cloudflare):/.test(account) ? account : `cloudflare:${account}`;
}

/** How a message is named in the test-run picker: who sent it and its subject. */
export function previewLabel(m: { sender: string; subject: string }, t: T): string {
  const who = m.sender.replace(/\s*<[^>]+>/, "").replace(/^"|"$/g, "") || m.sender;
  return `${who}: ${m.subject || t("No subject")}`;
}

/**
 * Whether a run offers "Check status" (SCN-020): only an uncertain run, and only when its action
 * leaves a record the server can read; a tool call (mcp) does not.
 */
export function runCheckable(run: Pick<Run, "status" | "rule" | "proposal">): boolean {
  return run.status === "unknown" && (run.proposal?.action ?? run.rule.action).type !== "mcp";
}

/** Whether a run waits for the person: an approval, or an outcome only they can check. */
export const needsYou = (run: Pick<Run, "status">) => run.status === "waiting_approval" || run.status === "unknown";

/** A reason from the server, set inside a sentence ("Skipped: the daily limit was reached"). */
const inSentence = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

/** A run's state in words, and the badge it wears. */
export function runState(run: Pick<Run, "status" | "detail">, t: T): { text: string; tone: "ok" | "warn" | "bad" | "busy" | "" } {
  const reason = run.detail ? inSentence(t.text(run.detail)) : "";
  switch (run.status) {
    case "pending": return { text: t("Waiting in line"), tone: "busy" };
    case "running": return { text: t("Running"), tone: "busy" };
    case "waiting_approval": return { text: t("Waiting for your approval"), tone: "warn" };
    case "waiting_device": return { text: t("Waiting for your device"), tone: "busy" };
    case "succeeded": return { text: t("Done"), tone: "ok" };
    case "skipped":
      return { text: !run.detail || run.detail === "Conditions did not match" ? t("Skipped: it did not match") : t("Skipped: {reason}", { reason }), tone: "" };
    case "failed": return { text: reason ? t("Failed: {reason}", { reason }) : t("Failed"), tone: "bad" };
    case "unknown": return { text: t("Not sure it happened"), tone: "warn" };
    case "cancelled": return { text: t("Cancelled"), tone: "" };
    default: return { text: String(run.status).replaceAll("_", " "), tone: "" };
  }
}

/** An outbox entry's state in words. */
function sendingState(status: string, t: T): string {
  switch (status) {
    case "pending": return t("Waiting to be sent");
    case "sending": return t("Sending");
    case "accepted": return t("Handed to the mail provider");
    case "failed": return t("Failed");
    case "unknown": return t("Not sure it was sent");
    default: return status;
  }
}

/** Parts with the typed values in bold. */
function Sentence({ parts }: { parts: readonly Part[] }) {
  return <>{parts.map((p, i) => (typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : <strong key={i}>{p.strong}</strong>))}</>;
}

export function meta({ matches }: MetaArgs) {
  const t = metaT(matches);
  return [{ title: t("Rules · Fabric Inbox") }];
}

export default function Automation() {
  const t = useT();
  const { account = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const base = "/api/automation/" + encodeURIComponent(account);
  const remote = REMOTE.test(account);
  // History and Sending poll every 30 s, and only while this window is visible and focused
  // (LC-08); coming back to the window refreshes them at once instead of after the next tick.
  const active = useWindowActive();
  const queryClient = useQueryClient();
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      void queryClient.invalidateQueries({ queryKey: ["runs", account] });
      void queryClient.invalidateQueries({ queryKey: ["outbox", account] });
    }
    wasActive.current = active;
  }, [active, account, queryClient]);
  const rules = useQuery({ queryKey: ["rules", account], queryFn: () => fabric<Rule[]>(base + "/rules") });
  const runs = useQuery({
    queryKey: ["runs", account],
    queryFn: () => fabric<Run[]>(base + "/runs"),
    refetchInterval: pollInterval(active, AUTOMATION_POLL_MS),
  });
  const outbox = useQuery({
    queryKey: ["outbox", account],
    queryFn: () => fabric<OutboxEntry[]>("/api/v1/mailboxes/" + encodeURIComponent(account) + "/outbox"),
    enabled: !remote,
    refetchInterval: pollInterval(active, AUTOMATION_POLL_MS),
  });
  const accounts = useInboxAccounts();
  const named = accounts.data?.find((a) => a.id === feedAccount(account));
  const provider = remote ? account.slice(0, account.indexOf(":")) : "cloudflare";

  // The editor, the step it opens at, and every value a test run succeeded for on this screen.
  const [editing, setEditing] = useState<{ rule: Rule; saved: { key: string; enabled: boolean } | null; step: Step } | null>(null);
  const [tested, setTested] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const addTested = (key: string) => setTested((old) => new Set(old).add(key));
  const open = (rule: Rule, step: Step = "when", isNew = false) => {
    setNotice("");
    setEditing({ rule: structuredClone(rule), saved: isNew ? null : { key: ruleReviewKey(rule), enabled: rule.enabled }, step });
    setParams((p) => { p.delete("tab"); return p; }, { replace: true });
  };

  // A rule's switch: off pauses at once; on needs a test run of its current values (FLW-05).
  async function toggle(rule: Rule) {
    if (!rule.enabled && switchOnStep(rule, tested) === "test-run") return open(rule, "test");
    setBusy(true);
    setNotice("");
    try {
      await fabric(base + "/rules", { ...rule, enabled: !rule.enabled }, "PUT");
      await rules.refetch();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return open(rule, "test");
      setNotice(t("The change was not saved: {reason}", { reason: t.text((e as Error).message) }));
    } finally {
      setBusy(false);
    }
  }

  const waiting = runs.data?.filter(needsYou).length ?? 0;
  const hasSending = !remote && (outbox.data?.length ?? 0) > 0;
  const asked = params.get("tab");
  const tab: Tab = editing ? "rules" : asked === "history" ? "history" : asked === "sending" && hasSending ? "sending" : "rules";
  const choose = (next: Tab) => setParams((p) => { if (next === "rules") p.delete("tab"); else p.set("tab", next); return p; });

  // Back to where the person came from: the mail (its history, so the open message stays open)
  // or Settings, which is also where an unknown start goes.
  const from: From = (location.state as { from?: From } | null)?.from === "mail" ? "mail" : "settings";
  const settingsBack = remote
    ? `/settings/accounts/${encodeURIComponent(account)}`
    : `/settings/addresses/${encodeURIComponent(account)}/rules`;

  const title = named?.email ?? (remote ? null : account);
  return (
    <div className="fi-rules">
      <div className="fi-rules-inner">
        <header className="fi-rules-head">
          {from === "mail" ? (
            <Link className="fi-rules-back" to="/" onClick={(e) => {
              if (location.key !== "default") { e.preventDefault(); navigate(-1); }
            }}>{t("Back to mail")}</Link>
          ) : (
            <Link className="fi-rules-back" to={settingsBack}>{t("Back to settings")}</Link>
          )}
          <h1>{title ? t("Rules for {name}", { name: title }) : t("Rules for this account")}</h1>
          <p className="fi-hint">
            {provider === "cloudflare" ? t("Cloudflare address")
              : provider === "gmail" ? t("Gmail account")
              : provider === "outlook" ? t("Outlook account")
              : t("IMAP account")}
          </p>
        </header>

        <div className="fi-rules-tabs" role="tablist" aria-label={t("Rules")}>
          <button type="button" role="tab" aria-selected={tab === "rules"} onClick={() => choose("rules")}>{t("Rules")}</button>
          <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => { setEditing(null); choose("history"); }}>
            {t("History")}
            {waiting > 0 && (
              <span className="fi-rules-count" aria-label={t.plural(waiting, { one: "{n} waits for you", other: "{n} wait for you" })}>{waiting}</span>
            )}
          </button>
          {hasSending && (
            <button type="button" role="tab" aria-selected={tab === "sending"} onClick={() => { setEditing(null); choose("sending"); }}>{t("Sending")}</button>
          )}
        </div>

        {notice && <p role="alert" className="fi-callout is-bad">{notice}</p>}

        {tab === "rules" && (editing ? (
          <RuleEditor
            key={editing.rule.id + editing.step}
            account={account}
            base={base}
            start={editing}
            tested={tested}
            onTested={addTested}
            onClose={() => setEditing(null)}
            onSaved={async () => { setEditing(null); await Promise.all([rules.refetch(), runs.refetch()]); }}
          />
        ) : (
          <section aria-label={t("Rules")}>
            {rules.isPending ? (
              <p role="status" className="fi-hint">{t("Loading rules…")}</p>
            ) : rules.isError ? (
              <div className="fi-load-failure" role="alert">
                <p>{t("The rules could not load: {reason}", { reason: t.text(rules.error.message) })}</p>
                <button type="button" className="fi-secondary" onClick={() => void rules.refetch()}>{t("Retry")}</button>
              </div>
            ) : rules.data.length === 0 ? (
              <div className="fi-rules-empty">
                <p>{t("A rule acts on new mail that arrives here.")}</p>
                <p className="fi-hint">{t("Start from one of these, or from nothing:")}</p>
                <ul className="fi-rules-starts">
                  {startingPoints(t).map((s) => (
                    <li key={s.label}><button type="button" className="fi-secondary" onClick={() => open(s.rule(), "when", true)}>{s.label}</button></li>
                  ))}
                </ul>
                <button type="button" className="fi-text-button" onClick={() => open(fresh(), "when", true)}>{t("New rule")}</button>
              </div>
            ) : (
              <>
                <div className="fi-rules-toolbar">
                  <p className="fi-hint">{t("A rule acts on new mail that arrives here.")}</p>
                  <button type="button" className="fi-primary" onClick={() => open(fresh(), "when", true)}>{t("New rule")}</button>
                </div>
                <ul className="fi-rules-list">
                  {rules.data.map((rule) => (
                    <li key={rule.id} className={"fi-rules-card" + (rule.enabled ? "" : " is-paused")}>
                      <div className="fi-rules-card-main">
                        <h2>{rule.name}{!rule.enabled && <span className="fi-badge">{t("[rule] Paused")}</span>}</h2>
                        <p className="fi-rules-sentence"><Sentence parts={ruleSentence(rule, t)} /></p>
                      </div>
                      <div className="fi-rules-card-side">
                        <button type="button" role="switch" aria-checked={rule.enabled} className="fi-rules-switch" disabled={busy}
                          aria-label={t("Turned on: {name}", { name: rule.name })} onClick={() => void toggle(rule)}>
                          <span aria-hidden="true" />{rule.enabled ? t("[rule] On") : t("[rule] Off")}
                        </button>
                        <button type="button" className="fi-secondary" onClick={() => open(rule)}>{t("Edit")}</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ))}

        {tab === "history" && <History base={base} account={account} runs={runs} />}

        {tab === "sending" && (
          <section aria-label={t("Sending")}>
            <p className="fi-hint">{t("“Handed to the mail provider” means the provider took the message; whether it reached the person is not known.")}</p>
            {outbox.error && <p role="alert" className="fi-callout is-warn">{t("What is being sent could not load.")}</p>}
            <ul className="fi-rules-runs">
              {outbox.data?.map((item) => (
                <li key={item.id} className="fi-rules-run">
                  <div className="fi-rules-run-head">
                    <span className={"fi-badge" + (item.status === "accepted" ? " is-ok" : item.status === "failed" ? " is-bad" : item.status === "unknown" ? " is-warn" : " is-busy")}>
                      {sendingState(item.status, t)}
                    </span>
                    <span className="fi-hint">{t.dateTime(item.createdAt)}</span>
                  </div>
                  <details className="fi-rules-details">
                    <summary>{t("Details")}</summary>
                    <p className="fi-hint">{item.id}</p>
                    {item.errorCode && <p className="fi-hint">{item.errorCode}</p>}
                  </details>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** What the rules did: one line per run, its state in words, Approve and Cancel; ids under Details. */
function History({ base, account, runs }: { base: string; account: string; runs: UseQueryResult<Run[]> }) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState("");
  // Per run: a check in flight, or what the last check found (or why it could not run).
  const [checks, setChecks] = useState<Record<string, { busy: boolean; text?: string; failed?: boolean }>>({});
  async function act(id: string, what: "approve" | "dismiss") {
    setBusy(id);
    setFailure("");
    try {
      await fabric(base + "/runs/" + encodeURIComponent(id) + "/" + what, {});
      await runs.refetch();
    } catch (e) {
      setFailure(t.text((e as Error).message));
    } finally {
      setBusy("");
    }
  }
  async function checkRun(id: string) {
    setChecks((old) => ({ ...old, [id]: { busy: true } }));
    try {
      const result = await fabric<RunCheck>(base + "/runs/" + encodeURIComponent(id) + "/check", {});
      setChecks((old) => ({ ...old, [id]: { busy: false, text: t.text(result.detail) } }));
      await runs.refetch();
    } catch (e) {
      setChecks((old) => ({ ...old, [id]: { busy: false, failed: true, text: t.text((e as Error).message) } }));
    }
  }
  if (runs.isPending) return <p role="status" className="fi-hint">{t("Loading…")}</p>;
  if (runs.isError) return (
    <div className="fi-load-failure" role="alert">
      <p>{t("History could not load: {reason}", { reason: t.text(runs.error.message) })}</p>
      <button type="button" className="fi-secondary" onClick={() => void runs.refetch()}>{t("Retry")}</button>
    </div>
  );
  if (runs.data.length === 0) return <p className="fi-rules-empty fi-hint">{t("Nothing yet. When a turned-on rule matches new mail, it shows here.")}</p>;
  return (
    <section aria-label={t("History")}>
      {failure && <p role="alert" className="fi-callout is-bad">{failure}</p>}
      <ul className="fi-rules-runs">
        {runs.data.map((run) => {
          const state = runState(run, t);
          const action = run.proposal?.action ?? run.rule.action;
          const find = "/?" + new URLSearchParams({ account: feedAccount(account), query: run.subject }).toString();
          return (
            <li key={run.id} className="fi-rules-run">
              <div className="fi-rules-run-head">
                <strong>{run.subject || t("(No subject)")}</strong>
                <span className={"fi-badge" + (state.tone ? " is-" + state.tone : "")}>{state.text}</span>
              </div>
              <p>{run.rule.name} → <Sentence parts={actionParts(action, t)} /></p>
              <p className="fi-hint">
                {t.dateTime(run.createdAt)}
                {run.subject && <> · <Link to={find}>{t("Find it in mail")}</Link></>}
              </p>
              {run.analysis?.summary && run.status === "waiting_approval" && <p>{t.text(run.analysis.summary)}</p>}
              {run.analysis?.draft && <pre className="fi-pre">{run.analysis.draft}</pre>}
              {run.detail && !["skipped", "failed"].includes(run.status) && <p>{t.text(run.detail)}</p>}
              {run.status === "unknown" && !runCheckable(run) && (
                <p role="note" className="fi-hint">{t("A tool call leaves no receipt on this server. Check the tool's own service before repeating it.")}</p>
              )}
              {run.status === "unknown" && run.checkedAt && (
                <p className="fi-hint">{t("Last checked {time}", { time: t.dateTime(run.checkedAt) })}</p>
              )}
              {checks[run.id]?.text && (run.status === "unknown" || checks[run.id]?.failed) && (
                <p role={checks[run.id]?.failed ? "alert" : "status"} className="fi-hint">{checks[run.id]?.text}</p>
              )}
              <div className="fi-buttons">
                {run.status === "waiting_approval" && (
                  <button type="button" className="fi-primary" disabled={!!busy} onClick={() => void act(run.id, "approve")}>{t("Approve")}</button>
                )}
                {["pending", "waiting_approval", "waiting_device"].includes(run.status) && (
                  <button type="button" className="fi-secondary" disabled={!!busy} onClick={() => void act(run.id, "dismiss")}>{t("Cancel")}</button>
                )}
                {runCheckable(run) && (
                  <button type="button" className="fi-secondary" disabled={!!checks[run.id]?.busy} onClick={() => void checkRun(run.id)}>
                    {checks[run.id]?.busy ? t("Checking…") : t("Check status")}
                  </button>
                )}
              </div>
              <details className="fi-rules-details">
                <summary>{t("Details")}</summary>
                <ul className="fi-facts">
                  <li>{t("Rule version {version}", { version: run.rule.version })}</li>
                  <li>{t.plural(run.attempts ?? 0, { one: "{n} attempt", other: "{n} attempts" })}</li>
                  {action.type === "mcp" && <li>{t("{tool} at {host}", { tool: action.tool, host: toolHost(action.endpoint) })}</li>}
                  <li className="fi-hint">{t("Run {id}", { id: run.id })}</li>
                  <li className="fi-hint">{t("Message {id}", { id: run.emailId })}</li>
                </ul>
                {run.proposal && <pre className="fi-pre">{JSON.stringify(run.proposal.action, null, 2)}</pre>}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One numbered step of the editor. */
function EditorStep({ n, title, children, refTo }: { n: number; title: string; children: ReactNode; refTo?: React.Ref<HTMLElement> }) {
  return (
    <section className="fi-rules-step" ref={refTo} tabIndex={-1} aria-label={title}>
      <h3><span className="fi-rules-step-n" aria-hidden="true">{n}</span>{title}</h3>
      {children}
    </section>
  );
}

/** The four-step editor: When, Do, How, Test run; Turn on after a test run of these values. */
function RuleEditor({ account, base, start, tested, onTested, onClose, onSaved }: {
  account: string;
  base: string;
  start: { rule: Rule; saved: { key: string; enabled: boolean } | null; step: Step };
  tested: ReadonlySet<string>;
  onTested: (key: string) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [rule, setRule] = useState<Rule>(start.rule);
  const [args, setArgs] = useState(start.rule.action.type === "mcp" ? JSON.stringify(start.rule.action.arguments, null, 2) : "{}");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [testFailure, setTestFailure] = useState("");
  const [result, setResult] = useState<{ result: TestRunResult; message?: { sender: string; subject: string } } | null>(null);
  const [messageId, setMessageId] = useState("");
  const testStep = useRef<HTMLElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  // The messages a test run can be tried on: this account's newest inbox mail, picked by name
  // instead of a typed internal id (UI walk 2026-10-08).
  const recent = useQuery({
    queryKey: ["rule-preview-messages", account],
    queryFn: () =>
      fabric<{ messages: { providerMessageId: string; sender: string; subject: string }[] }>(
        "/api/inbox?" + new URLSearchParams({ account: feedAccount(account), folder: "inbox", limit: "20" }),
      ).then((r) => r.messages),
  });
  useEffect(() => {
    const first = recent.data?.[0]?.providerMessageId;
    if (first && !recent.data?.some((m) => m.providerMessageId === messageId)) setMessageId(first);
  }, [recent.data, messageId]);
  useEffect(() => {
    if (start.step === "test") {
      testStep.current?.scrollIntoView?.({ block: "start" });
      testStep.current?.focus();
    } else firstField.current?.focus();
  }, [start.step]);

  const change = (value: Partial<Rule>) => setRule((old) => ({ ...old, ...value }));
  const changeCondition = (key: "from" | "subject" | "ai", text: string) =>
    setRule((old) => ({ ...old, conditions: { ...old.conditions, [key]: text || undefined } }));
  /** The values as they would be saved; throws on tool arguments that are not JSON. */
  function value(): Rule {
    const named = rule.name.trim() ? rule : { ...rule, name: defaultRuleName(rule, t) };
    return named.action.type === "mcp" ? { ...named, action: { ...named.action, arguments: JSON.parse(args) } } : named;
  }
  let current: Rule | null = null;
  try { current = value(); } catch { current = null; }
  const currentKey = current ? ruleReviewKey(current) : null;
  const locked = enableLocked(currentKey, start.saved, tested);
  const ready = hasCondition(rule.conditions);
  const wasOn = !!start.saved?.enabled;

  async function save(enabled: boolean) {
    setBusy(true);
    setFailure("");
    try {
      await fabric(base + "/rules", { ...value(), enabled }, "PUT");
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setFailure(t("Test-run it on a message first, so you see what it will do."));
        testStep.current?.focus();
      } else if (e instanceof SyntaxError) {
        setFailure(t("The tool's arguments are not valid JSON."));
      } else setFailure(t("The rule was not saved: {reason}", { reason: t.text((e as Error).message) }));
    } finally {
      setBusy(false);
    }
  }
  async function testRun() {
    setBusy(true);
    setTestFailure("");
    try {
      const values = value();
      const answer = await fabric<TestRunResult>(base + "/dry-run", { emailId: messageId, rule: values });
      setResult({ result: answer, message: recent.data?.find((m) => m.providerMessageId === messageId) });
      onTested(ruleReviewKey(values));
    } catch (e) {
      setTestFailure(e instanceof SyntaxError
        ? t("The tool's arguments are not valid JSON.")
        : t("The test run failed: {reason}", { reason: t.text((e as Error).message) }));
    } finally {
      setBusy(false);
    }
  }

  const type = rule.action.type;
  const setType = (next: Rule["action"]["type"]) =>
    change({
      action: next === "forward" ? { type: next, to: "" }
        : next === "mcp" ? { type: next, endpoint: "", tool: "", arguments: {}, location: "cloud" }
        : { type: next },
    });
  const choice = (id: Rule["action"]["type"], label: string) => (
    <label className="fi-check">
      <input type="radio" name="rule-action" checked={type === id} onChange={() => setType(id)} />
      <span>{label}</span>
    </label>
  );

  return (
    <form className="fi-rules-editor" onSubmit={(e) => { e.preventDefault(); void save(true); }} aria-label={start.saved ? t("Edit rule") : t("New rule")}>
      <div className="fi-rules-editor-head">
        <h2>{start.saved ? t("Edit rule") : t("New rule")}</h2>
        <label className="fi-field">
          {t("Name")}
          <input className="fi-input" maxLength={100} value={rule.name} placeholder={t("Named by what it does when left empty")}
            onChange={(e) => change({ name: e.target.value })} />
        </label>
        {current && <p className="fi-rules-sentence"><Sentence parts={ruleSentence(current, t)} /></p>}
      </div>

      <div className="fi-rules-steps">
        <EditorStep n={1} title={t("When")}>
          <p className="fi-hint">{t("Fill in at least one. A rule acts only on new mail.")}</p>
          <label className="fi-field">
            {t("From")}
            <input ref={firstField} type="email" className="fi-input" value={rule.conditions.from ?? ""} placeholder="ann@acme.example"
              onChange={(e) => changeCondition("from", e.target.value)} />
          </label>
          <label className="fi-field">
            {t("The subject contains")}
            <input className="fi-input" maxLength={200} value={rule.conditions.subject ?? ""} onChange={(e) => changeCondition("subject", e.target.value)} />
          </label>
          <label className="fi-field">
            {t("The message is about…")}
            <textarea className="fi-input" rows={2} maxLength={1000} value={rule.conditions.ai ?? ""}
              placeholder={t("For example: a customer is asking to reschedule a meeting")}
              onChange={(e) => changeCondition("ai", e.target.value)} />
            <span className="fi-hint">{t("A model reads the message and decides whether it fits.")}</span>
          </label>
        </EditorStep>

        <EditorStep n={2} title={t("Do")}>
          {choice("archive", t("[action] Archive"))}
          {choice("mark_read", t("Mark as read"))}
          {choice("draft", t("Prepare a reply draft"))}
          {choice("forward", t("Forward to…"))}
          {rule.action.type === "forward" && (
            <label className="fi-field">
              {t("Forward to")}
              <input required type="email" className="fi-input" value={rule.action.to}
                onChange={(e) => change({ action: { type: "forward", to: e.target.value } })} />
              <span className="fi-hint">{t("Forwards message text. Messages with attachments require manual handling.")}</span>
            </label>
          )}
          <details className="fi-rules-more" open={type === "mcp"}>
            <summary>{t("More")}</summary>
            {choice("mcp", t("Call a tool"))}
            <p className="fi-hint">{t("Sends the message's details to a tool on another service, for example to open a ticket.")}</p>
            {rule.action.type === "mcp" && (() => {
              const a = rule.action;
              return (
                <>
                  <label className="fi-field">
                    {t("Tool server")}
                    <input type="url" required className="fi-input" value={a.endpoint} placeholder="https://tools.acme.example/mcp"
                      onChange={(e) => change({ action: { ...a, endpoint: e.target.value } })} />
                  </label>
                  <label className="fi-field">
                    {t("Tool")}
                    <input required className="fi-input" value={a.tool} onChange={(e) => change({ action: { ...a, tool: e.target.value } })} />
                  </label>
                  <label className="fi-field">
                    {t("Arguments")}
                    <textarea rows={4} className="fi-input" value={args} onChange={(e) => setArgs(e.target.value)} />
                    <span className="fi-hint">
                      {t("Use {subject}, {sender}, {body} or {id} in string values. The server host must be allowed by your workspace administrator.", {
                        subject: "{{email.subject}}", sender: "{{email.sender}}", body: "{{email.body}}", preview: "{{email.preview}}", id: "{{email.id}}",
                      })}
                    </span>
                  </label>
                  <label className="fi-field">
                    {t("Credential (optional)")}
                    <input className="fi-input" value={a.tokenRef ?? ""} placeholder="TICKETS_TOKEN"
                      onChange={(e) => change({ action: { ...a, tokenRef: e.target.value || undefined } })} />
                    <span className="fi-hint">{t("The name of a key stored on your server for this tool.")}</span>
                  </label>
                </>
              );
            })()}
          </details>
        </EditorStep>

        <EditorStep n={3} title={t("How")}>
          <label className="fi-check">
            <input type="radio" name="rule-mode" checked={rule.mode === "approval"} onChange={() => change({ mode: "approval" })} />
            <span>{t("Ask me before each action")}</span>
          </label>
          <label className="fi-check">
            <input type="radio" name="rule-mode" checked={rule.mode === "automatic"} onChange={() => change({ mode: "automatic" })} />
            <span>{t("Act on its own")}</span>
          </label>
          <label className="fi-field">
            {t("At most this many actions a day")}
            <input type="number" required min={1} max={100} className="fi-input fi-rules-limit" value={rule.dailyLimit}
              onChange={(e) => change({ dailyLimit: Number(e.target.value) })} />
          </label>
        </EditorStep>

        <EditorStep n={4} title={t("Test run")} refTo={testStep}>
          {recent.isError ? (
            <label className="fi-field">
              {t("Preview message ID")}
              <span className="fi-hint">{t("Recent mail could not be read; enter a message ID instead.")}</span>
              <input className="fi-input" value={messageId} onChange={(e) => setMessageId(e.target.value)} />
            </label>
          ) : recent.isPending ? (
            <p role="status" className="fi-hint">{t("Loading…")}</p>
          ) : recent.data.length === 0 ? (
            <p className="fi-hint">{t("No mail here yet to try the rule on.")}</p>
          ) : (
            <label className="fi-field">
              {t("Try it on")}
              <select className="fi-input" value={messageId} onChange={(e) => setMessageId(e.target.value)}>
                {recent.data.map((m) => <option key={m.providerMessageId} value={m.providerMessageId}>{previewLabel(m, t)}</option>)}
              </select>
            </label>
          )}
          <div className="fi-buttons">
            <button type="button" className="fi-secondary" disabled={busy || !messageId || !ready || !current} onClick={() => void testRun()}>{t("Test run")}</button>
          </div>
          <p className="fi-hint">{t("A test run acts on nothing: no message is sent, moved or changed.")}</p>
          {testFailure && <p role="alert" className="fi-callout is-bad">{testFailure}</p>}
          {result && (
            <div className="fi-callout" aria-live="polite">
              <p><strong>{current ? testRunSentence(current, result.result, result.message, t) : null}</strong> {t("Nothing was changed.")}</p>
              {result.result.matched && result.result.analysis.draft ? (
                <>
                  <p className="fi-hint">{t("The draft it would prepare:")}</p>
                  <pre className="fi-pre">{result.result.analysis.draft}</pre>
                </>
              ) : null}
              <details className="fi-rules-details">
                <summary>{t("Details")}</summary>
                <pre className="fi-pre">{JSON.stringify(result.result, null, 2)}</pre>
              </details>
            </div>
          )}
        </EditorStep>
      </div>

      {failure && <p role="alert" className="fi-callout is-bad">{failure}</p>}
      <div className="fi-rules-footer">
        <button type="submit" className="fi-primary" disabled={busy || !ready || locked}>{wasOn ? t("Save") : t("Turn on")}</button>
        <button type="button" className="fi-secondary" disabled={busy || !ready || !current} onClick={() => void save(false)}>
          {wasOn ? t("Save and pause") : t("Save without turning on")}
        </button>
        <button type="button" className="fi-text-button" onClick={onClose}>{t("Cancel")}</button>
        {!ready ? (
          <p className="fi-hint">{t("Fill in at least one condition under When.")}</p>
        ) : !current ? (
          <p className="fi-hint">{t("The tool's arguments are not valid JSON.")}</p>
        ) : locked ? (
          <p className="fi-hint">{t("Test-run it on a message first, so you see what it will do.")}</p>
        ) : null}
      </div>
    </form>
  );
}
