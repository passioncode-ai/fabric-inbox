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

interface Row extends ListEntry { title: string; meta: string; size?: number }

const when = (at?: number) => (at ? new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "never");
/** How a rule's counts read in its row: "3 discarded by you · 5 on arrival". */
const counts = (r: DiscardRule) => `${r.discards} discarded by you · ${r.applied} on arrival`;

/**
 * Settings → Discard rules (SCR-15): what each discard taught — a mailing list or a sender — with why,
 * its counts and when it last applied; Remove stops it. The Always allow list keeps a sender's mail
 * out of every rule.
 */
export default function DiscardSection({ id }: { id: string | null }) {
  const state = useQuery({ queryKey: KEY, queryFn: () => fabric<DiscardState>("/api/discard/rules") });
  const data = state.data;
  const rows: Row[] = [
    { key: OVERVIEW, group: "about", text: "", title: "How Discarded works", meta: `Kept ${data?.retentionDays ?? 30} days, out of the inbox` },
    { key: ALLOWED, group: "about", text: "always allow", title: "Always allow", meta: "Senders and domains no rule discards", size: data?.allowed.length },
    ...(data?.rules ?? []).map((r): Row => ({ key: r.id, group: "rules", text: `${r.label} ${r.value} ${r.why.category ?? ""}`,
      title: r.label, meta: `${r.kind === "list" ? "Newsletter" : "Sender"} · ${counts(r)}` })),
  ];
  const groups = groupRows(rows, [{ id: "about", label: "" }, { id: "rules", label: "Rules" }]);
  const rule = data?.rules.find((r) => r.id === id);

  const list = (
    <SelectableList label="Discard rules" groups={groups} selected={id} hrefFor={(e) => settingsPath("discard", e.key)}
      empty={<p className="fi-hint">No rules yet.</p>}
      renderRow={(e) => (
        <>
          <span className="fi-row-main"><span className="fi-row-title">{e.title}</span><span className="fi-row-meta">{e.meta}</span></span>
          <span className="fi-row-side">{e.size !== undefined && <Badge>{e.size}</Badge>}</span>
        </>
      )} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Discarded mail teaches what to discard next</h2>
      <p>{data?.rules.length ? `${data.rules.length} rule${data.rules.length === 1 ? "" : "s"} so far. Choose one to see why it was learned, or remove it.`
        : "Discard a message (⌘⌫ in the list) and mail like it goes straight to Discarded from then on."}</p>
      <Link className="fi-secondary" to="/?folder=discarded">Open Discarded</Link>
    </PanelPlaceholder>
  ) : state.isPending ? <SkeletonPanel label="Loading discard rules…" /> : state.isError ? (
    <LoadFailure what="Discard rules" error={state.error} onRetry={() => void state.refetch()} retrying={state.isFetching} />
  ) : id === OVERVIEW ? (
    <Panel title="How Discarded works" closeTo={settingsPath("discard")}>
      <PanelBlock>
        <ul>
          <li>Discard a message with ⌘⌫ (Ctrl+Backspace on Windows and Linux), or Discard in the reader. It leaves the inbox for Discarded, read.</li>
          <li>Each discard teaches a rule at once: the message's mailing list when it has one, else its sender. Mail that matches goes straight to Discarded when it arrives, and no rule, agent or category acts on it.</li>
          <li>Never discarded on arrival: mail from someone your addresses wrote to, replies in a conversation you took part in, mail from your own domains, and senders on Always allow or Never spam.</li>
          <li>Discarded mail is deleted after {data!.retentionDays} days. In Gmail, IMAP and Outlook accounts it is moved to the account's Trash then, which the provider empties.</li>
        </ul>
        <p className="fi-hint">In Gmail, Discarded is a label of that name; in IMAP and Outlook accounts, a folder of that name, made the first time you discard there.</p>
        <div className="fi-buttons"><Link className="fi-secondary" to="/?folder=discarded">Open Discarded</Link></div>
      </PanelBlock>
    </Panel>
  ) : id === ALLOWED ? (
    <AllowedPanel values={data!.allowed} />
  ) : !rule ? (
    <PanelPlaceholder><h2>This rule is gone</h2><p>It was removed, perhaps from another window.</p><Link className="fi-secondary" to={settingsPath("discard")} replace>Discard rules</Link></PanelPlaceholder>
  ) : (
    <RulePanel key={rule.id} rule={rule} />
  );

  return <SectionLayout section="discard" hasSelection={!!id} list={state.isPending && !data ? <SkeletonRows rows={5} label="Loading discard rules…" /> : list} panel={panel} />;
}

