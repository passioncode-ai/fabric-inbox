import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { fabric } from "~/services/fabric";
import { groupRows, matches, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionResult, Badge, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList, SkeletonPanel,
  SkeletonRows, useWork,
} from "../ui";

type ListName = "blockedSenders" | "blockedDomains" | "allowedSenders" | "allowedDomains";
interface SpamState {
  lists: Record<ListName, string[]>;
  retentionDays: number;
  model: { used: number; limit: number; spamToday: number; screenedToday: number; unavailable?: boolean };
}

export const SPAM_LISTS: { id: ListName; title: string; hint: string; placeholder: string }[] = [
  { id: "blockedSenders", title: "Always spam: senders", hint: "Added when you report a message as spam.", placeholder: "deals@example.com" },
  { id: "blockedDomains", title: "Always spam: domains", hint: "Every address on the domain and its subdomains.", placeholder: "spammy.example" },
  { id: "allowedSenders", title: "Never spam: senders", hint: "Added when you mark a message Not spam. Wins over every check but a forgery.", placeholder: "friend@example.org" },
  { id: "allowedDomains", title: "Never spam: domains", hint: "For a partner or a service whose mail must always arrive.", placeholder: "partner.example" },
];
const OVERVIEW = "overview";
const KEY = ["spam"];
const SHOWN = 50;

interface SpamEntry extends ListEntry { title: string; meta: string; size?: number }

/** Settings → Spam rules (SCR-14, SCN-041, SP-6): what goes to Spam, and the operator's lists. */
export default function SpamSection({ id }: { id: string | null }) {
  const state = useQuery({ queryKey: KEY, queryFn: () => fabric<SpamState>("/api/spam") });
  const data = state.data;
  const entries: SpamEntry[] = [
    { key: OVERVIEW, group: "rules", text: "", title: "What goes to Spam", meta: "The four rules and what wins" },
    ...SPAM_LISTS.map((l): SpamEntry => ({ key: l.id, group: "lists", text: l.title, title: l.title, meta: l.hint, size: data?.lists[l.id].length })),
  ];
  const groups = groupRows(entries, [{ id: "rules", label: "" }, { id: "lists", label: "Your lists" }]);
  const list = SPAM_LISTS.find((l) => l.id === id);

  const listView = (
    <SelectableList label="Spam rules" groups={groups} selected={id} hrefFor={(e) => settingsPath("spam", e.key)}
      renderRow={(e) => (
        <>
          <span className="fi-row-main"><span className="fi-row-title">{e.title}</span><span className="fi-row-meta">{e.meta}</span></span>
          <span className="fi-row-side">{e.size !== undefined && <Badge>{e.size}</Badge>}</span>
        </>
      )} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>Spam is kept apart from your mail</h2>
      <p>No agent answers it, no rule or category acts on it, and it is not sent on as a copy.</p>
      <Link className="fi-secondary" to="/?folder=spam">Open Spam</Link>
    </PanelPlaceholder>
  ) : state.isPending ? <SkeletonPanel label="Loading spam rules…" /> : state.isError ? (
    <LoadFailure what="Spam rules" error={state.error} onRetry={() => void state.refetch()} retrying={state.isFetching} />
  ) : id === OVERVIEW ? (
    <Panel title="What goes to Spam" closeTo={settingsPath("spam")}>
      <PanelBlock>
        <ul>
          <li>Mail from a sender or domain on an Always spam list.</li>
          <li>Mail that claims to be from one of your own domains but fails its authenticity checks.</li>
          <li>Mail that fails DMARC where the sender's domain asks to reject or quarantine such mail, or fails SPF with no valid signature.</li>
          <li>Mail from someone none of your addresses has written to, when the model judges it spam: phishing, scams, unsolicited marketing, cold outreach.</li>
        </ul>
        <p className="fi-hint">
          A Never spam list wins over all of these except the first two: a forgery is spam even from a sender you allowed. Each message in
          Spam says why it is there. These rules apply to mail arriving at your addresses on Cloudflare; Gmail uses its own filter, which
          learns from Report spam and Not spam. Spam older than {data!.retentionDays} days is deleted with its attachments; Gmail keeps its
          own Spam, with its own 30 days.
        </p>
      </PanelBlock>
      <PanelBlock title="Today">
        <p>
          {data!.model.unavailable
            ? "The model's count could not be read right now."
            : `Today ${data!.model.screenedToday} new message${data!.model.screenedToday === 1 ? "" : "s"} from strangers ${data!.model.screenedToday === 1 ? "was" : "were"} checked and ${data!.model.spamToday} went to Spam. `
              + `The spam check's own allowance: ${data!.model.used} of ${data!.model.limit} a day (a check made in the same call as a category uses none).`}
          {!data!.model.unavailable && data!.model.used >= data!.model.limit ? " Mail after that stays in the inbox until tomorrow's budget." : ""}
        </p>
        <div className="fi-buttons">
          <Link className="fi-secondary" to="/?folder=spam">Open Spam</Link>
          <Link className="fi-secondary" to={settingsPath("categories")}>Categories</Link>
        </div>
      </PanelBlock>
    </Panel>
  ) : !list ? (
    <PanelPlaceholder><h2>There is no such list</h2><Link className="fi-secondary" to={settingsPath("spam")} replace>Spam rules</Link></PanelPlaceholder>
  ) : (
    <ListPanel key={list.id} list={list} values={data!.lists[list.id]} />
  );

  return (
    <SectionLayout section="spam" hasSelection={!!id} list={state.isPending && !data ? <SkeletonRows rows={5} label="Loading spam rules…" /> : listView} panel={panel} />
  );
}

