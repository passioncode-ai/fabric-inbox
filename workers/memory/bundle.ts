/**
 * B-309 (owner, 2026-11-20, relayed by CEO Fabric: «формировать граф на основе Inbox сообщений»): mail as a share of
 * Memory's knowledge graph, in Fabric's `memory-bundle/1` lines (Fabric's spec 2026-11-20 memory-dashboard §10). Pure:
 * the route (workers/routes/memory.ts) reads the rows, the spam and safety verdicts and the Inbox projects, and this
 * module decides what enters and writes the lines. Nothing here reads storage or the network.
 *
 * What enters: a message in the inbox, a folder of the person's, Archive or Sent. What never does (`exclusionOf`):
 * Spam, Discarded, Trash and drafts; a message the spam check judged spam but did not move; a message the safety check
 * holds; automated bulk the reply agents' prefilter already names (Auto-Submitted, bulk or junk precedence, delivery
 * reports, auto-replies, no-reply senders); a conversation whose keep-until date has already passed (Memory's sleep
 * would archive it at once: B-311). Text is taken out of every secret before it is written (`redactSecrets`).
 *
 * Ids carry the `mail:` prefix only (Fabric refuses a source's line that writes `task:`, `project:` and the like):
 *   mail:m-<hash>         a message (doc), hashed from its Message-ID, else its row id
 *   mail:t-<hash>         a conversation (node `thread`)
 *   mail:person:<hash>    a person, hashed from the lower-cased address (node `person`)
 *   mail:org:<domain>     an organization by its mail domain, never a shared personal provider (node `org`)
 *   mail:project:<id>     an Inbox project the mailbox belongs to; mail:project:n-<hash> one a model named (node `project`)
 *   mail:topic:<label>    a support topic label; mail:topic:list-<hash> a mailing list; mail:topic:n-<hash> a model's (node `topic`)
 *   mail:decision:<hash>  a decision a model found, kept only with a quote found verbatim in the message (node `decision`)
 */
import { addressOf, isPersonalDomain, listIdOf } from "../../shared/mail/discard";
import { headerValue, prefilter, type SkipReason } from "../agents/prefilter";
import { redactSecrets, type RedactKind } from "./redact";

export const MEMORY_BUNDLE = "memory-bundle/1";
export const MEMORY_SOURCE = "fabric-inbox";
/** The contexts Fabric's reader takes (estateSources.ts CONTEXT); a server context outside it is not exported. */
export const MEMORY_CONTEXT = /^(personal|org:[A-Za-z0-9._-]{1,64})$/;
/** Fabric keeps at most this many characters of a document's body. */
export const DOC_BODY_MAX = 20_000;
/** B-311: a conversation is kept in Memory this many days after its last message (MEMORY_RETAIN_DAYS). */
export const RETAIN_DAYS_DEFAULT = 180;
export const RETAIN_DAYS_MAX = 3650;
/** Changed messages one page reads per mailbox. */
export const PAGE_DEFAULT = 200;
export const PAGE_MAX = 500;

/** One stored message as the bundle reads it (MailboxDO.memoryPage). */
export interface MemoryRow {
  id: string;
  seq: number;
  folder: string;
  subject: string;
  sender: string;
  senderName: string | null;
  recipient: string;
  cc: string;
  date: string;
  messageId: string | null;
  threadKey: string;
  /** The message's plain text (its search text, else its HTML made text). */
  text: string;
  headers: { key: string; value: string }[];
  /** B-238's support topic label of its conversation, when it has one. */
  topic: string | null;
  /** The newest message of its conversation that enters Memory (ISO), for the keep-until date. */
  threadLast: string | null;
  /** What a model found in it (B-309 model step), when it ran. */
  entities: MailEntities | null;
}

export interface MailEntities {
  projects: string[];
  topics: string[];
  decisions: { text: string; quote: string }[];
  model: string;
}

export interface MemoryProject { id: string; name: string; domains: string[]; addresses: string[] }

export type ExcludeReason = "spam" | "discarded" | "trash" | "draft" | "spam_verdict" | "held" | "automated" | "expired";
const FOLDER_EXCLUDED: Record<string, ExcludeReason> = { spam: "spam", discarded: "discarded", trash: "trash", draft: "draft" };
/** The prefilter's reasons that mark a message as automated bulk (a calendar invitation and a mailing list stay). */
const AUTOMATED: ReadonlySet<SkipReason> = new Set(["auto_submitted", "bulk", "delivery_report", "auto_reply", "no_reply_sender"]);

