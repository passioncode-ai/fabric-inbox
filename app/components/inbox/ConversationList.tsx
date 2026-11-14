import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "~/lib/i18n";
import EmailIframe from "~/components/EmailIframe";
import { senderName, type InboxMessage } from "./model";
import { unreadOf, type ThreadRow } from "./thread";
import { listDate } from "./triage-view";
import { agentRunLabel, agentRunNeedsLook } from "./agent-run";
import { answeredRows, foldQuotedHtml, nestedRows, splitQuotedText, type QuoteLabels, type ThreadEvent } from "./quotes";
import { addressOf, compactRecipients, headerFacts } from "./message-header";
import { cardNeedsScroll, cardPlacement, cardToShow, retiredCards, type GoneCard, type ShownCard } from "./draft-card";
import { useAgentName } from "./agent-name";
import type { CellSafety } from "./thread-safety";
import { badgeWords } from "./safety-words";
import { ShieldSlashIcon, ShieldWarningIcon } from "@phosphor-icons/react";
import type { SafetyColour } from "../../../shared/mail/safety";

/** Messages shown whole at once; earlier ones wait behind "Show earlier messages" (a long thread stays light). */
const SHOWN = 25;

/**
 * The open message's conversation as one page to read (B-138, operator 2026-10-21; B-114 before it):
 * every message of its thread, oldest at the top and the newest at the bottom, each whole in its own
 * cell: who sent it, when, and for a reply whether the reply agent or a person sent it; for a message
 * that came in, what the agent did with it. The open message's cell shows it as the reader does
 * (`renderOpen`: its pictures, attachments and the agent's panel); choosing another cell opens it, so
 * Reply, Reply all and Forward act on it. Opening the conversation reads it, as opening a message does.
 * Shown only when the conversation has more than one message.
 */
