/** @jsxRuntime automatic @jsxImportSource react */
// ^ pins the automatic JSX runtime so tests/agent-access-ui.test.ts (tsx) renders this file as the app does.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { useState } from "react";
import { fabric } from "../services/fabric";

export function meta() {
  return [{ title: "Agent access · Fabric Inbox" }];
}

type Level = "read" | "mail" | "admin";
type Send = "drafts" | "send";
interface AgentKey { id: string; clientId: string; name: string; level: Level; send: Send; dailySendLimit: number; createdAt: string; expiresAt: string | null }
interface KeysState { keys: AgentKey[]; mcpUrl: string; canIssue: boolean }
interface NewKey { key: AgentKey; clientSecret: string; mcpUrl: string; configs: { claudeCode: string; json: unknown; jsonFromEnvironment: unknown } }
interface Entry { at: number; callerLabel: string; tool: string; target: string; outcome: "done" | "failed" | "refused" | "confirmation_asked"; detail: string }

export const LEVELS: { id: Level; title: string; hint: string }[] = [
  { id: "read", title: "Read", hint: "Reads and searches mail and sees how everything is set up. Changes nothing." },
  { id: "mail", title: "Mail", hint: "Also drafts, moves and marks mail and reports spam. Changes no settings." },
  { id: "admin", title: "Admin", hint: "Everything the app does: addresses and domains on Cloudflare, forwarding, spam lists, agents, categories, knowledge and rules." },
];
const DURATIONS = [{ id: "30d", title: "30 days" }, { id: "90d", title: "90 days" }, { id: "1y", title: "1 year" }] as const;
const OUTCOME: Record<Entry["outcome"], string> = { done: "Done", failed: "Failed", refused: "Refused", confirmation_asked: "Asked to confirm" };

export const sendingText = (k: Pick<AgentKey, "level" | "send" | "dailySendLimit">) =>
  k.level === "read" ? "Sends nothing" : k.level === "admin" || k.send === "send" ? `Can send, ${k.dailySendLimit} a day` : "Drafts only";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never");

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="fi-text-button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false)); }}>
      {done ? "Copied" : label}
    </button>
  );
}

