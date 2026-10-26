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
const TLD = "(?:[a-z]{2,}|xn--[a-z0-9-]+)";
const ADDRESS = new RegExp(`^[^\\s@<>]+@[a-z0-9.-]+\\.${TLD}$`);
const DOMAIN = new RegExp(`^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.${TLD}$`);

/** A domain as its ASCII form: "магазин.рф" is "xn--80aal0a.xn--p1ai", as mail headers carry it (C-6). */
export function asciiDomain(domain: string): string {
  if (/^[\x00-\x7f]*$/.test(domain)) return domain;
  try { return new URL(`http://${domain}`).hostname; } catch { return domain; }
}

const domainOf = (address: string) => asciiDomain(address.slice(address.lastIndexOf("@") + 1));
const under = (domain: string, list: string[]) => list.find((d) => domain === d || domain.endsWith("." + d));

/**
 * The topmost Authentication-Results by Cloudflare's MX. Cloudflare prepends its own
 * header, so a sender's forged "mx.cloudflare.net; dmarc=pass" can only sit below it.
 */
export function authResults(headers: { key: string; value: string }[]): AuthResults | null {
  const header = headers.find((h) => h.key.toLowerCase() === "authentication-results"
    && h.value.trim().toLowerCase().startsWith(AUTHSERV));
  if (!header) return null;
  // Each result is its own clause; text in a comment or a property (a quoted envelope local part) is not a result.
  const clauses = header.value.toLowerCase().split(";").slice(1).map((c) => c.replace(/\([^()]*\)/g, " ").trim());
  const result = (method: string) => clauses.map((c) => c.match(new RegExp(`^${method}=([a-z]+)([\\s\\S]*)$`))).filter((m): m is RegExpMatchArray => !!m);
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

/**
 * The domain Cloudflare's MX confirmed sent the message (B-172), for the model's spam check: the
 * From domain when DMARC passed, else a passing DKIM signature aligned with the sender's domain
 * (the same domain, or one under the other). Null when nothing was confirmed.
 */
export function verifiedDomain(auth: AuthResults | null, sender: string): string | null {
  if (!auth) return null;
  const domain = domainOf(sender.trim().toLowerCase());
  if (auth.dmarc === "pass") return auth.fromDomain ?? (domain || null);
  if (!domain) return null;
  return auth.dkimDomains.find((d) => d === domain || domain.endsWith("." + d) || d.endsWith("." + domain)) ?? null;
}

/** One of the domains written as a whole word in a sender's shown name ("Mail Update example.com"). */
export function namedDomain(name: string, domains: string[]): string | null {
  const text = name.toLowerCase();
  return domains.find((d) => {
    // Every occurrence: "mail.example.com | example.com Update" wears it in the second (C-9).
    for (let at = text.indexOf(d); at >= 0; at = text.indexOf(d, at + 1)) {
      const before = text[at - 1] ?? " ", after = text[at + d.length] ?? " ";
      if (!/[a-z0-9.@-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
    }
    return false;
  }) ?? null;
}

export function spamCheck(input: {
  sender: string;
  headers: { key: string; value: string }[];
  ownDomains: string[];
  lists: SpamLists;
  /** A mailbox here has sent mail to this address. */
  known: boolean;
  /** The name the From header shows. */
  senderName?: string | null;
}): SpamVerdict {
  const given = input.sender.trim().toLowerCase();
  const domain = domainOf(given);
  const sender = given.includes("@") ? given.slice(0, given.lastIndexOf("@") + 1) + domain : given;
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

  // C-4: a From whose own domain's DMARC says it is not from there (even under p=none, as gmail.com publishes)
  // is not the sender the person allowed or wrote to: it goes to the model instead.
  const disowned = !!auth && auth.dmarc === "fail";
  if (!disowned && lists.allowedSenders.includes(sender)) return { verdict: "clean", reason: msg("You marked this sender as not spam") };
  const allowedDomain = disowned ? undefined : under(domain, lists.allowedDomains);
  if (allowedDomain) return { verdict: "clean", reason: msg("You marked {domain} as not spam", { domain: allowedDomain }) };
  if (lists.blockedSenders.includes(sender)) return { verdict: "spam", reason: msg("You marked this sender as spam") };
  const blockedDomain = under(domain, lists.blockedDomains);
  if (blockedDomain) return { verdict: "spam", reason: msg("You marked {domain} as spam", { domain: blockedDomain }) };

  if (own) return { verdict: "clean", reason: msg("From one of your own domains") };
  // B-172: "Mail Update example.com" <x@elsewhere>: a stranger wearing your domain as its name, the
  // shape of every "verify your mailbox" phishing seen live; the model let it through as a notice.
  const worn = namedDomain(input.senderName ?? "", input.ownDomains);
  if (worn && domain) return { verdict: "spam", reason: msg("Shows your domain {domain} as its name but comes from {sender}", { domain: worn, sender: domain }) };
  if (auth) {
    // Weaker than DMARC: a real sender with a broken SPF record is the operator's to allow (above).
    if (auth.spf === "fail" && !auth.dkimDomains.length && auth.dmarc !== "pass")
      return { verdict: "spam", reason: msg("The sending server is not allowed to send for {domain}, and the message carries no valid signature", { domain }) };
  }
  if (input.known && !disowned) return { verdict: "clean", reason: msg("You have written to this sender") };
  return { verdict: "screen", reason: "" };
}

/** One list entry from an address as shown ("Ann <ann@example.com>"): the address, or its domain. */
export function listEntry(value: string, kind: "sender" | "domain"): string | null {
  const raw = (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase().replace(/^@/, "");
  const at = raw.lastIndexOf("@");
  const address = at < 0 ? asciiDomain(raw) : raw.slice(0, at + 1) + asciiDomain(raw.slice(at + 1));
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
