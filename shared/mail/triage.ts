import { msg } from "../i18n";
/**
 * Deterministic triage of one message (REQ-T1): which group it belongs to and
 * whether it deserves attention now. Header and label rules only — no model,
 * no network — so the same message always lands in the same place and every
 * placement names its reasons. Shared by the Worker and the client.
 */
export type TriageGroup =
  | "people"
  | "internal"
  | "security"
  | "alerts"
  | "stores"
  | "billing"
  | "dev"
  | "newsletters"
  | "social"
  | "notifications";
export type Importance = "important" | "normal" | "low";

export interface TriageSignals {
  listId?: boolean;
  /** The List-Id header itself (a discard rule is keyed on it); absent on mail cached before 0.12. */
  list?: string;
  listUnsubscribe?: boolean;
  precedence?: string;
  autoSubmitted?: string;
}
export interface TriageInput {
  sender: string;
  subject: string;
  read: boolean;
  starred: boolean;
  /** Gmail label ids, e.g. CATEGORY_PROMOTIONS, IMPORTANT. */
  labels?: string[];
  signals?: TriageSignals;
  /** Domains this workspace serves: mail from them is its own, never "a person's unread mail". */
  ownDomains?: string[];
}
export interface Triage {
  group: TriageGroup;
  importance: Importance;
  reasons: string[];
}

export const TRIAGE_GROUPS: { id: TriageGroup; label: string }[] = [
  { id: "people", label: msg("People") },
  { id: "internal", label: msg("Your addresses") },
  { id: "security", label: msg("Security") },
  { id: "alerts", label: msg("Alerts") },
  { id: "stores", label: msg("App stores") },
  { id: "billing", label: msg("Billing") },
  { id: "dev", label: msg("Dev & CI") },
  { id: "notifications", label: msg("Notifications") },
  { id: "social", label: msg("Social") },
  { id: "newsletters", label: msg("Newsletters") },
];

const address = (sender: string) => (sender.match(/<([^<>]+)>/)?.[1] ?? sender).trim().toLowerCase();
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const fromDomain = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith("." + d));

