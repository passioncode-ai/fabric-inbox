import { msg } from "../i18n";
/**
 * The spam verdict a Cloudflare message gets on arrival (SP-1). Pure: the operator's
 * lists, the authenticity results Cloudflare's MX wrote, and whether anyone here has
 * written to the sender. "screen" means no rule decided and the model may read it
 * (SP-2, workers/categories/store.ts).
 */
export interface SpamLists {
  blockedSenders: string[];
  blockedDomains: string[];
  allowedSenders: string[];
  allowedDomains: string[];
}
export type SpamVerdict = { verdict: "spam" | "clean" | "screen"; reason: string };

export interface AuthResults {
  dkim: string[];
  /** Domains with a passing DKIM signature. */
  dkimDomains: string[];
  dmarc: string | null;
  dmarcPolicy: string | null;
  spf: string | null;
  fromDomain: string | null;
}

/** Cloudflare's MX names itself so; results written by anyone else are not trusted. */
const AUTHSERV = "mx.cloudflare.net";
export const SPAM_LIST_LIMIT = 2000;
const ADDRESS = /^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const under = (domain: string, list: string[]) => list.find((d) => domain === d || domain.endsWith("." + d));

/**
 * The topmost Authentication-Results by Cloudflare's MX. Cloudflare prepends its own
 * header, so a sender's forged "mx.cloudflare.net; dmarc=pass" can only sit below it.
 */
export function authResults(headers: { key: string; value: string }[]): AuthResults | null {
  const header = headers.find((h) => h.key.toLowerCase() === "authentication-results"
    && h.value.trim().toLowerCase().startsWith(AUTHSERV));
  if (!header) return null;
  const value = header.value.toLowerCase();
  const result = (method: string) => [...value.matchAll(new RegExp(`(?:^|[;\\s])${method}=([a-z]+)([^;]*)`, "g"))];
  const dkim = result("dkim");
  const dmarc = result("dmarc")[0];
  const spf = result("spf")[0];
  return {
    dkim: dkim.map((m) => m[1]),
    dkimDomains: dkim.filter((m) => m[1] === "pass").map((m) => m[2].match(/header\.d=([a-z0-9.-]+)/)?.[1]).filter((d): d is string => !!d),
    dmarc: dmarc?.[1] ?? null,
    dmarcPolicy: dmarc?.[2].match(/policy\.dmarc=([a-z]+)/)?.[1] ?? null,
    spf: spf?.[1] ?? null,
    fromDomain: dmarc?.[2].match(/header\.from=([a-z0-9.-]+)/)?.[1] ?? null,
  };
}

export function spamCheck(input: {
  sender: string;
  headers: { key: string; value: string }[];
  ownDomains: string[];
  lists: SpamLists;
  /** A mailbox here has sent mail to this address. */
  known: boolean;
}): SpamVerdict {
  const sender = input.sender.trim().toLowerCase();
  const domain = domainOf(sender);
  const lists = input.lists;
  const auth = authResults(input.headers);
  const own = under(domain, input.ownDomains);
  // A forgery is decided before the operator's lists: "not spam" for bank.com means mail from
  // bank.com, not mail that bank.com's own DMARC says is not from it (2026-10-01 review).
  // A copy with no result from Cloudflare (local, relayed, a test) claims nothing.
  const ownAuthentic = !auth || auth.dmarc === "pass" || auth.dkimDomains.some((d) => under(d, input.ownDomains));
  if (own && !ownAuthentic) return { verdict: "spam", reason: msg("Claims to be from your domain {domain} but failed its authenticity checks", { domain: own }) };
  if (auth && auth.dmarc === "fail" && (auth.dmarcPolicy === "reject" || auth.dmarcPolicy === "quarantine"))
    return { verdict: "spam", reason: auth.dmarcPolicy === "reject"
      ? msg("Failed DMARC for {domain}, whose owner asks to reject such mail", { domain: auth.fromDomain ?? domain })
      : msg("Failed DMARC for {domain}, whose owner asks to quarantine such mail", { domain: auth.fromDomain ?? domain }) };

  if (lists.allowedSenders.includes(sender)) return { verdict: "clean", reason: msg("You marked this sender as not spam") };
  const allowedDomain = under(domain, lists.allowedDomains);
  if (allowedDomain) return { verdict: "clean", reason: msg("You marked {domain} as not spam", { domain: allowedDomain }) };
  if (lists.blockedSenders.includes(sender)) return { verdict: "spam", reason: msg("You marked this sender as spam") };
  const blockedDomain = under(domain, lists.blockedDomains);
  if (blockedDomain) return { verdict: "spam", reason: msg("You marked {domain} as spam", { domain: blockedDomain }) };

  if (own) return { verdict: "clean", reason: msg("From one of your own domains") };
  if (auth) {
    // Weaker than DMARC: a real sender with a broken SPF record is the operator's to allow (above).
    if (auth.spf === "fail" && !auth.dkimDomains.length && auth.dmarc !== "pass")
      return { verdict: "spam", reason: msg("The sending server is not allowed to send for {domain}, and the message carries no valid signature", { domain }) };
  }
  if (input.known) return { verdict: "clean", reason: msg("You have written to this sender") };
  return { verdict: "screen", reason: "" };
}

/** One list entry from an address as shown ("Ann <ann@example.com>"): the address, or its domain. */
export function listEntry(value: string, kind: "sender" | "domain"): string | null {
  const address = (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase().replace(/^@/, "");
  if (kind === "sender") return ADDRESS.test(address) ? address : null;
  const domain = address.includes("@") ? domainOf(address) : address;
  return DOMAIN.test(domain) ? domain : null;
}

export function normaliseLists(value: unknown): SpamLists {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const clean = (key: keyof SpamLists, kind: "sender" | "domain") => {
    const raw = Array.isArray(v[key]) ? v[key] as unknown[] : [];
    const out = raw.map((x) => (typeof x === "string" ? listEntry(x, kind) : null)).filter((x): x is string => !!x);
    return [...new Set(out)].slice(0, SPAM_LIST_LIMIT);
  };
  return {
    blockedSenders: clean("blockedSenders", "sender"),
    blockedDomains: clean("blockedDomains", "domain"),
    allowedSenders: clean("allowedSenders", "sender"),
    allowedDomains: clean("allowedDomains", "domain"),
  };
}

/** "Sent from my iPhone" and its translations: a signature, not content. */
const SENT_FROM = /^(sent from my |sent from |wysłane z |отправлено с |gesendet von |envoyé de |enviado desde |inviato da ).*$/gim;
const LINK = /(https?:\/\/|www\.)\S+/i;

/**
 * A message with almost no text and no link gives the model nothing to judge: it stays
 * where it is. Seen live on 2026-09-29, when a message whose whole body was
 * "Wysłane z iPhone'a" was judged cold outreach.
 */
export function tooLittleToJudge(text: string): boolean {
  if (LINK.test(text)) return false;
  return text.replace(SENT_FROM, "").replace(/\s+/g, " ").trim().length < 20;
}
