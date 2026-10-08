/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so tests/agent-access-ui.test.ts (tsx) renders this file as the app does.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "../../../services/fabric";
import { useT } from "../../../lib/i18n";
import { englishT, msg, type T } from "../../../../shared/i18n";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, Dialog, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout,
  SelectableList, SkeletonPanel, SkeletonRows, errorText, useConfirm, useWork,
} from "../ui";

type Level = "read" | "mail" | "admin";
type Send = "drafts" | "send";
export interface AgentKey { id: string; clientId: string; name: string; level: Level; send: Send; dailySendLimit: number; createdAt: string; expiresAt: string | null; accounts?: string[] | null }
interface Mailbox { id: string; email?: string; name?: string }
interface KeysState { keys: AgentKey[]; mcpUrl: string; canIssue: boolean }
interface NewKey { key: AgentKey; clientSecret: string; mcpUrl: string; configs: { claudeCode: string; json: unknown; jsonFromEnvironment: unknown } }
interface Entry { at: number; callerLabel: string; tool: string; target: string; outcome: "done" | "failed" | "refused" | "confirmation_asked"; detail: string }

/** The levels of an agent key, in the language (`LEVELS` is the English, for tests and agents' docs). */
export function levels(t: T): { id: Level; title: string; hint: string }[] {
  return [
    { id: "read", title: t("[level] Read"), hint: t("Reads and searches mail and sees how everything is set up. Changes nothing.") },
    { id: "mail", title: t("Mail"), hint: t("Also drafts, moves and marks mail and reports spam. Changes no settings.") },
    { id: "admin", title: t("Admin"), hint: t("Everything the app does: addresses and domains on Cloudflare, forwarding, spam lists, agents, categories, knowledge and rules.") },
  ];
}
export const LEVELS = levels(englishT);
const DURATIONS = [{ id: "30d", title: msg("30 days") }, { id: "90d", title: msg("90 days") }, { id: "1y", title: msg("1 year") }] as const;
const OUTCOME: Record<Entry["outcome"], string> = { done: msg("Done"), failed: msg("Failed"), refused: msg("Refused"), confirmation_asked: msg("Asked to confirm") };
export const KEYS_KEY = ["agent-keys"];
export const JOURNAL = "journal";

export const sendingText = (k: Pick<AgentKey, "level" | "send" | "dailySendLimit">, t: T = englishT) =>
  k.level === "read" ? t("Sends nothing") : k.level === "admin" || k.send === "send" ? t("Can send, {n} a day", { n: k.dailySendLimit }) : t("Drafts only");
/** Which mailboxes a key reaches (AP-11): the whole workspace, or the ones it names. */
export const scopeText = (k: Pick<AgentKey, "accounts">, t: T = englishT) =>
  !k.accounts ? t("All mailboxes") : k.accounts.length ? t("Only {mailboxes}", { mailboxes: t.list(k.accounts.map((a) => a.replace(/^cloudflare:/, ""))) }) : t("No mailbox");
const day = (iso: string | null, t: T) => (iso ? t.date(iso, { year: "numeric", month: "short", day: "numeric" }) : t("never"));
const levelTitle = (level: Level, t: T) => levels(t).find((l) => l.id === level)?.title ?? level;

function Copy({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="fi-text-button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false)); }}>
      {done ? t("Copied") : label}
    </button>
  );
}

/**
 * Settings → Agent access (SCR-15, SCN-043, SCN-044, AP-7): keys for AI agents the owner runs
 * elsewhere, and what they changed. These are not the reply agents that answer addresses. A new
 * key is made in a dialog that shows its secret once.
 */
