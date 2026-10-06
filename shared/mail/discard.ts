/**
 * Discarded (operator decision 2026-10-06): mail thrown away on purpose, kept apart from Trash and
 * Spam so a mistake can be undone, and learned from. Pure: the Worker and the app both read it.
 *
 * Each discard records why — the strongest stable signal of the message: its mailing list
 * (List-Id; List-Unsubscribe marks a newsletter), its sender's address, the sender's domain only for
 * bulk senders (never a shared personal domain such as gmail.com), the category it was in, and
 * optionally a model's one-line reason — and keeps a rule keyed on the List-Id, else the sender's
 * address. One discard is enough (operator: "сразу же"); the app tells the person once, after the
 * first, with a way to say Don't.
 *
 * On arrival, mail that matches a rule goes straight to Discarded, unless the person has written to
 * the sender, took part in the conversation, the sender is on the workspace's own domains, or the
 * sender is on the Always allow list (or a Never spam list).
 */

export interface DiscardWhy {
  /** The mailing list, by its List-Id (the id lower-cased, and the list's own name when it gives one). */
  list?: { id: string; name?: string };
  /** It carried List-Unsubscribe or List-Id: a newsletter or other bulk mail. */
  newsletter: boolean;
  /** The sender's address, lower-cased. */
  sender: string;
  /** The sender's domain, recorded only for a bulk sender and never for a shared personal domain. */
  domain?: string;
  /** The category the message was in when it was discarded. */
  category?: string;
  /** A model's one-line reason, when the server has a model and it answered. */
  model?: string;
}

export interface DiscardRule {
  /** `l-<hash>` for a list, `s-<hash>` for a sender: the same signal is always the same rule. */
  id: string;
  kind: "list" | "sender";
  /** The List-Id or the address, lower-cased. */
  value: string;
  /** How a person knows it: the list's name, else its id or the address. */
  label: string;
  /** Why it was learned: the first discard's facts. */
  why: DiscardWhy;
  /** Messages the person discarded that match it. */
  discards: number;
  /** Messages it sent to Discarded on arrival. */
  applied: number;
  createdAt: number;
  lastDiscardAt: number;
  lastAppliedAt?: number;
}

export interface DiscardStore {
  rules: DiscardRule[];
  /** Senders (addresses) and domains whose mail is never discarded on arrival. */
  allowed: string[];
}

/** What a message says about itself, for learning and for matching. */
export interface DiscardFacts extends DiscardWhy {}

/** Discarded mail is deleted after this many days (like Spam). */
export const DISCARD_RETENTION_DAYS = 30;
export const DISCARD_RETENTION_MS = DISCARD_RETENTION_DAYS * 86_400_000;
export const DISCARD_RULE_LIMIT = 2000;
export const DISCARD_ALLOWED_LIMIT = 2000;
export const EMPTY_DISCARD_STORE: DiscardStore = Object.freeze({ rules: [], allowed: [] }) as unknown as DiscardStore;

const ADDRESS = /^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const LIST_ID = /^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]{1,250}$/;
const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply[-_.].*|.*[-_.]noreply|mailer|newsletter|news|notifications?|bounce[s]?)$/;

