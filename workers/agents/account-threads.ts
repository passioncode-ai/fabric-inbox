import type { SentBy, ThreadFacts } from "../../shared/mail/agent-state";

/**
 * B-171 phase 3: the facts of one conversation of a Gmail, IMAP or Outlook account, for the reply
 * status (B-138, B-170), read from the account's cache as MailboxDO.agentThreads reads an address's
 * rows. A message came in when it is neither sent nor a draft and is still in the conversation (not in
 * Trash, Spam or Discarded); a sent message is the agent's when a send receipt of the agent's run on
 * a message of the conversation names it (`<run>`, or `<run>:waiting` for its waiting reply).
 */
export interface AccountThreadMember { id: string; at: number; labels: string[] }

const OUT = ["TRASH", "SPAM", "DISCARDED"];
const out = (labels: string[]) => labels.some((l) => OUT.includes(l));

export function accountThreadFacts(threadId: string, members: AccountThreadMember[], agentSent: ReadonlyMap<string, Exclude<SentBy, "person">>): ThreadFacts {
  const kept = members.filter((m) => !out(m.labels) && !m.labels.includes("DRAFT"));
  const latest = <T extends AccountThreadMember>(list: T[]) => list.reduce<T | null>((a, b) => (!a || b.at > a.at || (b.at === a.at && b.id > a.id) ? b : a), null);
  const inbound = latest(kept.filter((m) => !m.labels.includes("SENT")));
  const sentRows = kept.filter((m) => m.labels.includes("SENT"));
  const sent = latest(sentRows);
  return {
    threadId,
    lastInbound: inbound ? { id: inbound.id, at: inbound.at } : null,
    lastSent: sent ? { id: sent.id, at: sent.at, by: agentSent.get(sent.id) ?? "person" } : null,
    agentAnsweredBefore: !!inbound && sentRows.some((m) => agentSent.get(m.id) === "agent" && m.at < inbound.at),
  };
}
