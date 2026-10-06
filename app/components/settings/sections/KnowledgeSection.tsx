import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import { useT, type T } from "../../../lib/i18n";
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

function size(chars: number, t: T) {
  if (chars < 1000) return t.plural(chars, { one: "{n} character", other: "{n} characters" });
  const digits = chars < 10_000 ? 1 : 0;
  // English keeps its digits exactly as before ("1.0k"); another language writes the number its own way.
  const n = t.locale === "en" ? (chars / 1000).toFixed(digits) : t.number(chars / 1000, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return t("{n}k characters", { n });
}
/** What an upload or a paste did; a refusal's reason is the server's words, in the language where known. */
const say = (r: UpsertResult, t: T) => [
  r.added ? t("{n} added", { n: r.added }) : "", r.updated ? t("{n} updated", { n: r.updated }) : "", r.unchanged ? t("{n} unchanged", { n: r.unchanged }) : "",
  ...r.refused.map((x) => t("{document} not added: {reason}", { document: x.sourceUri || t("a document"), reason: t.text(x.reason) })),
].filter(Boolean).join("; ") || t("Nothing changed");

/**
 * Settings → Knowledge (SCR-12, SCN-034): collections of documents agents search (KN-5). Filled
 * by hand — paste or upload .md/.txt; a collection whose source is Fabric is filled by its sync
 * and read-only here (KN-6).
 */
export default function KnowledgeSection({ id }: { id: string | null }) {
  const t = useT();
  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => fabric<CollectionList>("/api/knowledge/collections") });
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const entries = (list.data?.collections ?? []).map((c): CollectionEntry => ({ key: c.id, group: "all", collection: c, text: `${c.name} ${c.description}` }));
  const groups = groupRows(visibleRows(entries, query, id), [{ id: "all", label: "" }]);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const close = () => navigate(settingsPath("knowledge"), { replace: true, preventScrollReset: true });

  const listView = list.isPending ? <SkeletonRows label={t("Loading collections…")} /> : list.isError ? (
    <LoadFailure what={t("Knowledge")} error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
  ) : (
    <SelectableList label={t("Knowledge collections")} groups={groups} selected={id} hrefFor={(e) => settingsPath("knowledge", e.key)}
      renderRow={(e) => (
        <>
          <span className="fi-row-main">
            <span className="fi-row-title">{e.collection.name}</span>
            <span className="fi-row-meta">{e.collection.agents.length ? t("Searched by {agents}", { agents: t.list(e.collection.agents) }) : t("No agent searches it yet")}</span>
          </span>
          <span className="fi-row-side">
            {e.collection.source.kind === "fabric" && <Badge>Fabric</Badge>}
            <Badge>{e.collection.documents}</Badge>
          </span>
        </>
      )}
      empty={<div className="fi-list-empty"><p>{query ? t("No collection matches “{query}”.", { query }) : t("No collection yet.")}</p>
        {!query && <Link className="fi-primary" to={settingsPath("knowledge", NEW)}>{t("Create the first one")}</Link>}</div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{t("Choose a collection")}</h2>
      <p>{t("An agent reads only the collections ticked on it, and says where each fact came from in its answer.")}</p>
      <Link className="fi-primary" to={settingsPath("knowledge", NEW)} preventScrollReset><PlusIcon size={16} /> {t("New collection")}</Link>
    </PanelPlaceholder>
  ) : id === NEW ? (
    <NewCollectionPanel onCreated={(c) => navigate(settingsPath("knowledge", c.id), { replace: true, preventScrollReset: true })} />
  ) : list.isPending ? <SkeletonPanel label={t("Loading this collection…")} /> : !selected ? (
    <PanelPlaceholder>
      <h2>{t("This collection is not here")}</h2>
      <p>{t("[collection] It may have been deleted.")}</p>
      <Link className="fi-secondary" to={settingsPath("knowledge")} replace preventScrollReset>{t("All collections")}</Link>
    </PanelPlaceholder>
  ) : (
    <CollectionPanel key={selected.key} collection={selected.collection} maxChars={list.data!.limits.documentChars} onDeleted={close} />
  );

  return (
    <SectionLayout section="knowledge" hasSelection={!!id} list={listView} panel={panel}
      toolbar={<>
        <ListSearch value={query} onChange={setQuery} placeholder={t("Find a collection")} label={t("Find a collection")} />
        <Link className="fi-primary" to={settingsPath("knowledge", NEW)} preventScrollReset><PlusIcon size={16} /> {t("New")}</Link>
      </>}
      footer={<p>{t("Put only what an agent may tell a customer into a collection an agent answering customers can search.")}</p>} />
  );
}