/** SCR-15 Agent access (AP-7): keys for agents the owner runs elsewhere, and what they changed. */
export default function AgentAccess() {
  const client = useQueryClient();
  const keys = useQuery({ queryKey: ["agent-keys"], queryFn: () => fabric<KeysState>("/api/agent-keys") });
  const [journalBefore, setJournalBefore] = useState<number[]>([]);
  const journal = useQuery({ queryKey: ["agent-journal", journalBefore.at(-1) ?? null], queryFn: () =>
    fabric<{ entries: Entry[]; nextBefore: number | null }>(`/api/agent-keys/journal${journalBefore.length ? `?before=${journalBefore.at(-1)}` : ""}`) });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<NewKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", level: "mail" as Level, send: "drafts" as Send, dailySendLimit: 50, duration: "1y" as (typeof DURATIONS)[number]["id"] });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice(""); setCreated(null);
    try {
      const made = await fabric<NewKey>("/api/agent-keys", { ...form, name: form.name.trim() });
      setCreated(made);
      setForm((f) => ({ ...f, name: "" }));
      await client.invalidateQueries({ queryKey: ["agent-keys"] });
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  async function revoke(key: AgentKey) {
    setBusy(true); setNotice("");
    try {
      const out = await fabric<{ revoked: string; warning?: string }>(`/api/agent-keys/${encodeURIComponent(key.id)}`, undefined, "DELETE");
      setNotice(out.warning ?? `${key.name} can no longer use Fabric Inbox.`);
      setRevoking(null);
      await client.invalidateQueries({ queryKey: ["agent-keys"] });
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  const data = keys.data;
  return (
    <main className="mx-auto max-w-4xl p-6 text-kumo-default">
      <nav className="flex gap-4 text-sm">
        <Link to="/">← Fabric Inbox</Link>
        <Link to="/ai-agents" className="underline">Agents</Link>
      </nav>
      <h1 className="mt-8 text-3xl font-semibold">Agent access</h1>
      <p className="my-3 text-kumo-subtle">
        Let an AI agent you run elsewhere, such as Claude Code, Cursor or your own, work with Fabric Inbox through its agent protocol (MCP).
        Each agent gets its own key and does only what its level allows. These are not the reply agents that answer your addresses.
      </p>
      {notice && <p role="status" className="my-4 rounded-lg border border-kumo-line p-3">{notice}</p>}

      {created && (
        <section className="my-6 rounded-lg border border-kumo-line p-4" aria-labelledby="secret-heading" role="alert">
          <h2 id="secret-heading" className="text-xl font-medium">Key for {created.key.name}</h2>
          <p className="mt-1 text-sm">Copy the secret now: it is shown only once. Put it in the agent's settings, not in a chat or a file others can read.</p>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>Server</dt><dd><code>{created.mcpUrl}</code></dd>
            <dt>Client ID</dt><dd><code>{created.key.clientId}</code> <Copy text={created.key.clientId} label="Copy" /></dd>
            <dt>Client Secret</dt><dd><code className="break-all">{created.clientSecret}</code> <Copy text={created.clientSecret} label="Copy" /></dd>
          </dl>
          <p className="mt-3 text-sm font-medium">Claude Code</p>
          <pre className="mt-1 overflow-x-auto rounded bg-kumo-tint p-2 text-xs">{created.configs.claudeCode}</pre>
          <Copy text={created.configs.claudeCode} label="Copy command" />
          <p className="mt-1 text-xs text-kumo-subtle">The command keeps the secret in Claude Code's settings and your shell history.</p>
          <p className="mt-3 text-sm font-medium">With the secret in an environment variable (FABRIC_INBOX_CLIENT_SECRET)</p>
          <pre className="mt-1 overflow-x-auto rounded bg-kumo-tint p-2 text-xs">{JSON.stringify(created.configs.jsonFromEnvironment, null, 2)}</pre>
          <Copy text={JSON.stringify(created.configs.jsonFromEnvironment, null, 2)} label="Copy JSON" />
          <p className="mt-3 text-sm font-medium">Other MCP clients (JSON)</p>
          <pre className="mt-1 overflow-x-auto rounded bg-kumo-tint p-2 text-xs">{JSON.stringify(created.configs.json, null, 2)}</pre>
          <Copy text={JSON.stringify(created.configs.json, null, 2)} label="Copy JSON" />
          <p className="mt-3"><button type="button" className="fi-text-button" onClick={() => setCreated(null)}>I saved it</button></p>
        </section>
      )}

      <section className="my-6" aria-labelledby="keys-heading">
        <h2 id="keys-heading" className="text-xl font-medium">Keys</h2>
        {keys.isLoading && <p className="mt-2 text-sm">Loading agent keys…</p>}
        {keys.error && <p className="mt-2 text-sm">{(keys.error as Error).message} <button type="button" className="fi-text-button" onClick={() => void keys.refetch()}>Retry</button></p>}
        {data && !data.keys.length && <p className="mt-2 text-sm text-kumo-subtle">No agent has a key yet.</p>}
        {data && data.keys.length > 0 && (
          <ul className="mt-2 divide-y divide-kumo-line rounded-lg border border-kumo-line">
            {data.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
                <span className="font-medium">{k.name}</span>
                <span>{LEVELS.find((l) => l.id === k.level)?.title}</span>
                <span>{sendingText(k)}</span>
                <span className="text-kumo-subtle">made {day(k.createdAt)}, expires {day(k.expiresAt)}</span>
                <span className="ml-auto">
                  {revoking === k.id ? (
                    <span role="alert">
                      {k.name} stops working at once.{" "}
                      <button type="button" className="fi-text-button" disabled={busy} onClick={() => void revoke(k)}>Revoke</button>{" "}
                      <button type="button" className="fi-text-button" onClick={() => setRevoking(null)}>Keep</button>
                    </span>
                  ) : (
                    <button type="button" className="fi-text-button" disabled={busy} onClick={() => setRevoking(k.id)}>Revoke…</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="my-6" aria-labelledby="new-heading">
        <h2 id="new-heading" className="text-xl font-medium">New key</h2>
        {data && !data.canIssue ? (
          <p className="mt-2 text-sm">This server has no Cloudflare token, so it cannot make keys. Add one on <Link className="underline" to="/projects">Domains &amp; addresses</Link>.</p>
        ) : (
          <form className="mt-2 space-y-3 text-sm" onSubmit={(e) => void create(e)}>
            <label className="block">Agent's name
              <input className="mt-1 block w-full rounded border border-kumo-line bg-transparent p-2" required maxLength={80} value={form.name}
                placeholder="Support assistant" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <fieldset>
              <legend>Level</legend>
              {LEVELS.map((l) => (
                <label key={l.id} className="mt-1 flex gap-2">
                  <input type="radio" name="level" checked={form.level === l.id} onChange={() => setForm({ ...form, level: l.id })} />
                  <span><strong>{l.title}</strong> — {l.hint}</span>
                </label>
              ))}
            </fieldset>
            {form.level === "admin" && (
              <p>
                An Admin key can send: it can make rules and reply agents that send by themselves. Up to{" "}
                <input type="number" min={1} max={1000} className="w-20 rounded border border-kumo-line bg-transparent px-1" aria-label="Messages a day"
                  value={form.dailySendLimit} onChange={(e) => setForm({ ...form, dailySendLimit: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />{" "}
                messages a day through its own send tools; what its rules and agents send is not counted here.
              </p>
            )}
            {form.level === "mail" && (
              <fieldset>
                <legend>Sending</legend>
                <label className="mt-1 flex gap-2"><input type="radio" name="send" checked={form.send === "drafts"} onChange={() => setForm({ ...form, send: "drafts" })} />
                  <span><strong>Drafts only</strong> — the agent writes drafts; you send them.</span></label>
                <label className="mt-1 flex gap-2"><input type="radio" name="send" checked={form.send === "send"} onChange={() => setForm({ ...form, send: "send" })} />
                  <span><strong>Can send</strong> — up to{" "}
                    <input type="number" min={1} max={1000} className="w-20 rounded border border-kumo-line bg-transparent px-1" aria-label="Messages a day"
                      value={form.dailySendLimit} onChange={(e) => setForm({ ...form, dailySendLimit: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />{" "}
                    messages a day.</span></label>
              </fieldset>
            )}
            <label className="block">Expires after
              <select className="ml-2 rounded border border-kumo-line bg-transparent p-1" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value as typeof form.duration })}>
                {DURATIONS.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              </select>
            </label>
            <p className="text-kumo-subtle">Deleting mail for good, removing an address and other changes that cannot be undone always take a second call with a code, which stops a mistaken call but is not your approval. Every change is listed below.</p>
            <button type="submit" className="rounded bg-kumo-brand px-3 py-2 text-white disabled:opacity-50" disabled={busy || !form.name.trim()}>
              {busy ? "Making the key…" : "Make key"}
            </button>
          </form>
        )}
      </section>

      <section className="my-6" aria-labelledby="journal-heading">
        <h2 id="journal-heading" className="text-xl font-medium">What agents changed</h2>
        {journal.isLoading && <p className="mt-2 text-sm">Loading…</p>}
        {journal.error && <p className="mt-2 text-sm">{(journal.error as Error).message} <button type="button" className="fi-text-button" onClick={() => void journal.refetch()}>Retry</button></p>}
        {journal.data && !journal.data.entries.length && <p className="mt-2 text-sm text-kumo-subtle">{journalBefore.length ? "Nothing older." : "No agent has changed anything yet."}</p>}
        {journal.data && journal.data.entries.length > 0 && (
          <table className="mt-2 w-full text-left text-sm">
            <thead><tr><th>When</th><th>Key</th><th>Action</th><th>On</th><th>Result</th></tr></thead>
            <tbody>
              {journal.data.entries.map((e, i) => (
                <tr key={`${e.at}-${i}`} className="border-t border-kumo-line align-top">
                  <td className="whitespace-nowrap pr-3">{new Date(e.at).toLocaleString()}</td>
                  <td className="pr-3">{e.callerLabel}</td>
                  <td className="pr-3"><code>{e.tool}</code></td>
                  <td className="pr-3 break-all">{e.target}</td>
                  <td title={e.detail}>{OUTCOME[e.outcome]}{e.detail && e.outcome !== "done" ? `: ${e.detail}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 flex gap-4 text-sm">
          {journalBefore.length > 0 && <button type="button" className="fi-text-button" onClick={() => setJournalBefore(journalBefore.slice(0, -1))}>Newer</button>}
          {journal.data?.nextBefore && <button type="button" className="fi-text-button" onClick={() => setJournalBefore([...journalBefore, journal.data!.nextBefore!])}>Show older</button>}
        </p>
      </section>
    </main>
  );
}
