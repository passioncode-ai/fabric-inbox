import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import type { Collection, CollectionList, KnowledgeDocument, KnowledgeHit, UpsertResult } from "~/services/knowledge";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList,
  SkeletonPanel, SkeletonRows, useConfirm, useDirtyGuard, useWork,
} from "../ui";

interface CollectionEntry extends ListEntry { collection: Collection }

const LIST_KEY = ["knowledge-collections"];
const NEW = "new";

const size = (chars: number) => (chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k characters`);
const say = (r: UpsertResult) => [
  r.added ? `${r.added} added` : "", r.updated ? `${r.updated} updated` : "", r.unchanged ? `${r.unchanged} unchanged` : "",
  ...r.refused.map((x) => `${x.sourceUri || "a document"} not added: ${x.reason}`),
].filter(Boolean).join("; ") || "Nothing changed";

/**
 * Settings → Knowledge (SCR-12, SCN-034): collections of documents agents search (KN-5). Filled
 * by hand — paste or upload .md/.txt; a collection whose source is Fabric is filled by its sync
 * and read-only here (KN-6).
 */
export default function KnowledgeSection({ id }: { id: string | null }) {
  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const entries = (list.data?.collections ?? []).map((c): CollectionEntry => ({ key: c.id, group: "all", collection: c, text: `${c.name} ${c.description}` }));
  const groups = groupRows(visibleRows(entries, query, id), [{ id: "all", label: "" }]);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const close = () => navigate(settingsPath("knowledge"), { replace: true, preventScrollReset: true });

  const listView = list.isPending ? <SkeletonRows label="Loading collections…" /> : list.isError ? (
    <LoadFailure what="Knowledge" error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
  ) : (
    <SelectableList label="Knowledge collections" groups={groups} selected={id} hrefFor={(e) => settingsPath("knowledge", e.key)}
      renderRow={(e) => (
        <>
          <span className="fi-row-main">
            <span className="fi-row-title">{e.collection.name}</span>
            <span className="fi-row-meta">{e.collection.agents.length ? `Searched by ${e.collection.agents.join(", ")}` : "No agent searches it yet"}</span>
          </span>
          <span className="fi-row-side">
            {e.collection.source.kind === "fabric" && <Badge>Fabric</Badge>}
            <Badge>{e.collection.documents}</Badge>
          </span>
        </>
      )}
      empty={<div className="fi-list-empty"><p>{query ? `No collection matches “${query}”.` : "No collection yet."}</p>
        {!query && <Link className="fi-primary" to={settingsPath("knowledge", NEW)}>Create the first one</Link>}</div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Choose a collection</h2>
      <p>An agent reads only the collections ticked on it, and says where each fact came from in its answer.</p>
      <Link className="fi-primary" to={settingsPath("knowledge", NEW)} preventScrollReset><PlusIcon size={16} /> New collection</Link>
    </PanelPlaceholder>
  ) : id === NEW ? (
    <NewCollectionPanel onCreated={(c) => navigate(settingsPath("knowledge", c.id), { replace: true, preventScrollReset: true })} />
  ) : list.isPending ? <SkeletonPanel label="Loading this collection…" /> : !selected ? (
    <PanelPlaceholder>
      <h2>This collection is not here</h2>
      <p>It may have been deleted.</p>
      <Link className="fi-secondary" to={settingsPath("knowledge")} replace preventScrollReset>All collections</Link>
    </PanelPlaceholder>
  ) : (
    <CollectionPanel key={selected.key} collection={selected.collection} maxChars={list.data!.limits.documentChars} onDeleted={close} />
  );

  return (
    <SectionLayout section="knowledge" hasSelection={!!id} list={listView} panel={panel}
      toolbar={<>
        <ListSearch value={query} onChange={setQuery} placeholder="Find a collection" label="Find a collection" />
        <Link className="fi-primary" to={settingsPath("knowledge", NEW)} preventScrollReset><PlusIcon size={16} /> New</Link>
      </>}
      footer={<p>Put only what an agent may tell a customer into a collection an agent answering customers can search.</p>} />
  );
}

function NewCollectionPanel({ onCreated }: { onCreated: (c: Collection) => void }) {
  const client = useQueryClient();
  const work = useWork(NEW);
  const [form, setForm] = useState({ name: "", description: "" });
  useDirtyGuard(!!(form.name || form.description) && !work.busy, "the new collection");
  const create = () => void work.run("Creating…", async () => {
    const c = await fabric<Collection>("/api/knowledge/collections", { name: form.name, ...(form.description ? { description: form.description } : {}) });
    await client.invalidateQueries({ queryKey: LIST_KEY });
    setForm({ name: "", description: "" });
    setTimeout(() => onCreated(c), 0);
    return `${c.name} is ready. Add documents to it, then tick it on an agent.`;
  });
  return (
    <Panel title="New collection" closeTo={settingsPath("knowledge")}>
      <form onSubmit={(e) => { e.preventDefault(); create(); }}>
        <label className="fi-field">Name
          <input className="fi-input" required maxLength={80} placeholder="Customer FAQ" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="fi-field">What is in it (optional)
          <input className="fi-input" maxLength={500} placeholder="Public answers for our customers" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        <div className="fi-buttons"><button type="submit" className="fi-primary" disabled={!!work.busy || !form.name.trim()}>{work.busy ?? "Create collection"}</button></div>
        <ActionResult result={work.result} />
      </form>
    </Panel>
  );
}

function CollectionPanel({ collection, maxChars, onDeleted }: { collection: Collection; maxChars: number; onDeleted: () => void }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const key = ["knowledge-collection", collection.id];
  const detail = useQuery({ queryKey: key, queryFn: () => fabric<{ documents: KnowledgeDocument[] }>(`/api/knowledge/collections/${collection.id}`) });
  const docsWork = useWork(collection.id, "documents");
  const searchWork = useWork(collection.id, "search");
  const deleteWork = useWork(collection.id, "delete");
  const [paste, setPaste] = useState({ title: "", text: "" });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const synced = collection.source.kind === "fabric";
  const path = `/api/knowledge/collections/${collection.id}`;
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: LIST_KEY })]);

  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const picked = [...files].slice(0, 100);
    void docsWork.run("Uploading…", async () => {
      const tooBig = picked.filter((f) => f.size > maxChars * 4);
      const docs = await Promise.all(picked.filter((f) => !tooBig.includes(f)).map(async (f) => ({
        sourceUri: f.webkitRelativePath || f.name, title: f.name.replace(/\.(md|markdown|txt)$/i, ""), text: await f.text(),
      })));
      try {
        const r = await fabric<UpsertResult>(path + "/documents", { documents: docs });
        return say({ ...r, refused: [...r.refused, ...tooBig.map((f) => ({ sourceUri: f.name, reason: "too large to be one document; split it" }))] });
      } finally { await refresh(); }
    });
  };
  const addPasted = () => void docsWork.run("Adding…", async () => {
    try {
      const r = await fabric<UpsertResult>(path + "/documents", { documents: [{ sourceUri: `pasted/${paste.title.trim()}`, title: paste.title.trim(), text: paste.text }] });
      setPaste({ title: "", text: "" });
      return say(r);
    } finally { await refresh(); }
  });
  const removeDoc = async (d: KnowledgeDocument) => {
    const ok = await confirm({ title: `Remove ${d.title}?`, body: <p>Agents stop finding its passages. Adding the file again brings it back.</p>, confirmLabel: "Remove document", danger: true });
    if (ok) void docsWork.run("Removing…", async () => {
      try { await fabric(`${path}/documents/${d.id}`, undefined, "DELETE"); return `${d.title} removed.`; } finally { await refresh(); }
    });
  };
  const search = () => void searchWork.run("Searching…", async () => {
    const r = await fabric<{ hits: KnowledgeHit[] }>(`/api/knowledge/search?q=${encodeURIComponent(query)}&collections=${collection.id}`);
    setHits(r.hits);
    return r.hits.length ? `${r.hits.length} passage${r.hits.length === 1 ? "" : "s"} found.` : "Nothing matched; an agent would find nothing either.";
  });
  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${collection.name} and its ${collection.documents} document${collection.documents === 1 ? "" : "s"}?`,
      body: <p>This cannot be undone.</p>, confirmLabel: "Delete collection", danger: true,
      blocked: collection.agents.length ? `Untick it on ${collection.agents.join(", ")} first (Agents).` : undefined,
    });
    if (!ok) return;
    const done = await deleteWork.run("Deleting…", async () => {
      try { await fabric(path, undefined, "DELETE"); return `${collection.name} deleted.`; } finally { await client.invalidateQueries({ queryKey: LIST_KEY }); }
    });
    if (done) onDeleted();
  };

  return (
    <Panel title={collection.name} subtitle={collection.description || undefined} closeTo={settingsPath("knowledge")}
      badges={<>{synced && <Badge>From Fabric</Badge>}<Badge>{collection.documents} document{collection.documents === 1 ? "" : "s"}</Badge></>}
      menu={<ActionMenu label={`More actions for ${collection.name}`} actions={[{ label: "Delete this collection…", danger: true, onSelect: () => void remove() }]} />}>
      <PanelBlock>
        <p>{collection.agents.length ? <>Searched by {collection.agents.join(", ")}.</> : <>No agent searches it yet: tick it on an agent under <Link to={settingsPath("agents")}>Agents</Link>.</>}</p>
        {collection.source.kind === "fabric" && <p>Filled from Fabric ({collection.source.project}{collection.source.scope ? ` · ${collection.source.scope}` : ""}); changes come from there.</p>}
      </PanelBlock>
      <PanelBlock title="Documents">
        {detail.isPending ? <SkeletonRows rows={3} label="Loading documents…" /> : detail.isError ? (
          <LoadFailure what="Documents" error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        ) : !detail.data.documents.length ? <p>No document yet.</p> : (
          <ul className="fi-plain-list">
            {detail.data.documents.map((d) => (
              <li key={d.id}>
                <span className="fi-grow"><strong>{d.title}</strong> <span className="fi-hint">· {d.sourceUri} · {size(d.chars)}</span></span>
                {!synced && <button type="button" className="fi-text-button" disabled={!!docsWork.busy} onClick={() => void removeDoc(d)}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        {!synced && (
          <>
            <label className="fi-field">Upload .md or .txt files
              <input type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={!!docsWork.busy}
                onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
              <span className="fi-hint">A file with the same name replaces the one already here.</span>
            </label>
            <form className="fi-callout" aria-label={`Paste a document into ${collection.name}`} onSubmit={(e) => { e.preventDefault(); addPasted(); }}>
              <label className="fi-field" style={{ marginTop: 0 }}>Title
                <input className="fi-input" required maxLength={200} value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} />
              </label>
              <label className="fi-field">Text
                <textarea className="fi-input" required rows={6} maxLength={maxChars} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} />
              </label>
              <div className="fi-buttons"><button type="submit" className="fi-secondary" disabled={!!docsWork.busy || !paste.title.trim() || !paste.text.trim()}>Add document</button></div>
            </form>
          </>
        )}
        <ActionResult result={docsWork.result} />
      </PanelBlock>
      <PanelBlock title="Try a search, as an agent would">
        <form className="fi-buttons" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input className="fi-input" style={{ flex: 1, minWidth: 180 }} aria-label="Search words" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="How much does it cost?" />
          <button type="submit" className="fi-secondary" disabled={!!searchWork.busy || !query.trim()}>Search</button>
        </form>
        <ActionResult result={searchWork.result} />
        {hits && hits.length > 0 && (
          <ol className="fi-plain-list">
            {hits.map((h) => <li key={h.ref} style={{ display: "block" }}><strong>{h.title}</strong> <span className="fi-hint">· {h.sourceUri}</span><br />{h.snippet}</li>)}
          </ol>
        )}
      </PanelBlock>
      <ActionResult result={deleteWork.result} />
    </Panel>
  );
}