// Cyrillic has no \b in JS regexes: (?<![а-яё]) … (?![а-яё]) bound a Russian word instead.
const SECURITY = /\b(security alert|new sign[- ]?in|sign[- ]?in attempt|new login|login attempt|verification code|verify your (email|account|identity)|password (reset|changed)|two[- ]factor|2fa|suspicious|unusual activity|one[- ]time (code|password))\b|код (подтверждения|для входа)|вход в (аккаунт|учётную запись|учетную запись)|новый вход|пароль (изменён|изменен|сброшен)|подозрительн/i;
const BOUNCE_LOCAL = /^(mailer-daemon|postmaster)$/;
const BOUNCE_SUBJECT = /\b(undeliverable|undelivered mail|delivery status notification|delivery (has )?failed|returned mail|mail delivery (failed|subsystem))\b|не доставлено|недоставленн|ошибка доставки/i;
const RSVP = /^(accepted|declined|tentative|tentatively accepted)( \(.*?\))?:|^(принято|отклонено|под вопросом):/i;
const INVITATION = /^(invitation|updated invitation|new event|canceled event|cancelled event)( \(.*?\))?:|^(приглашение|обновлённое приглашение|обновленное приглашение):/i;
// Google Calendar's own senders: these local parts at google.com (a shared domain, so never the domain alone).
const CALENDAR_DOMAIN = "google.com";
const CALENDAR_LOCALS = ["calendar-notification", "calendar-server"];
const ALERT_SENDERS = ["sentry.io", "getsentry.com", "pagerduty.com", "opsgenie.com", "statuspage.io", "uptimerobot.com", "betteruptime.com", "betterstack.com", "healthchecks.io", "datadoghq.com", "grafana.net"];
const ALERT_WORDS = /\b(down|outage|incident|critical|alert|failed|failing|error rate|exceeded|triggered)\b|(?<![а-яё])(сбой|авари[яи]|недоступ[а-яё]*|упал[а-яё]*|инцидент)(?![а-яё])/i;
// Store mail comes from these domains, or from these exact addresses on shared domains (google.com).
const STORE_SENDERS = ["email.apple.com", "apple.com", "itunes.com", "play.google.com", "meta.com", "oculus.com"];
const STORE_ADDRESSES = ["googleplay-noreply@google.com", "noreply-play-console@google.com", "google-play-noreply@google.com"];
const STORE_WORDS = /\b(app store connect|testflight|google play( console)?|play console|app review|horizon store|meta quest store)\b/i;
const STORE_ACTION = /\b(rejected|rejection|action required|needs your attention|policy (violation|issue)|suspended|removed|terminated|guideline)\b|(?<![а-яё])(отклонен[а-яё]*|требуется действие|нарушени[а-яё]*|заблокирован[а-яё]*)(?![а-яё])/i;
const BILLING_SENDERS = ["stripe.com", "paddle.com", "paypal.com", "lemonsqueezy.com", "chargebee.com", "wise.com", "revolut.com"];
const BILLING_WORDS = /\b(invoice|receipt|payment|paid|subscription|renewal|billing|refund|charge|order confirmation|your order)\b|(?<![а-яё])(сч[её]т(а|у|ом|е)?|оплат[а-яё]*|чек(а|и)?|платёж[а-яё]*|платеж[а-яё]*|подписк[а-яё]*|квитанци[а-яё]*)(?![а-яё])/i;
const BILLING_PROBLEM = /\b(payment (failed|declined)|card (declined|expir\w*)|past due|overdue|unpaid|failed to charge|update your payment)\b|(?<![а-яё])(плат[её]ж не прош[её]л|не удалось (списать|оплатить)|отклон[её]н[а-яё]*|задолженност[а-яё]*|просроч[а-яё]*)(?![а-яё])/i;
const DEV_SENDERS = ["github.com", "gitlab.com", "bitbucket.org", "vercel.com", "netlify.com", "circleci.com", "travis-ci.com", "linear.app", "atlassian.net", "atlassian.com", "npmjs.com", "docker.com", "heroku.com", "render.com", "railway.app", "cloudflare.com", "digitalocean.com", "fly.io", "supabase.io", "supabase.com", "expo.dev", "codemagic.io"];
const SOCIAL_SENDERS = ["linkedin.com", "facebookmail.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "telegram.org", "discord.com", "reddit.com", "youtube.com", "medium.com", "producthunt.com"];
// Senders that take no replies. Role addresses a person may write from (support@, info@,
// hello@, team@) are not on this list: they count as automated only with a bulk or auto header.
const NO_REPLY = /^(no[-_.]?reply\d*|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer|news(letter)?|updates?|marketing|automated|system|bounce[s]?)([+._-].*)?$/;

export function triage(input: TriageInput): Triage {
  const email = address(input.sender);
  const local = email.slice(0, email.lastIndexOf("@"));
  const domain = domainOf(email);
  const labels = new Set(input.labels ?? []);
  const s = input.signals ?? {};
  const subject = input.subject || "";
  const reasons: string[] = [];
  const bulk = !!s.listId || !!s.listUnsubscribe || ["bulk", "list", "junk"].includes((s.precedence ?? "").toLowerCase());
  const automated = bulk || (!!s.autoSubmitted && s.autoSubmitted.toLowerCase() !== "no") || NO_REPLY.test(local) || local.includes("noreply");
  const own = fromDomain(domain, (input.ownDomains ?? []).map((d) => d.toLowerCase()));

  let group: TriageGroup;
  let importance: Importance = "normal";
  if (own && !BOUNCE_LOCAL.test(local)) {
    // Our own addresses: tests, forwards, a colleague on the same domain (even through a
    // group with List-Id). Visible, never raised as someone else's unread mail.
    group = "internal";
    reasons.push(msg("From one of your addresses"));
  } else if (BOUNCE_LOCAL.test(local) || (automated && BOUNCE_SUBJECT.test(subject))) {
    group = "alerts";
    reasons.push(msg("Delivery failure: a message you sent did not arrive"));
    importance = input.read ? "normal" : "important";
  } else if ((domain === CALENDAR_DOMAIN && CALENDAR_LOCALS.includes(local)) || RSVP.test(subject.trim()) || INVITATION.test(subject.trim())) {
    group = "notifications";
    reasons.push(RSVP.test(subject.trim()) ? msg("Calendar reply") : msg("Calendar invitation"));
    importance = RSVP.test(subject.trim()) ? "low" : "normal";
  } else if (SECURITY.test(subject)) {
    group = "security";
    reasons.push(msg("Security or sign-in message"));
    importance = input.read ? "normal" : "important";
  } else if (fromDomain(domain, ALERT_SENDERS) || (automated && ALERT_WORDS.test(subject) && /\b(alert|monitor|status|uptime|incident)\b/i.test(email + " " + subject))) {
    group = "alerts";
    reasons.push(msg("Monitoring alert"));
    importance = ALERT_WORDS.test(subject) && !input.read ? "important" : "normal";
  } else if (STORE_ADDRESSES.includes(email) || (STORE_WORDS.test(subject) && (fromDomain(domain, STORE_SENDERS) || automated))) {
    group = "stores";
    reasons.push(msg("App store message"));
    if (STORE_ACTION.test(subject)) { importance = "important"; reasons.push(msg("Needs action")); }
  } else if (fromDomain(domain, BILLING_SENDERS) || (automated && BILLING_WORDS.test(subject))) {
    group = "billing";
    reasons.push(msg("Billing or receipt"));
    if (BILLING_PROBLEM.test(subject)) { importance = "important"; reasons.push(msg("Payment problem")); }
    else importance = "low";
  } else if (fromDomain(domain, DEV_SENDERS) || /^\[[\w.-]+\/[\w.-]+\]/.test(subject)) {
    group = "dev";
    reasons.push(msg("Developer tool notification"));
    importance = /\b(failed|failing|broken|build error|deploy(ment)? failed|security advisory|vulnerab)/i.test(subject) && !input.read ? "important" : "low";
    if (importance === "important") reasons.push(msg("Failure or advisory"));
  } else if (labels.has("CATEGORY_SOCIAL") || fromDomain(domain, SOCIAL_SENDERS)) {
    group = "social";
    reasons.push(msg("Social network"));
    importance = "low";
  } else if (bulk || labels.has("CATEGORY_PROMOTIONS") || labels.has("CATEGORY_FORUMS")) {
    group = "newsletters";
    reasons.push(bulk ? msg("Mailing list") : msg("Promotions or forums"));
    importance = "low";
  } else if (automated || labels.has("CATEGORY_UPDATES")) {
    group = "notifications";
    reasons.push(msg("Automated sender"));
    importance = "low";
  } else {
    group = "people";
    reasons.push(msg("Written by a person"));
    importance = input.read ? "normal" : "important";
    if (!input.read) reasons.push(msg("Unread"));
  }
  if (labels.has("IMPORTANT") && group === "people" && importance !== "important") {
    importance = "important";
    reasons.push(msg("Marked important by Gmail"));
  }
  if (input.starred) {
    importance = "important";
    reasons.push(msg("Starred"));
  }
  return { group, importance, reasons };
}

/** Compact signals from raw header pairs; the raw headers never leave the server. */
export function signalsFromHeaders(headers: { key: string; value: string }[]): TriageSignals {
  const get = (name: string) => headers.find((h) => h.key?.toLowerCase() === name)?.value;
  const signals: TriageSignals = {};
  const listId = get("list-id");
  if (listId) { signals.listId = true; signals.list = listId.trim().slice(0, 300); }
  if (get("list-unsubscribe")) signals.listUnsubscribe = true;
  const precedence = get("precedence");
  if (precedence) signals.precedence = precedence.trim().toLowerCase().slice(0, 20);
  const auto = get("auto-submitted");
  if (auto) signals.autoSubmitted = auto.trim().toLowerCase().slice(0, 40);
  return signals;
}
