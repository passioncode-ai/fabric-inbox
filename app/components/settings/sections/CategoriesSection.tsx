import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "~/services/fabric";
import {
  blankCategory, progressText, scopeSummary, type Category, type CategoryInput, type CategoryList, type Project,
} from "~/services/categories";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList,
  SkeletonPanel, SkeletonRows, useConfirm, useDirtyGuard, useWork,
} from "../ui";

type CategoryEntry = ListEntry & ({ kind: "category"; category: Category } | { kind: "project"; project: Project });

const KEY = ["categories"];
const NEW = "new";
const NEW_PROJECT = "new-project";
const PROJECT = "project:";
const GROUPS = [{ id: "categories", label: "Categories" }, { id: "projects", label: "Projects" }];

const words = (text: string) => [...new Set(text.split(/[\n,]+/).map((w) => w.trim()).filter(Boolean))];
const toInput = (c: Category): CategoryInput => ({
  name: c.name, description: c.description, scope: c.scope, conditions: c.conditions, promote: c.promote, enabled: c.enabled,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function selects(c: Category) {
  return c.kind === "scope"
    ? `Every message there (${c.accountIds?.length ?? 0} inbox${(c.accountIds?.length ?? 0) === 1 ? "" : "es"}).`
    : [c.description && `Described: “${c.description}”`, c.conditions.senders.length && `from ${c.conditions.senders.join(", ")}`,
       c.conditions.subjectWords.length && `subject has ${c.conditions.subjectWords.join(" / ")}`,
       c.conditions.textWords.length && `mentions ${c.conditions.textWords.join(" / ")}`].filter(Boolean).join(" · ");
}

/**
 * Settings → Categories (SCR-13, SCN-036, SCN-037, SCN-038): views over the mail that matters
 * (CAT-1..CAT-5), and the projects they can look at. The editor opens beside the chosen one.
 */
export default function CategoriesSection({ id }: { id: string | null }) {
  const list = useQuery({ queryKey: KEY, queryFn: () => fabric<CategoryList>("/api/categories"), refetchInterval: 15_000 });
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const data = list.data;
  const projects = data?.projects ?? [];
  const entries: CategoryEntry[] = [
    ...(data?.categories ?? []).map((c): CategoryEntry => ({ key: c.id, group: "categories", kind: "category", category: c, text: `${c.name} ${c.description}` })),
    ...projects.map((p): CategoryEntry => ({ key: PROJECT + p.id, group: "projects", kind: "project", project: p, text: [p.name, ...p.domains, ...p.addresses].join(" ") })),
  ];
  const groups = groupRows(visibleRows(entries, query, id), GROUPS);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const close = () => navigate(settingsPath("categories"), { replace: true, preventScrollReset: true });
  const open = (key: string) => navigate(settingsPath("categories", key), { replace: true, preventScrollReset: true });

  const listView = list.isPending ? <SkeletonRows label="Loading categories…" /> : list.isError ? (
    <LoadFailure what="Categories" error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
  ) : (
    <SelectableList label="Categories and projects" groups={groups} selected={id} hrefFor={(e) => settingsPath("categories", e.key)}
      renderRow={(e) => e.kind === "category" ? (
        <>
          <span className="fi-row-main">
            <span className="fi-row-title">{e.category.name}</span>
            <span className="fi-row-meta">{scopeSummary(e.category, projects)}{progressText(e.category) ? ` · ${progressText(e.category)}` : ""}</span>
          </span>
          <span className="fi-row-side">{!e.category.enabled && <Badge>Paused</Badge>}{e.category.promote && <Badge>Important</Badge>}</span>
        </>
      ) : (
        <span className="fi-row-main">
          <span className="fi-row-title">{e.project.name}</span>
          <span className="fi-row-meta">{[...e.project.domains, ...e.project.addresses].join(", ") || "No domain yet"}</span>
        </span>
      )}
      empty={<div className="fi-list-empty"><p>{query ? `No category matches “${query}”.` : "No category yet. For example: “Refund requests”, looking at all inboxes, described as “the sender asks for their money back”."}</p></div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Choose a category</h2>
      <p>A category sits in the sidebar with its count, and can raise its messages to Important.</p>
      <div className="fi-buttons" style={{ justifyContent: "center" }}>
        <Link className="fi-primary" to={settingsPath("categories", NEW)} preventScrollReset><PlusIcon size={16} /> New category</Link>
        <Link className="fi-secondary" to={settingsPath("categories", NEW_PROJECT)} preventScrollReset>New project</Link>
      </div>
    </PanelPlaceholder>
  ) : list.isPending || !data ? <SkeletonPanel label="Loading…" /> : id === NEW ? (
    <CategoryPanel key={NEW} data={data} onSaved={(c) => open(c.id)} onDeleted={close} />
  ) : id === NEW_PROJECT ? (
    <ProjectPanel key={NEW_PROJECT} data={data} onSaved={(p) => open(PROJECT + p.id)} onDeleted={close} />
  ) : !selected ? (
    <PanelPlaceholder>
      <h2>That category no longer exists</h2>
      <p>The mail itself is untouched.</p>
      <Link className="fi-secondary" to={settingsPath("categories")} replace preventScrollReset>All categories</Link>
    </PanelPlaceholder>
  ) : selected.kind === "category" ? (
    <CategoryPanel key={selected.key} category={selected.category} data={data} onSaved={() => undefined} onDeleted={close} />
  ) : (
    <ProjectPanel key={selected.key} project={selected.project} data={data} onSaved={() => undefined} onDeleted={close} />
  );

  return (
    <SectionLayout section="categories" hasSelection={!!id} list={listView} panel={panel}
      toolbar={<>
        <ListSearch value={query} onChange={setQuery} placeholder="Find a category or project" label="Find a category" />
        <Link className="fi-primary" to={settingsPath("categories", NEW)} preventScrollReset><PlusIcon size={16} /> New</Link>
        <Link className="fi-secondary" to={settingsPath("categories", NEW_PROJECT)} preventScrollReset>New project</Link>
      </>}
      footer={data ? <p>A description is read by the model once per new message in scope, for all described categories at once; at most {data.limits.dailyModelCalls} messages a day, the rest wait for the next day. A new or changed category sorts the last {data.limits.backfill} messages in its scope.</p> : undefined} />
  );
}

function CategoryPanel({ category, data, onSaved, onDeleted }: { category?: Category; data: CategoryList; onSaved: (c: Category) => void; onDeleted: () => void }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const key = category?.id ?? NEW;
  const work = useWork(key, "edit");
  const deleteWork = useWork(key, "delete");
  const [base, setBase] = useState(category ? toInput(category) : blankCategory());
  const [value, setValue] = useState(base);
  // The editor keeps the three condition lines as typed; a new revision starts it from `value` again.
  const [revision, setRevision] = useState(0);
  const reset = (to: CategoryInput) => { setValue(to); setRevision((r) => r + 1); };
  const dirty = !same(value, base);
  useDirtyGuard(dirty && !work.busy, category?.name ?? "the new category");
  // A refresh of the list (every 15 s, for progress) brings a newer version only into an untouched form.
  useEffect(() => {
    if (!category) return;
    const fresh = toInput(category);
    if (!same(fresh, base) && !dirty) { setBase(fresh); reset(fresh); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category?.version]);
  const projects = data.projects;
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: KEY }), client.invalidateQueries({ queryKey: ["unified-inbox"] })]);

  const save = () => void work.run("Saving…", async () => {
    try {
      const saved = category
        ? await fabric<Category>(`/api/categories/${category.id}`, value, "PUT")
        : await fabric<Category>("/api/categories", value);
      setBase(toInput(saved)); reset(toInput(saved));
      setTimeout(() => onSaved(saved), 0);
      return saved.kind === "screened"
        ? `${saved.name} is saved. Recent mail in its scope is being sorted now; new mail is sorted as it arrives.`
        : `${saved.name} is saved: it shows every message of ${saved.scope.all ? "all inboxes" : scopeSummary(saved, projects)}.`;
    } finally { await refresh(); }
  });
  const remove = async () => {
    if (!category) return;
    const ok = await confirm({
      title: `Delete ${category.name}?`, body: <p>Deleting removes the category and its sorting; no message is moved or deleted.</p>,
      confirmLabel: `Delete ${category.name}`, danger: true,
    });
    if (!ok) return;
    const done = await deleteWork.run("Deleting…", async () => {
      try { await fabric(`/api/categories/${category.id}`, undefined, "DELETE"); return `${category.name} deleted. The mail itself is untouched.`; } finally { await refresh(); }
    });
    if (done) onDeleted();
  };

  return (
    <Panel title={category?.name ?? "New category"} closeTo={settingsPath("categories")}
      subtitle={category ? `Looks at ${category.scope.all ? "all inboxes" : scopeSummary(category, projects)}${category.promote ? " · raises its mail to Important" : ""}` : undefined}
      badges={category && !category.enabled ? <Badge>Paused</Badge> : undefined}
      menu={category ? <ActionMenu label={`More actions for ${category.name}`} actions={[
        { label: `Delete ${category.name}…`, danger: true, onSelect: () => void remove() },
      ]} /> : undefined}>
      {category && (
        <PanelBlock>
          <p>{selects(category)}</p>
          {category.kind === "screened" && (
            <p className="fi-hint">{[category.stats.classified ? `${category.stats.matched} of ${category.stats.classified} sorted messages belong here` : "", progressText(category) ?? ""].filter(Boolean).join(" · ") || "Nothing sorted yet"}</p>
          )}
          <Link className="fi-secondary" to={`/?category=${category.id}`}>Open in the inbox</Link>
        </PanelBlock>
      )}
      <CategoryEditor key={revision} value={value} id={category?.id} data={data} busy={!!work.busy} onChange={setValue}
        onSave={save} onCancel={dirty ? () => reset(base) : undefined} />
      <ActionResult result={work.result} />
      <ActionResult result={deleteWork.result} />
    </Panel>
  );
}

