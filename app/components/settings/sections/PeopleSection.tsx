/** @jsxRuntime automatic @jsxImportSource react */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PlusIcon } from "@phosphor-icons/react";
import { fabric } from "../../../services/fabric";
import { useT } from "../../../lib/i18n";
import type { T } from "../../../../shared/i18n";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, Dialog, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout,
  SelectableList, SkeletonPanel, SkeletonRows, errorText, useConfirm, useWork,
} from "../ui";

type Role = "admin" | "member";
export interface Person { email: string; role: Role; accounts: string[] | null; addedAt: string }
interface PeopleState { members: Person[]; open: boolean; you: string | null }
interface Mailbox { id: string; email?: string }
export const PEOPLE_KEY = ["members"];

export const roleTitle = (role: Role, t: T) => (role === "admin" ? t("Administrator") : t("Member"));
export const reachText = (p: Pick<Person, "role" | "accounts">, t: T) =>
  p.role === "admin" ? t("Everything on this server") : t("Only {mailboxes}", { mailboxes: t.list((p.accounts ?? []).map((a) => a.replace(/^cloudflare:/, ""))) });

/**
 * Settings → People (SCR-16, SCN-081, B-149): who signs in to a shared server and what they reach.
 * Cloudflare Access decides who may sign in at all; this list decides the role. Empty, everyone Access
 * lets in is an administrator, as on a server of one person.
 */
