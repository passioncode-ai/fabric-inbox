import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "~/lib/i18n";
import EmailIframe from "~/components/EmailIframe";
import { senderName, type InboxMessage } from "./model";
import { unreadOf, type ThreadRow } from "./thread";
import { listDate } from "./triage-view";
import { agentRunLabel, agentRunNeedsLook } from "./agent-run";

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
export default function ConversationList({ rows, openId, onOpen, loadBody, onMarkRead, renderOpen }: {
  rows: ThreadRow[];
  openId: string;
  onOpen: (message: InboxMessage) => void;
  /** A message's HTML or text, for a cell whose body the thread route did not carry (Gmail, IMAP, Outlook). */
  loadBody: (message: InboxMessage) => Promise<{ html: string; text: string }>;
  /** Marks these rows read; `whole` when it is the whole conversation. */
  onMarkRead: (rows: ThreadRow[], whole: boolean) => Promise<void>;
  /** The open message's own content: its body, pictures, attachments and what the agent did. */
  renderOpen: () => ReactNode;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const openRef = useRef<HTMLElement | null>(null);
  const unread = rows.length > 1 ? unreadOf(rows) : [];
  const threadKey = rows[0]?.message.threadId ?? "";
  // Reading the conversation reads it, once per conversation opened; a refusal is said, with a retry.
  const marked = useRef("");
  useEffect(() => {
    if (!unread.length || marked.current === threadKey) return;
    marked.current = threadKey;
    onMarkRead(unread, true).then(() => setFailed(false), () => setFailed(true));
  }, [threadKey, unread.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // The open message comes into view: the conversation reads from the top, the reader lands on it.
  useEffect(() => { openRef.current?.scrollIntoView?.({ block: "start" }); }, [openId, rows.length]);
  if (rows.length < 2) return null;
  const hidden = earlier ? 0 : Math.max(0, rows.length - SHOWN);
  const shown = rows.slice(hidden);
  return (
    <section className="fi-thread" aria-label={t("Conversation")}>
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
        {shown.map((row) => {
          const open = row.message.providerMessageId === openId;
          return (
            <li key={row.message.id}>
              <article ref={open ? openRef : undefined} className={"fi-thread-cell" + (open ? " is-open" : "") + (row.kind !== "received" ? " is-outgoing" : "")
                + (row.sentBy === "agent" || row.sentBy === "agent_waiting" ? " is-agent" : "")} aria-current={open ? "true" : undefined}>
                <header className="fi-thread-cell-head">
                  {open ? (
                    <span className="fi-thread-cell-who"><strong>{whoSent(row, t)}</strong><WhoChip row={row} /></span>
                  ) : (
                    <button type="button" className="fi-thread-cell-who" onClick={() => onOpen(row.message)} title={t("Open this message to reply to it")}>
                      <strong>{whoSent(row, t)}</strong>
                      <WhoChip row={row} />
                    </button>
                  )}
                  <time dateTime={row.message.date}>{listDate(row.message.date, undefined, t)}</time>
                </header>
                <div className="fi-thread-cell-body">{open ? renderOpen() : <CellBody row={row} loadBody={loadBody} />}</div>
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function whoSent(row: ThreadRow, t: ReturnType<typeof useT>): string {
  if (row.kind === "received") return senderName(row.message.sender);
  if (row.sentBy === "agent" || row.sentBy === "agent_waiting") return t("Agent");
  return t("You");
}

/** The mark beside who sent it: the agent's answer or waiting reply, a draft, or what the agent did with a message that came in. */
function WhoChip({ row }: { row: ThreadRow }) {
  const t = useT();
  if (row.kind === "draft") return <span className="fi-thread-chip">{t("Draft")}</span>;
  if (row.sentBy === "agent") return <span className="fi-thread-chip is-agent">{t("Agent's answer")}</span>;
  if (row.sentBy === "agent_waiting") return <span className="fi-thread-chip is-agent">{t("Agent's waiting reply")}</span>;
  if (row.kind === "sent") return <span className="fi-thread-chip">{t("Sent by a person")}</span>;
  const run = row.message.agentRun;
  if (!run) return null;
  return <span className={"fi-thread-chip" + (agentRunNeedsLook(run.status) ? " needs-look" : "")}>{agentRunLabel(run.status, t)}</span>;
}

/** A message other than the open one, whole: the HTML the thread route carried, else read when shown. */
function CellBody({ row, loadBody }: { row: ThreadRow; loadBody: (message: InboxMessage) => Promise<{ html: string; text: string }> }) {
  const t = useT();
  const carried = row.body !== undefined;
  const body = useQuery({
    queryKey: ["thread-body", row.message.accountId, row.message.providerMessageId],
    queryFn: () => loadBody(row.message),
    enabled: !carried,
    staleTime: 300_000,
  });
  if (carried) return row.body ? <EmailIframe messageKey={row.message.id} body={row.body} autoSize blockedHosts={row.message.held?.links} /> : <p className="fi-thread-text">{t("This message has no text.")}</p>;
  if (body.isPending) return <p className="fi-thread-text is-loading">{t("Loading…")}</p>;
  if (body.isError)
    return (
      <p className="fi-thread-text fi-thread-error" role="alert">
        {t("This message could not be read.")}{" "}
        <button type="button" className="fi-thread-action" onClick={() => void body.refetch()}>{t("Try again")}</button>
      </p>
    );
  if (body.data.html) return <EmailIframe messageKey={row.message.id} body={body.data.html} autoSize blockedHosts={row.message.held?.links} />;
  return <div className="fi-thread-text">{body.data.text || t("This message has no text.")}</div>;
}