export default function ConversationList({ rows, openId, onOpen, loadBody, onMarkRead, renderOpen, events = [], renderCard, renderRetired, onOpenDrafts, cellSafety, cellSafetyPending }: {
  rows: ThreadRow[];
  /** A-11: each message's own safety colour and checked links, by provider message id; absent while not read. */
  cellSafety?: Readonly<Record<string, CellSafety>>;
  /** The colours are still on their way: a cell's links ask meanwhile, a `mailto:` too (A-21). */
  cellSafetyPending?: boolean;
  /** S05 (B-221): what rules and the safety check did to the thread's messages, shown as thin rows after each one. */
  events?: ThreadEvent[];
  openId: string;
  onOpen: (message: InboxMessage) => void;
  /** A message's HTML or text, for a cell whose body the thread route did not carry (Gmail, IMAP, Outlook). */
  loadBody: (message: InboxMessage) => Promise<{ html: string; text: string }>;
  /** Marks these rows read; `whole` when it is the whole conversation. */
  onMarkRead: (rows: ThreadRow[], whole: boolean) => Promise<void>;
  /** The open message's own content: its body, pictures, attachments and what the agent did. */
  renderOpen: () => ReactNode;
  /** S06 (B-271): a reply agent's waiting draft as a card under the message it answers (`answered` absent: not in this thread). */
  renderCard?: (draft: ThreadRow, answered: ThreadRow | undefined) => ReactNode;
  /** S07 (B-272): an open card whose draft was retired (or discarded, A-5) meanwhile, as a notice in its place. */
  renderRetired?: (answered: ThreadRow, draftId: string, close: () => void, kind: GoneCard["kind"]) => ReactNode;
  /** S07: opens Drafts, from "Your edited draft is in Drafts". */
  onOpenDrafts?: () => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const openRef = useRef<HTMLElement | null>(null);
  const cells = useRef(new Map<string, HTMLElement>());
  const [goto, setGoto] = useState<string | null>(null);
  // "Go to message": the answered cell is shown (opening the earlier ones when it is among them), scrolled to and focused.
  useEffect(() => {
    if (!goto) return;
    const cell = cells.current.get(goto);
    if (!cell) return;
    cell.scrollIntoView?.({ block: "start" });
    cell.focus();
    setGoto(null);
  }, [goto, earlier]);
  const unread = rows.length > 1 ? unreadOf(rows) : [];
  const threadKey = rows[0]?.message.threadId ?? "";
  // Reading the conversation reads it, once per conversation opened; a refusal is said, with a retry.
  const marked = useRef("");
  useEffect(() => {
    if (!unread.length || marked.current === threadKey) return;
    marked.current = threadKey;
    onMarkRead(unread, true).then(() => setFailed(false), () => setFailed(true));
  }, [threadKey, unread.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // S06: where each reply agent's draft is drawn: as a card under the message it answers.
  const placement = renderCard ? cardPlacement(rows) : null;
  const cardEls = useRef(new Map<string, HTMLElement>());
  // The open message comes into view: the conversation reads from the top, the reader lands on it. Then the card that
  // answers it (else the last waiting card) has its top in view (S06: seen at once; A-6): when the open message leaves
  // it below the fold or above the pane, the card goes to the pane's top.
  const cardRef = (id: string) => (el: HTMLElement | null) => { if (el) cardEls.current.set(id, el); else cardEls.current.delete(id); };
  const cardSeen = useRef("");
  /** While a conversation just opened settles, its card is still placed (A-6): until when, and for which conversation. */
  const cardWindow = useRef<{ thread: string; until: number } | null>(null);
  const target = placement ? cardToShow(rows, placement, openId) : null;
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Once per conversation opened, so moving within it never jumps back to the card.
    if (target && cardSeen.current !== threadKey) {
      cardSeen.current = threadKey;
      cardWindow.current = { thread: threadKey, until: Date.now() + SETTLE_MS };
    }
    const place = () => {
      openRef.current?.scrollIntoView?.({ block: "start" });
      const open = cardWindow.current;
      const card = open && open.thread === threadKey && Date.now() < open.until && target ? cardEls.current.get(target) : undefined;
      if (!card?.isConnected) return;
      const pane = scrollPane(card);
      const box = pane?.getBoundingClientRect?.();
      if (!box || cardNeedsScroll(card.getBoundingClientRect().top, box)) card.scrollIntoView?.({ block: "start" });
    };
    place();
    // A-6: the cells above load their bodies after this (each sizes itself to its mail), which moves the open message and
    // its card down. While the conversation settles, it is placed again on every change of size, until the person
    // scrolls, types or clicks, or for 2.5 s at most.
    const section = sectionRef.current;
    if (!section || typeof ResizeObserver === "undefined" || typeof window === "undefined") return;
    const observer = new ResizeObserver(() => place());
    observer.observe(section);
    const done = () => { observer.disconnect(); clearTimeout(timer); for (const e of INTERACTIONS) window.removeEventListener(e, interact, true); };
    const interact = () => { cardWindow.current = null; done(); };
    const timer = setTimeout(done, SETTLE_MS);
    for (const e of INTERACTIONS) window.addEventListener(e, interact, true);
    return done;
  }, [openId, rows.length, target]); // eslint-disable-line react-hooks/exhaustive-deps
  // S07: a card on screen whose draft a reply retired meanwhile turns into a notice instead of vanishing; the notice
  // knows the retired card's own draft id (round 2, K-2: "Answer again" moves the run's draft id on).
  const shownCards = useRef(new Map<string, ShownCard>());
  const [retired, setRetired] = useState<GoneCard[]>([]);
  useEffect(() => { shownCards.current = new Map(); setRetired([]); }, [threadKey]);
  useEffect(() => {
    if (!placement) return;
    const { now, gone } = retiredCards(shownCards.current, rows, placement);
    if (gone.length) setRetired((list) => [...list, ...gone.filter((g) => !list.some((x) => x.draftId === g.draftId))]);
    shownCards.current = now;
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  if (rows.length < 2) return null;
  const hidden = earlier ? 0 : Math.max(0, rows.length - SHOWN);
  const shown = rows.slice(hidden);
  const answered = answeredRows(rows.map((r) => ({ internalId: r.message.providerMessageId, rfcMessageId: r.rfcMessageId,
    inReplyTo: r.inReplyTo, references: r.references, draft: r.kind === "draft" })));
  // A-16: a reply is nested against the cell drawn above it, not against a draft drawn as a card in between.
  const nestedAt = nestedRows(answered, (i) => !placement?.taken.has(rows[i]!.message.id));
  return (
    <section ref={sectionRef} className="fi-thread" aria-label={t("Conversation")}>
      <div className="fi-thread-head">
        <h3 className="fi-thread-title">{t.plural(rows.length, { one: "{n} message in this thread", other: "{n} messages in this thread" })}</h3>
      </div>
      {failed && (
        <p className="fi-thread-error" role="alert">
          {t("The conversation could not be marked read. Try again.")}{" "}
          <button type="button" className="fi-thread-action" onClick={() => onMarkRead(unreadOf(rows), true).then(() => setFailed(false), () => setFailed(true))}>
            {t("Mark conversation read")}
          </button>
        </p>
      )}
      {hidden > 0 && (
        <button type="button" className="fi-thread-earlier" onClick={() => setEarlier(true)}>
          {t.plural(hidden, { one: "Show {n} earlier message", other: "Show {n} earlier messages" })}
        </button>
      )}
      <ol className="fi-thread-cells">
        {shown.map((row, k) => {
          if (placement?.taken.has(row.message.id)) return null;
          const open = row.message.providerMessageId === openId;
          const index = hidden + k;
          const answers = answered[index]!;
          const nested = nestedAt[index]!;
          const target = answers >= 0 ? rows[answers] : undefined;
          const safety = cellSafety?.[row.message.providerMessageId];
          const body = <div className="fi-thread-cell-body">{open ? renderOpen()
            : <CellBody row={row} loadBody={loadBody} linkSafety={safety ?? (cellSafetyPending ? "pending" : null)} />}</div>;
          return (
            <li key={row.message.id}>
              <article ref={(el) => { if (open) openRef.current = el; if (el) cells.current.set(row.message.id, el); else cells.current.delete(row.message.id); }}
                tabIndex={-1} className={"fi-thread-cell" + (open ? " is-open" : "") + (row.kind !== "received" ? " is-outgoing" : "")
                + (row.sentBy === "agent" || row.sentBy === "agent_waiting" ? " is-agent" : "") + (nested ? " is-nested" : "")} aria-current={open ? "true" : undefined}>
                <header className="fi-thread-cell-head">
                  {open ? (
                    <span className="fi-thread-cell-who"><strong>{whoSent(row, t)}</strong><WhoChip row={row} /></span>
                  ) : (
                    <button type="button" className="fi-thread-cell-who" onClick={() => onOpen(row.message)} title={t("Open this message to reply to it")}>
                      <strong>{whoSent(row, t)}</strong>
                      <WhoChip row={row} />
                    </button>
                  )}
                  {!open && safety && <CellMark colour={safety.colour} />}
                  <time dateTime={row.message.date}>{listDate(row.message.date, undefined, t)}</time>
                </header>
                <CellPeople row={row} />
                {answers === -2 && <p className="fi-thread-reply-to">{t("In reply to an earlier message")}</p>}
                {nested && target && <ReplyTo target={target} onGo={() => { if (answers < hidden) setEarlier(true); setGoto(target.message.id); }} />}
                {row.sentBy === "agent" && !!row.message.agentRun?.sources?.length && (
                  <p className="fi-thread-reply-to">{t("Answered from:")} {row.message.agentRun.sources.map((x) => x.title).join(" · ")}</p>
                )}
                {placement?.cards.has(index) ? <Clamp>{body}</Clamp> : body}
              </article>
              {placement?.cards.get(index)?.map((draft) => (
                <div key={draft.message.id} ref={cardRef(draft.message.id)}>{renderCard!(draft, row)}</div>
              ))}
              {retired.filter((card) => card.answered === row.message.id).map((card) => (
                <div key={card.draftId}>{renderRetired?.(row, card.draftId, () => setRetired((list) => list.filter((x) => x.draftId !== card.draftId)), card.kind)}</div>
              ))}
              {placement?.quiet.get(index)?.map((draft) => (
                <p key={draft.message.id} className="fi-thread-event is-quiet">
                  {t("Your edited draft is in Drafts")}
                  {onOpenDrafts && <>{" "}<button type="button" className="fi-thread-action" onClick={onOpenDrafts}>{t("Open Drafts")}</button></>}
                </p>
              ))}
              {events.filter((e) => e.messageId === row.message.providerMessageId).map((e, i) => (
                <p key={`${e.kind}-${i}`} className={"fi-thread-event is-" + e.kind}>
                  {eventText(e, t)}{e.at ? <> · <time dateTime={new Date(e.at).toISOString()}>{listDate(new Date(e.at).toISOString(), undefined, t)}</time></> : null}
                </p>
              ))}
            </li>
          );
        })}
      </ol>
      {placement?.last.map((draft) => <div key={draft.message.id} ref={cardRef(draft.message.id)}>{renderCard!(draft, undefined)}</div>)}
    </section>
  );
}

/** How long an opened conversation is placed again as its cells load (A-6). */
const SETTLE_MS = 2500;
/** What the person does that ends the settling placement of an opened conversation (A-6). */
const INTERACTIONS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** The nearest ancestor that scrolls (the reading pane), whose box says what of the card is in view. */
function scrollPane(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = typeof getComputedStyle === "function" ? getComputedStyle(p).overflowY : "";
    if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * S06: a message above the agent's draft card is held to 40 % of the pane, so the card is seen at once; a longer one
 * shows "Show whole message".
 */
function Clamp({ children }: { children: ReactNode }) {
  const t = useT();
  const box = useRef<HTMLDivElement | null>(null);
  const [whole, setWhole] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || whole) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 4);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => observer?.disconnect();
  }, [whole]);
  return (
    <>
      <div ref={box} className={"fi-clamp" + (whole ? "" : " is-clamped")}>{children}</div>
      {long && !whole && <button type="button" className="fi-thread-action fi-clamp-more" onClick={() => setWhole(true)}>{t("Show whole message")}</button>}
    </>
  );
}

