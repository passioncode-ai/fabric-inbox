import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "~/lib/i18n";
import { senderName, type InboxMessage } from "./model";
import { unreadOf, type ThreadRow } from "./thread";
import { listDate } from "./triage-view";

/**
 * The open message's conversation (B-114): every message of its thread, oldest first, your replies
 * and drafts included. The open one is marked; choosing another opens it in the reader, where Reply,
 * Reply all and Forward act on it. Show expands a message's text in place (and marks it read);
 * Mark conversation read marks every unread message of it. Shown only when the conversation has
 * more than one message.
 */
export default function ConversationList({ rows, openId, onOpen, loadText, onMarkRead }: {
  rows: ThreadRow[];
  openId: string;
  onOpen: (message: InboxMessage) => void;
  /** The message's text, for Show. */
  loadText: (message: InboxMessage) => Promise<string>;
  /** Marks these rows read; `whole` when the person asked for the whole conversation. */
  onMarkRead: (rows: ThreadRow[], whole: boolean) => Promise<void>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [marking, setMarking] = useState(false);
  const [failed, setFailed] = useState(false);
  if (rows.length < 2) return null;
  const unread = unreadOf(rows);
  const toggle = (row: ThreadRow) => {
    const id = row.message.id;
    const open = !expanded.has(id);
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(id); else next.delete(id);
      return next;
    });
    // Reading it in place reads it, as opening it does; a refusal leaves it unread, as the list shows.
    if (open && unread.includes(row)) void onMarkRead([row], false).catch(() => undefined);
  };
  const markAll = () => {
    setMarking(true);
    setFailed(false);
    onMarkRead(unread, true).catch(() => setFailed(true)).finally(() => setMarking(false));
  };
  return (
    <nav className="fi-thread" aria-label={t("Conversation")}>
      <div className="fi-thread-head">
        <h3 className="fi-thread-title">{t.plural(rows.length, { one: "{n} message in this thread", other: "{n} messages in this thread" })}</h3>
        {unread.length > 0 && (
          <button type="button" className="fi-thread-action" disabled={marking} onClick={markAll}>
            {marking ? t("Marking read…") : t("Mark conversation read")}
          </button>
        )}
      </div>
      {failed && <p className="fi-thread-error" role="alert">{t("The conversation could not be marked read. Try again.")}</p>}
      <ol className="fi-thread-list">
        {rows.map((row) => {
          const open = row.message.providerMessageId === openId;
          const shown = expanded.has(row.message.id);
          return (
            <li key={row.message.id} className="fi-thread-item">
              <button type="button" className={"fi-thread-row" + (open ? " is-open" : "") + (row.message.read ? "" : " is-unread")}
                aria-current={open ? "true" : undefined} disabled={open} onClick={() => onOpen(row.message)}>
                <span className="fi-thread-who">
                  {row.kind === "sent" ? t("You") : senderName(row.message.sender)}
                  {row.kind === "draft" && <span className="fi-thread-chip">{t("Draft")}</span>}
                </span>
                <time dateTime={row.message.date}>{listDate(row.message.date, undefined, t)}</time>
                {!shown && <span className="fi-thread-snippet">{row.message.snippet}</span>}
              </button>
              {!open && (
                <button type="button" className="fi-thread-toggle" aria-expanded={shown} onClick={() => toggle(row)}>
                  {shown ? t("Hide") : t("Show")}
                </button>
              )}
              {shown && <ThreadText message={row.message} loadText={loadText} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** One message's text, read when it is first shown and kept while the reader stays open. */
function ThreadText({ message, loadText }: { message: InboxMessage; loadText: (message: InboxMessage) => Promise<string> }) {
  const t = useT();
  const text = useQuery({ queryKey: ["thread-text", message.accountId, message.providerMessageId], queryFn: () => loadText(message), staleTime: 300_000 });
  if (text.isPending) return <p className="fi-thread-text is-loading">{t("Loading…")}</p>;
  if (text.isError)
    return (
      <p className="fi-thread-text fi-thread-error" role="alert">
        {t("This message could not be read.")}{" "}
        <button type="button" className="fi-thread-action" onClick={() => void text.refetch()}>{t("Try again")}</button>
      </p>
    );
  return <div className="fi-thread-text">{text.data || t("This message has no text.")}</div>;
}
