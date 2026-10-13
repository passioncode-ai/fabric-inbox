import { useT } from "~/lib/i18n";
import { senderName, type InboxMessage } from "./model";
import type { ThreadRow } from "./thread";
import { listDate } from "./triage-view";

/**
 * The open message's conversation (B-114): every message of its thread, oldest first, your replies
 * and drafts included. The open one is marked; choosing another opens it in the reader, where Reply,
 * Reply all and Forward act on it. Shown only when the conversation has more than one message.
 */
export default function ConversationList({ rows, openId, onOpen }: { rows: ThreadRow[]; openId: string; onOpen: (message: InboxMessage) => void }) {
  const t = useT();
  if (rows.length < 2) return null;
  return (
    <nav className="fi-thread" aria-label={t("Conversation")}>
      <h3 className="fi-thread-title">{t.plural(rows.length, { one: "{n} message in this thread", other: "{n} messages in this thread" })}</h3>
      <ol className="fi-thread-list">
        {rows.map((row) => {
          const open = row.message.providerMessageId === openId;
          return (
            <li key={row.message.id}>
              <button type="button" className={"fi-thread-row" + (open ? " is-open" : "") + (row.message.read ? "" : " is-unread")}
                aria-current={open ? "true" : undefined} disabled={open} onClick={() => onOpen(row.message)}>
                <span className="fi-thread-who">
                  {row.kind === "sent" ? t("You") : senderName(row.message.sender)}
                  {row.kind === "draft" && <span className="fi-thread-chip">{t("Draft")}</span>}
                </span>
                <time dateTime={row.message.date}>{listDate(row.message.date, undefined, t)}</time>
                <span className="fi-thread-snippet">{row.message.snippet}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
