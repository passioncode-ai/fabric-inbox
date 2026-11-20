/**
 * B-308: what on this server waits on a person, as `notice/1` records (docs/agents/notice.schema.json). Fabric reads
 * them (GET /api/notices, the `list_notices` tool) and shows them on its home screen under «Нужны вы»; it ranks and
 * draws them and interprets nothing, so every word is written here, in the reader's language.
 *
 * Pure: the sources come in as plain values (the route reads them), and the module builds the facts, keeps them
 * against what was served before (`mergeNotices`: when each changed, and a `resolved` record once a condition clears,
 * kept for 7 days), and renders them. A record never carries a secret, a token or any text of anyone's mail: no
 * subject, no sender, no body. A mailbox is named only by the address the app already shows its owner (a Cloudflare
 * address of this server, a connected account's address); everything else is a count.
 */
import type { T } from "../../shared/i18n";
import { ticketOutcomeOf } from "../agents/ticket-outcome";
import type { AgentRun } from "../agents/run";

export const NOTICE_VERSION = 1 as const;
/** Resolved records stay in the feed this long, then leave it. */
export const RESOLVED_KEPT_MS = 7 * 86_400_000;
/** A reply that could not be sent is a notice this long after its message came. */
export const SEND_FAILED_WINDOW_MS = 7 * 86_400_000;
/** A mail account that failed this many syncs in a row is an error, not a warning. */
export const NETWORK_ERROR_AFTER = 5;
/** Who Inbox's own notices are from. */
export const INBOX_NAME = "Inbox";

export type NoticeLevel = "critical" | "error" | "warn" | "info";
export type NoticeKind = "question" | "approval" | "failure" | "network" | "notice";
export interface NoticeFrom { kind: "system" | "agent" | "service" | "person"; name: string; project?: string; session?: string }
export interface NoticeAction { id: string; label: string; effect: "answer" | "open" | "dismiss" }

/** One notice as Fabric reads it (`notice/1`). */
export interface Notice {
  v: typeof NOTICE_VERSION;
  id: string;
  dedupKey: string;
  /** When this record last changed: it appeared, its content changed, or it was resolved. */
  at: string;
  from: NoticeFrom;
  level: NoticeLevel;
  kind: NoticeKind;
  title: string;
  body?: string;
  link?: string;
  actions?: NoticeAction[];
  expiresAt?: string;
  resolved?: boolean;
}

/**
 * What each notice is about. The part of a dedupKey before its first colon; after it, the subject: a mailbox's account
 * id (`cloudflare:<address>`, `gmail:<id>` …), with `/<agent id>` for an agent's, or an access request's id.
 */
export type Topic =
  | "account_reconnect" | "account_failure" | "account_network" | "account_sync" | "account_rate_limited"
  | "agent_drafts" | "agent_questions" | "agent_send_failed"
  | "access_request" | "safety_held";

/** Which source a topic comes from: a source that could not be read keeps its earlier records as they were. */
export type NoticeSource = "accounts" | "agents" | "access" | "safety";
export const SOURCE_OF: Readonly<Record<Topic, NoticeSource>> = {
  account_reconnect: "accounts", account_failure: "accounts", account_network: "accounts", account_sync: "accounts", account_rate_limited: "accounts",
  agent_drafts: "agents", agent_questions: "agents", agent_send_failed: "agents",
  access_request: "access", safety_held: "safety",
};

/** A notice before it is put in words: what `mergeNotices` compares and keeps. Locale-free. */
export interface NoticeFact {
  topic: Topic;
  dedupKey: string;
  from: NoticeFrom;
  level: NoticeLevel;
  kind: NoticeKind;
  /** The values its words are filled with: a count, a mailbox's address. */
  params: { n?: number; mailbox?: string };
  /** A path in the Inbox web app that resolves it. */
  path?: string;
  expiresAt?: string;
}

/** A kept record: the fact, when it last changed, and whether it is resolved. */
export interface StoredNotice extends NoticeFact { at: string; resolved?: boolean }
export interface NoticeState { v: 1; records: StoredNotice[] }