export default function PeopleSection({ id }: { id: string | null }) {
  const t = useT();
  const people = useQuery({ queryKey: PEOPLE_KEY, queryFn: () => fabric<PeopleState>("/api/members") });
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const data = people.data;
  const entries = (data?.members ?? []).map((p): ListEntry & { person: Person } => ({ key: p.email, group: p.role, person: p, text: `${p.email} ${roleTitle(p.role, t)}` }));
  const groups = groupRows(visibleRows(entries, query, id), [{ id: "admin", label: t("Administrators") }, { id: "member", label: t("Members") }]);
  const selected = id ? entries.find((e) => e.key === id) ?? null : null;
  const adding = params.get("new") === "1";
  const setAdding = (on: boolean) => setParams((old) => { const n = new URLSearchParams(old); if (on) n.set("new", "1"); else n.delete("new"); return n; }, { replace: true, preventScrollReset: true });

  const listView = people.isPending ? <SkeletonRows label={t("Loading people…")} /> : people.isError ? (
    <LoadFailure what={t("People")} error={people.error} onRetry={() => void people.refetch()} retrying={people.isFetching} />
  ) : (
    <SelectableList label={t("People")} groups={groups} selected={id} hrefFor={(e) => settingsPath("people", e.key)}
      renderRow={(e) => (
        <>
          <span className="fi-row-main">
            <span className="fi-row-title">{e.person.email}{e.person.email === data?.you ? ` ${t("(you)")}` : ""}</span>
            <span className="fi-row-meta">{reachText(e.person, t)}</span>
          </span>
          <span className="fi-row-side"><Badge>{roleTitle(e.person.role, t)}</Badge></span>
        </>
      )}
      empty={<div className="fi-list-empty"><p>{query ? t("Nobody matches “{query}”.", { query }) : t("Nobody is listed: everyone who can sign in is an administrator.")}</p></div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{t("Share this server with other people")}</h2>
      <p>{t("Cloudflare Access decides who can sign in at all. This list decides what each of them reaches: an administrator manages everything, a member reads and answers only the mailboxes you give them.")}</p>
      {data?.open && <p>{t("Nobody is listed yet, so everyone who can sign in is an administrator. The first person you add makes you this server's administrator too.")}</p>}
      <button type="button" onClick={() => setAdding(true)}><PlusIcon size={16} /> {t("Add a person")}</button>
    </PanelPlaceholder>
  ) : people.isPending ? <SkeletonPanel label={t("Loading…")} /> : !selected ? (
    <PanelPlaceholder>
      <h2>{t("This person is not on the list")}</h2>
      <p>{t("They may have been removed.")}</p>
      <Link className="fi-secondary" to={settingsPath("people")} replace preventScrollReset>{t("All people")}</Link>
    </PanelPlaceholder>
  ) : (
    <PersonPanel key={selected.key} person={selected.person} you={data?.you ?? null}
      onRemoved={() => navigate(settingsPath("people"), { replace: true, preventScrollReset: true })} />
  );

  return (
    <>
      <SectionLayout section="people" hasSelection={!!id} list={listView} panel={panel}
        toolbar={<>
          <ListSearch value={query} onChange={setQuery} placeholder={t("Find a person")} label={t("Find a person")} />
          <button type="button" className="fi-primary" onClick={() => setAdding(true)}><PlusIcon size={16} /> {t("Add a person")}</button>
        </>} />
      <PersonDialog open={adding} onClose={() => setAdding(false)}
        onDone={(email) => { setAdding(false); navigate(settingsPath("people", email), { replace: true, preventScrollReset: true }); }} />
    </>
  );
}

function PersonPanel({ person: p, you, onRemoved }: { person: Person; you: string | null; onRemoved: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const work = useWork(p.email);
  const [editing, setEditing] = useState(false);
  const remove = async () => {
    const self = p.email === you;
    const ok = await confirm({ title: t("Remove {email}?", { email: p.email }),
      body: <p>{self ? t("You can no longer open this server. Another administrator can add you again.") : t("{email} can no longer open this server, even when Cloudflare Access lets them sign in.", { email: p.email })}</p>,
      confirmLabel: t("Remove"), cancelLabel: t("Keep"), danger: true });
    if (!ok) return;
    const done = await work.run(t("Removing…"), async () => {
      try {
        await fabric(`/api/members/${encodeURIComponent(p.email)}`, undefined, "DELETE");
        return t("{email} was removed.", { email: p.email });
      } finally { await client.invalidateQueries({ queryKey: PEOPLE_KEY }); }
    });
    if (done) onRemoved();
  };
  return (
    <Panel title={p.email} subtitle={roleTitle(p.role, t)} closeTo={settingsPath("people")}
      menu={<ActionMenu label={t("More actions for {email}", { email: p.email })} actions={[
        { label: t("Change…"), onSelect: () => setEditing(true) },
        { label: t("Remove…"), danger: true, onSelect: () => void remove() },
      ]} />}>
      <PanelBlock>
        <ul className="fi-facts">
          <li><strong>{t("Role")}</strong> {roleTitle(p.role, t)}</li>
          <li><strong>{t("Reaches")}</strong> {reachText(p, t)}</li>
          <li><strong>{t("Added")}</strong> {t.date(p.addedAt, { year: "numeric", month: "short", day: "numeric" })}</li>
        </ul>
        {p.role === "member" && <p className="fi-hint">{t("A member reads, answers and sorts the mail of these mailboxes. Settings, other mailboxes, agents and categories stay with the administrators.")}</p>}
        <ActionResult result={work.result} />
      </PanelBlock>
      <PersonDialog open={editing} person={p} onClose={() => setEditing(false)} onDone={() => setEditing(false)} />
    </Panel>
  );
}

/** Adds a person, or changes one (`person`). A member needs at least one mailbox. */
function PersonDialog({ open, person, onClose, onDone }: { open: boolean; person?: Person; onClose: () => void; onDone: (email: string) => void }) {
  const t = useT();
  const client = useQueryClient();
  const blank = () => ({ email: person?.email ?? "", role: (person?.role ?? "member") as Role, accounts: person?.accounts ?? [] });
  const [form, setForm] = useState(blank);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const mailboxes = useQuery({ queryKey: ["people-mailboxes"], enabled: open, queryFn: () => fabric<{ accounts: Mailbox[] }>("/api/inbox?limit=1") });
  useEffect(() => { if (open) { setForm(blank()); setProblem(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setWorking(true); setProblem("");
    try {
      const email = form.email.trim().toLowerCase();
      await fabric(`/api/members/${encodeURIComponent(email)}`, { role: form.role, ...(form.role === "member" ? { accounts: form.accounts } : {}) }, "PUT");
      await client.invalidateQueries({ queryKey: PEOPLE_KEY });
      onDone(email);
    } catch (error) { setProblem(t.text(errorText(error))); } finally { setWorking(false); }
  }
  return (
    <Dialog open={open} title={person ? t("Change {email}", { email: person.email }) : t("Add a person")} onClose={onClose} busy={working}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {!person && (
          <label className="fi-field">{t("Their sign-in email")}
            <input className="fi-input" type="email" data-autofocus required maxLength={320} value={form.email} placeholder="name@example.com"
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
        )}
        <fieldset>
          <legend>{t("Role")}</legend>
          <label className="fi-check"><input type="radio" name="role" checked={form.role === "member"} onChange={() => setForm({ ...form, role: "member" })} />
            <span><strong>{t("Member")}</strong>: {t("reads and answers only the mailboxes below.")}</span></label>
          <label className="fi-check"><input type="radio" name="role" checked={form.role === "admin"} onChange={() => setForm({ ...form, role: "admin" })} />
            <span><strong>{t("Administrator")}</strong>: {t("everything on this server, including this list.")}</span></label>
        </fieldset>
        {form.role === "member" && (
          <fieldset>
            <legend>{t("Mailboxes")}</legend>
            {mailboxes.isPending && <p role="status" className="fi-hint">{t("Loading mailboxes…")}</p>}
            {mailboxes.isError && <LoadFailure what={t("Mailboxes")} error={mailboxes.error} onRetry={() => void mailboxes.refetch()} retrying={mailboxes.isFetching} />}
            {mailboxes.data?.accounts.map((m) => (
              <label key={m.id} className="fi-check">
                <input type="checkbox" checked={form.accounts.includes(m.id)}
                  onChange={(e) => setForm({ ...form, accounts: e.target.checked ? [...form.accounts, m.id] : form.accounts.filter((a) => a !== m.id) })} />
                <span>{m.email ?? m.id}</span>
              </label>
            ))}
          </fieldset>
        )}
        <p className="fi-hint">{t("Cloudflare Access must let this email sign in, too: on an organization's server, through its Access group.")}</p>
        {problem && <p className="fi-action-result is-error" role="alert">{problem}</p>}
        <div className="fi-dialog-actions">
          <button type="button" className="fi-secondary" onClick={onClose} disabled={working}>{t("Cancel")}</button>
          <button type="submit" className="fi-primary" disabled={working || !form.email.trim() || (form.role === "member" && !form.accounts.length)}>
            {working ? t("Saving…") : person ? t("Save") : t("Add")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
