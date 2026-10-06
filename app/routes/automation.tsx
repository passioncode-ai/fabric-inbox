import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { fabric } from "~/services/fabric";
import { useWindowActive } from "~/hooks/useWindowActive";
import { AUTOMATION_POLL_MS, pollInterval } from "~/lib/window-activity";
import type { OutboxEntry } from "../../shared/mail/outbox";
import type { Rule, Run } from "../../workers/automation/policy";
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
export function meta() {
  return [{ title: "Rules · Fabric Inbox" }];
}
export default function Automation() {
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
  const change = (value: Partial<Rule>) =>
    setEditing((old) => (old ? { ...old, ...value } : old));
  function edit(rule: Rule) {
    setEditing(structuredClone(rule));
    setArgs(
      rule.action.type === "mcp"
        ? JSON.stringify(rule.action.arguments, null, 2)
        : "{}",
    );
    setPreview("");
    setNotice("");
  }
  function value() {
    if (!editing) throw Error("Choose a rule");
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
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-5xl p-6 text-kumo-default">
      <Link className="underline" to={/^(gmail|imap|outlook):/.test(account) ? `/settings/accounts/${encodeURIComponent(account)}` : `/settings/addresses/${encodeURIComponent(account)}/rules`}>
        ← Settings
      </Link>
      <div className="my-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Rules and history</h1>
          <p className="mt-2 text-kumo-subtle break-all">{account}</p>
        </div>
        <Button onClick={() => edit(fresh())}>New rule</Button>
      </div>
      <p className="mb-6 text-kumo-subtle">
        Rules apply to new incoming mail. Start with approval, preview a
        message, then enable the rule. Pausing stops new actions; it cannot undo
        completed work.
      </p>
      {(rules.error || runs.error) && (
        <p role="alert">
          Rules or history could not load.{" "}
          <button
            onClick={() => {
              rules.refetch();
              runs.refetch();
            }}
          >
            Retry
          </button>
        </p>
      )}
      {notice && (
        <p role="alert" className="my-4">
          {notice}
        </p>
      )}
      <section aria-label="Saved rules" className="space-y-3">
        {rules.data?.length === 0 && <p>No rules yet.</p>}
        {rules.data?.map((rule) => (
          <div
            className="rounded-xl border border-kumo-line p-4 flex flex-wrap items-center justify-between gap-4"
            key={rule.id}
          >
            <div>
              <h2 className="font-semibold">{rule.name}</h2>
              <p className="text-sm text-kumo-subtle">
                {rule.enabled ? "Enabled" : "Paused"} ·{" "}
                {rule.mode === "approval" ? "Requires approval" : "Automatic"} ·{" "}
                {rule.action.type.replaceAll("_", " ")} · {rule.dailyLimit}/day
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
                {rule.enabled ? "Pause" : "Enable"}
              </Button>
              <Button variant="secondary" onClick={() => edit(rule)}>
                Edit
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
          <h2 className="text-xl font-semibold">Rule settings</h2>
          <label className="block">
            Name
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
              From address (optional)
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
              Subject contains (optional)
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
            AI condition (optional)
            <textarea
              className={input}
              maxLength={1000}
              placeholder="For example: a customer is asking to reschedule a meeting"
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
            Action
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
              <option value="archive">Archive</option>
              <option value="mark_read">Mark read</option>
              <option value="draft">Prepare a reply draft</option>
              <option value="forward">Forward message</option>
              <option value="mcp">Call a cloud tool (MCP)</option>
            </select>
          </label>
          {editing.action.type === "forward" && (
            <label className="block">
              Forward to
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
                Forwards message text. Messages with attachments require manual
                handling.
              </span>
            </label>
          )}
          {editing.action.type === "mcp" && (
            <>
              <label className="block">
                Tool server URL
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
                Tool name
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
                Arguments (JSON)
                <textarea
                  rows={4}
                  className={input}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <p className="text-sm text-kumo-subtle">
                Use {"{{email.subject}}"}, {"{{email.sender}}"},{" "}
                {"{{email.body}}"} or {"{{email.id}}"} in string values. The
                server host must be allowed by your workspace administrator.
              </p>
              <label className="block">
                Credential name (optional)
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
              Execution
              <select
                className={input}
                value={editing.mode}
                onChange={(e) =>
                  change({ mode: e.target.value as Rule["mode"] })
                }
              >
                <option value="approval">Ask for approval</option>
                <option value="automatic">Automatic</option>
              </select>
            </label>
            <label>
              Daily action limit
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
              onChange={(e) => change({ enabled: e.target.checked })}
            />
            Enable for new incoming mail
          </label>
          <div className="border-t border-kumo-line pt-4">
            <label className="block">
              Preview message ID
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
                perform(async () =>
                  setPreview(
                    JSON.stringify(
                      await fabric(base + "/dry-run", {
                        emailId: messageId,
                        rule: value(),
                      }),
                      null,
                      2,
                    ),
                  ),
                )
              }
            >
              Dry-run
            </Button>
            <p className="mt-2 text-sm text-kumo-subtle">
              Preview only. No message is sent, moved or changed.
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
            <Button type="submit" disabled={busy}>
              Save rule
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <section className="mt-10">
        <h2 className="mb-4 text-xl font-semibold">Recent runs</h2>
        {runs.data?.length === 0 && (
          <p className="text-kumo-subtle">
            No runs yet. History appears when an enabled rule matches new mail.
          </p>
        )}
        {runs.data?.map((run) => (
          <article className="border-b border-kumo-line py-4" key={run.id}>
            <div className="flex flex-wrap justify-between gap-2">
              <h3 className="font-semibold">
                {run.rule.name} · {run.subject || "(No subject)"}
              </h3>
              <span>{run.status.replaceAll("_", " ")}</span>
            </div>
            <p className="my-2 text-sm text-kumo-subtle">
              {new Date(run.createdAt).toLocaleString()} ·{" "}
              {run.rule.action.type === "forward"
                ? "Forward to " + run.rule.action.to
                : run.rule.action.type === "mcp"
                  ? run.rule.action.tool +
                    " at " +
                    new URL(run.rule.action.endpoint).host
                  : run.rule.action.type.replaceAll("_", " ")}
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
            {run.detail && <p>{run.detail}</p>}
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
                Approve this action
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
                Cancel run
              </Button>
            )}
          </article>
        ))}
      </section>
      {!/^(gmail|imap|outlook):/.test(account) && (
        <section className="mt-10">
          <h2 className="mb-4 text-xl font-semibold">Outbox</h2>
          <p className="text-kumo-subtle">
            Accepted means the email provider took the message. Recipient
            delivery remains unconfirmed.
          </p>
          {outbox.error && <p role="alert">Outbox could not load.</p>}
          {outbox.data?.length === 0 && <p>No outgoing actions yet.</p>}
          {outbox.data?.map((item) => (
            <div key={item.id} className="border-b border-kumo-line py-3">
              <p>
                {item.status} · {new Date(item.createdAt).toLocaleString()}
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