export default function AgentAccessSection({ id }: { id: string | null }) {
  const t = useT();
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: () => fabric<KeysState>("/api/agent-keys") });
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const data = keys.data;
  const entries = (data?.keys ?? []).map((k): ListEntry & { agentKey: AgentKey } => ({ key: k.id, group: "keys", agentKey: k, text: `${k.name} ${levelTitle(k.level, t)}` }));
  const groups = groupRows(visibleRows(entries, query, id), [{ id: "keys", label: t("Keys") }]);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const making = params.get("new") === "1";
  const setMaking = (on: boolean) => setParams((old) => { const n = new URLSearchParams(old); if (on) n.set("new", "1"); else n.delete("new"); return n; }, { replace: true, preventScrollReset: true });

  const listView = keys.isPending ? <SkeletonRows label={t("Loading agent keys…")} /> : keys.isError ? (
    <LoadFailure what={t("Agent keys")} error={keys.error} onRetry={() => void keys.refetch()} retrying={keys.isFetching} />
  ) : (
    <SelectableList label={t("Agent keys")} groups={groups} selected={id} hrefFor={(e) => settingsPath("agent-access", e.key)}
      pinned={[{ key: JOURNAL, href: settingsPath("agent-access", JOURNAL), content: (
        <span className="fi-row-main"><span className="fi-row-title">{t("What agents changed")}</span><span className="fi-row-meta">{t("Every change an outside agent made, newest first")}</span></span>
      ) }]}
      renderRow={(e) => (
        <>
          <span className="fi-row-main">
            <span className="fi-row-title">{e.agentKey.name}</span>
            <span className="fi-row-meta">{sendingText(e.agentKey, t)} · {scopeText(e.agentKey, t)}</span>
          </span>
          <span className="fi-row-side"><Badge>{levelTitle(e.agentKey.level, t)}</Badge></span>
        </>
      )}
      empty={<div className="fi-list-empty"><p>{query ? t("No key matches “{query}”.", { query }) : t("No agent has a key yet.")}</p></div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{t("Let an AI agent you run elsewhere work with Fabric Inbox")}</h2>
      <p>{t("Claude Code, Cursor or your own agent can work through the agent protocol (MCP). Each agent gets its own key and does only what its level allows. These are not the reply agents that answer your addresses.")}</p>
      {data?.canIssue && <button type="button" className="fi-primary" onClick={() => setMaking(true)}><PlusIcon size={16} /> {t("New key")}</button>}
    </PanelPlaceholder>
  ) : id === JOURNAL ? (
    <Panel title={t("What agents changed")} closeTo={settingsPath("agent-access")}><Journal /></Panel>
  ) : keys.isPending ? <SkeletonPanel label={t("Loading this key…")} /> : !selected ? (
    <PanelPlaceholder>
      <h2>{t("This key is not here")}</h2>
      <p>{t("It may have been revoked.")}</p>
      <Link className="fi-secondary" to={settingsPath("agent-access")} replace preventScrollReset>{t("All keys")}</Link>
    </PanelPlaceholder>
  ) : (
    <KeyPanel key={selected.key} agentKey={selected.agentKey} mcpUrl={data!.mcpUrl}
      onRevoked={() => navigate(settingsPath("agent-access"), { replace: true, preventScrollReset: true })} />
  );

  return (
    <>
      <SectionLayout section="agent-access" hasSelection={!!id} list={listView} panel={panel}
        toolbar={<>
          <ListSearch value={query} onChange={setQuery} placeholder={t("Find a key")} label={t("Find a key")} />
          <button type="button" className="fi-primary" disabled={!data?.canIssue} onClick={() => setMaking(true)}><PlusIcon size={16} /> {t("New key")}</button>
        </>}
        footer={data && !data.canIssue ? (
          <p>{t.rich("This server has no Cloudflare token, so it cannot make keys. {connect}.", { connect: <Link key="connect" to={settingsPath("domains", "connect")}>{t("Connect Cloudflare")}</Link> })}</p>
        ) : undefined} />
      {data?.canIssue && (
        <NewKeyDialog open={making} onClose={() => setMaking(false)}
          onDone={(k) => { setMaking(false); navigate(settingsPath("agent-access", k.id), { replace: true, preventScrollReset: true }); }} />
      )}
    </>
  );
}

