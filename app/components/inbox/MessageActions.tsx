import { ArrowUUpLeftIcon, ShieldCheckIcon, StarIcon, TrashIcon, WarningOctagonIcon } from "@phosphor-icons/react";
import type { InboxFolder, InboxMessage } from "../../../shared/mail/inbox";
import { fabric } from "../../services/fabric";

export type ActionMessage = Pick<InboxMessage, "id" | "accountId" | "provider" | "providerMessageId" | "starred"> & { sender?: string };
export type MessageChange = { id: string; starred: boolean } | { id: string; removed: true; notice?: string };
export interface MessageActionsProps {
  message: ActionMessage;
  folder: InboxFolder;
  busy: boolean;
  /** Runs the action; `optimistic` is what the list may show before the server answers (P3-12). */
  run: (action: () => Promise<unknown>, after?: () => void, optimistic?: MessageChange) => Promise<unknown>;
  onChanged: (change: MessageChange) => void;
  /** What the message's account can do (an IMAP server with no Spam or Trash folder): absent is everything. */
  capabilities?: { spam: boolean; trash: boolean };
}
type Request = (url: string, body: unknown, method?: string) => Promise<unknown>;

/** The clicked message supplies both routing and the completion identity. */
export async function changeMessage(
  message: ActionMessage,
  change: { starred: boolean } | { trashed: boolean },
  request: Request = fabric,
): Promise<MessageChange> {
  const prefix = message.provider + ":";
  if (!message.accountId.startsWith(prefix) || !message.accountId.slice(prefix.length) || !message.providerMessageId)
    throw new Error("Message account is unavailable. Refresh and try again.");
  const account = encodeURIComponent(message.accountId.slice(prefix.length));
  const id = encodeURIComponent(message.providerMessageId);
  // Gmail and IMAP accounts share their routes (/api/accounts/<id>); a Cloudflare mailbox has its own.
  const gmail = message.provider === "gmail" || message.provider === "imap";
  const path = gmail ? `/api/accounts/${account}/messages/${id}` : `/api/v1/mailboxes/${account}/emails/${id}`;
  if ("starred" in change) {
    const result = await request(gmail ? path + "/starred" : path, change, gmail ? "POST" : "PUT") as { labels?: string[]; starred?: boolean };
    const starred = gmail && Array.isArray(result?.labels) ? result.labels.includes("STARRED") : result?.starred;
    if (typeof starred !== "boolean") throw new Error("Message state could not be confirmed. Refresh and try again.");
    return { id: message.id, starred };
  }
  await request(gmail ? path + "/trashed" : path + "/move",
    gmail ? change : { folderId: change.trashed ? "trash" : "inbox" }, "POST");
  return { id: message.id, removed: true };
}

/** What the list may show at once for an action on `message`, before the server confirms it. */
export function expectedChange(message: ActionMessage, change: { starred: boolean } | { trashed: boolean } | { spam: boolean }): MessageChange {
  return "starred" in change ? { id: message.id, starred: change.starred } : { id: message.id, removed: true };
}

/** Guard completion against selecting a different account/message while waiting. */
export function applyMessageChange<T extends ActionMessage>(current: T | null, change: MessageChange): T | null {
  if (!current || current.id !== change.id) return current;
  return "removed" in change ? null : { ...current, starred: change.starred };
}

/**
 * Report spam or Not spam (SP-3): the message moves, and its sender goes on the
 * block or allow list, so the next message from them is decided on arrival.
 */
export async function changeSpam(message: ActionMessage, spam: boolean, request: Request = fabric): Promise<MessageChange> {
  const result = await request(spam ? "/api/spam/report" : "/api/spam/release", {
    messages: [{ accountId: message.accountId, providerMessageId: message.providerMessageId, sender: message.sender ?? "" }],
    list: "sender",
  }) as { moved?: number; listed?: string[]; listError?: string; failed?: { error?: string }[] };
  if (!result?.moved) throw new Error(result?.failed?.[0]?.error || "The message could not be moved. Refresh and try again.");
  const who = result.listed?.[0];
  const notice = result.listError
    ? result.listError
    : spam
      ? `Moved to Spam.${who ? ` New mail from ${who} goes to Spam too; change it on Spam rules.` : ""}`
      : `Moved to the inbox.${who ? ` Mail from ${who} is no longer treated as spam.` : ""}`;
  return { id: message.id, removed: true, notice };
}

export default function MessageActions({ message, folder, busy, run, onChanged, capabilities }: MessageActionsProps) {
  const restoring = folder === "trash";
  const starLabel = message.starred ? "Unstar message" : "Star message";
  const trashLabel = restoring
    ? message.provider !== "cloudflare" ? "Restore message" : "Restore to inbox"
    : "Move to trash";
  function perform(change: { starred: boolean } | { trashed: boolean }) {
    let result: MessageChange | undefined;
    // Parent run surfaces errors and refreshes provider-backed lists before completion.
    void run(async () => { result = await changeMessage(message, change); }, () => {
      if (result) onChanged(result);
    }, expectedChange(message, change));
  }
  const inSpam = folder === "spam";
  const canReport = !inSpam && folder !== "sent" && folder !== "trash" && capabilities?.spam !== false;
  const canTrash = capabilities?.trash !== false;
  function spam(toSpam: boolean) {
    let result: MessageChange | undefined;
    void run(async () => { result = await changeSpam(message, toSpam); }, () => {
      if (result) onChanged(result);
    }, expectedChange(message, { spam: toSpam }));
  }
  return <>
    {inSpam && (
      <button type="button" className="fi-icon-button" aria-label="Not spam" title="Not spam: back to the inbox"
        disabled={busy} onClick={() => spam(false)}>
        <ShieldCheckIcon size={19} />
      </button>
    )}
    <button type="button" className="fi-icon-button" aria-label={starLabel} title={starLabel}
      aria-pressed={message.starred} disabled={busy} onClick={() => perform({ starred: !message.starred })}>
      <StarIcon size={19} weight={message.starred ? "fill" : "regular"} />
    </button>
    {canTrash && (
      <button type="button" className="fi-icon-button" aria-label={trashLabel} title={trashLabel}
        disabled={busy} onClick={() => perform({ trashed: !restoring })}>
        {restoring ? <ArrowUUpLeftIcon size={19} /> : <TrashIcon size={19} />}
      </button>
    )}
    {canReport && (
      <button type="button" className="fi-icon-button" aria-label="Report spam" title="Report spam: move it and its sender to Spam"
        disabled={busy} onClick={() => spam(true)}>
        <WarningOctagonIcon size={19} />
      </button>
    )}
  </>;
}
