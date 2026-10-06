import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { fabric } from "~/services/fabric";
import { groupRows, matches, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionResult, Badge, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList, SkeletonPanel, SkeletonRows, useWork,
} from "../ui";
import type { DiscardRule } from "../../../../shared/mail/discard";

interface DiscardState { rules: DiscardRule[]; allowed: string[]; retentionDays: number }
const KEY = ["discard-rules"];
const OVERVIEW = "overview";
const ALLOWED = "allowed";

/** Every string of the section, in one table for the localization that follows (Discarded: «Выброшенные»). */
export const DISCARD_SECTION_TEXT = {
  label: "Discard rules",
  loading: "Loading discard rules…",
  noRules: "No rules yet.",
  rulesGroup: "Rules",
  overviewTitle: "How Discarded works",
  overviewMeta: (days: number) => `Kept ${days} days, out of the inbox`,
  allowedTitle: "Always allow",
  allowedMeta: "Senders and domains no rule discards",
  newsletter: "Newsletter",
  sender: "Sender",
  counts: (r: Pick<DiscardRule, "discards" | "applied">) => `${r.discards} discarded by you · ${r.applied} on arrival`,
  never: "never",
  placeholderTitle: "Discarded mail teaches what to discard next",
  placeholderSome: (n: number) => `${n} rule${n === 1 ? "" : "s"} so far. Choose one to see why it was learned, or remove it.`,
  placeholderNone: "Discard a message (⌘⌫ in the list) and mail like it goes straight to Discarded from then on.",
  openDiscarded: "Open Discarded",
  how: [
    "Discard a message with ⌘⌫ (Ctrl+Backspace on Windows and Linux), or Discard in the reader. It leaves the inbox for Discarded, read.",
    "Each discard teaches a rule at once: the message's mailing list when it has one, else its sender. Mail that matches goes straight to Discarded when it arrives, and no rule, agent or category acts on it.",
    "Never discarded on arrival: mail from someone your addresses wrote to, replies in a conversation you took part in, mail from your own domains, and senders on Always allow or Never spam.",
  ],
  howRetention: (days: number) => `Discarded mail is deleted after ${days} days. In Gmail, IMAP and Outlook accounts it is moved to the account's Trash then, which the provider empties.`,
  howProviders: "In Gmail, Discarded is a label of that name; in IMAP and Outlook accounts, a folder of that name, made the first time you discard there.",
  goneTitle: "This rule is gone",
  goneBody: "It was removed, perhaps from another window.",
  mailingList: (id: string) => `Mailing list ${id}`,
  oneSender: "One sender",
  why: "Why",
  whyList: (name: string) => `It came through the mailing list ${name}.`,
  whyNewsletter: "It carried an unsubscribe link: a newsletter or other bulk mail.",
  whyFrom: (sender: string, domain?: string) => `From ${sender}${domain ? `, a bulk sender on ${domain}` : ""}.`,
  whyCategory: (name: string) => `It was in the category ${name}.`,
  whyModel: (text: string) => `The model's guess: ${text}`,
  whatItDid: "What it did",
  history: (counts: string, created: string, last: string, applied: string) => `${counts}. Learned ${created}; last discard ${last}; last applied ${applied}.`,
  remove: "Remove rule",
  removing: "Removing…",
  allowing: "Allowing…",
  allowSender: (sender: string) => `Always allow ${sender}`,
  removed: "Rule removed. Mail already in Discarded stays there.",
  allowedNow: (sender: string) => `${sender} is always allowed now, and the rule is gone.`,
  allowedSubtitle: "Mail from these senders and domains is never discarded on arrival, whatever a rule says. Never spam entries count too.",
  add: "Add",
  adding: "Adding…",
  addLabel: "Add to Always allow",
  addPlaceholder: "friend@example.org or example.org",
  entries: "Entries",
  empty: "Empty.",
  find: "Find",
  findLabel: "Find in Always allow",
  nothingMatches: (q: string) => `Nothing matches “${q}”.`,
  removeEntry: "Remove",
  removeEntryLabel: (v: string) => `Remove ${v}`,
  entryAdded: (v: string) => `${v} is always allowed.`,
  entryRemoved: (v: string) => `${v} removed from Always allow.`,
};
const T = DISCARD_SECTION_TEXT;