/** S05 (B-221): the cell's one line of who wrote to whom: the sender's address, the first recipient and how many more. */
function CellPeople({ row }: { row: ThreadRow }) {
  const facts = headerFacts({ from: row.message.sender, to: row.message.recipient, cc: row.cc });
  const { first, more } = compactRecipients(facts);
  const from = addressOf(row.message.sender);
  if (!from && !first) return null;
  return (
    <p className="fi-thread-people">
      {from}{first ? <> → {first.address || first.text}{more > 0 ? `, +${more}` : ""}</> : null}
    </p>
  );
}

/** S05: "In reply to <name>, <date>" for a reply that does not answer the cell above it; opens the answered lines in place. */
function ReplyTo({ target, onGo }: { target: ThreadRow; onGo: () => void }) {
  const t = useT();
  const [showing, setShowing] = useState(false);
  const name = target.kind === "received" ? senderName(target.message.sender) : whoSent(target, t);
  return (
    <div className="fi-thread-reply-to">
      <button type="button" className="fi-thread-reply-toggle" aria-expanded={showing} onClick={() => setShowing(!showing)}>
        {t("In reply to {name}, {date}", { name, date: listDate(target.message.date, undefined, t) })}
      </button>
      {showing && (
        <div className="fi-thread-reply-quote">
          <p>{target.message.snippet || t("This message has no text.")}</p>
          <button type="button" className="fi-thread-action" onClick={onGo}>{t("Go to message")}</button>
        </div>
      )}
    </div>
  );
}