// ── Sources, as the route reads them ─────────────────────────────

/** A mail account as GET /api/accounts lists it (no credentials). */
export interface AccountInput {
  id: string;
  provider: string;
  email: string;
  status: string;
  error?: string;
  failures?: number;
}
/** The reply agents' runs that wait on a person, one group per mailbox, agent and what they wait for. */
export interface WaitingGroup { mailboxId: string; agentId: string | null; topic: "agent_drafts" | "agent_questions" | "agent_send_failed"; count: number }
export interface AccessRequestInput { id: string; keyName: string | null; holderId: string; mailboxes: readonly string[]; expiresAt: string; state: string }
export interface HeldInput { accountId: string; state: string }

export interface NoticeSources {
  accounts?: readonly AccountInput[];
  waiting?: readonly WaitingGroup[];
  agents?: readonly { id: string; name: string }[];
  accessRequests?: readonly AccessRequestInput[];
  held?: readonly HeldInput[];
}

/**
 * Account errors a person fixes (shared/mail/gmail-reasons.ts and the IMAP connect errors): the grant, the server's
 * Google or Microsoft setup, a refused password. Network errors are the ones where the provider's server could not be
 * reached or answered with a failure; Inbox tries again by itself. Any other error is a stopped sync.
 */
const PERSON_ERRORS = new Set(["gmail_api_disabled", "google_client_rejected", "microsoft_secret_expired", "microsoft_client_rejected", "mailbox_unavailable",
  "insufficient_scope", "invalid_profile", "redirect_uri_mismatch", "auth_failed", "app_password_required", "imap_disabled", "auth_or_imap_disabled",
  "web_login_required", "smtp_auth_failed", "smtp_auth_unsupported", "credentials_unreadable"]);
const NETWORK_ERRORS = new Set(["provider_unavailable", "provider_failed", "host_unreachable", "smtp_unreachable", "tls_failed", "too_many_connections",
  "provider_auth_failed", "timeout", "network_error", "connection_failed"]);

const INBOX: NoticeFrom = { kind: "service", name: INBOX_NAME };

/** A run's mailbox (a Cloudflare address, or `<provider>:<id>` for an account) as the account id a key names. */
export const accountIdOfMailbox = (mailboxId: string): string => {
  const m = mailboxId.toLowerCase();
  return /^(gmail|imap|outlook):/.test(m) ? m : `cloudflare:${m}`;
};

/** The mailbox's account id a dedupKey is about, or null for one about the whole server. */
export function accountOfDedupKey(dedupKey: string): string | null {
  const colon = dedupKey.indexOf(":");
  if (colon < 0) return null;
  const topic = dedupKey.slice(0, colon) as Topic;
  if (!(topic in SOURCE_OF) || topic === "access_request") return null;
  const subject = dedupKey.slice(colon + 1);
  const account = subject.split("/")[0]!;
  return /^(cloudflare|gmail|imap|outlook):/.test(account) ? account : null;
}

/** A stable id from a dedupKey (FNV-1a, 52 bits, hex): the same condition keeps its id. */
export function noticeId(dedupKey: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(dedupKey)) h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n);
  return `n-${(h & 0xfffffffffffffn).toString(16).padStart(13, "0")}`;
}

/**
 * The reply agents' runs that wait on a person now, grouped: a draft waiting for approval, a message held because the
 * agent had no answer, and a reply that could not be sent (or whose sending is unknown) in the last 7 days. The
 * outcome is ticketOutcomeOf's, so a draft a person answered or a question a later turn answered is not counted.
 */
