import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { fabric } from "~/services/fabric";
import {
  blankCategory, progressText, scopeSummary,
  type Category, type CategoryInput, type CategoryList, type Project,
} from "~/services/categories";

export function meta() {
  return [{ title: "Categories · Fabric Inbox" }];
}

const inputClass = "mt-1 w-full rounded-lg border border-kumo-line bg-transparent px-3 py-2 text-sm";
const KEY = ["categories"];
const words = (text: string) => [...new Set(text.split(/[\n,]+/).map((w) => w.trim()).filter(Boolean))];
const toInput = (c: Category): CategoryInput => ({
  name: c.name, description: c.description, scope: c.scope, conditions: c.conditions, promote: c.promote, enabled: c.enabled,
});

/**
 * SCR-13 Categories: views over the mail that matters (CAT-1..CAT-5). A category
 * looks somewhere (all inboxes, projects, domains, addresses) and, optionally,
 * keeps only what plain conditions or a description in words select; the model
 * reads each new message in scope against the description.
 */
export default function CategoriesPage() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const list = useQuery({ queryKey: KEY, queryFn: () => fabric<CategoryList>("/api/categories"), refetchInterval: 15_000 });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; input: CategoryInput } | null>(null);
  const [projectEdit, setProjectEdit] = useState<{ id?: string; name: string; domains: string; addresses: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");
  const focus = params.get("c") ?? "";

  async function run(action: () => Promise<string>) {
    setBusy(true); setNotice("");
    try { setNotice(await action()); await client.invalidateQueries({ queryKey: KEY }); await client.invalidateQueries({ queryKey: ["unified-inbox"] }); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  const data = list.data;
  const projects = data?.projects ?? [];
  const opened = data?.categories.find((c) => c.id === focus);
  useEffect(() => {
    // Arriving from a category's "Change" link opens its editor once.
    if (!opened) return;
    setEditing({ id: opened.id, input: toInput(opened) });
    setParams({}, { replace: true });
  }, [opened, setParams]);
  useEffect(() => {
    if (focus && data && !opened) { setNotice("That category no longer exists."); setParams({}, { replace: true }); }
  }, [focus, data, opened, setParams]);

  return (
    <main className="mx-auto max-w-4xl p-6 text-kumo-default">
      <nav className="flex gap-4 text-sm">
        <Link to="/">← Fabric Inbox</Link>
        <Link to="/ai-agents" className="underline">Agents</Link>
        <Link to="/projects" className="underline">Domains &amp; addresses</Link>
      </nav>
      <h1 className="mt-8 text-3xl font-semibold">Categories</h1>
      <p className="my-3 text-kumo-subtle">
        A category is a view of the mail that matters to you: everything from a project, or only what you describe — refund requests
        from any inbox, support questions for Acme. It sits in the sidebar with its count, and can raise its messages to Important.
      </p>
      {notice && <p role="status" className="my-4 rounded-lg border border-kumo-line p-3">{notice}</p>}

      {!editing && (
        <div className="my-6 flex flex-wrap gap-3">
          <button className="fi-primary" disabled={busy || !data} onClick={() => setEditing({ input: blankCategory() })}>New category</button>
          <button className="fi-secondary" disabled={busy || !data} onClick={() => setProjectEdit({ name: "", domains: "", addresses: "" })}>New project</button>
        </div>
      )}

      {editing && data && (
        <CategoryEditor value={editing.input} id={editing.id} data={data} busy={busy}
          onChange={(input) => setEditing({ ...editing, input })}
          onCancel={() => setEditing(null)}
          onNewProject={projectEdit ? undefined : () => setProjectEdit({ name: "", domains: "", addresses: "" })}
          onSave={() => void run(async () => {
            const saved = editing.id
              ? await fabric<Category>(`/api/categories/${editing.id}`, editing.input, "PUT")
              : await fabric<Category>("/api/categories", editing.input);
            setEditing(null);
            return saved.kind === "screened"
              ? `${saved.name} is saved. Recent mail in its scope is being sorted now; new mail is sorted as it arrives.`
              : `${saved.name} is saved: it shows every message of ${saved.scope.all ? "all inboxes" : scopeSummary(saved, projects)}.`;
          })} />
      )}

      {projectEdit && (
        <form className="my-6 rounded-xl border border-kumo-line p-5" aria-label={projectEdit.id ? "Edit project" : "New project"}
          onSubmit={(e) => { e.preventDefault(); void run(async () => {
            const body = { name: projectEdit.name, domains: words(projectEdit.domains.toLowerCase()), addresses: words(projectEdit.addresses.toLowerCase()) };
            const saved = projectEdit.id ? await fabric<Project>(`/api/projects/${projectEdit.id}`, body, "PUT") : await fabric<Project>("/api/projects", body);
            setProjectEdit(null);
            return `Project ${saved.name} saved. Choose it as the place to look in a category.`;
          }); }}>
          <h2 className="text-xl font-medium">{projectEdit.id ? `Edit ${projectEdit.name}` : "New project"}</h2>
          <p className="mt-1 text-sm text-kumo-subtle">A project is the domains and addresses one product uses; categories can look at all of them at once.</p>
          <label className="mt-3 block text-sm font-medium">Name
            <input className={inputClass} required autoFocus maxLength={80} value={projectEdit.name} onChange={(e) => setProjectEdit({ ...projectEdit, name: e.target.value })} placeholder="Acme" />
          </label>
          <label className="mt-3 block text-sm font-medium">Domains
            <span className="block text-xs font-normal text-kumo-subtle">One per line or comma-separated. A domain covers its subdomains.</span>
            <textarea className={inputClass} rows={3} value={projectEdit.domains} onChange={(e) => setProjectEdit({ ...projectEdit, domains: e.target.value })}
              placeholder={[...new Set((data?.accounts ?? []).filter((a) => a.provider === "cloudflare").map((a) => a.email.split("@")[1]))].slice(0, 2).join(", ")} />
          </label>
          <label className="mt-3 block text-sm font-medium">Addresses (optional)
            <span className="block text-xs font-normal text-kumo-subtle">Single inboxes elsewhere, for example a Gmail account the project uses.</span>
            <textarea className={inputClass} rows={2} value={projectEdit.addresses} onChange={(e) => setProjectEdit({ ...projectEdit, addresses: e.target.value })} />
          </label>
          <div className="mt-4 flex gap-3">
            <button type="submit" className="fi-primary" disabled={busy || !projectEdit.name.trim()}>Save project</button>
            <button type="button" className="fi-secondary" onClick={() => setProjectEdit(null)}>Cancel</button>
          </div>
        </form>
      )}

      {list.isPending ? <p role="status" className="my-6 text-kumo-subtle">Loading categories…</p> : list.isError ? (
        <p role="alert" className="my-6">Categories could not load: {(list.error as Error).message} <button className="underline" onClick={() => void list.refetch()}>Retry</button></p>
      ) : (
        <>
          <section className="my-6" aria-labelledby="cats-heading">
            <h2 id="cats-heading" className="text-xl font-medium">Your categories</h2>
            {!data!.categories.length && <p className="mt-2 text-sm">No category yet. For example: “Refund requests”, looking at all inboxes, described as “the sender asks for their money back”.</p>}
            {data!.categories.map((c) => (
              <article key={c.id} className="mt-3 rounded-xl border border-kumo-line p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="text-lg font-medium">{c.name} {!c.enabled && <span className="text-sm font-normal text-kumo-subtle">· paused</span>}</h3>
                  <div className="flex flex-wrap gap-2">
                    <Link className="fi-secondary" to={`/?category=${c.id}`}>Open</Link>
                    <button className="fi-secondary" disabled={busy} onClick={() => setEditing({ id: c.id, input: toInput(c) })}>Edit</button>
                    {confirmDelete === c.id ? (
                      <>
                        <button className="fi-secondary" disabled={busy} onClick={() => void run(async () => {
                          await fabric(`/api/categories/${c.id}`, undefined, "DELETE"); setConfirmDelete(""); return `${c.name} deleted. The mail itself is untouched.`;
                        })}>Delete {c.name}</button>
                        <button className="fi-secondary" onClick={() => setConfirmDelete("")}>Keep</button>
                      </>
                    ) : <button className="fi-secondary" disabled={busy} onClick={() => setConfirmDelete(c.id)}>Delete…</button>}
                  </div>
                </div>
                <p className="mt-1 text-sm">Looks at {c.scope.all ? "all inboxes" : scopeSummary(c, projects)}{c.promote ? " · raises its mail to Important" : ""}</p>
                <p className="mt-1 text-sm text-kumo-subtle">
                  {c.kind === "scope"
                    ? `Every message there (${c.accountIds?.length ?? 0} inbox${(c.accountIds?.length ?? 0) === 1 ? "" : "es"}).`
                    : [c.description && `Described: “${c.description}”`, c.conditions.senders.length && `from ${c.conditions.senders.join(", ")}`,
                       c.conditions.subjectWords.length && `subject has ${c.conditions.subjectWords.join(" / ")}`,
                       c.conditions.textWords.length && `mentions ${c.conditions.textWords.join(" / ")}`].filter(Boolean).join(" · ")}
                </p>
                {c.kind === "screened" && (
                  <p className="mt-1 text-sm text-kumo-subtle">
                    {[c.stats.classified ? `${c.stats.matched} of ${c.stats.classified} sorted messages belong here` : "", progressText(c) ?? ""].filter(Boolean).join(" · ") || "Nothing sorted yet"}
                  </p>
                )}
                {confirmDelete === c.id && <p role="alert" className="mt-2 text-sm">Deleting removes the category and its sorting; no message is moved or deleted.</p>}
              </article>
            ))}
          </section>

          <section className="my-8" aria-labelledby="projects-heading">
            <h2 id="projects-heading" className="text-xl font-medium">Projects</h2>
            {!projects.length && <p className="mt-2 text-sm">No project yet. A project groups the domains and addresses of one product, for example Acme.</p>}
            {!!projects.length && <ul className="mt-2 divide-y divide-kumo-line rounded-xl border border-kumo-line text-sm">
              {projects.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <span><strong>{p.name}</strong> <span className="text-kumo-subtle">· {[...p.domains, ...p.addresses].join(", ")}</span></span>
                  <span className="flex gap-3">
                    <button className="underline" disabled={busy} onClick={() => setProjectEdit({ id: p.id, name: p.name, domains: p.domains.join("\n"), addresses: p.addresses.join("\n") })}>Edit</button>
                    <button className="underline" disabled={busy} onClick={() => void run(async () => {
                      await fabric(`/api/projects/${p.id}`, undefined, "DELETE"); return `Project ${p.name} deleted.`;
                    })}>Delete</button>
                  </span>
                </li>
              ))}
            </ul>}
          </section>
          <p className="my-6 text-xs text-kumo-subtle">
            A description is read by the model once per new message in scope, for all described categories at once; at most
            {" "}{data!.limits.dailyModelCalls} messages a day, the rest wait for the next day. A new or changed category sorts the last
            {" "}{data!.limits.backfill} messages in its scope.
          </p>
        </>
      )}
    </main>
  );
}