function RulePanel({ rule }: { rule: DiscardRule }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const work = useWork(rule.id);
  const remove = (allow: boolean) => work.run(allow ? "Allowing…" : "Removing…", async () => {
    try {
      if (allow) await fabric("/api/discard/allowed", { value: rule.why.sender, action: "add" });
      await fabric(`/api/discard/rules/${rule.id}`, undefined, "DELETE");
      navigate(settingsPath("discard"), { replace: true, preventScrollReset: true });
      return allow ? `${rule.why.sender} is always allowed now, and the rule is gone.` : "Rule removed. Mail already in Discarded stays there.";
    } finally { await client.invalidateQueries({ queryKey: KEY }); }
  });
  const why = rule.why;
  return (
    <Panel title={rule.label} subtitle={rule.kind === "list" ? `Mailing list ${rule.value}` : "One sender"} closeTo={settingsPath("discard")}
      badges={<Badge>{rule.kind === "list" ? "Newsletter" : "Sender"}</Badge>}>
      <PanelBlock title="Why">
        <ul>
          {why.list && <li>It came through the mailing list {why.list.name ? `${why.list.name} (${why.list.id})` : why.list.id}.</li>}
          {why.newsletter && !why.list && <li>It carried an unsubscribe link: a newsletter or other bulk mail.</li>}
          {why.sender && <li>From {why.sender}{why.domain ? `, a bulk sender on ${why.domain}` : ""}.</li>}
          {why.category && <li>It was in the category {why.category}.</li>}
          {why.model && <li>The model's guess: {why.model}</li>}
        </ul>
      </PanelBlock>
      <PanelBlock title="What it did">
        <p>{counts(rule)}. Learned {when(rule.createdAt)}; last discard {when(rule.lastDiscardAt)}; last applied {when(rule.lastAppliedAt)}.</p>
        <div className="fi-buttons">
          <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => void remove(false)}>Remove rule</button>
          {why.sender && <button type="button" className="fi-text-button" disabled={!!work.busy} onClick={() => void remove(true)}>Always allow {why.sender}</button>}
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
  const edit = (entry: string, action: "add" | "remove") => work.run(action === "add" ? "Adding…" : "Removing…", async () => {
    try {
      await fabric("/api/discard/allowed", { value: entry, action });
      return action === "add" ? `${entry.trim()} is always allowed.` : `${entry} removed from Always allow.`;
    } finally { await client.invalidateQueries({ queryKey: KEY }); }
  });
  return (
    <Panel title="Always allow" subtitle="Mail from these senders and domains is never discarded on arrival, whatever a rule says. Never spam entries count too."
      closeTo={settingsPath("discard")} badges={<Badge>{values.length}</Badge>}>
      <PanelBlock title="Add">
        <form className="fi-buttons" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); void edit(value, "add").then((ok) => { if (ok) setValue(""); }); }}>
          <input className="fi-input" style={{ flex: 1, minWidth: 200 }} value={value} maxLength={320} onChange={(e) => setValue(e.target.value)}
            placeholder="friend@example.org or example.org" aria-label="Add to Always allow" />
          <button type="submit" className="fi-secondary" disabled={!!work.busy || !value.trim()}>Add</button>
        </form>
        <ActionResult result={work.result} />
      </PanelBlock>
      <PanelBlock title="Entries" aside={values.length > 8 ? (
        <input className="fi-input" style={{ maxWidth: 220 }} type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find" aria-label="Find in Always allow" />
      ) : undefined}>
        {!values.length ? <p className="fi-hint">Empty.</p> : !found.length ? <p className="fi-hint">Nothing matches “{find}”.</p> : (
          <ul className="fi-plain-list">
            {found.map((v) => (
              <li key={v}>
                <span className="fi-grow">{v}</span>
                <button type="button" className="fi-text-button" disabled={!!work.busy} onClick={() => void edit(v, "remove")} aria-label={`Remove ${v}`}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </PanelBlock>
    </Panel>
  );
}
