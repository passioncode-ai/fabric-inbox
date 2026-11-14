import { checkReplyPath, checkSenderIdentity } from "../../vendor/okolos/core-mail/sender";
import { parseAddressList } from "../../vendor/okolos/core-mail/parse";
import type { MailAddress, MailMessage } from "../../vendor/okolos/core-mail/types";
import { checkLookalike } from "../../vendor/okolos/core-lookalike/check";
import { DEFAULT_WATCHLIST } from "../../vendor/okolos/core-lookalike/watchlist";
import { authResults } from "../../shared/mail/spam";
import type { CheckSignal } from "../../shared/mail/safety";

/**
 * S03 §1 (B-269): the sender checks. Authentication counts only when the topmost `Authentication-Results` header is
 * the account's own receiver's: Cloudflare's MX, or Gmail's when the topmost `Received` line is Google's too. Anything
 * else (Outlook, IMAP, a header the sender could have written) did not run. A `DKIM-Signature` or `Received-SPF`
 * header alone never counts. The identity and reply-path checks are Okolos's, called once per address.
 */
export type Header = { key: string; value: string };
export type Outcome = { ran: true; signals: CheckSignal[] } | { ran: false; why: string };

const first = (headers: Header[], name: string) => headers.find((h) => h.key.toLowerCase() === name);
const ENFORCING = new Set(["reject", "quarantine"]);

/** Results that mean a mechanism failed (a published policy not met); `none` is no policy, not a failure. */
const FAILED = new Set(["fail", "softfail", "permerror"]);

/** Gmail's Authentication-Results, read as its clauses, its DMARC policy from the comment (`p=REJECT`). */
function gmailResults(value: string) {
  const lower = value.toLowerCase();
  const clauses = lower.split(";").slice(1).map((c) => c.trim());
  const result = (method: string) => clauses.map((c) => c.match(new RegExp(`^${method}=([a-z]+)([\\s\\S]*)$`))).filter((m): m is RegExpMatchArray => !!m);
  const dmarc = result("dmarc")[0];
  return {
    dkim: result("dkim").map((m) => m[1]!),
    dmarc: dmarc?.[1] ?? null,
    dmarcPolicy: dmarc?.[2]?.match(/\bp=([a-z]+)/)?.[1] ?? null,
    spf: result("spf")[0]?.[1] ?? null,
  };
}

export function senderAuth(headers: Header[], provider: string): Outcome {
  const top = first(headers, "authentication-results");
  let auth: { dkim: string[]; dmarc: string | null; dmarcPolicy: string | null; spf: string | null } | null = null;
  if (provider === "cloudflare") auth = authResults(headers);
  else if (provider === "gmail") {
    const received = first(headers, "received");
    if (top && /^\s*mx\.google\.com\s*;/i.test(top.value) && received && /\bby\s+mx\.google\.com\b/i.test(received.value)) auth = gmailResults(top.value);
  }
  if (!auth) return { ran: false, why: top ? "inboxSkipNotReceiver" : "mailSkipNoAuthResult" };
  const signals: CheckSignal[] = [];
  if (auth.dmarc && FAILED.has(auth.dmarc)) {
    const policy = auth.dmarcPolicy ?? "";
    signals.push({ check: "senderAuth", severity: ENFORCING.has(policy) ? "critical" : "major", code: ENFORCING.has(policy) ? "inboxDmarcFailEnforced" : "inboxDmarcFail",
      facts: policy ? [{ label: "inboxFactPolicy", value: policy }] : [] });
  }
  if (auth.spf && FAILED.has(auth.spf)) signals.push({ check: "senderAuth", severity: "major", code: "mailSenderSpfFail" });
  if (auth.dkim.some((d) => FAILED.has(d)) && !auth.dkim.includes("pass")) signals.push({ check: "senderAuth", severity: "major", code: "mailSenderDkimFail" });
  return { ran: true, signals };
}

/** A message as Okolos's sender checks read it: only its From and Reply-To. */
const asMessage = (from: MailAddress[], replyTo: MailAddress[] = []): MailMessage => ({
  headers: new Map(), subject: null, from, to: [], cc: [], replyTo, date: null, text: null, html: null, attachments: [], truncated: false,
});

export const addresses = (value: string | null | undefined): MailAddress[] => value?.trim() ? parseAddressList(value) : [];

/** Okolos's identity check once per From address (it reads `from[0]`): a lookalike domain, a brand on another domain. */
export function senderIdentity(from: MailAddress[], ownDomains: readonly string[] = []): Outcome {
  const watchlist = [...DEFAULT_WATCHLIST, ...ownDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)];
  const withDomain = from.filter((a) => a.domain);
  if (!withDomain.length) return { ran: false, why: "mailSkipNoSender" };
  const signals: CheckSignal[] = [];
  for (const a of withDomain) {
    const outcome = checkSenderIdentity(asMessage([a]), { lookalike: (host) => checkLookalike(host, watchlist), watchlist });
    if (outcome.ran) for (const s of outcome.signals) signals.push({ check: "senderIdentity", severity: s.severity, code: s.code, facts: s.facts.map((f) => ({ ...f })) });
  }
  return { ran: true, signals };
}

/** R6-7: a Reply-To fires only when its domain matches none of the From addresses (Okolos's check, pair by pair). */
export function replyPath(from: MailAddress[], replyTo: MailAddress[]): Outcome {
  const withDomain = from.filter((a) => a.domain);
  if (!withDomain.length) return { ran: false, why: "mailSkipNoSender" };
  const signals: CheckSignal[] = [];
  for (const r of replyTo.filter((a) => a.domain)) {
    const outcomes = withDomain.map((f) => checkReplyPath(asMessage([f], [r])));
    if (outcomes.every((o) => o.ran && o.signals.length)) {
      const s = (outcomes[0] as { signals: readonly { severity: string; code: string; facts: readonly { label: string; value: string }[] }[] }).signals[0]!;
      signals.push({ check: "replyPath", severity: s.severity as CheckSignal["severity"], code: s.code, facts: s.facts.map((f) => ({ ...f })) });
    }
  }
  return { ran: true, signals };
}
