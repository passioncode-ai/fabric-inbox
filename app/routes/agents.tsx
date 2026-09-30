import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { useState } from "react";
import { fabric } from "~/services/fabric";
import { ApiError } from "~/services/api";
import type { CollectionList } from "~/services/knowledge";
import {
  blankAgent,
  RUN_STATUS_TEXT,
  type Agent,
  type AgentInput,
  type AgentList,
  type AgentRun,
  type ToolGrant,
} from "~/services/agents";

export function meta() {
  return [{ title: "Agents · Fabric Inbox" }];
}

const inputClass = "mt-1 w-full rounded-lg border border-kumo-line bg-transparent px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium";

function errorText(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string } | undefined;
    return body?.error || error.message;
  }
  return (error as Error).message;
}

/** When the daily send count starts again, in the viewer's own time (the count is kept per UTC day). */
function resetTime() {
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const RUN_PAGE = 50;
const OUTCOME_FILTERS = [
  { id: "", label: "Everything" },
  { id: "answered", label: "Sent or drafted" },
  { id: "attention", label: "Needs a look" },
  { id: "skipped", label: "Left alone" },
] as const;

function policySummary(agent: AgentInput) {
  const p = agent.replyPolicy;
  if (p.mode === "draft") return "Drafts every answer for you";
  const intents = p.allowedIntents.length ? p.allowedIntents.join(", ") : "any grounded answer";
  return `Sends ${intents} · up to ${p.dailySendLimit} a day per address`;
}

/** SCR-10: reusable agents, their limits, and what they did. */
export default function Agents() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["agents"], queryFn: () => fabric<AgentList>("/api/agents") });
  const [outcome, setOutcome] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const runs = useInfiniteQuery({
    queryKey: ["agent-runs", outcome, agentFilter],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(RUN_PAGE) });
      if (outcome) q.set("outcome", outcome);
      if (agentFilter) q.set("agent", agentFilter);
      if (pageParam) q.set("before", pageParam);
      return fabric<AgentRun[]>(`/api/agent-runs?${q}`);
    },
    getNextPageParam: (last) => (last.length < RUN_PAGE ? undefined : `${last[last.length - 1].createdAt}|${last[last.length - 1].id}`),
    // Refreshing rewrites every loaded page; only the first page is kept fresh.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 20_000),
  });
  const runList = runs.data?.pages.flat() ?? [];
  const [editing, setEditing] = useState<{ id?: string; version?: number; input: AgentInput } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function save() {
    if (!editing) return;
    setBusy(true);
    setNotice("");
    try {
      const saved = editing.id
        ? await fabric<Agent>(`/api/agents/${encodeURIComponent(editing.id)}`, { agent: editing.input, expectedVersion: editing.version }, "PUT")
        : await fabric<Agent>("/api/agents", { agent: editing.input });
      setNotice(`Saved ${saved.name}, version ${saved.version}.`);
      setEditing(null);
      setConflict(false);
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (error) {
      // The form keeps its input; a conflict names the newer version and offers it.
      setConflict(error instanceof ApiError && error.status === 409);
      setNotice(`Not saved: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(agent: Agent) {
    setBusy(true);
    try {
      await fabric(`/api/agents/${encodeURIComponent(agent.id)}`, undefined, "DELETE");
      setNotice(`${agent.name} was deleted. Its addresses are now Off.`);
      setConfirmDelete(null);
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (error) {
      setNotice(`Not deleted: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /** A conflict: load the newest version into the form, keeping nothing of the stale one. */
  async function reloadNewest() {
    if (!editing?.id) return;
    setBusy(true);
    try {
      const fresh = await fabric<Agent>(`/api/agents/${encodeURIComponent(editing.id)}`);
      setEditing({ id: fresh.id, version: fresh.version, input: editInput(fresh) });
      setConflict(false);
      setNotice(`Loaded version ${fresh.version}. Make your change again and save.`);
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (error) {
      setNotice(`Could not load the newest version: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const agentName = (id?: string) => list.data?.agents.find((a) => a.id === id)?.name ?? id ?? "—";

  const collectionsQuery = useQuery({ queryKey: ["knowledge-collections"], queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });

  const collectionName = (id: string) => collectionsQuery.data?.collections.find((c) => c.id === id)?.name ?? id;

  return (
    <main className="mx-auto max-w-4xl p-6 text-kumo-default">
      <nav className="flex gap-4 text-sm">
        <Link to="/">← Fabric Inbox</Link>
        <Link to="/projects" className="underline">Domains &amp; addresses</Link>
        <Link to="/categories" className="underline">Categories</Link>
      </nav>
      <h1 className="mt-8 text-3xl font-semibold">Agents</h1>
      <p className="my-3 text-kumo-subtle">
        An agent answers mail on the addresses you give it. Define it once, use it on many addresses. Every save is a new version;
        each answer records the version that wrote it.
      </p>
      {notice && (
        <p role="status" className="my-4 rounded-lg border border-kumo-line p-3">
          {notice}
          {conflict && editing?.id && <> <button className="underline" disabled={busy} onClick={() => void reloadNewest()}>Load the newest version</button></>}
        </p>
      )}

      {!editing && (
        <section className="my-6 flex flex-wrap items-center gap-2" aria-label="New agent">
          <span className="mr-2 text-sm font-medium">New agent from</span>
          {Object.entries(list.data?.templates ?? {}).map(([key, template]) => (
            <button key={key} className="fi-secondary" onClick={() => setEditing({ input: structuredClone(template) })}>
              {template.name}
            </button>
          ))}
          <button className="fi-secondary" onClick={() => setEditing({ input: blankAgent() })}>Blank</button>
        </section>
      )}

      {editing && (
        <AgentEditor
          value={editing.input}
          version={editing.version}
          toolHosts={list.data?.toolHosts ?? []}
          busy={busy}
          onChange={(input) => setEditing({ ...editing, input })}
          onSave={() => void save()}
          onCancel={() => { setEditing(null); setNotice(""); setConflict(false); }}
        />
      )}

      <section className="my-6" aria-labelledby="agents-heading">
        <h2 id="agents-heading" className="text-xl font-medium">Your agents</h2>
        {list.isPending ? (
          <p role="status" className="my-3 text-kumo-subtle">Loading agents…</p>
        ) : list.isError ? (
          <p role="alert" className="my-3">Agents could not load: {errorText(list.error)} <button className="underline" onClick={() => void list.refetch()}>Retry</button></p>
        ) : !list.data.agents.length ? (
          <p className="my-3 text-kumo-subtle">No agents yet. Start from a template above; nothing answers mail until you put an agent on an address.</p>
        ) : (
          list.data.agents.map((agent) => (
            <article key={agent.id} className="mt-4 rounded-xl border border-kumo-line p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="text-lg font-medium">{agent.name} <span className="text-sm font-normal text-kumo-subtle">v{agent.version}</span></h3>
                <div className="flex gap-2">
                  {/* One form at a time: switching agents mid-edit would drop the unsaved change. */}
                  <button className="fi-secondary" disabled={busy || !!editing}
                    title={editing ? "Save or cancel the open form first" : undefined}
                    onClick={() => setEditing({ id: agent.id, version: agent.version, input: editInput(agent) })}>Edit</button>
                  {confirmDelete === agent.id ? (
                    <>
                      <button className="fi-secondary" disabled={busy} onClick={() => void remove(agent)}>Delete {agent.name}</button>
                      <button className="fi-secondary" onClick={() => setConfirmDelete(null)}>Keep</button>
                    </>
                  ) : (
                    <button className="fi-secondary" disabled={busy || editing?.id === agent.id} onClick={() => setConfirmDelete(agent.id)}>Delete…</button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-sm">{policySummary(agent)}</p>
              <p className="mt-1 text-sm text-kumo-subtle">
                {agent.tools.length ? `Tools: ${agent.tools.map((t) => `${t.name} (${new URL(t.endpoint).hostname})`).join(", ")}` : "No tools"}
              </p>
              <p className="mt-1 text-sm text-kumo-subtle">
                {agent.collections?.length ? `Searches ${agent.collections.map(collectionName).join(", ")}` : "Searches no knowledge collection"}
                {" · "}<Link className="underline" to="/knowledge">Knowledge</Link>
              </p>
              <p className="mt-1 text-sm text-kumo-subtle">
                {agent.addresses?.length ? `Answers ${agent.addresses.join(", ")}` : "Not on any address yet"}
                {" · "}<Link className="underline" to="/projects">Assign on Domains &amp; addresses</Link>
              </p>
              {confirmDelete === agent.id && (
                <p role="alert" className="mt-2 text-sm">Deleting turns its addresses Off. Past runs keep the version they used.</p>
              )}
            </article>
          ))
        )}
      </section>

      <section className="my-8" aria-labelledby="runs-heading">
        <h2 id="runs-heading" className="text-xl font-medium">Recent answers</h2>
        <p className="mt-1 text-sm text-kumo-subtle">Every message that reached an agent, with its decision and exactly what was sent.</p>
        <div className="mt-3 flex flex-wrap gap-3" role="group" aria-label="Filter the history">
          <label className="text-sm">Show{" "}
            <select className="ml-1 rounded-lg border border-kumo-line bg-transparent px-2 py-1 text-sm" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {OUTCOME_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          {!!list.data?.agents.length && (
            <label className="text-sm">Agent{" "}
              <select className="ml-1 rounded-lg border border-kumo-line bg-transparent px-2 py-1 text-sm" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
                <option value="">All agents</option>
                {list.data.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
        </div>
        {runs.isPending ? (
          <p role="status" className="my-3 text-kumo-subtle">Loading…</p>
        ) : runs.isError && !runList.length ? (
          <p role="alert" className="my-3">History could not load: {errorText(runs.error)} <button className="underline" onClick={() => void runs.refetch()}>Retry</button></p>
        ) : !runList.length ? (
          <p className="my-3 text-kumo-subtle">
            {outcome || agentFilter ? "Nothing matches this filter." : "No answers yet. New mail on an address with an agent appears here."}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-kumo-line rounded-xl border border-kumo-line">
            {runList.map((run) => (
              <li key={run.id} className="p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{RUN_STATUS_TEXT[run.status]}</strong>
                  <time className="text-kumo-subtle" dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
                </div>
                <p className="mt-1">{run.subject || "(No subject)"} — from {run.sender} to {run.mailboxId}</p>
                <p className="mt-1 text-kumo-subtle">
                  {run.agentId ? `${agentName(run.agentId)} v${run.agentVersion}` : "No agent"}
                  {run.intent ? ` · intent: ${run.intent}` : ""} · {run.reason}
                </p>
                {run.status === "send_unknown" && <p className="mt-1" role="note">Check Sent for this address before answering again; it is not retried.</p>}
                {run.sources && run.sources.length > 0 && (
                  <details className="mt-2">
                    <summary>{run.status === "sent" || run.status === "drafted" ? "Answered from" : "Found"} {run.sources.length} passage{run.sources.length > 1 ? "s" : ""}</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {run.sources.map((s) => (
                        <li key={s.ref}><Link className="underline" to={`/knowledge?c=${encodeURIComponent(s.collectionId)}`}>{s.title}</Link> <span className="text-kumo-subtle">· {s.sourceUri} · {collectionName(s.collectionId)}</span></li>
                      ))}
                    </ul>
                  </details>
                )}
                {run.toolCalls.length > 0 && (
                  <details className="mt-2">
                    <summary>{run.toolCalls.length} tool call{run.toolCalls.length > 1 ? "s" : ""}</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {run.toolCalls.map((call, i) => (
                        <li key={i}>{call.name} on {call.host} — {call.ok ? "ok" : "failed"}, {call.ms} ms: <span className="text-kumo-subtle">{call.result}</span></li>
                      ))}
                    </ul>
                  </details>
                )}
                {run.sent && (
                  <details className="mt-2">
                    <summary>What was sent to {run.sent.to}</summary>
                    <p className="mt-1 font-medium">{run.sent.subject}</p>
                    <pre className="mt-1 whitespace-pre-wrap font-sans">{run.sent.body}</pre>
                  </details>
                )}
                {run.draftId && (
                  <p className="mt-1"><Link className="underline" to={`/mailbox/${encodeURIComponent(run.mailboxId)}/emails/draft?open=${encodeURIComponent(run.draftId)}`}>Open the draft</Link></p>
                )}
              </li>
            ))}
          </ul>
        )}
        {runs.hasNextPage && (
          <button className="fi-secondary mt-3" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
            {runs.isFetchingNextPage ? "Loading…" : "Show older"}
          </button>
        )}
        {runs.isFetchNextPageError && <p role="alert" className="mt-2 text-sm">Older answers could not load: {errorText(runs.error)}</p>}
      </section>
    </main>
  );
}

function editInput(agent: Agent): AgentInput {
  return { name: agent.name, instructions: agent.instructions, knowledge: agent.knowledge, collections: agent.collections ?? [], tools: agent.tools, replyPolicy: agent.replyPolicy };
}

function AgentEditor({ value, version, toolHosts, busy, onChange, onSave, onCancel }: {
  value: AgentInput; version?: number; toolHosts: string[]; busy: boolean;
  onChange: (value: AgentInput) => void; onSave: () => void; onCancel: () => void;
}) {
  const set = <K extends keyof AgentInput>(key: K, v: AgentInput[K]) => onChange({ ...value, [key]: v });
  const policy = value.replyPolicy;
  const setTool = (index: number, tool: ToolGrant) => set("tools", value.tools.map((t, i) => (i === index ? tool : t)));
  return (
    <form
      className="my-6 rounded-xl border border-kumo-line p-5"
      aria-label={version ? `Edit agent, version ${version}` : "New agent"}
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
    >
      <h2 className="text-xl font-medium">{version ? `Edit ${value.name} (saving creates version ${version + 1})` : "New agent"}</h2>
      <label className={labelClass + " mt-4"}>Name
        <input className={inputClass} required maxLength={80} value={value.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className={labelClass + " mt-4"}>Instructions
        <textarea className={inputClass} required rows={5} maxLength={20000} value={value.instructions} onChange={(e) => set("instructions", e.target.value)} />
      </label>
      <KnowledgeGrants value={value.collections ?? []} onChange={(ids) => set("collections", ids)} />
      <label className={labelClass + " mt-4"}>Notes the agent always sees
        <span className="block text-xs font-normal text-kumo-subtle">A few lines sent with every message, e.g. the product name and tone. Longer material belongs in a collection, which is searched instead. The agent may only state facts from here, its collections or a tool result.</span>
        <textarea className={inputClass} rows={4} maxLength={50000} value={value.knowledge} onChange={(e) => set("knowledge", e.target.value)} />
      </label>

      <fieldset className="mt-5">
        <legend className={labelClass}>Reply policy</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="mode" checked={policy.mode === "draft"} onChange={() => set("replyPolicy", { ...policy, mode: "draft" })} />
          Draft every answer for me to send
        </label>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input type="radio" name="mode" checked={policy.mode === "auto"} onChange={() => set("replyPolicy", { ...policy, mode: "auto" })} />
          Send answers it is allowed to send; draft the rest with the reason
        </label>
        {policy.mode === "auto" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>Allowed intents
              <span className="block text-xs font-normal text-kumo-subtle">Comma-separated, e.g. question, pricing. Empty: any answer grounded in the knowledge.</span>
              <input className={inputClass} value={policy.allowedIntents.join(", ")}
                onChange={(e) => set("replyPolicy", { ...policy, allowedIntents: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </label>
            <label className={labelClass}>Sends per address per day
              <span className="block text-xs font-normal text-kumo-subtle">The count starts again at {resetTime()} your time (midnight UTC).</span>
              <input className={inputClass} type="number" min={1} max={200} value={policy.dailySendLimit}
                onChange={(e) => set("replyPolicy", { ...policy, dailySendLimit: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })} />
            </label>
          </div>
        )}
        <p className="mt-2 text-xs text-kumo-subtle">
          Never answered: no-reply, bulk, list and automatic mail, calendar invitations, and mail from your own domains. A message is
          also left alone once you have replied to it yourself.
        </p>
      </fieldset>

      <fieldset className="mt-5">
        <legend className={labelClass}>Tools</legend>
        <p className="text-xs text-kumo-subtle">
          Remote MCP tools on allowed hosts: {toolHosts.length ? toolHosts.join(", ") : "none — an administrator sets AUTOMATION_MCP_HOSTS"}.
          A tool failure turns the answer into a draft.
        </p>
        {value.tools.map((tool, i) => (
          <div key={i} className="mt-3 grid gap-2 rounded-lg border border-kumo-line p-3 sm:grid-cols-2">
            <label className={labelClass}>Name <input className={inputClass} value={tool.name} pattern="[a-z][a-z0-9_]{0,47}" required onChange={(e) => setTool(i, { ...tool, name: e.target.value })} /></label>
            <label className={labelClass}>Remote tool <input className={inputClass} value={tool.tool} required onChange={(e) => setTool(i, { ...tool, tool: e.target.value })} /></label>
            <label className={labelClass + " sm:col-span-2"}>What the agent may use it for <input className={inputClass} value={tool.description} required onChange={(e) => setTool(i, { ...tool, description: e.target.value })} /></label>
            <label className={labelClass}>Endpoint (https) <input className={inputClass} type="url" value={tool.endpoint} required onChange={(e) => setTool(i, { ...tool, endpoint: e.target.value })} /></label>
            <label className={labelClass}>Credential name (optional) <input className={inputClass} value={tool.tokenRef ?? ""} onChange={(e) => setTool(i, { ...tool, tokenRef: e.target.value || undefined })} /></label>
            <button type="button" className="fi-secondary justify-self-start" onClick={() => set("tools", value.tools.filter((_, j) => j !== i))}>Remove tool</button>
          </div>
        ))}
        <button type="button" className="fi-secondary mt-3" disabled={value.tools.length >= 10}
          onClick={() => set("tools", [...value.tools, { name: "", description: "", endpoint: "https://", tool: "" }])}>Add tool</button>
      </fieldset>

      <div className="mt-6 flex gap-3">
        <button type="submit" className="fi-primary" disabled={busy}>{busy ? "Saving…" : "Save agent"}</button>
        <button type="button" className="fi-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** KN-3: which collections the agent may search; nothing else is searched for it. */
function KnowledgeGrants({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const list = useQuery({ queryKey: ["knowledge-collections"], queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id].slice(0, 10));
  return (
    <fieldset className="mt-4">
      <legend className={labelClass}>Knowledge collections it may search</legend>
      <p className="text-xs text-kumo-subtle">
        Each message is searched in these, and the agent can search them again with other words. It never sees a collection that is not
        ticked. <Link className="underline" to="/knowledge">Manage knowledge</Link>
      </p>
      {list.isPending ? <p role="status" className="mt-2 text-sm">Loading collections…</p> : list.isError ? (
        <p role="alert" className="mt-2 text-sm">Collections could not load: {errorText(list.error)}</p>
      ) : !list.data.collections.length ? (
        <p className="mt-2 text-sm">No collection yet. <Link className="underline" to="/knowledge">Create one</Link>, then come back.</p>
      ) : (
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {list.data.collections.map((c) => (
            <li key={c.id}>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={value.includes(c.id)} onChange={() => toggle(c.id)} />
                <span><strong>{c.name}</strong> <span className="text-kumo-subtle">· {c.documents} document{c.documents === 1 ? "" : "s"}{c.source.kind === "fabric" ? " · from Fabric" : ""}</span>
                  {c.description && <span className="block text-xs text-kumo-subtle">{c.description}</span>}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {value.some((id) => list.data && !list.data.collections.some((c) => c.id === id)) && (
        <p role="alert" className="mt-2 text-sm">A ticked collection no longer exists; untick it before saving.</p>
      )}
    </fieldset>
  );
}