interface Row extends ListEntry { title: string; meta: string; size?: number }

const when = (at?: number) => (at ? new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : T.never);

/**
 * Settings → Discard rules (SCR-16): what each discard taught — a mailing list or a sender — with why,
 * its counts and when it last applied; Remove stops it. The Always allow list keeps a sender's mail
 * out of every rule.
 */
export default function DiscardSection({ id }: { id: string | null }) {
  const state = useQuery({ queryKey: KEY, queryFn: () => fabric<DiscardState>("/api/discard/rules") });
  const data = state.data;
  const rows: Row[] = [
    { key: OVERVIEW, group: "about", text: "", title: T.overviewTitle, meta: T.overviewMeta(data?.retentionDays ?? 30) },
    { key: ALLOWED, group: "about", text: T.allowedTitle.toLowerCase(), title: T.allowedTitle, meta: T.allowedMeta, size: data?.allowed.length },
    ...(data?.rules ?? []).map((r): Row => ({ key: r.id, group: "rules", text: `${r.label} ${r.value} ${r.why.category ?? ""}`,
      title: r.label, meta: `${r.kind === "list" ? T.newsletter : T.sender} · ${T.counts(r)}` })),
  ];
  const groups = groupRows(rows, [{ id: "about", label: "" }, { id: "rules", label: T.rulesGroup }]);
  const rule = data?.rules.find((r) => r.id === id);

  const list = (
    <SelectableList label={T.label} groups={groups} selected={id} hrefFor={(e) => settingsPath("discard", e.key)}
      empty={<p className="fi-hint">{T.noRules}</p>}
      renderRow={(e) => (
        <>
          <span className="fi-row-main"><span className="fi-row-title">{e.title}</span><span className="fi-row-meta">{e.meta}</span></span>
          <span className="fi-row-side">{e.size !== undefined && <Badge>{e.size}</Badge>}</span>
        </>
      )} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{T.placeholderTitle}</h2>
      <p>{data?.rules.length ? T.placeholderSome(data.rules.length) : T.placeholderNone}</p>
      <Link className="fi-secondary" to="/?folder=discarded">{T.openDiscarded}</Link>
    </PanelPlaceholder>
  ) : state.isPending ? <SkeletonPanel label={T.loading} /> : state.isError ? (
    <LoadFailure what={T.label} error={state.error} onRetry={() => void state.refetch()} retrying={state.isFetching} />
  ) : id === OVERVIEW ? (
    <Panel title={T.overviewTitle} closeTo={settingsPath("discard")}>
      <PanelBlock>
        <ul>
          {T.how.map((line) => <li key={line}>{line}</li>)}
          <li>{T.howRetention(data!.retentionDays)}</li>
        </ul>
        <p className="fi-hint">{T.howProviders}</p>
        <div className="fi-buttons"><Link className="fi-secondary" to="/?folder=discarded">{T.openDiscarded}</Link></div>
      </PanelBlock>
    </Panel>
  ) : id === ALLOWED ? (
    <AllowedPanel values={data!.allowed} />
  ) : !rule ? (
    <PanelPlaceholder><h2>{T.goneTitle}</h2><p>{T.goneBody}</p><Link className="fi-secondary" to={settingsPath("discard")} replace>{T.label}</Link></PanelPlaceholder>
  ) : (
    <RulePanel key={rule.id} rule={rule} />
  );

  return <SectionLayout section="discard" hasSelection={!!id} list={state.isPending && !data ? <SkeletonRows rows={5} label={T.loading} /> : list} panel={panel} />;
}

