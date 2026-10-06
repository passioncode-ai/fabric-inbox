import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import { useT, type T } from "../../../lib/i18n";
import { msg } from "../../../../shared/i18n";
import { ApiError } from "~/services/api";
import type { CollectionList } from "~/services/knowledge";
import {
  blankAgent, runStatusText, type Agent, type AgentInput, type AgentList, type AgentRun, type ToolGrant,
} from "~/services/agents";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, PanelTabs, SectionLayout,
  SelectableList, SkeletonPanel, SkeletonRows, errorText, useConfirm, useDirtyGuard, useWork,
} from "../ui";
import { AGENTS_KEY, refreshMail, useAgents } from "./data";
import { policySummary } from "./add-address-model";

interface AgentEntry extends ListEntry { agent: Agent }

const ANSWERS = "answers";
const NEW = "new";
const RUN_PAGE = 50;
const OUTCOME_FILTERS = [
  { id: "", label: msg("Everything") },
  { id: "answered", label: msg("Sent or drafted") },
  { id: "attention", label: msg("Needs a look") },
  { id: "skipped", label: msg("Left alone") },
] as const;
const COLLECTIONS_KEY = ["knowledge-collections"];

/** When the daily send count starts again, in the viewer's own time (the count is kept per UTC day). */
function resetTime(t: T) {
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return t.time(midnight, { hour: "2-digit", minute: "2-digit" });
}

// One wording for a reply policy, here and under Who answers (add-address-model.ts).
export { policySummary };

const editInput = (agent: Agent): AgentInput => ({
  name: agent.name, instructions: agent.instructions, knowledge: agent.knowledge, collections: agent.collections ?? [],
  tools: agent.tools, replyPolicy: agent.replyPolicy,
});

/**
 * Settings → Agents (SCR-10, SCN-022, SCN-023, SCN-034): reusable agents with their reply policy.
 * The editor opens beside the chosen agent; every save is a new version. "Recent answers" is the
 * history of every agent, and each agent has its own.
 */
export default function AgentsSection({ id, tab }: { id: string | null; tab: string | null }) {
  const t = useT();
  const agents = useAgents();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const entries = (agents.data?.agents ?? []).map((a): AgentEntry => ({ key: a.id, group: "agents", agent: a, text: [a.name, ...(a.addresses ?? [])].join(" ") }));
  const groups = groupRows(visibleRows(entries, query, id), [{ id: "agents", label: t("Your agents") }]);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;

  const listView = agents.isPending ? <SkeletonRows label={t("Loading agents…")} /> : agents.isError ? (
    <LoadFailure what={t("Agents")} error={agents.error} onRetry={() => void agents.refetch()} retrying={agents.isFetching} />
  ) : (
    <SelectableList label={t("Agents")} groups={groups} selected={id} hrefFor={(e) => settingsPath("agents", e.key)}
      pinned={[{ key: ANSWERS, href: settingsPath("agents", ANSWERS), content: (
        <span className="fi-row-main"><span className="fi-row-title">{t("Recent answers")}</span><span className="fi-row-meta">{t("What every agent did with each message")}</span></span>
      ) }]}
      renderRow={(e) => (
        <>
          <span className="fi-row-main">
            <span className="fi-row-title">{e.agent.name}</span>
            <span className="fi-row-meta">{e.agent.addresses?.length ? t("Answers {addresses}", { addresses: t.list(e.agent.addresses) }) : t("Not on any address yet")}</span>
          </span>
          <span className="fi-row-side"><Badge>v{e.agent.version}</Badge></span>
        </>
      )}
      empty={<div className="fi-list-empty"><p>{query ? t("No agent matches “{query}”.", { query }) : t("No agents yet. Nothing answers mail until you put an agent on an address.")}</p></div>} />
  );

  const close = () => navigate(settingsPath("agents"), { replace: true, preventScrollReset: true });
  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{t("Choose an agent")}</h2>
      <p>{t("An agent answers mail on the addresses you give it. Define it once, use it on many addresses.")}</p>
      <Link className="fi-primary" to={settingsPath("agents", NEW)} preventScrollReset><PlusIcon size={16} /> {t("New agent")}</Link>
    </PanelPlaceholder>
  ) : id === ANSWERS ? (
    <Panel title={t("Recent answers")} subtitle={t("Every message that reached an agent, with its decision and exactly what was sent.")} closeTo={settingsPath("agents")}>
      <RunsHistory agents={agents.data} />
    </Panel>
  ) : agents.isPending ? <SkeletonPanel label={t("Loading this agent…")} /> : id === NEW ? (
    agents.data ? <NewAgentPanel list={agents.data} onCreated={(a) => navigate(settingsPath("agents", a.id), { replace: true, preventScrollReset: true })} /> : null
  ) : !selected ? (
    <PanelPlaceholder>
      <h2>{t("This agent is not here")}</h2>
      <p>{t("[agent] It may have been deleted.")}</p>
      <Link className="fi-secondary" to={settingsPath("agents")} replace preventScrollReset>{t("All agents")}</Link>
    </PanelPlaceholder>
  ) : (
    <AgentPanel key={selected.key} agent={selected.agent} list={agents.data!} tab={tab === ANSWERS ? ANSWERS : "settings"} onDeleted={close} />
  );

  return (
    <SectionLayout section="agents" hasSelection={!!id} list={listView} panel={panel}
      toolbar={<>
        <ListSearch value={query} onChange={setQuery} placeholder={t("Find an agent or address")} label={t("Find an agent")} />
        <Link className="fi-primary" to={settingsPath("agents", NEW)} preventScrollReset><PlusIcon size={16} /> {t("New agent")}</Link>
      </>} />
  );
}

