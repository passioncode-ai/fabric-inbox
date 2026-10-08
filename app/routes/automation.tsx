/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so tests/automation-ui.test.ts (tsx) renders this file as the app does.
import { useEffect, useRef, useState } from "react";
import { useParams, Link, type MetaArgs } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { metaT, useT, type T } from "../lib/i18n";
import { fabric } from "../services/fabric";
import { msg } from "../../shared/i18n";
import { useWindowActive } from "../hooks/useWindowActive";
import { AUTOMATION_POLL_MS, pollInterval } from "../lib/window-activity";
import type { OutboxEntry } from "../../shared/mail/outbox";
import type { Rule, Run } from "../../workers/automation/policy";
import type { RunCheck } from "../../workers/automation/index";
const input =
  "w-full rounded-md border border-kumo-line bg-kumo-base p-2 text-kumo-default";
const fresh = (): Rule => ({
  id: crypto.randomUUID(),
  version: 1,
  name: "",
  enabled: false,
  mode: "approval",
  conditions: {},
  action: { type: "archive" },
  dailyLimit: 20,
});
/** What a dry-run reviews: the whole rule but its saved version and whether it is enabled. */
export function ruleReviewKey(rule: Rule): string {
  return JSON.stringify({ ...rule, version: 0, enabled: false });
}
/**
 * The pre-enable review gate (FLW-05): a new or edited rule can be enabled only after a
 * dry-run of the current form values succeeded. An enabled rule saved unchanged — and any
 * pause — needs no dry-run.
 */
export function enableLocked(
  currentKey: string | null,
  saved: { key: string; enabled: boolean } | null,
  dryRunKey: string,
): boolean {
  if (currentKey !== null && saved?.enabled && saved.key === currentKey) return false;
  return currentKey === null || currentKey !== dryRunKey;
}
/** A run's status in words; an unknown one shows as it came. */
function runStatusText(status: string, t: T): string {
  switch (status) {
    case "pending": return t("[run] pending");
    case "running": return t("[run] running");
    case "waiting_approval": return t("[run] waiting approval");
    case "waiting_device": return t("[run] waiting device");
    case "succeeded": return t("[run] succeeded");
    case "skipped": return t("[run] skipped");
    case "failed": return t("[run] failed");
    case "unknown": return t("[run] unknown");
    case "cancelled": return t("[run] cancelled");
    default: return status.replaceAll("_", " ");
  }
}
/** A rule's action in words. */
function actionText(type: string, t: T): string {
  switch (type) {
    case "archive": return t("[action] archive");
    case "mark_read": return t("[action] mark read");
    case "draft": return t("[action] draft");
    case "forward": return t("[action] forward");
    case "mcp": return t("[action] mcp");
    default: return type.replaceAll("_", " ");
  }
}
/** An outbox entry's status in words. */
function outboxStatusText(status: string, t: T): string {
  switch (status) {
    case "pending": return t("[outbox] pending");
    case "sending": return t("[outbox] sending");
    case "accepted": return t("[outbox] accepted");
    case "failed": return t("[outbox] failed");
    case "unknown": return t("[outbox] unknown");
    default: return status;
  }
}
/**
 * Whether a run card offers "Check status" (SCN-020): only an uncertain run, and only when its
 * action leaves a record the server can read — a tool call (mcp) does not.
 */
