import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { useState } from "react";
import { fabric } from "~/services/fabric";

export function meta() {
  return [{ title: "Spam rules · Fabric Inbox" }];
}

type ListName = "blockedSenders" | "blockedDomains" | "allowedSenders" | "allowedDomains";
interface SpamState {
  lists: Record<ListName, string[]>;
  retentionDays: number;
  model: { used: number; limit: number; spamToday: number; screenedToday: number; unavailable?: boolean };
}

const LISTS: { id: ListName; title: string; hint: string; placeholder: string }[] = [
  { id: "blockedSenders", title: "Always spam: senders", hint: "Added when you report a message as spam.", placeholder: "deals@example.com" },
  { id: "blockedDomains", title: "Always spam: domains", hint: "Every address on the domain and its subdomains.", placeholder: "spammy.example" },
  { id: "allowedSenders", title: "Never spam: senders", hint: "Added when you mark a message Not spam. Wins over every check.", placeholder: "friend@example.org" },
  { id: "allowedDomains", title: "Never spam: domains", hint: "For a partner or a service whose mail must always arrive.", placeholder: "partner.example" },
];

/** SCR-14 Spam rules (SP-6): what goes to Spam, and the operator's lists. */
export default function SpamRules() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ["spam"], queryFn: () => fabric<SpamState>("/api/spam") });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function edit(list: ListName, value: string, action: "add" | "remove") {
    setBusy(true); setNotice("");
    try {
      await fabric("/api/spam/lists", { list, value, action });
      await client.invalidateQueries({ queryKey: ["spam"] });
      setNotice(action === "add" ? `${value.trim()} added.` : `${value} removed.`);
      return true;
    } catch (error) {
      setNotice((error as Error).message);
      return false;
    } finally { setBusy(false); }
  }

  const data = state.data;
  return (
    <main className="mx-auto max-w-4xl p-6 text-kumo-default">
      <nav className="flex gap-4 text-sm">
        <Link to="/">← Fabric Inbox</Link>
        <Link to="/?folder=spam" className="underline">Open Spam</Link>
        <Link to="/categories" className="underline">Categories</Link>
      </nav>
      <h1 className="mt-8 text-3xl font-semibold">Spam rules</h1>
      <p className="my-3 text-kumo-subtle">
        Spam is kept apart from your mail: no agent answers it, no rule or category acts on it, and it is not sent on as a copy.
      </p>
      {notice && <p role="status" className="my-4 rounded-lg border border-kumo-line p-3">{notice}</p>}

      <section className="my-6" aria-labelledby="how-heading">
        <h2 id="how-heading" className="text-xl font-medium">What goes to Spam</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>Mail from a sender or domain on an Always spam list below.</li>
          <li>Mail that claims to be from one of your own domains but fails its authenticity checks.</li>
          <li>Mail that fails DMARC where the sender's domain asks to reject or quarantine such mail, or fails SPF with no valid signature.</li>
          <li>Mail from someone none of your addresses has written to, when the model judges it spam: phishing, scams, unsolicited marketing, cold outreach.</li>
        </ul>
        <p className="mt-2 text-sm text-kumo-subtle">
          A Never spam list wins over all of these. Each message in Spam says why it is there. These rules apply to mail
          arriving at your addresses on Cloudflare; Gmail uses its own filter, which learns from Report spam and Not spam. Spam older than
          {" "}{data?.retentionDays ?? 30} days is deleted with its attachments; Gmail keeps its own Spam, with its own 30 days.
        </p>
        {data && (
          <p className="mt-2 text-sm">
            {data.model.unavailable
              ? "The model's count could not be read right now."
              : `Today ${data.model.screenedToday} new message${data.model.screenedToday === 1 ? "" : "s"} from strangers ${data.model.screenedToday === 1 ? "was" : "were"} checked and ${data.model.spamToday} went to Spam. `
                + `The spam check's own allowance: ${data.model.used} of ${data.model.limit} a day (a check made in the same call as a category uses none).`}
            {!data.model.unavailable && data.model.used >= data.model.limit ? " Mail after that stays in the inbox until tomorrow's budget." : ""}
          </p>
        )}
      </section>

      {state.isPending ? <p role="status" className="text-kumo-subtle">Loading spam rules…</p> : state.isError ? (
        <p role="alert">Spam rules could not load: {(state.error as Error).message} <button className="underline" onClick={() => void state.refetch()}>Retry</button></p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {LISTS.map((l) => <ListCard key={l.id} list={l} values={data!.lists[l.id]} busy={busy} onEdit={edit} />)}
        </div>
      )}
    </main>
  );
}

function ListCard({ list, values, busy, onEdit }: {
  list: (typeof LISTS)[number]; values: string[]; busy: boolean;
  onEdit: (list: ListName, value: string, action: "add" | "remove") => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? values : values.slice(0, 20);
  return (
    <section className="rounded-xl border border-kumo-line p-4" aria-labelledby={`list-${list.id}`}>
      <h2 id={`list-${list.id}`} className="text-base font-medium">{list.title} <span className="text-sm font-normal text-kumo-subtle">· {values.length}</span></h2>
      <p className="mt-1 text-xs text-kumo-subtle">{list.hint}</p>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void onEdit(list.id, value, "add").then((ok) => { if (ok) setValue(""); }); }}>
        <input className="min-w-0 flex-1 rounded-lg border border-kumo-line bg-transparent px-3 py-1.5 text-sm" value={value} maxLength={320}
          onChange={(e) => setValue(e.target.value)} placeholder={list.placeholder} aria-label={`Add to ${list.title}`} />
        <button type="submit" className="fi-secondary" disabled={busy || !value.trim()}>Add</button>
      </form>
      {values.length ? (
        <ul className="mt-3 divide-y divide-kumo-line text-sm">
          {shown.map((v) => (
            <li key={v} className="flex items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 break-all">{v}</span>
              <button type="button" className="underline" disabled={busy} onClick={() => void onEdit(list.id, v, "remove")} aria-label={`Remove ${v}`}>Remove</button>
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-kumo-subtle">Empty.</p>}
      {values.length > 20 && (
        <button type="button" className="mt-2 text-sm underline" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${values.length}`}</button>
      )}
    </section>
  );
}