function RulePanel({ rule }: { rule: DiscardRule }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const work = useWork(rule.id);
  const remove = (allow: boolean) => work.run(allow ? T.allowing : T.removing, async () => {
    try {
      if (allow) await fabric("/api/discard/allowed", { value: rule.why.sender, action: "add" });
      await fabric(`/api/discard/rules/${rule.id}`, undefined, "DELETE");
      navigate(settingsPath("discard"), { replace: true, preventScrollReset: true });
      return allow ? T.allowedNow(rule.why.sender) : T.removed;
    } finally { await client.invalidateQueries({ queryKey: KEY }); }
  });
  const why = rule.why;
  return (
    <Panel title={rule.label} subtitle={rule.kind === "list" ? T.mailingList(rule.value) : T.oneSender} closeTo={settingsPath("discard")}
      badges={<Badge>{rule.kind === "list" ? T.newsletter : T.sender}</Badge>}>
      <PanelBlock title={T.why}>
        <ul>
          {why.list && <li>{T.whyList(why.list.name ? `${why.list.name} (${why.list.id})` : why.list.id)}</li>}
          {why.newsletter && !why.list && <li>{T.whyNewsletter}</li>}
          {why.sender && <li>{T.whyFrom(why.sender, why.domain)}</li>}
          {why.category && <li>{T.whyCategory(why.category)}</li>}
          {why.model && <li>{T.whyModel(why.model)}</li>}
        </ul>
      </PanelBlock>
      <PanelBlock title={T.whatItDid}>
        <p>{T.history(T.counts(rule), when(rule.createdAt), when(rule.lastDiscardAt), when(rule.lastAppliedAt))}</p>
        <div className="fi-buttons">
          <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => void remove(false)}>{T.remove}</button>
          {why.sender && <button type="button" className="fi-text-button" disabled={!!work.busy} onClick={() => void remove(true)}>{T.allowSender(why.sender)}</button>}
        </div>
        <ActionResult result={work.result} />
      </PanelBlock>
    </Panel>
  );
}

function AllowedPanel({ values }: { values: string[] }) {
  const client = useQueryClient();
  const work = useWork(ALLOWED);
  const [value, setValue] = useState("");
  const [find, setFind] = useState("");
  const found = values.filter((v) => matches({ text: v }, find));
  const edit = (entry: string, action: "add" | "remove") => work.run(action === "add" ? T.adding : T.removing, async () => {
    try {
      await fabric("/api/discard/allowed", { value: entry, action });
      return action === "add" ? T.entryAdded(entry.trim()) : T.entryRemoved(entry);
    } finally { await client.invalidateQueries({ queryKey: KEY }); }
  });
  return (
    <Panel title={T.allowedTitle} subtitle={T.allowedSubtitle} closeTo={settingsPath("discard")} badges={<Badge>{values.length}</Badge>}>
      <PanelBlock title={T.add}>
        <form className="fi-buttons" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); void edit(value, "add").then((ok) => { if (ok) setValue(""); }); }}>
          <input className="fi-input" style={{ flex: 1, minWidth: 200 }} value={value} maxLength={320} onChange={(e) => setValue(e.target.value)}
            placeholder={T.addPlaceholder} aria-label={T.addLabel} />
          <button type="submit" className="fi-secondary" disabled={!!work.busy || !value.trim()}>{T.add}</button>
        </form>
        <ActionResult result={work.result} />
      </PanelBlock>
      <PanelBlock title={T.entries} aside={values.length > 8 ? (
        <input className="fi-input" style={{ maxWidth: 220 }} type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder={T.find} aria-label={T.findLabel} />
      ) : undefined}>
        {!values.length ? <p className="fi-hint">{T.empty}</p> : !found.length ? <p className="fi-hint">{T.nothingMatches(find)}</p> : (
          <ul className="fi-plain-list">
            {found.map((v) => (
              <li key={v}>
                <span className="fi-grow">{v}</span>
                <button type="button" className="fi-text-button" disabled={!!work.busy} onClick={() => void edit(v, "remove")} aria-label={T.removeEntryLabel(v)}>{T.removeEntry}</button>
              </li>
            ))}
          </ul>
        )}
      </PanelBlock>
    </Panel>
  );
}