export function runCheckable(run: Pick<Run, "status" | "rule" | "proposal">): boolean {
  return run.status === "unknown" && (run.proposal?.action ?? run.rule.action).type !== "mcp";
}
export function meta({ matches }: MetaArgs) {
  const t = metaT(matches);
  return [{ title: t("Rules · Fabric Inbox") }];
}
export default function Automation() {
  const t = useT();
  const { account = "" } = useParams();
  const base = "/api/automation/" + encodeURIComponent(account);
  // Runs and the outbox poll every 30 s, and only while this window is visible and focused
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
  const rules = useQuery({
    queryKey: ["rules", account],
    queryFn: () => fabric<Rule[]>(base + "/rules"),
  });
  const runs = useQuery({
    queryKey: ["runs", account],
    queryFn: () => fabric<Run[]>(base + "/runs"),
    refetchInterval: pollInterval(active, AUTOMATION_POLL_MS),
  });
  const outbox = useQuery({
    queryKey: ["outbox", account],
    queryFn: () =>
      fabric<OutboxEntry[]>(
        "/api/v1/mailboxes/" + encodeURIComponent(account) + "/outbox",
      ),
    enabled: !/^(gmail|imap|outlook):/.test(account),
    refetchInterval: pollInterval(active, AUTOMATION_POLL_MS),
  });
  const [editing, setEditing] = useState<Rule | null>(null);
  const [args, setArgs] = useState("{}");
  const [messageId, setMessageId] = useState("");
  const [preview, setPreview] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ key: string; enabled: boolean } | null>(null);
  const [dryRunKey, setDryRunKey] = useState("");
  // Per run: a check in flight, or what the last check found (or why it could not run).
  const [checks, setChecks] = useState<Record<string, { busy: boolean; text?: string; failed?: boolean }>>({});
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
  const change = (value: Partial<Rule>) =>
    setEditing((old) => (old ? { ...old, ...value } : old));
  function edit(rule: Rule) {
    setEditing(structuredClone(rule));
    setSaved({ key: ruleReviewKey(rule), enabled: rule.enabled });
    setDryRunKey("");
    setArgs(
      rule.action.type === "mcp"
        ? JSON.stringify(rule.action.arguments, null, 2)
        : "{}",
    );
    setPreview("");
    setNotice("");
  }
  function value() {
    if (!editing) throw Error(msg("Choose a rule"));
    return {
      ...editing,
      action:
        editing.action.type === "mcp"
          ? { ...editing.action, arguments: JSON.parse(args) }
          : editing.action,
    };
  }
  async function perform(fn: () => Promise<unknown>) {
    setBusy(true);
    setNotice("");
    try {
      await fn();
      await Promise.all([rules.refetch(), runs.refetch()]);
    } catch (e) {
      setNotice(t.text((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  // The key of the values on screen; invalid MCP arguments count as changed, so Enable stays locked.
  let currentKey: string | null = null;
  try {
    currentKey = editing ? ruleReviewKey(value()) : null;
  } catch {
    currentKey = null;
  }
  const locked = enableLocked(currentKey, saved, dryRunKey);
  return (
    <main className="mx-auto max-w-5xl p-6 text-kumo-default">
      <Link className="underline" to={/^(gmail|imap|outlook):/.test(account) ? `/settings/accounts/${encodeURIComponent(account)}` : `/settings/addresses/${encodeURIComponent(account)}/rules`}>
        {t("← Settings")}
      </Link>
      <div className="my-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">{t("Rules and history")}</h1>
          <p className="mt-2 text-kumo-subtle break-all">{account}</p>
        </div>
        <Button onClick={() => edit(fresh())}>{t("New rule")}</Button>
      </div>
      <p className="mb-6 text-kumo-subtle">
        {t("Rules apply to new incoming mail. Start with approval, preview a message, then enable the rule. Pausing stops new actions; it cannot undo completed work.")}
      </p>
      {(rules.error || runs.error) && (
        <p role="alert">
          {t("Rules or history could not load.")}{" "}
          <button
            onClick={() => {
              rules.refetch();
              runs.refetch();
            }}
          >
            {t("Retry")}
          </button>
        </p>
      )}
      {notice && (
        <p role="alert" className="my-4">
          {notice}
        </p>
      )}
      <section aria-label={t("Saved rules")} className="space-y-3">
        {rules.data?.length === 0 && <p>{t("No rules yet.")}</p>}
        {rules.data?.map((rule) => (
          <div
            className="rounded-xl border border-kumo-line p-4 flex flex-wrap items-center justify-between gap-4"
            key={rule.id}
          >
            <div>
              <h2 className="font-semibold">{rule.name}</h2>
              <p className="text-sm text-kumo-subtle">
                {rule.enabled ? t("Enabled") : t("Paused")} ·{" "}
                {t("v{version}", { version: rule.version })} ·{" "}
                {rule.mode === "approval" ? t("Requires approval") : t("Automatic")} ·{" "}
                {actionText(rule.action.type, t)} · {t("{limit}/day", { limit: rule.dailyLimit })}
              </p>
            </div>
            <div className="flex gap-3">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  perform(() =>
                    fabric(
                      base + "/rules",
                      { ...rule, enabled: !rule.enabled },
                      "PUT",
                    ),
                  )
                }
              >
                {rule.enabled ? t("Pause") : t("Enable")}
              </Button>
              <Button variant="secondary" onClick={() => edit(rule)}>
                {t("Edit")}
              </Button>
            </div>
          </div>
        ))}
      </section>
      {editing && (
        <form
          className="my-8 rounded-xl border border-kumo-line bg-kumo-base p-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            perform(async () => {
              await fabric(base + "/rules", value(), "PUT");
              setEditing(null);
            });
          }}
        >
          <h2 className="text-xl font-semibold">
            {t("Rule settings")}{" "}
            <span className="text-sm font-normal text-kumo-subtle">
              {t("v{version}", { version: editing.version })}
            </span>
          </h2>
          <label className="block">
            {t("Name")}
            <input
              required
              maxLength={100}
              className={input}
              value={editing.name}
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              {t("From address (optional)")}
              <input
                type="email"
                className={input}
                value={editing.conditions.from ?? ""}
                onChange={(e) =>
                  change({
                    conditions: {
                      ...editing.conditions,
                      from: e.target.value || undefined,
                    },
                  })
                }
              />
            </label>
            <label>
              {t("Subject contains (optional)")}
              <input
                maxLength={200}
                className={input}
                value={editing.conditions.subject ?? ""}
                onChange={(e) =>
                  change({
                    conditions: {
                      ...editing.conditions,
                      subject: e.target.value || undefined,
                    },
                  })
                }
              />
            </label>
          </div>
          <label className="block">
            {t("AI condition (optional)")}
            <textarea
              className={input}
              maxLength={1000}
              placeholder={t("For example: a customer is asking to reschedule a meeting")}
              value={editing.conditions.ai ?? ""}
              onChange={(e) =>
                change({
                  conditions: {
                    ...editing.conditions,
                    ai: e.target.value || undefined,
                  },
                })
              }
            />
          </label>
          <label className="block">
            {t("Action")}
            <select
              className={input}
              value={editing.action.type}
              onChange={(e) => {
                const type = e.target.value as Rule["action"]["type"];
                change({
                  action:
                    type === "forward"
                      ? { type, to: "" }
                      : type === "mcp"
                        ? {
                            type,
                            endpoint: "",
                            tool: "",
                            arguments: {},
                            location: "cloud",
                          }
                        : { type },
                });
              }}
            >
              <option value="archive">{t("Archive")}</option>
              <option value="mark_read">{t("Mark read")}</option>
              <option value="draft">{t("Prepare a reply draft")}</option>
              <option value="forward">{t("Forward message")}</option>
              <option value="mcp">{t("Call a cloud tool (MCP)")}</option>
            </select>
          </label>
          {editing.action.type === "forward" && (
            <label className="block">
              {t("Forward to")}
              <input
                required
                type="email"
                className={input}
                value={editing.action.to}
                onChange={(e) =>
                  change({ action: { type: "forward", to: e.target.value } })
                }
              />
              <span className="text-sm text-kumo-subtle">
                {t("Forwards message text. Messages with attachments require manual handling.")}
              </span>
            </label>
          )}
          {editing.action.type === "mcp" && (
            <>
              <label className="block">
                {t("Tool server URL")}
                <input
                  type="url"
                  required
                  className={input}
                  value={editing.action.endpoint}
                  onChange={(e) =>
                    editing.action.type === "mcp" &&
                    change({
                      action: { ...editing.action, endpoint: e.target.value },
                    })
                  }
                />
              </label>
              <label className="block">
                {t("Tool name")}
                <input
                  required
                  className={input}
                  value={editing.action.tool}
                  onChange={(e) =>
                    editing.action.type === "mcp" &&
                    change({
                      action: { ...editing.action, tool: e.target.value },
                    })
                  }
                />
              </label>
              <label className="block">
                {t("Arguments (JSON)")}
                <textarea
                  rows={4}
                  className={input}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <p className="text-sm text-kumo-subtle">
                {t("Use {subject}, {sender}, {body} or {id} in string values. The server host must be allowed by your workspace administrator.", {
                  subject: "{{email.subject}}",
                  sender: "{{email.sender}}",
                  body: "{{email.body}}",
                  id: "{{email.id}}",
                })}
              </p>
              <label className="block">
                {t("Credential name (optional)")}
                <input
                  className={input}
                  value={editing.action.tokenRef ?? ""}
                  onChange={(e) =>
                    editing.action.type === "mcp" &&
                    change({
                      action: {
                        ...editing.action,
                        tokenRef: e.target.value || undefined,
                      },
                    })
                  }
                />
              </label>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              {t("Execution")}
              <select
                className={input}
                value={editing.mode}
                onChange={(e) =>
                  change({ mode: e.target.value as Rule["mode"] })
                }
              >
                <option value="approval">{t("Ask for approval")}</option>
                <option value="automatic">{t("Automatic")}</option>
              </select>
            </label>
            <label>
              {t("Daily action limit")}
              <input
                type="number"
                required
                min={1}
                max={100}
                className={input}
                value={editing.dailyLimit}
                onChange={(e) => change({ dailyLimit: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={editing.enabled}
              disabled={locked && !editing.enabled}
              onChange={(e) => change({ enabled: e.target.checked })}
            />
            {t("Enable for new incoming mail")}
          </label>
          {locked && (
            <p className="text-sm text-kumo-subtle">
              {t("Preview the rule with a dry-run before enabling it.")}
            </p>
          )}
          <div className="border-t border-kumo-line pt-4">
            <label className="block">
              {t("Preview message ID")}
              <input
                className={input}
                value={messageId}
                onChange={(e) => setMessageId(e.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !messageId}
              onClick={() =>
                perform(async () => {
                  const rule = value();
                  setPreview(
                    JSON.stringify(
                      await fabric(base + "/dry-run", {
                        emailId: messageId,
                        rule,
                      }),
                      null,
                      2,
                    ),
                  );
                  setDryRunKey(ruleReviewKey(rule));
                })
              }
            >
              {t("Dry-run")}
            </Button>
            <p className="mt-2 text-sm text-kumo-subtle">
              {t("Preview only. No message is sent, moved or changed.")}
            </p>
            {preview && (
              <pre
                aria-live="polite"
                className="mt-3 whitespace-pre-wrap break-words text-sm"
              >
                {preview}
              </pre>
            )}
          </div>
          <div className="flex gap-3">
            <Button type="submit" disabled={busy || (editing.enabled && locked)}>
              {t("Save rule")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditing(null)}
            >
              {t("Cancel")}
            </Button>
          </div>
        </form>
      )}
      <section className="mt-10">
        <h2 className="mb-4 text-xl font-semibold">{t("Recent runs")}</h2>
        {runs.isPending && <p className="text-kumo-subtle">{t("Loading…")}</p>}
        {runs.data?.length === 0 && (
          <p className="text-kumo-subtle">
            {t("No runs yet. History appears when an enabled rule matches new mail.")}
          </p>
        )}
        {runs.data?.map((run) => (
          <article className="border-b border-kumo-line py-4" key={run.id}>
            <div className="flex flex-wrap justify-between gap-2">
              <h3 className="font-semibold">
                {run.rule.name} · {run.subject || t("(No subject)")}
              </h3>
              <span>{runStatusText(run.status, t)}</span>
            </div>
            <p className="my-2 text-sm text-kumo-subtle">
              {t.dateTime(run.createdAt)} ·{" "}
              {t("v{version}", { version: run.rule.version })} ·{" "}
              {t.plural(run.attempts ?? 0, { one: "{n} attempt", other: "{n} attempts" })} ·{" "}
              {t("Cost unavailable")} ·{" "}
              {run.rule.action.type === "forward"
                ? t("Forward to {address}", { address: run.rule.action.to })
                : run.rule.action.type === "mcp"
                  ? t("{tool} at {host}", {
                      tool: run.rule.action.tool,
                      host: new URL(run.rule.action.endpoint).host,
                    })
                  : actionText(run.rule.action.type, t)}
            </p>
            {run.proposal && run.status === "waiting_approval" && (
              <pre className="my-3 whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(run.proposal.action, null, 2)}
              </pre>
            )}
            {run.analysis && <p className="my-2">{run.analysis.summary}</p>}
            {run.analysis?.draft && (
              <pre className="my-3 whitespace-pre-wrap text-sm">
                {run.analysis.draft}
              </pre>
            )}
            {run.detail && <p>{t.text(run.detail)}</p>}
            {run.status === "unknown" && !runCheckable(run) && (
              <p role="note" className="mt-2 text-sm text-kumo-subtle">
                {t("A tool call leaves no receipt on this server. Check the tool's own service before repeating it.")}
              </p>
            )}
            {run.status === "unknown" && run.checkedAt && (
              <p className="mt-2 text-sm text-kumo-subtle">
                {t("Last checked {time}", { time: t.dateTime(run.checkedAt) })}
              </p>
            )}
            {checks[run.id]?.text && (run.status === "unknown" || checks[run.id]?.failed) && (
              <p role={checks[run.id]?.failed ? "alert" : "status"} className="mt-2 text-sm">
                {checks[run.id]?.text}
              </p>
            )}
            {runCheckable(run) && (
              <Button
                className="mt-3"
                variant="secondary"
                disabled={!!checks[run.id]?.busy}
                onClick={() => checkRun(run.id)}
              >
                {checks[run.id]?.busy ? t("Checking…") : t("Check status")}
              </Button>
            )}
            {run.status === "waiting_approval" && (
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() =>
                  perform(() =>
                    fabric(base + "/runs/" + run.id + "/approve", {}),
                  )
                }
              >
                {t("Approve this action")}
              </Button>
            )}
            {["pending", "waiting_approval", "waiting_device"].includes(
              run.status,
            ) && (
              <Button
                className="ml-3 mt-3"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  perform(() =>
                    fabric(base + "/runs/" + run.id + "/dismiss", {}),
                  )
                }
              >
                {t("Cancel run")}
              </Button>
            )}
          </article>
        ))}
      </section>
      {!/^(gmail|imap|outlook):/.test(account) && (
        <section className="mt-10">
          <h2 className="mb-4 text-xl font-semibold">{t("Outbox")}</h2>
          <p className="text-kumo-subtle">
            {t("Accepted means the email provider took the message. Recipient delivery remains unconfirmed.")}
          </p>
          {outbox.error && <p role="alert">{t("Outbox could not load.")}</p>}
          {outbox.data?.length === 0 && <p>{t("No outgoing actions yet.")}</p>}
          {outbox.data?.map((item) => (
            <div key={item.id} className="border-b border-kumo-line py-3">
              <p>
                {outboxStatusText(item.status, t)} · {t.dateTime(item.createdAt)}
              </p>
              <p className="text-sm break-all">{item.id}</p>
              {item.errorCode && <p>{item.errorCode}</p>}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