function CategoryEditor({ value, id, data, busy, onChange, onSave, onCancel, onNewProject }: {
  value: CategoryInput; id?: string; data: CategoryList; busy: boolean;
  onChange: (v: CategoryInput) => void; onSave: () => void; onCancel: () => void; onNewProject?: () => void;
}) {
  const set = <K extends keyof CategoryInput>(k: K, v: CategoryInput[K]) => onChange({ ...value, [k]: v });
  const setScope = (patch: Partial<CategoryInput["scope"]>) => set("scope", { ...value.scope, ...patch });
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  // What is ticked stays visible whatever the search, so a choice is never hidden.
  const shown = (text: string, ticked: boolean) => ticked || !needle || text.toLowerCase().includes(needle);
  const domains = [...new Set(data.accounts.filter((a) => a.provider === "cloudflare").map((a) => a.email.split("@")[1]))].sort()
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
    <form className="my-6 rounded-xl border border-kumo-line p-5" aria-label={id ? `Edit ${value.name}` : "New category"} onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <h2 className="text-xl font-medium">{id ? `Edit ${value.name}` : "New category"}</h2>
      <label className="mt-4 block text-sm font-medium">Name
        <input className={inputClass} required maxLength={60} value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Refund requests" />
      </label>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium">Where to look</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.scope.all} onChange={(e) => setScope({ all: e.target.checked })} /> All inboxes, present and future
        </label>
        {!value.scope.all && (
          <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input className={inputClass + " sm:max-w-xs"} type="search" value={find} onChange={(e) => setFind(e.target.value)}
              placeholder="Find a domain or inbox" aria-label="Find a domain or inbox" />
            <span className="text-sm text-kumo-subtle" aria-live="polite">{picked ? `${picked} chosen` : "Nothing chosen yet"}</span>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs font-medium text-kumo-subtle">Projects</p>
              {data.projects.length ? data.projects.map((p) => (
                <label key={p.id} className="mt-1 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={value.scope.projects.includes(p.id)} onChange={() => setScope({ projects: toggle(value.scope.projects, p.id) })} /> {p.name}
                </label>
              )) : <p className="mt-1 text-sm text-kumo-subtle">None yet. {onNewProject && <button type="button" className="underline" onClick={onNewProject}>New project</button>}</p>}
            </div>
            <div>
              <p className="text-xs font-medium text-kumo-subtle">Domains <span className="font-normal">· a domain covers every address on it</span></p>
              <div className="max-h-60 overflow-auto">
              {!domains.length && <p className="mt-1 text-sm text-kumo-subtle">No domain matches.</p>}
              {domains.map((d) => (
                <label key={d} className="mt-1 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={value.scope.domains.includes(d)} onChange={() => setScope({ domains: toggle(value.scope.domains, d) })} /> {d}
                </label>
              ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-kumo-subtle">Single inboxes</p>
              <div className="max-h-60 overflow-auto">
                {!inboxes.length && <p className="mt-1 text-sm text-kumo-subtle">No inbox matches.</p>}
                {inboxes.map((a) => (
                  <label key={a.id} className="mt-1 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={value.scope.accounts.includes(a.id)} onChange={() => setScope({ accounts: toggle(value.scope.accounts, a.id) })} /> {a.email}
                  </label>
                ))}
              </div>
            </div>
          </div>
          </>
        )}
        {nowhere && <p className="mt-2 text-sm">Choose all inboxes, or at least one project, domain or inbox.</p>}
      </fieldset>

      <label className="mt-5 block text-sm font-medium">What belongs here, in your words (optional)
        <span className="block text-xs font-normal text-kumo-subtle">The model reads each new message in scope against this and keeps only what fits, with a one-line reason. Leave it empty to see every message in scope.</span>
        <textarea className={inputClass} rows={3} maxLength={1000} value={value.description} onChange={(e) => set("description", e.target.value)}
          placeholder="The sender asks for a refund or their money back, or disputes a charge." />
      </label>

      <details className="mt-4" open={value.conditions.senders.length + value.conditions.subjectWords.length + value.conditions.textWords.length > 0}>
        <summary className="cursor-pointer text-sm font-medium">Plain conditions (optional, no model)</summary>
        <p className="mt-1 text-xs text-kumo-subtle">Each filled line must match; any entry in it is enough. With a description, these narrow what the model reads.</p>
        <label className="mt-2 block text-sm">From
          <input className={inputClass} value={senders} onChange={(e) => { setSenders(e.target.value); syncConditions({ senders: e.target.value }); }} placeholder="@stripe.com, billing@example.com" />
        </label>
        <label className="mt-2 block text-sm">Subject has
          <input className={inputClass} value={subject} onChange={(e) => { setSubject(e.target.value); syncConditions({ subject: e.target.value }); }} placeholder="refund, возврат" />
        </label>
        <label className="mt-2 block text-sm">Text mentions
          <input className={inputClass} value={text} onChange={(e) => { setText(e.target.value); syncConditions({ text: e.target.value }); }} placeholder="chargeback" />
        </label>
      </details>

      <label className="mt-5 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.promote} onChange={(e) => set("promote", e.target.checked)} /> Also raise its messages to Important in Focus
      </label>
      {id && (
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Active (paused categories sort nothing and leave the sidebar)
        </label>
      )}
      <p className="mt-4 text-sm text-kumo-subtle">
        {screened
          ? value.description.trim()
            ? "Sorted by the model: recent mail in scope is sorted when you save, then each new message."
            : "Sorted by the conditions alone: no model is used."
          : "Shows every message in scope, as it is now; nothing is sorted."}
        {id ? " Changing where it looks, the description or the conditions sorts again from scratch." : ""}
      </p>
      <div className="mt-5 flex gap-3">
        <button type="submit" className="fi-primary" disabled={busy || nowhere || !value.name.trim()}>{busy ? "Saving…" : "Save category"}</button>
        <button type="button" className="fi-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