/** S05: a thread event in the reader's words. */
function eventText(e: ThreadEvent, t: ReturnType<typeof useT>): string {
  const v = e.values;
  switch (e.code) {
    case "rule_waiting": return t("The rule {name} waits for your approval", v);
    case "rule_failed": return t("The rule {name} failed on this message", v);
    case "rule_forwarded": return t("The rule {name} forwarded this to {to}", v);
    case "rule_archived": return t("The rule {name} archived this", v);
    case "rule_marked_read": return t("The rule {name} marked this read", v);
    case "rule_drafted": return t("The rule {name} prepared a reply draft", v);
    case "rule_called_tool": return t("The rule {name} called the tool {tool}", v);
    case "safety_held": return t("The safety check held this message");
    case "safety_kept": return t("You kept this message held");
    case "safety_released_by_review": return t("The safety check's review released this message");
    case "safety_released": return t("You released this message");
  }
}

function whoSent(row: ThreadRow, t: ReturnType<typeof useT>): string {
  if (row.kind === "received") return senderName(row.message.sender);
  if (row.sentBy === "agent" || row.sentBy === "agent_waiting") return t("Agent");
  return t("You");
}

/** The mark beside who sent it: the agent's answer or waiting reply, a draft, or what the agent did with a message that came in. */
export function WhoChip({ row }: { row: ThreadRow }) {
  const t = useT();
  // S06, A-26: the agent by its name, as the card names it (its id when the name cannot be read).
  const agent = useAgentName(row.sentBy === "agent" ? row.message.agentRun?.agentId : undefined);
  if (row.kind === "draft") return <span className="fi-thread-chip">{t("Draft")}</span>;
  // S06: the agent's own sent answer names its agent and version.
  if (row.sentBy === "agent" && agent)
    return <span className="fi-thread-chip is-agent">{row.message.agentRun?.agentVersion
      ? t("Sent by {agent}, version {n}", { agent, n: row.message.agentRun.agentVersion })
      : t("Sent by {agent}", { agent })}</span>;
  if (row.sentBy === "agent") return <span className="fi-thread-chip is-agent">{t("Agent's answer")}</span>;
  if (row.sentBy === "agent_waiting") return <span className="fi-thread-chip is-agent">{t("Agent's waiting reply")}</span>;
  if (row.kind === "sent") return <span className="fi-thread-chip">{t("Sent by a person")}</span>;
  const run = row.message.agentRun;
  if (!run) return null;
  return <span className={"fi-thread-chip" + (agentRunNeedsLook(run.status) ? " needs-look" : "")}>{agentRunLabel(run.status, t)}</span>;
}