function NewCollectionPanel({ onCreated }: { onCreated: (c: Collection) => void }) {
  const t = useT();
  const client = useQueryClient();
  const work = useWork(NEW);
  const [form, setForm] = useState({ name: "", description: "" });
  useDirtyGuard(!!(form.name || form.description) && !work.busy, t("the new collection"));
  const create = () => void work.run(t("Creating…"), async () => {
    const c = await fabric<Collection>("/api/knowledge/collections", { name: form.name, ...(form.description ? { description: form.description } : {}) });
    await client.invalidateQueries({ queryKey: LIST_KEY });
    setForm({ name: "", description: "" });
    setTimeout(() => onCreated(c), 0);
    return t("{name} is ready. Add documents to it, then tick it on an agent.", { name: c.name });
  });
  return (
    <Panel title={t("New collection")} closeTo={settingsPath("knowledge")}>
      <form onSubmit={(e) => { e.preventDefault(); create(); }}>
        <label className="fi-field">{t("Name")}
          <input className="fi-input" required maxLength={80} placeholder={t("Customer FAQ")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="fi-field">{t("What is in it (optional)")}
          <input className="fi-input" maxLength={500} placeholder={t("Public answers for our customers")} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        <div className="fi-buttons"><button type="submit" className="fi-primary" disabled={!!work.busy || !form.name.trim()}>{work.busy ?? t("Create collection")}</button></div>
        <ActionResult result={work.result} />
      </form>
    </Panel>
  );
}

function CollectionPanel({ collection, maxChars, onDeleted }: { collection: Collection; maxChars: number; onDeleted: () => void }) {
  const t = useT();
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
    void docsWork.run(t("Uploading…"), async () => {
      const tooBig = picked.filter((f) => f.size > maxChars * 4);
      const docs = await Promise.all(picked.filter((f) => !tooBig.includes(f)).map(async (f) => ({
        sourceUri: f.webkitRelativePath || f.name, title: f.name.replace(/\.(md|markdown|txt)$/i, ""), text: await f.text(),
      })));
      try {
        const r = await fabric<UpsertResult>(path + "/documents", { documents: docs });
        return say({ ...r, refused: [...r.refused, ...tooBig.map((f) => ({ sourceUri: f.name, reason: t("too large to be one document; split it") }))] }, t);
      } finally { await refresh(); }
    });
  };
  const addPasted = () => void docsWork.run(t("Adding…"), async () => {
    try {
      const r = await fabric<UpsertResult>(path + "/documents", { documents: [{ sourceUri: `pasted/${paste.title.trim()}`, title: paste.title.trim(), text: paste.text }] });
      setPaste({ title: "", text: "" });
      return say(r, t);
    } finally { await refresh(); }
  });
  const removeDoc = async (d: KnowledgeDocument) => {
    const ok = await confirm({ title: t("Remove {title}?", { title: d.title }), body: <p>{t("Agents stop finding its passages. Adding the file again brings it back.")}</p>, confirmLabel: t("Remove document"), danger: true });
    if (ok) void docsWork.run(t("Removing…"), async () => {
      try { await fabric(`${path}/documents/${d.id}`, undefined, "DELETE"); return t("{title} removed.", { title: d.title }); } finally { await refresh(); }
    });
  };
  const search = () => void searchWork.run(t("Searching…"), async () => {
    const r = await fabric<{ hits: KnowledgeHit[] }>(`/api/knowledge/search?q=${encodeURIComponent(query)}&collections=${collection.id}`);
    setHits(r.hits);
    return r.hits.length ? t.plural(r.hits.length, { one: "{n} passage found.", other: "{n} passages found." }) : t("Nothing matched; an agent would find nothing either.");
  });
  const remove = async () => {
    const ok = await confirm({
      title: t.plural(collection.documents, { one: "Delete {name} and its {n} document?", other: "Delete {name} and its {n} documents?" }, { name: collection.name }),
      body: <p>{t("This cannot be undone.")}</p>, confirmLabel: t("Delete collection"), danger: true,
      blocked: collection.agents.length ? t("Untick it on {agents} first (Agents).", { agents: t.list(collection.agents) }) : undefined,
    });
    if (!ok) return;
    const done = await deleteWork.run(t("Deleting…"), async () => {
      try { await fabric(path, undefined, "DELETE"); return t("{name} deleted.", { name: collection.name }); } finally { await client.invalidateQueries({ queryKey: LIST_KEY }); }
    });
    if (done) onDeleted();
  };

  return (
    <Panel title={collection.name} subtitle={collection.description || undefined} closeTo={settingsPath("knowledge")}
      badges={<>{synced && <Badge>{t("From Fabric")}</Badge>}<Badge>{t.plural(collection.documents, { one: "{n} document", other: "{n} documents" })}</Badge></>}
      menu={<ActionMenu label={t("More actions for {name}", { name: collection.name })} actions={[{ label: t("Delete this collection…"), danger: true, onSelect: () => void remove() }]} />}>
      <PanelBlock>
        <p>{collection.agents.length ? t("Searched by {agents}.", { agents: t.list(collection.agents) })
          : t.rich("No agent searches it yet: tick it on an agent under {agents}.", { agents: <Link key="agents" to={settingsPath("agents")}>{t("Agents")}</Link> })}</p>
        {collection.source.kind === "fabric" && <p>{t("Filled from Fabric ({source}); changes come from there.", { source: collection.source.scope ? `${collection.source.project} · ${collection.source.scope}` : collection.source.project })}</p>}
      </PanelBlock>
      <PanelBlock title={t("Documents")}>
        {detail.isPending ? <SkeletonRows rows={3} label={t("Loading documents…")} /> : detail.isError ? (
          <LoadFailure what={t("Documents")} error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        ) : !detail.data.documents.length ? <p>{t("No document yet.")}</p> : (
          <ul className="fi-plain-list">
            {detail.data.documents.map((d) => (
              <li key={d.id}>
                <span className="fi-grow"><strong>{d.title}</strong> <span className="fi-hint">· {d.sourceUri} · {size(d.chars, t)}</span></span>
                {!synced && <button type="button" className="fi-text-button" disabled={!!docsWork.busy} onClick={() => void removeDoc(d)}>{t("Remove")}</button>}
              </li>
            ))}
          </ul>
        )}
        {!synced && (
          <>
            <label className="fi-field">{t("Upload .md or .txt files")}
              <input type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={!!docsWork.busy}
                onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
              <span className="fi-hint">{t("A file with the same name replaces the one already here.")}</span>
            </label>
            <form className="fi-callout" aria-label={t("Paste a document into {name}", { name: collection.name })} onSubmit={(e) => { e.preventDefault(); addPasted(); }}>
              <label className="fi-field" style={{ marginTop: 0 }}>{t("Title")}
                <input className="fi-input" required maxLength={200} value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} />
              </label>
              <label className="fi-field">{t("Text")}
                <textarea className="fi-input" required rows={6} maxLength={maxChars} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} />
              </label>
              <div className="fi-buttons"><button type="submit" className="fi-secondary" disabled={!!docsWork.busy || !paste.title.trim() || !paste.text.trim()}>{t("Add document")}</button></div>
            </form>
          </>
        )}
        <ActionResult result={docsWork.result} />
      </PanelBlock>
      <PanelBlock title={t("Try a search, as an agent would")}>
        <form className="fi-buttons" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input className="fi-input" style={{ flex: 1, minWidth: 180 }} aria-label={t("Search words")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("How much does it cost?")} />
          <button type="submit" className="fi-secondary" disabled={!!searchWork.busy || !query.trim()}>{t("Search")}</button>
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