function CategoryEditor({ value, id, data, busy, onChange, onSave, onCancel }: {
  value: CategoryInput; id?: string; data: CategoryList; busy: boolean;
  onChange: (v: CategoryInput) => void; onSave: () => void; onCancel?: () => void;
}) {
  const set = <K extends keyof CategoryInput>(k: K, v: CategoryInput[K]) => onChange({ ...value, [k]: v });
  const setScope = (patch: Partial<CategoryInput["scope"]>) => set("scope", { ...value.scope, ...patch });
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  // What is ticked stays visible whatever the search, so a choice is never hidden.
  const shown = (text: string, ticked: boolean) => ticked || !needle || text.toLowerCase().includes(needle);
  const domains = [...new Set(data.accounts.filter((a) => a.provider === "cloudflare").map((a) => a.email.split("@")[1]!))].sort()
    .filter((d) => shown(d, value.scope.domains.includes(d)));
  const inboxes = data.accounts.filter((a) => shown(a.email, value.scope.accounts.includes(a.id)));
  const picked = value.scope.projects.length + value.scope.domains.length + value.scope.accounts.length;
  const screened = !!value.description.trim() || value.conditions.senders.length + value.conditions.subjectWords.length + value.conditions.textWords.length > 0;
  const nowhere = !value.scope.all && !value.scope.accounts.length && !value.scope.domains.length && !value.scope.projects.length;
  const [senders, setSenders] = useState(value.conditions.senders.join(", "));
  const [subject, setSubject] = useState(value.conditions.subjectWords.join(", "));
  const [text, setText] = useState(value.conditions.textWords.join(", "));
  const syncConditions = (patch: Partial<{ senders: string; subject: string; text: string }>) => {
    const next = { senders, subject, text, ...patch };
    set("conditions", { senders: words(next.senders.toLowerCase()), subjectWords: words(next.subject), textWords: words(next.text) });
  };
  return (
    <form aria-label={id ? `Edit ${value.name}` : "New category"} onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <label className="fi-field">Name
        <input className="fi-input" required maxLength={60} value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Refund requests" />
      </label>
      <fieldset>
        <legend>Where to look</legend>
        <label className="fi-check"><input type="checkbox" checked={value.scope.all} onChange={(e) => setScope({ all: e.target.checked })} /><span>All inboxes, present and future</span></label>
        {!value.scope.all && (
          <>
            <div className="fi-buttons">
              <input className="fi-input" style={{ flex: 1, minWidth: 180 }} type="search" value={find} onChange={(e) => setFind(e.target.value)}
                placeholder="Find a domain or inbox" aria-label="Find a domain or inbox" />
              <span className="fi-hint" aria-live="polite">{picked ? `${picked} chosen` : "Nothing chosen yet"}</span>
            </div>
            <div className="fi-field-row">
              <div>
                <p className="fi-hint">Projects</p>
                {data.projects.length ? data.projects.map((p) => (
                  <label key={p.id} className="fi-check"><input type="checkbox" checked={value.scope.projects.includes(p.id)} onChange={() => setScope({ projects: toggle(value.scope.projects, p.id) })} /><span>{p.name}</span></label>
                )) : <p className="fi-hint">None yet. <Link to={settingsPath("categories", NEW_PROJECT)}>New project</Link></p>}
              </div>
              <div>
                <p className="fi-hint">Domains · a domain covers every address on it</p>
                <div style={{ maxHeight: 240, overflow: "auto" }}>
                  {!domains.length && <p className="fi-hint">No domain matches.</p>}
                  {domains.map((d) => (
                    <label key={d} className="fi-check"><input type="checkbox" checked={value.scope.domains.includes(d)} onChange={() => setScope({ domains: toggle(value.scope.domains, d) })} /><span>{d}</span></label>
                  ))}
                </div>
              </div>
              <div>
                <p className="fi-hint">Single inboxes</p>
                <div style={{ maxHeight: 240, overflow: "auto" }}>
                  {!inboxes.length && <p className="fi-hint">No inbox matches.</p>}
                  {inboxes.map((a) => (
                    <label key={a.id} className="fi-check"><input type="checkbox" checked={value.scope.accounts.includes(a.id)} onChange={() => setScope({ accounts: toggle(value.scope.accounts, a.id) })} /><span>{a.email}</span></label>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
        {nowhere && <p role="alert">Choose all inboxes, or at least one project, domain or inbox.</p>}
      </fieldset>
      <label className="fi-field">What belongs here, in your words (optional)
        <span className="fi-hint">The model reads each new message in scope against this and keeps only what fits, with a one-line reason. Leave it empty to see every message in scope.</span>
        <textarea className="fi-input" rows={3} maxLength={1000} value={value.description} onChange={(e) => set("description", e.target.value)}
          placeholder="The sender asks for a refund or their money back, or disputes a charge." />
      </label>
      <details style={{ marginTop: 12 }} open={value.conditions.senders.length + value.conditions.subjectWords.length + value.conditions.textWords.length > 0}>
        <summary>Plain conditions (optional, no model)</summary>
        <p className="fi-hint">Each filled line must match; any entry in it is enough. With a description, these narrow what the model reads.</p>
        <label className="fi-field">From
          <input className="fi-input" value={senders} onChange={(e) => { setSenders(e.target.value); syncConditions({ senders: e.target.value }); }} placeholder="@stripe.com, billing@example.com" />
        </label>
        <label className="fi-field">Subject has
          <input className="fi-input" value={subject} onChange={(e) => { setSubject(e.target.value); syncConditions({ subject: e.target.value }); }} placeholder="refund, возврат" />
        </label>
        <label className="fi-field">Text mentions
          <input className="fi-input" value={text} onChange={(e) => { setText(e.target.value); syncConditions({ text: e.target.value }); }} placeholder="chargeback" />
        </label>
      </details>
      <label className="fi-check"><input type="checkbox" checked={value.promote} onChange={(e) => set("promote", e.target.checked)} /><span>Also raise its messages to Important in Focus</span></label>
      {id && <label className="fi-check"><input type="checkbox" checked={value.enabled} onChange={(e) => set("enabled", e.target.checked)} /><span>Active (paused categories sort nothing and leave the sidebar)</span></label>}
      <p className="fi-hint">
        {screened
          ? value.description.trim() ? "Sorted by the model: recent mail in scope is sorted when you save, then each new message." : "Sorted by the conditions alone: no model is used."
          : "Shows every message in scope, as it is now; nothing is sorted."}
        {id ? " Changing where it looks, the description or the conditions sorts again from scratch." : ""}
      </p>
      <div className="fi-buttons">
        <button type="submit" className="fi-primary" disabled={busy || nowhere || !value.name.trim()}>{busy ? "Saving…" : "Save category"}</button>
        {onCancel && <button type="button" className="fi-secondary" disabled={busy} onClick={onCancel}>Undo changes</button>}
      </div>
    </form>
  );
}

function ProjectPanel({ project, data, onSaved, onDeleted }: { project?: Project; data: CategoryList; onSaved: (p: Project) => void; onDeleted: () => void }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const key = project ? PROJECT + project.id : NEW_PROJECT;
  const work = useWork(key, "edit");
  const deleteWork = useWork(key, "delete");
  const initial = { name: project?.name ?? "", domains: project?.domains.join("\n") ?? "", addresses: project?.addresses.join("\n") ?? "" };
  const [base, setBase] = useState(initial);
  const [form, setForm] = useState(initial);
  const dirty = !same(form, base);
  useDirtyGuard(dirty && !work.busy, project?.name ?? "the new project");
  const used = project ? data.categories.filter((c) => c.scope.projects.includes(project.id)) : [];

  const save = () => void work.run("Saving…", async () => {
    try {
      const body = { name: form.name, domains: words(form.domains.toLowerCase()), addresses: words(form.addresses.toLowerCase()) };
      const saved = project ? await fabric<Project>(`/api/projects/${project.id}`, body, "PUT") : await fabric<Project>("/api/projects", body);
      const next = { name: saved.name, domains: saved.domains.join("\n"), addresses: saved.addresses.join("\n") };
      setBase(next); setForm(next);
      setTimeout(() => onSaved(saved), 0);
      return `Project ${saved.name} saved. Choose it as the place to look in a category.`;
    } finally { await client.invalidateQueries({ queryKey: KEY }); }
  });
  const remove = async () => {
    if (!project) return;
    const ok = await confirm({
      title: `Delete project ${project.name}?`, body: <p>Its domains and addresses are untouched.</p>, confirmLabel: `Delete ${project.name}`, danger: true,
      blocked: used.length ? `${used.map((c) => c.name).join(", ")} look${used.length === 1 ? "s" : ""} at it; change ${used.length === 1 ? "that category" : "those categories"} first.` : undefined,
    });
    if (!ok) return;
    const done = await deleteWork.run("Deleting…", async () => {
      try { await fabric(`/api/projects/${project.id}`, undefined, "DELETE"); return `Project ${project.name} deleted.`; } finally { await client.invalidateQueries({ queryKey: KEY }); }
    });
    if (done) onDeleted();
  };
  const placeholder = [...new Set(data.accounts.filter((a) => a.provider === "cloudflare").map((a) => a.email.split("@")[1]))].slice(0, 2).join(", ");
  return (
    <Panel title={project?.name ?? "New project"} subtitle="A project is the domains and addresses one product uses; categories can look at all of them at once."
      closeTo={settingsPath("categories")}
      menu={project ? <ActionMenu label={`More actions for ${project.name}`} actions={[{ label: `Delete ${project.name}…`, danger: true, onSelect: () => void remove() }]} /> : undefined}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="fi-field">Name
          <input className="fi-input" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme" />
        </label>
        <label className="fi-field">Domains
          <span className="fi-hint">One per line or comma-separated. A domain covers its subdomains.</span>
          <textarea className="fi-input" rows={3} value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} placeholder={placeholder} />
        </label>
        <label className="fi-field">Addresses (optional)
          <span className="fi-hint">Single inboxes elsewhere, for example a Gmail account the project uses.</span>
          <textarea className="fi-input" rows={2} value={form.addresses} onChange={(e) => setForm({ ...form, addresses: e.target.value })} />
        </label>
        <div className="fi-buttons">
          <button type="submit" className="fi-primary" disabled={!!work.busy || !form.name.trim() || !dirty}>{work.busy ? "Saving…" : "Save project"}</button>
          {dirty && project && <button type="button" className="fi-secondary" onClick={() => setForm(base)}>Undo changes</button>}
        </div>
      </form>
      {used.length > 0 && <p className="fi-hint">Looked at by {used.map((c) => c.name).join(", ")}.</p>}
      <ActionResult result={work.result} />
      <ActionResult result={deleteWork.result} />
    </Panel>
  );
}