/**
 * Why a message stays out of Memory, or null when it enters. `verdict`: the spam check's verdict
 * (CategoriesDO.spamOf); `safety`: the safety check's state (CategoriesDO.safetyOf).
 */
export function exclusionOf(row: Pick<MemoryRow, "folder" | "sender" | "headers" | "subject">, mailbox: string,
  checks: { verdict?: string; safety?: string } = {}): ExcludeReason | null {
  const byFolder = FOLDER_EXCLUDED[row.folder];
  if (byFolder) return byFolder;
  if (checks.verdict === "spam" || checks.verdict === "spam_not_moved") return "spam_verdict";
  if (checks.safety === "held" || checks.safety === "kept") return "held";
  if (row.folder !== "sent") {
    // The prefilter stops at its first reason, and a list's headers come before a no-reply sender: read without them
    // too, so a newsletter from a no-reply address is automated while a discussion list stays.
    const ask = (headers: { key: string; value: string }[]) => prefilter({ mailboxId: mailbox, sender: row.sender, headers, answeredAfter: false, subject: row.subject });
    const reasons = [ask(row.headers), ask(row.headers.filter((h) => !/^list-(id|unsubscribe)$/i.test(h.key ?? "")))];
    if (reasons.some((r) => r && AUTOMATED.has(r))) return "automated";
  }
  return null;
}

/** MEMORY_RETAIN_DAYS as days, within 1 and RETAIN_DAYS_MAX; anything else the default. */
export function retainDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= RETAIN_DAYS_MAX ? n : RETAIN_DAYS_DEFAULT;
}

/** B-311: the date Memory's sleep archives a conversation: its last message plus `days`; null when it has no date. */
export function retainUntil(last: string | null, days: number): string | null {
  const at = Date.parse(last ?? "");
  return Number.isFinite(at) ? new Date(at + days * 86_400_000).toISOString() : null;
}

export async function sha(value: string, chars = 32): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, chars);
}

export const threadNode = async (threadKey: string) => `mail:t-${await sha(`thread:${threadKey}`)}`;
export const messageDoc = async (row: Pick<MemoryRow, "id" | "messageId">) => {
  const rfc = (row.messageId ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
  return `mail:m-${await sha(rfc ? `rfc:${rfc}` : `row:${row.id}`)}`;
};
export const personNode = async (address: string) => `mail:person:${await sha(`person:${address.trim().toLowerCase()}`)}`;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$/;

/** Addresses of a To or Cc header ("Ann <a@x.example>, b@y.example"). */
export function addressesOf(list: string | null | undefined): string[] {
  return [...new Set(String(list ?? "").split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => addressOf(p)).filter(Boolean))];
}

const iso = (value: string | null | undefined): string | null => {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const clean = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);
const plainSubject = (subject: string) => clean(subject.replace(/^((re|fwd?|aw|wg|sv|réf)\s*:\s*)+/i, ""), 400) || "(no subject)";

export interface BundleOptions {
  context: string;
  mailbox: string;
  now: number;
  retainDays: number;
  projects?: MemoryProject[];
  /** The spam check's and the safety check's word on each row, by row id. */
  checks?: Record<string, { verdict?: string; safety?: string }>;
}

export interface BundleCounts {
  read: number;
  kept: number;
  excluded: Partial<Record<ExcludeReason, number>>;
  redacted: { docs: number; finds: number; kinds: Partial<Record<RedactKind, number>> };
  entities: { people: number; orgs: number; projects: number; topics: number; decisions: number };
  lines: { docs: number; nodes: number; edges: number };
}

export type BundleLine = Record<string, unknown> & { bundle: string; source: string; context: string; kind: "doc" | "node" | "edge" };

export function emptyCounts(): BundleCounts {
  return { read: 0, kept: 0, excluded: {}, redacted: { docs: 0, finds: 0, kinds: {} },
    entities: { people: 0, orgs: 0, projects: 0, topics: 0, decisions: 0 }, lines: { docs: 0, nodes: 0, edges: 0 } };
}