function NewAgentPanel({ list, onCreated }: { list: AgentList; onCreated: (a: Agent) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const client = useQueryClient();
  const work = useWork(NEW);
  useDirtyGuard(!!draft && !work.busy, t("the new agent"));
  const save = (input: AgentInput) => void work.run(t("Saving…"), async () => {
    const saved = await fabric<Agent>("/api/agents", { agent: input });
    await client.invalidateQueries({ queryKey: AGENTS_KEY });
    setDraft(null);
    setTimeout(() => onCreated(saved), 0);
    return t("Saved {name}, version {version}. Put it on an address under Addresses → Who answers.", { name: saved.name, version: saved.version });
  });
  return (
    <Panel title={t("New agent")} closeTo={settingsPath("agents")}>
      {!draft ? (
        <PanelBlock title={t("Start from")}>
          <div className="fi-provider-cards">
            {Object.entries(list.templates).map(([key, template]) => (
              <button key={key} type="button" className="fi-provider-card" onClick={() => setDraft(structuredClone(template))}>
                <strong>{template.name}</strong><span>{policySummary(template, t)}</span>
              </button>
            ))}
            <button type="button" className="fi-provider-card" onClick={() => setDraft(blankAgent())}>
              <strong>{t("Blank")}</strong><span>{t("Drafts every answer until you change its policy.")}</span>
            </button>
          </div>
        </PanelBlock>
      ) : (
        <AgentEditor value={draft} toolHosts={list.toolHosts} busy={!!work.busy} onChange={setDraft}
          onSave={() => save(draft)} onCancel={() => setDraft(null)} saveLabel={t("Create agent")} />
      )}
      <ActionResult result={work.result} />
    </Panel>
  );
}

function AgentPanel({ agent, list, tab, onDeleted }: { agent: Agent; list: AgentList; tab: "settings" | "answers"; onDeleted: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(agent.id, "edit");
  const removeWork = useWork(agent.id, "delete");
  const [base, setBase] = useState({ version: agent.version, input: editInput(agent) });
  const [value, setValue] = useState(base.input);
  const [conflict, setConflict] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(base.input);
  useDirtyGuard(dirty && !work.busy, agent.name);
  const collections = useQuery({ queryKey: COLLECTIONS_KEY, queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });
  const collectionName = (cid: string) => collections.data?.collections.find((c) => c.id === cid)?.name ?? cid;

  const save = () => void work.run(t("Saving…"), async () => {
    try {
      const saved = await fabric<Agent>(`/api/agents/${encodeURIComponent(agent.id)}`, { agent: value, expectedVersion: base.version }, "PUT");
      setBase({ version: saved.version, input: editInput(saved) });
      setValue(editInput(saved));
      setConflict(false);
      await client.invalidateQueries({ queryKey: AGENTS_KEY });
      return t("Saved {name}, version {version}.", { name: saved.name, version: saved.version });
    } catch (error) {
      // The form keeps its input; a conflict names the newer version and offers it.
      setConflict(error instanceof ApiError && error.status === 409);
      throw new Error(t("Not saved: {error}", { error: t.text(errorText(error)) }));
    }
  });
  /** A conflict: load the newest version into the form, keeping nothing of the stale one. */
  const reloadNewest = () => void work.run(t("Loading…"), async () => {
    const fresh = await fabric<Agent>(`/api/agents/${encodeURIComponent(agent.id)}`);
    setBase({ version: fresh.version, input: editInput(fresh) });
    setValue(editInput(fresh));
    setConflict(false);
    await client.invalidateQueries({ queryKey: AGENTS_KEY });
    return t("Loaded version {version}. Make your change again and save.", { version: fresh.version });
  });
  const remove = async () => {
    const ok = await confirm({
      title: t("Delete {name}?", { name: agent.name }),
      body: <p>{t("Its addresses are turned Off: new mail to them stays for you. Past answers keep the version they used.")}</p>,
      confirmLabel: t("Delete {name}", { name: agent.name }), danger: true,
    });
    if (!ok) return;
    const done = await removeWork.run(t("Deleting…"), async () => {
      try {
        await fabric(`/api/agents/${encodeURIComponent(agent.id)}`, undefined, "DELETE");
        return t("{name} was deleted. Its addresses are now Off.", { name: agent.name });
      } finally { await Promise.all([client.invalidateQueries({ queryKey: AGENTS_KEY }), refreshMail(client)]); }
    });
    if (done) onDeleted();
  };

  return (
    <Panel title={agent.name} subtitle={t("Version {version} · {policy}", { version: base.version, policy: policySummary(agent, t) })} closeTo={settingsPath("agents")}
      menu={<ActionMenu label={t("More actions for {name}", { name: agent.name })} actions={[{ label: t("Delete {name}…", { name: agent.name }), danger: true, onSelect: () => void remove() }]} />}>
      <PanelBlock>
        <ul className="fi-facts">
          <li><strong>{t("Answers")}</strong> {agent.addresses?.length
            ? agent.addresses.map((a, i) => <span key={a}>{i > 0 && ", "}<Link to={settingsPath("addresses", a)}>{a}</Link></span>)
            : <>{t.rich("no address yet — choose it under {addresses} → Who answers", { addresses: <Link key="addresses" to={settingsPath("addresses")}>{t("Addresses")}</Link> })}</>}</li>
          <li><strong>{t("Searches")}</strong> {agent.collections?.length ? t.list(agent.collections.map(collectionName)) : t("no knowledge collection")}</li>
          <li><strong>{t("Tools")}</strong> {agent.tools.length ? t.list(agent.tools.map((tool) => `${tool.name} (${hostOf(tool.endpoint)})`)) : t("none")}</li>
        </ul>
      </PanelBlock>
      <PanelTabs label={`${agent.name}`} current={tab} tabs={[{ id: "settings", label: t("Settings") }, { id: ANSWERS, label: t("Its answers") }]}
        hrefFor={(tab) => settingsPath("agents", agent.id, tab === "settings" ? null : tab)} />
      {tab === "settings" ? (
        <>
          <AgentEditor value={value} version={base.version} toolHosts={list.toolHosts} busy={!!work.busy} onChange={setValue}
            onSave={save} onCancel={dirty ? () => setValue(base.input) : undefined} saveLabel={t("Save agent")} />
          <ActionResult result={work.result} />
          {conflict && <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={reloadNewest}>{t("Load the newest version")}</button>}
        </>
      ) : <RunsHistory agents={list} agentId={agent.id} />}
      <ActionResult result={removeWork.result} />
    </Panel>
  );
}

const hostOf = (endpoint: string) => { try { return new URL(endpoint).hostname; } catch { return endpoint; } };

function AgentEditor({ value, version, toolHosts, busy, onChange, onSave, onCancel, saveLabel }: {
  value: AgentInput; version?: number; toolHosts: string[]; busy: boolean; saveLabel: string;
  onChange: (value: AgentInput) => void; onSave: () => void; onCancel?: () => void;
}) {
  const t = useT();
  const set = <K extends keyof AgentInput>(key: K, v: AgentInput[K]) => onChange({ ...value, [key]: v });
  const policy = value.replyPolicy;
  const setTool = (index: number, tool: ToolGrant) => set("tools", value.tools.map((old, i) => (i === index ? tool : old)));
  return (
    <form aria-label={version ? t("Edit agent, version {version}", { version }) : t("New agent")} onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      {version && <p className="fi-hint">{t("Saving creates version {version}; each answer records the version that wrote it.", { version: version + 1 })}</p>}
      <label className="fi-field">{t("Name")}
        <input className="fi-input" required maxLength={80} value={value.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="fi-field">{t("Instructions")}
        <textarea className="fi-input" required rows={5} maxLength={20000} value={value.instructions} onChange={(e) => set("instructions", e.target.value)} />
      </label>
      <KnowledgeGrants value={value.collections ?? []} onChange={(ids) => set("collections", ids)} />
      <label className="fi-field">{t("Notes the agent always sees")}
        <span className="fi-hint">{t("A few lines sent with every message, e.g. the product name and tone. Longer material belongs in a collection, which is searched instead. The agent may only state facts from here, its collections or a tool result.")}</span>
        <textarea className="fi-input" rows={4} maxLength={50000} value={value.knowledge} onChange={(e) => set("knowledge", e.target.value)} />
      </label>

      <fieldset>
        <legend>{t("Reply policy")}</legend>
        <label className="fi-check"><input type="radio" name="mode" checked={policy.mode === "draft"} onChange={() => set("replyPolicy", { ...policy, mode: "draft" })} />
          <span>{t("Draft every answer for me to send")}</span></label>
        <label className="fi-check"><input type="radio" name="mode" checked={policy.mode === "auto"} onChange={() => set("replyPolicy", { ...policy, mode: "auto" })} />
          <span>{t("Send answers it is allowed to send; draft the rest with the reason")}</span></label>
        {policy.mode === "auto" && (
          <div className="fi-field-row">
            <label className="fi-field">{t("Allowed intents")}
              <span className="fi-hint">{t("Comma-separated, e.g. question, pricing. Empty: any answer grounded in the knowledge.")}</span>
              <input className="fi-input" value={policy.allowedIntents.join(", ")}
                onChange={(e) => set("replyPolicy", { ...policy, allowedIntents: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </label>
            <label className="fi-field">{t("Sends per address per day")}
              <span className="fi-hint">{t("The count starts again at {time} your time (midnight UTC).", { time: resetTime(t) })}</span>
              <input className="fi-input" type="number" min={1} max={200} value={policy.dailySendLimit}
                onChange={(e) => set("replyPolicy", { ...policy, dailySendLimit: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })} />
            </label>
          </div>
        )}
        <p className="fi-hint">{t("Never answered: no-reply, bulk, list and automatic mail, calendar invitations, and mail from your own domains. A message is also left alone once you have replied to it yourself.")}</p>
      </fieldset>

      <fieldset>
        <legend>{t("Tools")}</legend>
        <p className="fi-hint">{t("Remote MCP tools on allowed hosts: {hosts}. A tool failure turns the answer into a draft.", { hosts: toolHosts.length ? toolHosts.join(", ") : t("none — an administrator sets AUTOMATION_MCP_HOSTS") })}</p>
        {value.tools.map((tool, i) => (
          <div key={i} className="fi-callout">
            <div className="fi-field-row">
              <label className="fi-field">{t("Name")} <input className="fi-input" value={tool.name} pattern="[a-z][a-z0-9_]{0,47}" required onChange={(e) => setTool(i, { ...tool, name: e.target.value })} /></label>
              <label className="fi-field">{t("Remote tool")} <input className="fi-input" value={tool.tool} required onChange={(e) => setTool(i, { ...tool, tool: e.target.value })} /></label>
            </div>
            <label className="fi-field">{t("What the agent may use it for")} <input className="fi-input" value={tool.description} required onChange={(e) => setTool(i, { ...tool, description: e.target.value })} /></label>
            <div className="fi-field-row">
              <label className="fi-field">{t("Endpoint (https)")} <input className="fi-input" type="url" value={tool.endpoint} required onChange={(e) => setTool(i, { ...tool, endpoint: e.target.value })} /></label>
              <label className="fi-field">{t("Credential name (optional)")} <input className="fi-input" value={tool.tokenRef ?? ""} onChange={(e) => setTool(i, { ...tool, tokenRef: e.target.value || undefined })} /></label>
            </div>
            <div className="fi-buttons"><button type="button" className="fi-secondary" onClick={() => set("tools", value.tools.filter((_, j) => j !== i))}>{t("Remove tool")}</button></div>
          </div>
        ))}
        <div className="fi-buttons">
          <button type="button" className="fi-secondary" disabled={value.tools.length >= 10}
            onClick={() => set("tools", [...value.tools, { name: "", description: "", endpoint: "https://", tool: "" }])}>{t("Add tool")}</button>
        </div>
      </fieldset>

      <div className="fi-buttons">
        <button type="submit" className="fi-primary" disabled={busy}>{busy ? t("Saving…") : saveLabel}</button>
        {onCancel && <button type="button" className="fi-secondary" disabled={busy} onClick={onCancel}>{version ? t("Undo changes") : t("Choose another template")}</button>}
      </div>
    </form>
  );
}

/** KN-3: which collections the agent may search; nothing else is searched for it. */
function KnowledgeGrants({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const t = useT();
  const list = useQuery({ queryKey: COLLECTIONS_KEY, queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });
  const toggle = (cid: string) => onChange(value.includes(cid) ? value.filter((x) => x !== cid) : [...value, cid].slice(0, 10));
  return (
    <fieldset>
      <legend>{t("Knowledge collections it may search")}</legend>
      <p className="fi-hint">
        {t("Each message is searched in these, and the agent can search them again with other words. It never sees a collection that is not ticked.")}{" "}
        <Link to={settingsPath("knowledge")}>{t("Manage knowledge")}</Link>
      </p>
      {list.isPending ? <p role="status" className="fi-hint">{t("Loading collections…")}</p> : list.isError ? (
        <p role="alert">{t("Collections could not load: {error}", { error: t.text(errorText(list.error)) })}</p>
      ) : !list.data.collections.length ? (
        <p>{t.rich("No collection yet. {create}, then come back.", { create: <Link key="create" to={settingsPath("knowledge", "new")}>{t("Create one")}</Link> })}</p>
      ) : (
        list.data.collections.map((c) => (
          <label key={c.id} className="fi-check">
            <input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} />
            <span><strong>{c.name}</strong> <span className="fi-hint">· {t.plural(c.documents, { one: "{n} document", other: "{n} documents" })}{c.source.kind === "fabric" ? ` · ${t("from Fabric")}` : ""}</span>
              {c.description && <span className="fi-hint" style={{ display: "block" }}>{c.description}</span>}</span>
          </label>
        ))
      )}
      {value.some((cid) => list.data && !list.data.collections.some((c) => c.id === cid)) && (
        <p role="alert">{t("A ticked collection no longer exists; untick it before saving.")}</p>
      )}
    </fieldset>
  );
}

/** The history of answers, filtered by what happened and (on the history row) by agent. */
function RunsHistory({ agents, agentId }: { agents?: AgentList; agentId?: string }) {
  const t = useT();
  const statusText = runStatusText(t);
  const [outcome, setOutcome] = useState("");
  const [chosenAgent, setChosenAgent] = useState("");
  const agentFilter = agentId ?? chosenAgent;
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
    getNextPageParam: (last) => (last.length < RUN_PAGE ? undefined : `${last[last.length - 1]!.createdAt}|${last[last.length - 1]!.id}`),
    // Refreshing rewrites every loaded page; only the first page is kept fresh.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : 20_000),
  });
  const collections = useQuery({ queryKey: COLLECTIONS_KEY, queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });
  const collectionName = (cid: string) => collections.data?.collections.find((c) => c.id === cid)?.name ?? cid;
  const agentName = (aid?: string) => agents?.agents.find((a) => a.id === aid)?.name ?? aid ?? "—";
  const runList = runs.data?.pages.flat() ?? [];
  return (
    <PanelBlock>
      <div className="fi-buttons" role="group" aria-label={t("Filter the history")}>
        <label className="fi-field" style={{ marginTop: 0 }}>{t("Show")}
          <select className="fi-input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {OUTCOME_FILTERS.map((f) => <option key={f.id} value={f.id}>{t.text(f.label)}</option>)}
          </select>
        </label>
        {!agentId && !!agents?.agents.length && (
          <label className="fi-field" style={{ marginTop: 0 }}>{t("Agent")}
            <select className="fi-input" value={chosenAgent} onChange={(e) => setChosenAgent(e.target.value)}>
              <option value="">{t("All agents")}</option>
              {agents.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {runs.isPending ? <SkeletonRows rows={4} label={t("Loading answers…")} /> : runs.isError && !runList.length ? (
        <LoadFailure what={t("The history")} error={runs.error} onRetry={() => void runs.refetch()} retrying={runs.isFetching} />
      ) : !runList.length ? (
        <p className="fi-hint">{outcome || agentFilter ? t("Nothing matches this filter.") : t("No answers yet. New mail on an address with an agent appears here.")}</p>
      ) : (
        <ul className="fi-plain-list" style={{ marginTop: 12 }}>
          {runList.map((run) => (
            <li key={run.id} style={{ display: "block" }}>
              <div className="fi-panel-block-head" style={{ marginBottom: 2 }}>
                <strong>{statusText[run.status]}</strong>
                <time className="fi-hint" dateTime={run.createdAt}>{t.dateTime(run.createdAt)}</time>
              </div>
              <p style={{ margin: 0 }}>{t("{subject} — from {sender} to {mailbox}", { subject: run.subject || t("(No subject)"), sender: run.sender, mailbox: run.mailboxId })}</p>
              <p className="fi-hint" style={{ margin: 0 }}>
                {run.agentId ? `${agentName(run.agentId)} v${run.agentVersion}` : t("No agent")}{run.intent ? ` · ${t("intent: {intent}", { intent: run.intent })}` : ""} · {t.text(run.reason)}
              </p>
              {run.status === "send_unknown" && <p role="note">{t("Check Sent for this address before answering again; it is not retried.")}</p>}
              {run.sources && run.sources.length > 0 && (
                <details>
                  <summary>{run.status === "sent" || run.status === "drafted"
                    ? t.plural(run.sources.length, { one: "Answered from {n} passage", other: "Answered from {n} passages" })
                    : t.plural(run.sources.length, { one: "Found {n} passage", other: "Found {n} passages" })}</summary>
                  <ul>
                    {run.sources.map((s) => (
                      <li key={s.ref}><Link to={settingsPath("knowledge", s.collectionId)}>{s.title}</Link> <span className="fi-hint">· {s.sourceUri} · {collectionName(s.collectionId)}</span></li>
                    ))}
                  </ul>
                </details>
              )}
              {run.toolCalls.length > 0 && (
                <details>
                  <summary>{t.plural(run.toolCalls.length, { one: "{n} tool call", other: "{n} tool calls" })}</summary>
                  <ul>{run.toolCalls.map((call, i) => <li key={i}>{call.ok
                    ? t("{name} on {host} — ok, {ms} ms:", { name: call.name, host: call.host, ms: call.ms })
                    : t("{name} on {host} — failed, {ms} ms:", { name: call.name, host: call.host, ms: call.ms })} <span className="fi-hint">{call.result}</span></li>)}</ul>
                </details>
              )}
              {run.sent && (
                <details>
                  <summary>{t("What was sent to {to}", { to: run.sent.to })}</summary>
                  <p><strong>{run.sent.subject}</strong></p>
                  <pre className="fi-pre">{run.sent.body}</pre>
                </details>
              )}
              {run.draftId && <p style={{ margin: 0 }}><Link to={`/mailbox/${encodeURIComponent(run.mailboxId)}/emails/draft?open=${encodeURIComponent(run.draftId)}`}>{t("Open the draft")}</Link></p>}
            </li>
          ))}
        </ul>
      )}
      {runs.hasNextPage && (
        <div className="fi-buttons">
          <button type="button" className="fi-secondary" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>{runs.isFetchingNextPage ? t("Loading…") : t("Show older")}</button>
        </div>
      )}
      {runs.isFetchNextPageError && <p role="alert">{t("Older answers could not load: {error}", { error: t.text(errorText(runs.error)) })}</p>}
    </PanelBlock>
  );
}
