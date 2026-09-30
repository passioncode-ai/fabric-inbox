import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { useState } from "react";
import { fabric } from "~/services/fabric";
import type { Collection, CollectionList, KnowledgeDocument, KnowledgeHit, UpsertResult } from "~/services/knowledge";

export function meta() {
  return [{ title: "Knowledge · Fabric Inbox" }];
}

const inputClass = "mt-1 w-full rounded-lg border border-kumo-line bg-transparent px-3 py-2 text-sm";
const LIST_KEY = ["knowledge-collections"];

/**
 * SCR-12 Knowledge: collections of documents agents search (KN-5). Filled by
 * hand today — paste or upload .md/.txt; a collection whose source is Fabric
 * is filled by its sync and read-only here (KN-6).
 */
export default function KnowledgePage() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const open = params.get("c") ?? "";

  async function run(action: () => Promise<string>) {
    setBusy(true); setNotice("");
    try { setNotice(await action()); await client.invalidateQueries({ queryKey: LIST_KEY }); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-4xl p-6 text-kumo-default">
      <nav className="flex gap-4 text-sm">
        <Link to="/">← Fabric Inbox</Link>
        <Link to="/ai-agents" className="underline">Agents</Link>
      </nav>
      <h1 className="mt-8 text-3xl font-semibold">Knowledge</h1>
      <p className="my-3 text-kumo-subtle">
        Collections of documents your agents search when they answer. An agent reads only the collections ticked on it, and says where each
        fact came from in its run. When Fabric's project memory is available, a collection can be filled from it instead of by hand.
      </p>
      {notice && <p role="status" className="my-4 rounded-lg border border-kumo-line p-3">{notice}</p>}

      <form className="my-6 rounded-xl border border-kumo-line p-5" aria-label="New collection"
        onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const c = await fabric<Collection>("/api/knowledge/collections", { name: form.name, ...(form.description ? { description: form.description } : {}) });
          setForm({ name: "", description: "" });
          setParams({ c: c.id }, { replace: true });
          return `${c.name} is ready. Add documents to it, then tick it on an agent.`;
        }); }}>
        <h2 className="text-xl font-medium">New collection</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">Name
            <input className={inputClass} required maxLength={80} placeholder="Customer FAQ" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="block text-sm font-medium">What is in it (optional)
            <input className={inputClass} maxLength={500} placeholder="Public answers for our customers" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
        </div>
        <p className="mt-2 text-xs text-kumo-subtle">Put only what an agent may tell a customer into a collection an agent answering customers can search.</p>
        <button type="submit" className="fi-primary mt-4" disabled={busy || !form.name.trim()}>Create collection</button>
      </form>

      {list.isPending ? <p role="status" className="my-6 text-kumo-subtle">Loading collections…</p> : list.isError ? (
        <p role="alert" className="my-6">Knowledge could not load: {(list.error as Error).message} <button className="underline" onClick={() => void list.refetch()}>Retry</button></p>
      ) : !list.data.collections.length ? (
        <p className="my-6 text-sm">No collection yet. Create the first one above.</p>
      ) : (
        list.data.collections.map((c) => (
          <CollectionCard key={c.id} collection={c} open={open === c.id} maxChars={list.data.limits.documentChars}
            onToggle={() => setParams(open === c.id ? {} : { c: c.id }, { replace: true })} busy={busy} run={run} />
        ))
      )}
    </main>
  );
}