/** Adds one page's counts to a running total. */
export function addCounts(into: BundleCounts, from: BundleCounts): BundleCounts {
  into.read += from.read; into.kept += from.kept;
  for (const [k, n] of Object.entries(from.excluded)) into.excluded[k as ExcludeReason] = (into.excluded[k as ExcludeReason] ?? 0) + (n ?? 0);
  into.redacted.docs += from.redacted.docs; into.redacted.finds += from.redacted.finds;
  for (const [k, n] of Object.entries(from.redacted.kinds)) into.redacted.kinds[k as RedactKind] = (into.redacted.kinds[k as RedactKind] ?? 0) + (n ?? 0);
  for (const k of Object.keys(into.entities) as (keyof BundleCounts["entities"])[]) into.entities[k] += from.entities[k];
  for (const k of Object.keys(into.lines) as (keyof BundleCounts["lines"])[]) into.lines[k] += from.lines[k];
  return into;
}

/** The lines of one mailbox's page, and what each stage did (counts only, never text or addresses). */
export async function buildBundle(rows: MemoryRow[], options: BundleOptions): Promise<{ lines: BundleLine[]; counts: BundleCounts }> {
  const counts = emptyCounts();
  counts.read = rows.length;
  const mailbox = options.mailbox.trim().toLowerCase();
  const base = { bundle: MEMORY_BUNDLE, source: MEMORY_SOURCE, context: options.context };
  const docs: BundleLine[] = [];
  const nodes = new Map<string, BundleLine>();
  const edges = new Map<string, BundleLine>();
  const seen = { people: new Set<string>(), orgs: new Set<string>(), projects: new Set<string>(), topics: new Set<string>(), decisions: new Set<string>() };
  const node = (id: string, kind: string, label: string, at: string | null, extra: Record<string, unknown> = {}) => {
    if (!nodes.has(id)) nodes.set(id, { ...base, kind: "node", id, node_kind: kind, label: clean(label, 400) || id, at, ...extra });
  };
  const edge = (src: string, rel: string, dst: string, at: string | null, evidence: string) => {
    const key = `${src} ${rel} ${dst}`;
    if (!edges.has(key)) edges.set(key, { ...base, kind: "edge", src, rel, dst, at, evidence: clean(evidence, 300) });
  };
  const mailboxDomain = mailbox.slice(mailbox.lastIndexOf("@") + 1);
  const projects = (options.projects ?? []).filter((p) => p.addresses.includes(mailbox)
    || p.domains.some((d) => mailboxDomain === d || mailboxDomain.endsWith("." + d)));

  for (const row of rows) {
    const excluded = exclusionOf(row, mailbox, options.checks?.[row.id]);
    const keepUntil = retainUntil(row.threadLast ?? row.date, options.retainDays);
    const reason = excluded ?? (keepUntil && Date.parse(keepUntil) <= options.now ? "expired" : null);
    if (reason) { counts.excluded[reason] = (counts.excluded[reason] ?? 0) + 1; continue; }
    counts.kept++;
    const at = iso(row.date);
    const thread = await threadNode(row.threadKey);
    const doc = await messageDoc(row);
    const subject = plainSubject(row.subject);
    const redacted = redactSecrets(row.text);
    const title = redactSecrets(subject).text;
    if (redacted.count) {
      counts.redacted.docs++; counts.redacted.finds += redacted.count;
      for (const [k, n] of Object.entries(redacted.kinds)) counts.redacted.kinds[k as RedactKind] = (counts.redacted.kinds[k as RedactKind] ?? 0) + (n ?? 0);
    }
    docs.push({ ...base, kind: "doc", id: doc, node: thread, doc_kind: "message", title, body: redacted.text.slice(0, DOC_BODY_MAX), at });
    node(thread, "thread", title, iso(row.threadLast) ?? at, { retain_until: keepUntil });

    // People and their organizations, from the From, To and Cc headers; the mailbox's own address is not a person here.
    const from = addressOf(row.sender);
    const parties: { address: string; rel: "sent" | "received"; header: string; name?: string | null }[] = [];
    if (from) parties.push({ address: from, rel: "sent", header: "From", name: row.senderName });
    for (const a of addressesOf(row.recipient)) parties.push({ address: a, rel: "received", header: "To" });
    for (const a of addressesOf(row.cc)) parties.push({ address: a, rel: "received", header: "Cc" });
    for (const p of parties) {
      if (p.address === mailbox) continue;
      const person = await personNode(p.address);
      if (!seen.people.has(person)) { seen.people.add(person); counts.entities.people++; }
      node(person, "person", p.name?.trim() || p.address, at);
      edge(person, p.rel, doc, at, `${p.header} header of the message`);
      edge(person, "takes-part-in", thread, at, `${p.header} header of a message in the conversation`);
      const domain = p.address.slice(p.address.lastIndexOf("@") + 1);
      if (!DOMAIN.test(domain) || isPersonalDomain(domain)) continue;
      const org = `mail:org:${domain}`;
      if (!seen.orgs.has(org)) { seen.orgs.add(org); counts.entities.orgs++; }
      node(org, "org", domain, at);
      edge(person, "works-at", org, at, "the domain of the person's address");
      edge(org, "takes-part-in", thread, at, `an address of this domain in the ${p.header} header`);
    }

    // Projects: the Inbox projects the mailbox belongs to.
    for (const p of projects) {
      const id = `mail:project:${p.id}`;
      if (!seen.projects.has(id)) { seen.projects.add(id); counts.entities.projects++; }
      node(id, "project", p.name, at);
      edge(thread, "relates-to", id, at, "the conversation's mailbox is in this Inbox project");
    }

    // Topics: the mailing list (List-Id) and the support topic label of the conversation.
    const list = listIdOf(headerValue(row.headers, "list-id"));
    if (list) {
      const id = `mail:topic:list-${await sha(`list:${list.id}`, 24)}`;
      if (!seen.topics.has(id)) { seen.topics.add(id); counts.entities.topics++; }
      node(id, "topic", list.name || list.id, at);
      edge(id, "discussed-in", thread, at, "the List-Id header of a message in the conversation");
    }
    if (row.topic && /^[a-z_]{2,40}$/.test(row.topic)) {
      const id = `mail:topic:${row.topic.replace(/_/g, "-")}`;
      if (!seen.topics.has(id)) { seen.topics.add(id); counts.entities.topics++; }
      node(id, "topic", row.topic.replace(/_/g, " "), at);
      edge(id, "discussed-in", thread, at, "the conversation's support topic label");
    }

    // What a model found (off unless MEMORY_MODEL names one): projects, topics, decisions with a verbatim quote.
    const found = row.entities;
    if (found) {
      for (const name of found.projects) {
        const id = `mail:project:n-${await sha(`project:${name.toLowerCase()}`, 24)}`;
        if (!seen.projects.has(id)) { seen.projects.add(id); counts.entities.projects++; }
        node(id, "project", name, at);
        edge(id, "mentioned-in", doc, at, `named by ${found.model}`);
        edge(thread, "relates-to", id, at, `named by ${found.model} in a message of the conversation`);
      }
      for (const name of found.topics) {
        const id = `mail:topic:n-${await sha(`topic:${name.toLowerCase()}`, 24)}`;
        if (!seen.topics.has(id)) { seen.topics.add(id); counts.entities.topics++; }
        node(id, "topic", name, at);
        edge(id, "discussed-in", thread, at, `named by ${found.model}`);
      }
      for (const d of found.decisions) {
        const quote = redactSecrets(d.quote).text;
        if (!quote || !redacted.text.includes(quote)) continue;
        const id = `mail:decision:${await sha(`decision:${row.threadKey}:${d.text.toLowerCase()}`, 24)}`;
        if (!seen.decisions.has(id)) { seen.decisions.add(id); counts.entities.decisions++; }
        node(id, "decision", redactSecrets(d.text).text, at);
        edge(id, "decided-in", doc, at, quote);
        edge(id, "discussed-in", thread, at, `found by ${found.model}`);
      }
    }
  }
  const lines = [...docs, ...nodes.values(), ...edges.values()];
  counts.lines = { docs: docs.length, nodes: nodes.size, edges: edges.size };
  return { lines, counts };
}

/** The route's cursor: the last change sequence read per mailbox, as base64url JSON. */
export type MemoryCursor = Record<string, number>;
export function encodeCursor(cursor: MemoryCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, m: cursor }));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** A cursor this route gave, or null when it is none (a missing cursor is `{}`: everything from the start). */
export function decodeCursor(raw: string | null | undefined): MemoryCursor | null {
  if (!raw) return {};
  if (raw.length > 64_000 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    const value = JSON.parse(text) as { v?: unknown; m?: unknown };
    if (value.v !== 1 || !value.m || typeof value.m !== "object" || Array.isArray(value.m)) return null;
    const out: MemoryCursor = {};
    for (const [k, n] of Object.entries(value.m as Record<string, unknown>)) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || k.length > 320) return null;
      out[k.toLowerCase()] = n;
    }
    return out;
  } catch { return null; }
}