function KeyPanel({ agentKey: k, mcpUrl, onRevoked }: { agentKey: AgentKey; mcpUrl: string; onRevoked: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(k.id);
  const revoke = async () => {
    const ok = await confirm({ title: t("Revoke the key of {name}?", { name: k.name }), body: <p>{t("{name} stops working at once. This cannot be undone; a new key can be made.", { name: k.name })}</p>, confirmLabel: t("Revoke"), cancelLabel: t("Keep"), danger: true });
    if (!ok) return;
    const done = await work.run(t("Revoking…"), async () => {
      try {
        const out = await fabric<{ revoked: string; warning?: string }>(`/api/agent-keys/${encodeURIComponent(k.id)}`, undefined, "DELETE");
        return out.warning ? t.text(out.warning) : t("{name} can no longer use Fabric Inbox.", { name: k.name });
      } finally { await client.invalidateQueries({ queryKey: KEYS_KEY }); }
    });
    if (done) onRevoked();
  };
  return (
    <Panel title={k.name} subtitle={`${levelTitle(k.level, t)} · ${sendingText(k, t)}`} closeTo={settingsPath("agent-access")}
      menu={<ActionMenu label={t("More actions for {name}", { name: k.name })} actions={[{ label: t("Revoke…"), danger: true, onSelect: () => void revoke() }]} />}>
      <PanelBlock>
        <ul className="fi-facts">
          <li><strong>{t("Level")}</strong> {levelTitle(k.level, t)} — {levels(t).find((l) => l.id === k.level)?.hint}</li>
          <li><strong>{t("Sending")}</strong> {sendingText(k, t)}</li>
          <li><strong>{t("Mailboxes")}</strong> {scopeText(k, t)}</li>
          <li><strong>{t("Made")}</strong> {day(k.createdAt, t)}</li>
          <li><strong>{t("Expires")}</strong> {day(k.expiresAt, t)}</li>
          <li><strong>Client ID</strong> <code>{k.clientId}</code> <Copy text={k.clientId} label={t("Copy")} /></li>
          <li><strong>{t("Server")}</strong> <code>{mcpUrl}</code></li>
        </ul>
        <p className="fi-hint">{t("The secret was shown once, when the key was made. A lost secret means a new key.")}</p>
        <ActionResult result={work.result} />
      </PanelBlock>
    </Panel>
  );
}

function Journal() {
  const t = useT();
  const [before, setBefore] = useState<number[]>([]);
  const journal = useQuery({ queryKey: ["agent-journal", before.at(-1) ?? null], queryFn: () =>
    fabric<{ entries: Entry[]; nextBefore: number | null }>(`/api/agent-keys/journal${before.length ? `?before=${before.at(-1)}` : ""}`) });
  return (
    <PanelBlock>
      {journal.isPending ? <SkeletonRows rows={4} label={t("Loading…")} /> : journal.isError ? (
        <LoadFailure what={t("The journal")} error={journal.error} onRetry={() => void journal.refetch()} retrying={journal.isFetching} />
      ) : !journal.data.entries.length ? (
        <p className="fi-hint">{before.length ? t("Nothing older.") : t("No agent has changed anything yet.")}</p>
      ) : (
        <table className="fi-table">
          <thead><tr><th>{t("When")}</th><th>{t("Key")}</th><th>{t("Action")}</th><th>{t("On")}</th><th>{t("Result")}</th></tr></thead>
          <tbody>
            {journal.data.entries.map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td style={{ whiteSpace: "nowrap" }}>{t.dateTime(e.at)}</td>
                <td>{e.callerLabel}</td>
                <td><code>{e.tool}</code></td>
                <td>{e.target}</td>
                <td title={e.detail ? t.text(e.detail) : e.detail}>{t.text(OUTCOME[e.outcome])}{e.detail && e.outcome !== "done" ? `: ${t.text(e.detail)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="fi-buttons">
        {before.length > 0 && <button type="button" className="fi-secondary" onClick={() => setBefore(before.slice(0, -1))}>{t("Newer")}</button>}
        {journal.data?.nextBefore && <button type="button" className="fi-secondary" onClick={() => setBefore([...before, journal.data!.nextBefore!])}>{t("Show older")}</button>}
      </div>
    </PanelBlock>
  );
}

const blankForm = () => ({ name: "", level: "mail" as Level, send: "drafts" as Send, dailySendLimit: 50, duration: "1y" as (typeof DURATIONS)[number]["id"], limited: false, accounts: [] as string[] });

/** A new key: the form, then its secret, shown once. Closing after the secret was shown keeps the key. */
export function NewKeyDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (key: AgentKey) => void }) {
  const t = useT();
  const client = useQueryClient();
  const [form, setForm] = useState(blankForm);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const [created, setCreated] = useState<NewKey | null>(null);
  const mailboxes = useQuery({ queryKey: ["agent-access-mailboxes"], enabled: open, queryFn: () => fabric<{ accounts: Mailbox[] }>("/api/inbox?limit=1") });
  useEffect(() => { if (open) { setForm(blankForm()); setProblem(""); setCreated(null); } }, [open]);

  async function create() {
    setWorking(true); setProblem("");
    try {
      const { limited, accounts, ...fields } = form;
      const made = await fabric<NewKey>("/api/agent-keys", { ...fields, name: form.name.trim(), ...(limited && form.level !== "admin" ? { accounts } : {}) });
      setCreated(made);
      await client.invalidateQueries({ queryKey: KEYS_KEY });
    } catch (error) { setProblem(t.text(errorText(error))); } finally { setWorking(false); }
  }
  const finish = () => (created ? onDone(created.key) : onClose());
  const limit = (v: string) => Math.max(1, Math.min(1000, Number(v) || 1));

  return (
    <Dialog open={open} title={created ? t("Key for {name}", { name: created.key.name }) : t("New key")} onClose={finish} busy={working} wide>
      {created ? (
        <div role="alert">
          <p>{t("Copy the secret now: it is shown only once. Put it in the agent's settings, not in a chat or a file others can read.")}</p>
          <table className="fi-table">
            <tbody>
              <tr><th>{t("Server")}</th><td><code>{created.mcpUrl}</code></td></tr>
              <tr><th>Client ID</th><td><code>{created.key.clientId}</code> <Copy text={created.key.clientId} label={t("Copy")} /></td></tr>
              <tr><th>Client Secret</th><td><code>{created.clientSecret}</code> <Copy text={created.clientSecret} label={t("Copy")} /></td></tr>
            </tbody>
          </table>
          <p><strong>Claude Code</strong></p>
          <pre className="fi-pre">{created.configs.claudeCode}</pre>
          <Copy text={created.configs.claudeCode} label={t("Copy command")} />
          <p className="fi-hint">{t("The command keeps the secret in Claude Code's settings and your shell history.")}</p>
          <p><strong>{t("With the secret in an environment variable (FABRIC_INBOX_CLIENT_SECRET)")}</strong></p>
          <pre className="fi-pre">{JSON.stringify(created.configs.jsonFromEnvironment, null, 2)}</pre>
          <Copy text={JSON.stringify(created.configs.jsonFromEnvironment, null, 2)} label={t("Copy JSON")} />
          <p><strong>{t("Other MCP clients (JSON)")}</strong></p>
          <pre className="fi-pre">{JSON.stringify(created.configs.json, null, 2)}</pre>
          <Copy text={JSON.stringify(created.configs.json, null, 2)} label={t("Copy JSON")} />
          <div className="fi-dialog-actions"><button type="button" className="fi-primary" data-autofocus onClick={finish}>{t("I saved it")}</button></div>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="fi-field">{t("Agent's name")}
            <input className="fi-input" data-autofocus required maxLength={80} value={form.name} placeholder={t("Support assistant")} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <fieldset>
            <legend>{t("Level")}</legend>
            {levels(t).map((l) => (
              <label key={l.id} className="fi-check">
                <input type="radio" name="level" checked={form.level === l.id} onChange={() => setForm({ ...form, level: l.id })} />
                <span><strong>{l.title}</strong> — {l.hint}</span>
              </label>
            ))}
          </fieldset>
          {form.level === "admin" && (
            <p>{t.rich("An Admin key can send: it can make rules and reply agents that send by themselves. Up to {limit} messages a day through its own send tools; what its rules and agents send is not counted here.", {
              limit: <input key="limit" type="number" min={1} max={1000} className="fi-input" style={{ width: 80, display: "inline-block" }} aria-label={t("Messages a day")}
                value={form.dailySendLimit} onChange={(e) => setForm({ ...form, dailySendLimit: limit(e.target.value) })} />,
            })}</p>
          )}
          {form.level === "mail" && (
            <fieldset>
              <legend>{t("Sending")}</legend>
              <label className="fi-check"><input type="radio" name="send" checked={form.send === "drafts"} onChange={() => setForm({ ...form, send: "drafts" })} />
                <span><strong>{t("Drafts only")}</strong> — {t("the agent writes drafts; you send them.")}</span></label>
              <label className="fi-check"><input type="radio" name="send" checked={form.send === "send"} onChange={() => setForm({ ...form, send: "send" })} />
                <span><strong>{t("Can send")}</strong> — {t.rich("up to {limit} messages a day.", {
                  limit: <input key="limit" type="number" min={1} max={1000} className="fi-input" style={{ width: 80, display: "inline-block" }} aria-label={t("Messages a day")}
                    value={form.dailySendLimit} onChange={(e) => setForm({ ...form, dailySendLimit: limit(e.target.value) })} />,
                })}</span></label>
            </fieldset>
          )}
          {form.level === "admin" ? <p>{t("An Admin key reaches every mailbox: it manages the whole workspace.")}</p> : (
            <fieldset>
              <legend>{t("Mailboxes")}</legend>
              <label className="fi-check"><input type="radio" name="limited" checked={!form.limited} onChange={() => setForm({ ...form, limited: false })} />
                <span><strong>{t("All mailboxes")}</strong> — {t("and what the whole workspace shares at this level.")}</span></label>
              <label className="fi-check"><input type="radio" name="limited" checked={form.limited} onChange={() => setForm({ ...form, limited: true })} />
                <span><strong>{t("Only these mailboxes")}</strong> — {t("the agent sees and changes nothing else, not even settings.")}</span></label>
              {form.limited && (
                <div style={{ marginLeft: 24 }}>
                  {mailboxes.isPending && <p role="status" className="fi-hint">{t("Loading mailboxes…")}</p>}
                  {mailboxes.isError && <LoadFailure what={t("Mailboxes")} error={mailboxes.error} onRetry={() => void mailboxes.refetch()} retrying={mailboxes.isFetching} />}
                  {mailboxes.data?.accounts.map((m) => (
                    <label key={m.id} className="fi-check">
                      <input type="checkbox" checked={form.accounts.includes(m.id)}
                        onChange={(e) => setForm({ ...form, accounts: e.target.checked ? [...form.accounts, m.id] : form.accounts.filter((a) => a !== m.id) })} />
                      <span>{m.email ?? m.id}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          )}
          <label className="fi-field">{t("Expires after")}
            <select className="fi-input" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value as typeof form.duration })}>
              {DURATIONS.map((d) => <option key={d.id} value={d.id}>{t.text(d.title)}</option>)}
            </select>
          </label>
          <p className="fi-hint">{t("Deleting mail for good, removing an address and other changes that cannot be undone always take a second call with a code, which stops a mistaken call but is not your approval. Every change is listed under What agents changed.")}</p>
          {problem && <p className="fi-action-result is-error" role="alert">{problem}</p>}
          <div className="fi-dialog-actions">
            <button type="button" className="fi-secondary" onClick={onClose} disabled={working}>{t("Cancel")}</button>
            <button type="submit" className="fi-primary" disabled={working || !form.name.trim() || (form.limited && form.level !== "admin" && !form.accounts.length)}>
              {working ? t("Making the key…") : t("Make key")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