function CollectionCard({ collection, open, maxChars, onToggle, busy, run }: {
  collection: Collection; open: boolean; maxChars: number; onToggle: () => void; busy: boolean; run: (a: () => Promise<string>) => Promise<void>;
}) {
  const client = useQueryClient();
  const key = ["knowledge-collection", collection.id];
  const detail = useQuery({ queryKey: key, enabled: open, queryFn: () => fabric<{ documents: KnowledgeDocument[] }>(`/api/knowledge/collections/${collection.id}`) });
  const [paste, setPaste] = useState({ title: "", text: "" });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const synced = collection.source.kind === "fabric";
  const path = `/api/knowledge/collections/${collection.id}`;
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const say = (r: UpsertResult) => [
    r.added ? `${r.added} added` : "", r.updated ? `${r.updated} updated` : "", r.unchanged ? `${r.unchanged} unchanged` : "",
    ...r.refused.map((x) => `${x.sourceUri || "a document"} not added: ${x.reason}`),
  ].filter(Boolean).join("; ") || "Nothing changed";

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    await run(async () => {
      const picked = [...files].slice(0, 100);
      const tooBig = picked.filter((f) => f.size > maxChars * 4);
      const docs = await Promise.all(picked.filter((f) => !tooBig.includes(f)).map(async (f) => ({
        sourceUri: f.webkitRelativePath || f.name, title: f.name.replace(/\.(md|markdown|txt)$/i, ""), text: await f.text(),
      })));
      const r = await fabric<UpsertResult>(path + "/documents", { documents: docs });
      await refresh();
      return say({ ...r, refused: [...r.refused, ...tooBig.map((f) => ({ sourceUri: f.name, reason: "too large to be one document; split it" }))] });
    });
  }

  return (
    <section className="mt-3 rounded-xl border border-kumo-line" aria-labelledby={"kc-" + collection.id}>
      <button className="flex w-full flex-wrap items-baseline gap-2 p-4 text-left" aria-expanded={open} onClick={onToggle}>
        <h3 id={"kc-" + collection.id} className="text-lg font-medium">{collection.name}</h3>
        <span className="text-sm text-kumo-subtle">{collection.documents} document{collection.documents === 1 ? "" : "s"}{synced ? " · from Fabric" : ""}</span>
        <span className="ml-auto text-sm text-kumo-subtle">{collection.agents.length ? `Searched by ${collection.agents.join(", ")}` : "No agent searches it yet"}</span>
      </button>
      {open && (
        <div className="border-t border-kumo-line p-4">
          {collection.description && <p className="text-sm text-kumo-subtle">{collection.description}</p>}
          {synced && (
            <p className="mt-2 text-sm">Filled from Fabric ({collection.source.kind === "fabric" ? collection.source.project : ""}{collection.source.kind === "fabric" && collection.source.scope ? ` · ${collection.source.scope}` : ""}); changes come from there.</p>
          )}

          <h4 className="mt-4 font-medium">Documents</h4>
          {detail.isPending ? <p role="status" className="text-sm">Loading documents…</p> : detail.isError ? (
            <p role="alert" className="text-sm">Documents could not load: {(detail.error as Error).message}</p>
          ) : !detail.data.documents.length ? <p className="text-sm">No document yet.</p> : (
            <ul className="mt-1 divide-y divide-kumo-line rounded-lg border border-kumo-line text-sm">
              {detail.data.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                  <span><strong>{d.title}</strong> <span className="text-kumo-subtle">· {d.sourceUri} · {d.chars < 1000 ? `${d.chars} characters` : `${(d.chars / 1000).toFixed(d.chars < 10_000 ? 1 : 0)}k characters`}</span></span>
                  {!synced && <button className="underline" disabled={busy} onClick={() => void run(async () => {
                    await fabric(`${path}/documents/${d.id}`, undefined, "DELETE"); await refresh(); return `${d.title} removed.`;
                  })}>Remove</button>}
                </li>
              ))}
            </ul>
          )}

          {!synced && (
            <div className="mt-4 grid gap-4">
              <label className="block text-sm font-medium">Upload .md or .txt files
                <input type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" className="mt-1 block text-sm" disabled={busy}
                  onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
                <span className="block text-xs font-normal text-kumo-subtle">A file with the same name replaces the one already here.</span>
              </label>
              <form className="rounded-lg border border-dashed border-kumo-line p-3" aria-label={`Paste a document into ${collection.name}`}
                onSubmit={(e) => { e.preventDefault(); void run(async () => {
                  const r = await fabric<UpsertResult>(path + "/documents", { documents: [{ sourceUri: `pasted/${paste.title.trim()}`, title: paste.title.trim(), text: paste.text }] });
                  setPaste({ title: "", text: "" }); await refresh(); return say(r);
                }); }}>
                <label className="block text-sm font-medium">Title
                  <input className={inputClass} required maxLength={200} value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} />
                </label>
                <label className="mt-2 block text-sm font-medium">Text
                  <textarea className={inputClass} required rows={6} maxLength={maxChars} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} />
                </label>
                <button type="submit" className="fi-secondary mt-2" disabled={busy || !paste.title.trim() || !paste.text.trim()}>Add document</button>
              </form>
            </div>
          )}

          <form className="mt-5" aria-label={`Try a search in ${collection.name}`}
            onSubmit={(e) => { e.preventDefault(); void run(async () => {
              const r = await fabric<{ hits: KnowledgeHit[] }>(`/api/knowledge/search?q=${encodeURIComponent(query)}&collections=${collection.id}`);
              setHits(r.hits); return r.hits.length ? `${r.hits.length} passage(s) found.` : "Nothing matched; an agent would find nothing either.";
            }); }}>
            <label className="block text-sm font-medium">Try a search, as an agent would
              <span className="mt-1 flex gap-2"><input className={inputClass + " mt-0"} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="How much does it cost?" />
                <button type="submit" className="fi-secondary" disabled={busy || !query.trim()}>Search</button></span>
            </label>
          </form>
          {hits && hits.length > 0 && (
            <ol className="mt-2 grid gap-2 text-sm">
              {hits.map((h) => <li key={h.ref} className="rounded-lg border border-kumo-line p-2"><strong>{h.title}</strong> <span className="text-kumo-subtle">· {h.sourceUri}</span><br />{h.snippet}</li>)}
            </ol>
          )}

          <div className="mt-6 text-sm">
            {!confirmDelete ? <button className="underline" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete this collection…</button> : (
              <div role="group" aria-label={`Delete ${collection.name}`} className="rounded-lg border border-kumo-line p-3">
                <p className="font-medium">Delete {collection.name} and its {collection.documents} document{collection.documents === 1 ? "" : "s"}?</p>
                {collection.agents.length > 0 && <p className="mt-1">Untick it on {collection.agents.join(", ")} first.</p>}
                <div className="mt-2 flex gap-3">
                  <button className="fi-primary" disabled={busy || collection.agents.length > 0} onClick={() => void run(async () => {
                    await fabric(path, undefined, "DELETE"); setConfirmDelete(false); return `${collection.name} deleted.`;
                  })}>Delete collection</button>
                  <button className="fi-secondary" onClick={() => setConfirmDelete(false)}>Keep it</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
