/**
 * S02 (B-268): who wrote an open message and to whom, read from the header lines the reader already has. Pure, so
 * the rules are tested without a page: which recipient is "you", when Reply-To is worth showing, and when a received
 * message reached us without our address in To or Cc. Bcc is never guessed on received mail: only the mail we sent
 * knows its Bcc.
 */

export type Recipient = { text: string; address: string; you: boolean };

/** The address in "Ann <ann@acme.example>" or a bare address, lowercased; "" when there is none. */
export function addressOf(value: string): string {
  const inside = value.match(/<([^<>]+)>/)?.[1] ?? value;
  const email = inside.trim().replace(/^"|"$/g, "").toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(email) ? email : "";
}

/** A header's address list split on the commas between addresses, never inside a quoted name or angle brackets. */
export function splitAddresses(list: string | null | undefined): string[] {
  if (!list) return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of list) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted && angle > 0) angle--;
    if ((ch === "," || ch === ";") && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const recipients = (list: string | null | undefined, own: string): Recipient[] =>
  splitAddresses(list).map((text) => {
    const address = addressOf(text);
    return { text, address, you: !!own && address === own };
  });

export interface HeaderInput {
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  replyTo?: string | null;
  /** The account's own address (the one the message arrived at, or was sent from). */
  own?: string | null;
  /** The message is ours: sent or a draft. */
  sent?: boolean;
  /** A mailing list's List-Id header, when the message has one. */
  listId?: string | null;
  /** The account is a catch-all: mail to any address of its domain reaches it. */
  catchAll?: boolean;
}

export interface HeaderFacts {
  to: Recipient[];
  cc: Recipient[];
  /** Only on mail we sent: received mail does not carry its Bcc. */
  bcc: Recipient[];
  /** Shown only when it differs from From. */
  replyTo: string | null;
  /** Received mail whose To and Cc do not name our address, from no list and not to a catch-all. */
  notAddressed: boolean;
  /** "Received at <our address>": received mail whose To, Cc and Bcc do not name it. Never on mail we sent (A-8). */
  receivedAt: boolean;
}

export function headerFacts(input: HeaderInput): HeaderFacts {
  const own = addressOf(input.own ?? "");
  const to = recipients(input.to, own);
  const cc = recipients(input.cc, own);
  const bcc = input.sent ? recipients(input.bcc, own) : [];
  const from = addressOf(input.from);
  const replyAddresses = splitAddresses(input.replyTo).map(addressOf).filter(Boolean);
  const replyTo = replyAddresses.length && replyAddresses.some((a) => a !== from) ? (input.replyTo ?? "").trim() : null;
  const named = to.some((r) => r.you) || cc.some((r) => r.you);
  const notAddressed = !input.sent && !!own && !named && !input.listId?.trim() && !input.catchAll;
  const receivedAt = !input.sent && !!own && ![...to, ...cc, ...bcc].some((r) => r.you);
  return { to, cc, bcc, replyTo, notAddressed, receivedAt };
}

/** How many recipients a list shows before "and N more". */
export const SHOWN_RECIPIENTS = 3;

/** The compact line of a thread's other cells: the first recipient and how many more. */
export function compactRecipients(facts: Pick<HeaderFacts, "to" | "cc" | "bcc">): { first: Recipient | null; more: number } {
  const all = [...facts.to, ...facts.cc, ...facts.bcc];
  return { first: all[0] ?? null, more: Math.max(0, all.length - 1) };
}

/**
 * A-22 (S02): the date's relative time, shown on pointing ("3 hours ago", «3 часа назад»), in the reader's language
 * through `Intl.RelativeTimeFormat`; a future date (a clock that is off) reads as now.
 */
export function relativeDate(date: Date, now: number, locale: string | undefined): string {
  const seconds = Math.round((date.valueOf() - now) / 1000);
  const past = Math.min(0, seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(past) >= size) return format.format(Math.round(past / size), unit);
  return format.format(0, "second");
}
