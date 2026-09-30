/**
 * Mail no agent should answer, decided from headers before any model call
 * (REQ-P3, SCN-024 alt path). Cheap, deterministic and explainable: every skip
 * names its reason in the run record.
 */
export type SkipReason =
  | "no_sender"
  | "own_address"
  | "own_domain"
  | "calendar"
  | "auto_submitted"
  | "bulk"
  | "mailing_list"
  | "auto_reply"
  | "delivery_report"
  | "no_reply_sender"
  | "already_answered";

export const SKIP_TEXT: Record<SkipReason, string> = {
  no_sender: "The message has no sender address",
  own_address: "The message came from this address itself",
  own_domain: "The message came from one of this server's own addresses",
  calendar: "Calendar invitation or response",
  auto_submitted: "Automatically generated message (Auto-Submitted)",
  bulk: "Bulk or list precedence",
  mailing_list: "Mailing list or newsletter",
  auto_reply: "Automatic reply or out-of-office",
  delivery_report: "Delivery report or bounce",
  no_reply_sender: "The sender does not accept replies",
  already_answered: "The operator already replied in this thread",
};

export interface PrefilterInput {
  mailboxId: string;
  sender: string;
  /** Header names are compared case-insensitively. */
  headers: { key: string; value: string }[];
  /** A message sent from this mailbox in the thread after this one arrived. */
  answeredAfter: boolean;
  /** Domains this server serves: mail from them is our own, never answered (no loops between agents). */
  ownDomains?: string[];
  /** The address a reply would go to (Reply-To), checked like the sender. */
  replyTo?: string;
  subject?: string;
}

const NO_REPLY_LOCAL = /^(no[-_.]?reply\d*|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|automated|system)([+._-].*)?$/;
const CALENDAR_SUBJECT = /^(accepted|declined|tentative|tentatively accepted|updated invitation|invitation|new event|canceled event|cancelled event|приглашение|принято|отклонено)( \(.*?\))?:/i;
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const ours = (email: string, domains: string[]) => domains.some((d) => domainOf(email) === d || domainOf(email).endsWith("." + d));

/** The first address of a Reply-To header ("Ann <ann@example.com>, …" → "ann@example.com"), or "" when there is none that parses. */
export function replyToAddress(headers: { key: string; value: string }[]): string {
  const raw = headerValue(headers, "reply-to") ?? "";
  const first = raw.split(",")[0] ?? "";
  const email = (first.match(/<([^<>]+)>/)?.[1] ?? first).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : "";
}

export function headerValue(headers: { key: string; value: string }[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.key?.toLowerCase() === wanted)?.value;
}

/** Parses the `raw_headers` column (postal-mime `{key,value}[]` JSON). Broken or absent → no headers. */
export function parseStoredHeaders(raw: string | null | undefined): { key: string; value: string }[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((h) => h && typeof h.key === "string").map((h) => ({ key: h.key, value: String(h.value ?? "") }))
      : [];
  } catch {
    return [];
  }
}

export function prefilter(input: PrefilterInput): SkipReason | null {
  const sender = input.sender.trim().toLowerCase();
  if (!sender || !sender.includes("@")) return "no_sender";
  if (sender === input.mailboxId.trim().toLowerCase()) return "own_address";
  const replyTo = (input.replyTo ?? "").trim().toLowerCase();
  const domains = (input.ownDomains ?? []).map((d) => d.toLowerCase());
  if (domains.length && (ours(sender, domains) || (replyTo && ours(replyTo, domains)))) return "own_domain";
  const h = (name: string) => headerValue(input.headers, name)?.trim().toLowerCase();
  const autoSubmitted = h("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return "auto_submitted";
  const contentType = h("content-type") ?? "";
  if (contentType.startsWith("multipart/report") || h("return-path") === "<>") return "delivery_report";
  if (h("x-autoreply") || h("x-autorespond") || /\b(oof|autoreply|all)\b/.test(h("x-auto-response-suppress") ?? ""))
    return "auto_reply";
  const precedence = h("precedence");
  if (precedence && ["bulk", "list", "junk", "auto_reply"].includes(precedence)) return "bulk";
  if (h("list-id") || h("list-unsubscribe")) return "mailing_list";
  if (contentType.startsWith("text/calendar") || /method=(request|reply|cancel)/.test(contentType) || CALENDAR_SUBJECT.test((input.subject ?? "").trim()))
    return "calendar";
  // The address actually answered is Reply-To when there is one.
  const target = replyTo || sender;
  const local = target.slice(0, target.lastIndexOf("@"));
  if (NO_REPLY_LOCAL.test(local) || local.includes("noreply")) return "no_reply_sender";
  if (input.answeredAfter) return "already_answered";
  return null;
}