/** A message other than the open one, whole: the HTML the thread route carried, else read when shown. */
function CellBody({ row, loadBody, linkSafety }: { row: ThreadRow; loadBody: (message: InboxMessage) => Promise<{ html: string; text: string }>;
  linkSafety: CellSafety | "pending" | null }) {
  const t = useT();
  const carried = row.body !== undefined;
  const body = useQuery({
    queryKey: ["thread-body", row.message.accountId, row.message.providerMessageId],
    queryFn: () => loadBody(row.message),
    enabled: !carried,
    staleTime: 300_000,
  });
  const labels: QuoteLabels = { show: t("Show quoted text"), hide: t("Hide quoted text") };
  if (carried) return row.body ? <EmailIframe messageKey={row.message.id} body={foldQuotedHtml(row.body, labels)} autoSize blockedHosts={row.message.held?.links} linkSafety={linkSafety} /> : <p className="fi-thread-text">{t("This message has no text.")}</p>;
  if (body.isPending) return <p className="fi-thread-text is-loading">{t("Loading…")}</p>;
  if (body.isError)
    return (
      <p className="fi-thread-text fi-thread-error" role="alert">
        {t("This message could not be read.")}{" "}
        <button type="button" className="fi-thread-action" onClick={() => void body.refetch()}>{t("Try again")}</button>
      </p>
    );
  if (body.data.html) return <EmailIframe messageKey={row.message.id} body={foldQuotedHtml(body.data.html, labels)} autoSize blockedHosts={row.message.held?.links} linkSafety={linkSafety} />;
  return body.data.text ? <QuotedText text={body.data.text} /> : <div className="fi-thread-text">{t("This message has no text.")}</div>;
}

/** S05: a text body with its quoted history folded under "Show quoted text". */
export function QuotedText({ text, className = "fi-thread-text" }: { text: string; className?: string }) {
  const t = useT();
  const { main, quote } = splitQuotedText(text);
  return (
    <div className={className}>
      {main}
      {quote && (
        <details className="fi-quote">
          <summary><span className="fi-quote-show">{t("Show quoted text")}</span><span className="fi-quote-hide">{t("Hide quoted text")}</span></summary>
          <div className="fi-quote-text">{quote}</div>
        </details>
      )}
    </div>
  );
}

/**
 * A-11 (S02): a cell other than the open one marks an amber or red message with its icon and word, as the open
 * message's badge would say it; a green or grey cell carries no mark.
 */
function CellMark({ colour }: { colour: SafetyColour }) {
  const t = useT();
  if (colour.colour !== "amber" && colour.colour !== "red") return null;
  const Icon = colour.colour === "red" ? ShieldSlashIcon : ShieldWarningIcon;
  return (
    <span className={`fi-thread-safety is-${colour.colour}`}>
      <Icon size={13} weight="bold" aria-hidden="true" />{badgeWords(colour.label, t)}
    </span>
  );
}