/**
 * Domains people get a personal address on: a rule or a reason never names one, since a domain
 * there says nothing about who sent the mail. Exact domains, not their subdomains (a provider's own
 * service, such as mail.google.com, is not a person's address).
 */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "fastmail.com", "zoho.com",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.ru", "inbox.ru", "list.ru", "bk.ru", "yandex.ru", "yandex.com", "ya.ru", "tutanota.com",
  "tuta.io", "hey.com", "qq.com", "163.com", "126.com", "naver.com", "seznam.cz", "wp.pl", "o2.pl", "interia.pl", "onet.pl",
]);
export function isPersonalDomain(domain: string): boolean {
  return PERSONAL_DOMAINS.has(domain.trim().toLowerCase());
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const under = (domain: string, list: readonly string[]) => list.some((d) => domain === d || domain.endsWith("." + d));
/** The address in "Name <address>" or a bare address, lower-cased; "" when it is none. */
export function addressOf(value: string): string {
  const address = (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
  return ADDRESS.test(address) ? address : "";
}

/** A List-Id header value (RFC 2919: an optional phrase, then the id in angle brackets). */
export function listIdOf(value: string | undefined | null): { id: string; name?: string } | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const bracket = raw.match(/^(.*?)<([^<>]+)>\s*$/);
  const id = (bracket ? bracket[2] : raw).trim().toLowerCase();
  if (!LIST_ID.test(id) || !id.includes(".")) return null;
  const name = bracket?.[1].trim().replace(/^"(.*)"$/, "$1").trim().slice(0, 120);
  return name ? { id, name } : { id };
}

/** A message's facts for learning and matching, from its sender, its headers and the category it was in. */
export function discardFacts(input: { sender: string; headers: { key: string; value: string }[]; category?: string; model?: string }): DiscardFacts {
  const header = (name: string) => input.headers.find((h) => h.key?.toLowerCase() === name)?.value;
  const sender = addressOf(input.sender);
  const list = listIdOf(header("list-id"));
  const newsletter = !!list || !!header("list-unsubscribe");
  const precedence = (header("precedence") ?? "").trim().toLowerCase();
  const local = sender.slice(0, sender.lastIndexOf("@"));
  const bulk = newsletter || ["bulk", "list", "junk"].includes(precedence) || NO_REPLY.test(local);
  const domain = sender ? domainOf(sender) : "";
  return {
    ...(list ? { list } : {}), newsletter, sender,
    ...(bulk && domain && !isPersonalDomain(domain) ? { domain } : {}),
    ...(input.category ? { category: input.category.slice(0, 120) } : {}),
    ...(input.model ? { model: input.model.slice(0, 200) } : {}),
  };
}

/** The rule a message's facts are kept under: its List-Id, else its sender's address. */
export function ruleFor(facts: DiscardFacts): { kind: DiscardRule["kind"]; value: string; label: string } | null {
  if (facts.list) return { kind: "list", value: facts.list.id, label: facts.list.name || facts.list.id };
  if (facts.sender) return { kind: "sender", value: facts.sender, label: facts.sender };
  return null;
}

/** FNV-1a, 32 bits: a short stable id for a rule's signal. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const ruleId = (kind: DiscardRule["kind"], value: string) => (kind === "list" ? "l-" : "s-") + hash(kind + ":" + value);
/** The id of the rule these facts are kept under, or null when they name no list and no sender. */
export function ruleIdOf(facts: DiscardFacts): string | null {
  const key = ruleFor(facts);
  return key ? ruleId(key.kind, key.value) : null;
}

/** The person's own entry, or the list's: an Always allow entry or a Never spam one. */
function allowed(facts: DiscardFacts, store: DiscardStore, spam?: { allowedSenders: string[]; allowedDomains: string[] }): boolean {
  if (!facts.sender) return false;
  const domain = domainOf(facts.sender);
  const entries = store.allowed;
  if (entries.includes(facts.sender) || under(domain, entries.filter((e) => !e.includes("@")))) return true;
  return !!spam && (spam.allowedSenders.includes(facts.sender) || under(domain, spam.allowedDomains));
}

export interface LearnOptions {
  /** A mailbox of the workspace has written to this sender. */
  known?: boolean;
  /** Domains the workspace serves: its own mail is never learned from. */
  ownDomains?: string[];
}
export interface Learned {
  store: DiscardStore;
  rule?: DiscardRule;
  /** The first discard of this signal: the app tells the person once, with Don't. */
  created: boolean;
  /** Why nothing was learned, in a sentence. */
  skipped?: string;
}

/**
 * Records one discard: the rule for its signal is created (the first time) or counted. A sender
 * the person wrote to, one on the workspace's own domains, or one on the Always allow list is not
 * learned — such a rule would never apply — unless the mail came through a mailing list, which is
 * not the person.
 */
export function learnDiscard(store: DiscardStore, facts: DiscardFacts, now: number, options: LearnOptions = {}): Learned {
  const key = ruleFor(facts);
  if (!key) return { store, created: false, skipped: "The message names no sender or list to learn from" };
  if (key.kind === "sender") {
    if (options.known) return { store, created: false, skipped: "You have written to this sender, so their mail is never discarded on its own" };
    if (under(domainOf(facts.sender), options.ownDomains ?? [])) return { store, created: false, skipped: "It is from your own domain, whose mail is never discarded on its own" };
  }
  if (allowed(facts, store)) return { store, created: false, skipped: "The sender is on the Always allow list" };
  const id = ruleId(key.kind, key.value);
  const old = store.rules.find((r) => r.id === id);
  const rule: DiscardRule = old
    ? { ...old, discards: old.discards + 1, lastDiscardAt: now }
    : { id, kind: key.kind, value: key.value, label: key.label, why: { ...facts }, discards: 1, applied: 0, createdAt: now, lastDiscardAt: now };
  const rules = [rule, ...store.rules.filter((r) => r.id !== id)];
  return { store: normaliseDiscardStore({ ...store, rules }), rule, created: !old };
}

/**
 * Undo of a discard that taught `id` (the rule learnDiscard counted it on): its count goes down, and
 * a rule that discard made goes. A discard that taught nothing names no rule, so it forgets nothing.
 */
export function forgetDiscard(store: DiscardStore, id: string): DiscardStore {
  const old = store.rules.find((r) => r.id === id);
  if (!old) return store;
  const rules = old.discards <= 1 ? store.rules.filter((r) => r.id !== id) : store.rules.map((r) => (r.id === id ? { ...r, discards: r.discards - 1 } : r));
  return { ...store, rules };
}

/** The rule an arriving message matches (its list first, then its sender), or null; allowed senders never match. */
export function matchDiscard(store: DiscardStore, facts: DiscardFacts, spamAllowed?: { allowedSenders: string[]; allowedDomains: string[] }): DiscardRule | null {
  if (allowed(facts, store, spamAllowed)) return null;
  if (facts.list) {
    const byList = store.rules.find((r) => r.kind === "list" && r.value === facts.list!.id);
    if (byList) return byList;
  }
  return facts.sender ? store.rules.find((r) => r.kind === "sender" && r.value === facts.sender) ?? null : null;
}

/** Why mail that matches a rule must still reach the inbox, or null when nothing stops it. */
export function discardSafety(input: { sender: string; known: boolean; inThread: boolean; ownDomains: string[] }): string | null {
  const sender = addressOf(input.sender);
  if (sender && under(domainOf(sender), input.ownDomains)) return "It is from one of your own domains";
  if (input.known) return "You have written to this sender";
  if (input.inThread) return "It is in a conversation you took part in";
  return null;
}

/** How a rule is named to a person: the list's name, else the address. */
export function ruleSubject(rule: Pick<DiscardRule, "label" | "value">): string {
  return rule.label || rule.value;
}

/** The reason mail discarded on arrival carries. */
export function autoReason(rule: Pick<DiscardRule, "kind" | "label" | "value" | "discards">): string {
  const n = `${rule.discards} message${rule.discards === 1 ? "" : "s"}`;
  return rule.kind === "list"
    ? `Discarded automatically: you discarded ${n} from this newsletter (${ruleSubject(rule)})`
    : `Discarded automatically: you discarded ${n} from ${ruleSubject(rule)}`;
}

/** A rule applied to one more arriving message. */
export function recordApplied(store: DiscardStore, id: string, now: number): DiscardStore {
  if (!store.rules.some((r) => r.id === id)) return store;
  return { ...store, rules: store.rules.map((r) => (r.id === id ? { ...r, applied: r.applied + 1, lastAppliedAt: now } : r)) };
}

/** An Always allow entry from what a person typed: an address or a domain, or null. */
export function allowEntry(value: string): string | null {
  const address = addressOf(value);
  if (address) return address;
  const domain = value.trim().toLowerCase().replace(/^@/, "");
  return DOMAIN.test(domain) ? domain : null;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** The stored file, cleaned: unknown shapes dropped, at most DISCARD_RULE_LIMIT rules (the most recently used kept). */
export function normaliseDiscardStore(value: unknown): DiscardStore {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const rules: DiscardRule[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(v.rules) ? v.rules : []) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = r.kind === "list" || r.kind === "sender" ? r.kind : null;
    const value = str(r.value, 320)?.toLowerCase();
    if (!kind || !value || (kind === "sender" ? !ADDRESS.test(value) : !LIST_ID.test(value))) continue;
    const id = ruleId(kind, value);
    if (seen.has(id)) continue;
    seen.add(id);
    const w = (r.why && typeof r.why === "object" ? r.why : {}) as Record<string, unknown>;
    const list = w.list && typeof w.list === "object" ? listIdOf(`${str((w.list as Record<string, unknown>).name, 120) ?? ""} <${str((w.list as Record<string, unknown>).id, 250) ?? ""}>`) : null;
    const why: DiscardWhy = { newsletter: w.newsletter === true, sender: addressOf(str(w.sender, 320) ?? ""),
      ...(list ? { list } : {}), ...(str(w.domain, 253) && DOMAIN.test(String(w.domain)) && !isPersonalDomain(String(w.domain)) ? { domain: String(w.domain) } : {}),
      ...(str(w.category, 120) ? { category: str(w.category, 120) } : {}), ...(str(w.model, 200) ? { model: str(w.model, 200) } : {}) };
    rules.push({ id, kind, value, label: str(r.label, 200) || value, why, discards: Math.max(1, num(r.discards)), applied: num(r.applied),
      createdAt: num(r.createdAt), lastDiscardAt: num(r.lastDiscardAt), ...(num(r.lastAppliedAt) ? { lastAppliedAt: num(r.lastAppliedAt) } : {}) });
  }
  rules.sort((a, b) => Math.max(b.lastDiscardAt, b.lastAppliedAt ?? 0) - Math.max(a.lastDiscardAt, a.lastAppliedAt ?? 0));
  const allowedEntries = [...new Set((Array.isArray(v.allowed) ? v.allowed : []).map((x) => (typeof x === "string" ? allowEntry(x) : null)).filter((x): x is string => !!x))];
  return { rules: rules.slice(0, DISCARD_RULE_LIMIT), allowed: allowedEntries.slice(0, DISCARD_ALLOWED_LIMIT) };
}
