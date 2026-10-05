/**
 * One answer per workspace for a message delivered to several agent addresses (B-22).
 *
 * Every address on the envelope gets its own copy, its own mailbox row and its own queue
 * item, so without this a message sent To support@ and Cc sales@ was answered once from
 * each. Each copy works out the same two things from the same headers: which message it is
 * (`messageKey`) and which address should answer it (`electAnswerer`: the first agent address
 * in To, else the first in Cc, an unlisted (Bcc) copy last). The workspace registry then
 * applies `decideClaim` in one SQLite transaction, so copies running side by side cannot both
 * win. A copy that is not chosen waits for the chosen address, at most `CLAIM_WAIT_MS`, and is
 * then recorded as a skipped duplicate naming the address that answers; if the chosen address
 * never claims the message (its copy was spam there, say), the waiting copy answers instead.
 */
import { headerValue, parseStoredHeaders } from "./prefilter";

/** How long a copy waits for the chosen address: its spam hold (B-30, 15 min) plus the queue's own delays. */
export const CLAIM_WAIT_MS = 20 * 60_000;
/** How often a waiting copy looks again; the chosen address usually claims within seconds. */
export const CLAIM_POLL_MS = 30_000;
/** Claims are kept a week, like the send counters, then pruned. */
export const CLAIM_TTL_MS = 7 * 86_400_000;
/** Listed addresses looked at when choosing; a longer list ranks the rest as unlisted. */
const MAX_LISTED = 50;

export type MessageClaim =
  | { outcome: "answer" }
  | { outcome: "duplicate"; owner: string }
  | { outcome: "wait"; owner: string; until: number };

/** The stored claim: `owner` answers; `taken` once the owner (or a copy that took over) has started. */
export interface ClaimRow { owner: string; taken: boolean; deadline: number }

export interface KeyedEmail {
  message_id?: string | null;
  sender: string;
  subject: string;
  raw_headers: string | null;
  recipient?: string | null;
  cc?: string | null;
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes).slice(0, 16), (n) => n.toString(16).padStart(2, "0")).join("");
}

/**
 * Which message this is, the same in every copy: its RFC Message-ID. Without one, a hash of
 * sender, subject, the Date header and the To and Cc lists — the same in every copy of one
 * send, and different for a separate message with the same subject. Without a Date header as
 * well there is nothing that tells two sends apart, so there is no key and each copy is
 * answered on its own, as before B-22.
 */
export async function messageKey(email: KeyedEmail): Promise<string | null> {
  const id = (email.message_id ?? "").trim().replace(/^<|>$/g, "").trim();
  if (id) return "mid:" + await sha256(id);
  const headers = parseStoredHeaders(email.raw_headers);
  const date = headerValue(headers, "date")?.trim();
  if (!date) return null;
  const list = (value: string | null | undefined) => (value ?? "").toLowerCase().split(",").map((a) => a.trim()).filter(Boolean).join(",");
  return "hdr:" + await sha256(JSON.stringify([email.sender.trim().toLowerCase(), email.subject.trim(), date, list(email.recipient), list(email.cc)]));
}

/** To, then Cc, each in header order, lower case and without repeats. */
export function answeringOrder(email: { recipient?: string | null; cc?: string | null }): string[] {
  const split = (value: string | null | undefined) => (value ?? "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => a.includes("@"));
  return [...new Set([...split(email.recipient), ...split(email.cc)])];
}

/**
 * The address that answers: the first one in `order` with an agent, this mailbox counting as
 * one (it has an agent, or it would not be asking). Only addresses ranked before this mailbox
 * are looked up. One whose agent cannot be read counts as having one: waiting for an address
 * that turns out to have no agent costs `CLAIM_WAIT_MS`; answering beside it could send twice.
 */
export async function electAnswerer(mailboxId: string, order: string[], serves: (address: string) => Promise<boolean>): Promise<string> {
  const self = mailboxId.toLowerCase();
  for (const address of order.slice(0, MAX_LISTED)) {
    if (address === self) return self;
    let served: boolean;
    try {
      served = await serves(address);
    } catch (error) {
      console.warn(JSON.stringify({ event: "agent_peer_unreadable", address, error: (error as Error).message }));
      served = true;
    }
    if (served) return address;
  }
  return self;
}

/**
 * The claim decision for one copy, applied by the registry inside one transaction. `write` is
 * the row to store, or null when nothing changes. The first stored choice stands: a later copy
 * that would choose differently (an agent switched on meanwhile) follows it.
 */
export function decideClaim(row: ClaimRow | null, mailboxId: string, elected: string, now: number, waitMs = CLAIM_WAIT_MS): { claim: MessageClaim; write: ClaimRow | null } {
  const self = mailboxId.toLowerCase();
  if (!row) {
    const owner = elected.toLowerCase();
    const write = { owner, taken: owner === self, deadline: now + waitMs };
    return { claim: write.taken ? { outcome: "answer" } : { outcome: "wait", owner, until: write.deadline }, write };
  }
  if (row.owner === self) return { claim: { outcome: "answer" }, write: row.taken ? null : { ...row, taken: true } };
  if (row.taken) return { claim: { outcome: "duplicate", owner: row.owner }, write: null };
  // The chosen address never started: this copy answers rather than leave the message unanswered.
  if (now >= row.deadline) return { claim: { outcome: "answer" }, write: { owner: self, taken: true, deadline: row.deadline } };
  return { claim: { outcome: "wait", owner: row.owner, until: row.deadline }, write: null };
}

/** The reason on a copy that is not answered, as the history shows it. */
export function duplicateReason(owner: string): string {
  return `Duplicate: answered from ${owner}`;
}