function ListPanel({ list, values }: { list: (typeof SPAM_LISTS)[number]; values: string[] }) {
  const client = useQueryClient();
  const work = useWork(list.id);
  const [value, setValue] = useState("");
  const [find, setFind] = useState("");
  const [showAll, setShowAll] = useState(false);
  const found = values.filter((v) => matches({ text: v }, find));
  const shown = showAll || find ? found : found.slice(0, SHOWN);
  const edit = (entry: string, action: "add" | "remove") => work.run(action === "add" ? "Adding…" : "Removing…", async () => {
    try {
      await fabric("/api/spam/lists", { list: list.id, value: entry, action });
      return action === "add" ? `${entry.trim()} added to ${list.title}.` : `${entry} removed from ${list.title}.`;
    } finally { await client.invalidateQueries({ queryKey: KEY }); }
  });
  return (
    <Panel title={list.title} subtitle={list.hint} closeTo={settingsPath("spam")} badges={<Badge>{values.length}</Badge>}>
      <PanelBlock title="Add">
        <form className="fi-buttons" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); void edit(value, "add").then((ok) => { if (ok) setValue(""); }); }}>
          <input className="fi-input" style={{ flex: 1, minWidth: 200 }} value={value} maxLength={320} onChange={(e) => setValue(e.target.value)}
            placeholder={list.placeholder} aria-label={`Add to ${list.title}`} />
          <button type="submit" className="fi-secondary" disabled={!!work.busy || !value.trim()}>Add</button>
        </form>
        <ActionResult result={work.result} />
      </PanelBlock>
      <PanelBlock title="Entries" aside={values.length > 8 ? (
        <input className="fi-input" style={{ maxWidth: 220 }} type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find" aria-label={`Find in ${list.title}`} />
      ) : undefined}>
        {!values.length ? <p className="fi-hint">Empty.</p> : !found.length ? <p className="fi-hint">Nothing matches “{find}”.</p> : (
          <ul className="fi-plain-list">
            {shown.map((v) => (
              <li key={v}>
                <span className="fi-grow">{v}</span>
                <button type="button" className="fi-text-button" disabled={!!work.busy} onClick={() => void edit(v, "remove")} aria-label={`Remove ${v}`}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        {!find && found.length > SHOWN && (
          <div className="fi-buttons"><button type="button" className="fi-text-button" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${found.length}`}</button></div>
        )}
      </PanelBlock>
    </Panel>
  );
}