export function waitingGroups(runs: readonly AgentRun[], now = Date.now()): WaitingGroup[] {
  const groups = new Map<string, WaitingGroup>();
  for (const run of runs) {
    const outcome = ticketOutcomeOf(run, now);
    let topic: WaitingGroup["topic"] | null = null;
    if (run.status === "drafted" && outcome === "awaiting_approval") topic = "agent_drafts";
    else if (run.status === "held" && outcome === "question_open") topic = "agent_questions";
    else if ((run.status === "send_failed" || run.status === "send_unknown") && !run.closedAt
      && now - (Date.parse(run.receivedAt ?? run.createdAt) || 0) < SEND_FAILED_WINDOW_MS) topic = "agent_send_failed";
    if (!topic) continue;
    const mailboxId = run.mailboxId.toLowerCase();
    const agentId = run.agentId ?? null;
    const key = `${topic}|${mailboxId}|${agentId ?? ""}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { mailboxId, agentId, topic, count: 1 });
  }
  return [...groups.values()].sort((a, b) => (a.topic + a.mailboxId + (a.agentId ?? "")).localeCompare(b.topic + b.mailboxId + (b.agentId ?? "")));
}

const enc = encodeURIComponent;
/** The page of a mailbox: a Cloudflare address's folder, or an account's inbox. */
function mailboxPath(accountId: string, folder: string): string {
  return accountId.startsWith("cloudflare:") ? `/mailbox/${enc(accountId.slice("cloudflare:".length))}/emails/${folder}`
    : `/accounts/${enc(accountId.slice(accountId.indexOf(":") + 1))}`;
}

/** The facts every source gives now. */
export function noticeFacts(sources: NoticeSources): NoticeFact[] {
  const facts: NoticeFact[] = [];
  const emails = new Map<string, string>();
  for (const a of sources.accounts ?? []) emails.set(`${a.provider}:${a.id}`.toLowerCase(), a.email);
  /** The address the app shows for a mailbox: a Cloudflare address, or a connected account's address. */
  const mailboxName = (accountId: string) =>
    accountId.startsWith("cloudflare:") ? accountId.slice("cloudflare:".length) : emails.get(accountId) ?? accountId;

  for (const a of sources.accounts ?? []) {
    const subject = `${a.provider}:${a.id}`.toLowerCase();
    const base = { from: INBOX, params: { mailbox: a.email }, path: "/settings/accounts" };
    const error = a.error ?? "";
    if (a.status === "reconnect_required")
      facts.push({ topic: "account_reconnect", dedupKey: `account_reconnect:${subject}`, level: "error", kind: "failure", ...base });
    else if (a.status === "error" && PERSON_ERRORS.has(error))
      facts.push({ topic: "account_failure", dedupKey: `account_failure:${subject}`, level: "error", kind: "failure", ...base });
    else if (a.status === "error" && NETWORK_ERRORS.has(error))
      facts.push({ topic: "account_network", dedupKey: `account_network:${subject}`, level: (a.failures ?? 0) >= NETWORK_ERROR_AFTER ? "error" : "warn", kind: "network", ...base });
    else if (a.status === "error")
      facts.push({ topic: "account_sync", dedupKey: `account_sync:${subject}`, level: "warn", kind: "failure", ...base });
    else if (a.status === "rate_limited")
      facts.push({ topic: "account_rate_limited", dedupKey: `account_rate_limited:${subject}`, level: "info", kind: "notice", ...base });
  }

  const agentNames = new Map((sources.agents ?? []).map((a) => [a.id, a.name]));
  for (const g of sources.waiting ?? []) {
    const account = accountIdOfMailbox(g.mailboxId);
    const from: NoticeFrom = { kind: "agent", name: (g.agentId && agentNames.get(g.agentId)) || g.agentId || INBOX_NAME };
    const agentPath = g.agentId ? `/settings/agents/${enc(g.agentId)}/answers` : "/settings/agents";
    const common = { dedupKey: `${g.topic}:${account}/${g.agentId ?? ""}`, from, params: { n: g.count, mailbox: mailboxName(account) } };
    if (g.topic === "agent_drafts") facts.push({ topic: g.topic, ...common, level: "warn", kind: "approval", path: mailboxPath(account, "draft") });
    else if (g.topic === "agent_questions") facts.push({ topic: g.topic, ...common, level: "warn", kind: "question", path: agentPath });
    else facts.push({ topic: g.topic, ...common, level: "error", kind: "failure", path: agentPath });
  }

  for (const r of sources.accessRequests ?? []) {
    if (r.state !== "waiting") continue;
    facts.push({ topic: "access_request", dedupKey: `access_request:${r.id}`, from: { kind: "agent", name: r.keyName || r.holderId },
      level: "warn", kind: "approval", params: { n: r.mailboxes.length }, path: "/settings/agent-access", expiresAt: r.expiresAt });
  }

  const held = new Map<string, number>();
  for (const h of sources.held ?? []) if (h.state === "held") held.set(h.accountId.toLowerCase(), (held.get(h.accountId.toLowerCase()) ?? 0) + 1);
  for (const [account, n] of [...held].sort(([a], [b]) => a.localeCompare(b)))
    facts.push({ topic: "safety_held", dedupKey: `safety_held:${account}`, from: INBOX, level: "warn", kind: "approval",
      params: { n, mailbox: mailboxName(account) }, path: mailboxPath(account, "inbox") });

  return facts;
}

/** Two facts say the same: nothing a reader sees differs. */
const sameFact = (a: NoticeFact, b: NoticeFact) => JSON.stringify(factOnly(a)) === JSON.stringify(factOnly(b));
function factOnly(f: NoticeFact): NoticeFact {
  return { topic: f.topic, dedupKey: f.dedupKey, from: f.from, level: f.level, kind: f.kind, params: f.params,
    ...(f.path ? { path: f.path } : {}), ...(f.expiresAt ? { expiresAt: f.expiresAt } : {}) };
}

/** A kept state that is not one reads as empty (a damaged file is repaired by the next write). */
export function normaliseState(raw: unknown): NoticeState {
  const records = (raw as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) return { v: 1, records: [] };
  return { v: 1, records: records.filter((r): r is StoredNotice => !!r && typeof r === "object" && typeof r.dedupKey === "string"
    && typeof r.topic === "string" && r.topic in SOURCE_OF && typeof r.at === "string" && !Number.isNaN(Date.parse(r.at))) };
}

/**
 * The facts of now against what was kept: a new or changed fact is stamped now; an unchanged one keeps its time; a
 * kept one no longer true is resolved now (once); a resolved one older than RESOLVED_KEPT_MS leaves. A source that
 * could not be read (`unavailable`) keeps its records as they were, so a failed read never resolves anything.
 */
export function mergeNotices(previous: NoticeState, current: readonly NoticeFact[], now: Date, unavailable: ReadonlySet<NoticeSource> = new Set()): { state: NoticeState; changed: boolean } {
  const at = now.toISOString();
  const kept = new Map(previous.records.map((r) => [r.dedupKey, r]));
  const out: StoredNotice[] = [];
  let changed = false;
  const seen = new Set<string>();
  for (const fact of current) {
    if (seen.has(fact.dedupKey)) continue;
    seen.add(fact.dedupKey);
    const before = kept.get(fact.dedupKey);
    if (before && !before.resolved && sameFact(before, fact)) { out.push(before); continue; }
    out.push({ ...factOnly(fact), at });
    changed = true;
  }
  for (const before of previous.records) {
    if (seen.has(before.dedupKey)) continue;
    seen.add(before.dedupKey);
    if (unavailable.has(SOURCE_OF[before.topic])) { out.push(before); continue; }
    if (!before.resolved) { out.push({ ...before, resolved: true, at }); changed = true; continue; }
    if (now.getTime() - Date.parse(before.at) > RESOLVED_KEPT_MS) { changed = true; continue; }
    out.push(before);
  }
  return { state: { v: 1, records: out }, changed };
}

/** The words of a fact in the reader's language: its title and body. */
function words(f: NoticeFact, t: T): { title: string; body?: string } {
  const n = f.params.n ?? 0;
  const mailbox = f.params.mailbox ?? "";
  switch (f.topic) {
    case "account_reconnect":
      return { title: t("Connect {mailbox} again", { mailbox }), body: t("Mail of this account is not read until it is connected again.") };
    case "account_failure":
      return { title: t("{mailbox} stopped receiving mail", { mailbox }), body: t("Open Settings → Accounts to see why and fix it.") };
    case "account_network":
      return { title: t("No connection to the mail server of {mailbox}", { mailbox }), body: t("Fabric Inbox tries again by itself; the mail comes in once the server answers.") };
    case "account_sync":
      return { title: t("{mailbox} stopped syncing", { mailbox }), body: t("Fabric Inbox tries again by itself. Settings → Accounts shows the reason.") };
    case "account_rate_limited":
      return { title: t("The provider of {mailbox} asked to slow down", { mailbox }), body: t("The mail comes in again when the provider allows it.") };
    case "agent_drafts":
      return { title: t.plural(n, { one: "{n} reply draft waits for your approval in {mailbox}", other: "{n} reply drafts wait for your approval in {mailbox}" }, { mailbox }) };
    case "agent_questions":
      return { title: t.plural(n, { one: "{n} message in {mailbox} waits: the agent does not know the answer", other: "{n} messages in {mailbox} wait: the agent does not know the answer" }, { mailbox }),
        body: t("Add the answer to the agent's knowledge, or answer the sender yourself.") };
    case "agent_send_failed":
      return { title: t.plural(n, { one: "{n} reply in {mailbox} could not be sent", other: "{n} replies in {mailbox} could not be sent" }, { mailbox }),
        body: t("Check whether the customer got an answer, and answer again if not.") };
    case "access_request":
      return { title: t.plural(n, { one: "Asks for access to {n} mailbox", other: "Asks for access to {n} mailboxes" }), body: t("Approve, narrow or refuse it in Agent access.") };
    case "safety_held":
      return { title: t.plural(n, { one: "{n} message in {mailbox} is held by the safety check", other: "{n} messages in {mailbox} are held by the safety check" }, { mailbox }),
        body: t("Look at each one, then release it or keep it held.") };
  }
}

const LEVEL_RANK: Record<NoticeLevel, number> = { critical: 0, error: 1, warn: 2, info: 3 };
const FROM_RANK: Record<NoticeFrom["kind"], number> = { system: 0, service: 0, person: 1, agent: 2 };

/** A kept record as `notice/1`, in the reader's language; `origin` makes its link absolute. */
export function renderNotice(r: StoredNotice, t: T, origin: string): Notice {
  const { title, body } = words(r, t);
  return {
    v: NOTICE_VERSION, id: noticeId(r.dedupKey), dedupKey: r.dedupKey, at: r.at, from: r.from, level: r.level, kind: r.kind, title,
    ...(body ? { body } : {}),
    ...(r.path ? { link: new URL(r.path, origin).href } : {}),
    ...(r.path && !r.resolved ? { actions: [{ id: "open", label: t("Open"), effect: "open" as const }] } : {}),
    ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
    ...(r.resolved ? { resolved: true } : {}),
  };
}

/**
 * The feed's answer: the records changed after `since` (all of them without it), open ones first, then Inbox's own
 * above the agents', the most severe first, the newest first; `cursor` is the latest change among those kept for
 * the reader, the `since` of the next read.
 */
export function noticeFeed(state: NoticeState, t: T, origin: string, options: { since?: string; accounts?: ReadonlySet<string> } = {}): { notices: Notice[]; cursor: string } {
  const since = options.since ? Date.parse(options.since) : null;
  const mine = (r: StoredNotice) => {
    if (!options.accounts) return true;
    const account = accountOfDedupKey(r.dedupKey);
    return account !== null && options.accounts.has(account);
  };
  const visible = state.records.filter(mine);
  const latest = visible.reduce((max, r) => Math.max(max, Date.parse(r.at)), since ?? 0);
  const notices = visible.filter((r) => since === null || Date.parse(r.at) > since)
    .sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || FROM_RANK[a.from.kind] - FROM_RANK[b.from.kind]
      || LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.at.localeCompare(a.at) || a.dedupKey.localeCompare(b.dedupKey))
    .map((r) => renderNotice(r, t, origin));
  return { notices, cursor: new Date(latest).toISOString() };
}
