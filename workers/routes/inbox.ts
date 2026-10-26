import { Hono } from "hono";
import { INBOX_FOLDERS, compareInbox, inboxPosition, type InboxAccount, type InboxIssue, type InboxReadOptions, type InboxResponse, type InboxMessage, type InboxPosition } from "../../shared/mail/inbox";
import type { Env } from "../types";
import { inboxSources } from "../lib/inbox-sources";
import { inScope } from "../categories/definition";
import { allServedDomains, storedCatchAll } from "../lib/mailbox-store";
import { changeHidden, HiddenConflict, readHidden } from "../lib/hidden-accounts";
import { REMOTE_ACCOUNT, parseRemoteAccount } from "../../shared/mail/accounts";
import { msg } from "../../shared/i18n";
import { runIdFor, type AgentRun } from "../agents/run";
import { AgentStatusConflict, AgentStatusInvalid, attachAgentStates, changeAgentStatus, listAgentThreads, readAgentStatus } from "../lib/agent-status";
import { isAgentState, OPEN_STATES } from "../../shared/mail/agent-state";

export interface InboxSources {
  cloudflareAccounts(): Promise<InboxAccount[]>;
  /** Gmail, IMAP and Outlook accounts: the accounts object's. */
  remoteAccounts(): Promise<InboxAccount[]>;
  messages(account: InboxAccount, options: InboxReadOptions): Promise<InboxMessage[]>;
  /** Unread messages in the account's inbox; optional, a failure leaves the count out. */
  unreadCount?(account: InboxAccount): Promise<number>;
  /** Unread and total mail and stuck journal events; preferred over unreadCount when present. */
  counts?(account: InboxAccount): Promise<InboxCountsRead>;
  /**
   * Gmail, IMAP and Outlook accounts live in one accounts object: their pages are read in one call
   * (B-24), each account answering its page or its own error code. Cloudflare mailboxes are their
   * own objects and are read one by one.
   */
  messagesMany?(accounts: InboxAccount[], options: InboxReadOptions): Promise<Record<string, { messages: InboxMessage[] } | { error: string }>>;
  /** The same accounts' counts in one call (B-24). */
  countsMany?(accounts: InboxAccount[]): Promise<Record<string, InboxCountsRead | { error: string }>>;
}
export interface InboxCountsRead { unread: number; total?: number; stuck?: InboxAccount["stuck"] }
/** Accounts the accounts object holds, which a batched source reads together. */
const batched = (a: InboxAccount) => a.provider !== "cloudflare";
class InboxRequestError extends Error { constructor(message: string, readonly status: 400 | 404 = 400) { super(message); } }
const allowedErrors = new Set(["cache_scan_limit", "account_not_found", "reconnect_required", "rate_limited", "message_store_unavailable", "account_limit"]);
function publicError(error: unknown) { return error instanceof Error && allowedErrors.has(error.message) ? error.message : "account_unavailable"; }
function scope(account: string, folder: string, query: string, unread: boolean, domain = "") {
  const base: string[] = [account, folder, query];
  if (unread) base.push("unread");
  if (domain) base.push("domain:" + domain);
  return JSON.stringify(base);
}
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function cursorEncode(value: unknown) { return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))); }
/** A short fingerprint of an RFC Message-ID (FNV-1a, 32 bits), so a cursor can name a page's messages compactly. */
function seenKey(rfcMessageId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < rfcMessageId.length; i++) { hash ^= rfcMessageId.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}
const MAX_SEEN = 150;

/** The messages already shown before this page (by Message-ID fingerprint); empty for an older cursor. */
function cursorSeen(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))));
    return new Set(Array.isArray(value.seen) ? value.seen.filter((x: unknown) => typeof x === "string" && /^[0-9a-f]{8}$/.test(x)).slice(0, MAX_SEEN) : []);
  } catch { return new Set(); }
}

function cursorDecode(raw: string, expectedScope: string): InboxPosition {
  try {
    if (raw.length > 4096) throw new Error();
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))));
    if (value.version !== 1 || value.scope !== expectedScope || !Number.isSafeInteger(value.position?.timestamp) ||
      typeof value.position.accountId !== "string" || value.position.accountId.length > 512 ||
      typeof value.position.providerMessageId !== "string" || value.position.providerMessageId.length > 512) throw new Error();
    return value.position;
  } catch { throw new InboxRequestError("invalid_cursor"); }
}

/** Shared Access workspace: only identities discovered in the providers may be read. */
/** What a caller may add to a read: a narrower account set (a category's scope) and a pass over the page. */
export interface InboxReadExtra {
  /** Only accounts this accepts are read; `key` names the set so a cursor cannot cross it. */
  accounts?: { key: string; accept(account: InboxAccount): boolean };
  /** Runs on the page before it is returned (category chips, raising to Important). */
  decorate?(page: InboxMessage[]): Promise<void>;
  /** Domains the workspace serves, passed to each source for triage. */
  ownDomains?: string[];
  /** Accounts the operator hid: read only when asked for alone, never in All inboxes or a domain. */
  hidden?: Set<string>;
  /** Catch-all mailboxes, marked on their account. */
  catchAlls?: Set<string>;
}

export async function readInbox(params: URLSearchParams, sources: InboxSources, extra: InboxReadExtra = {}): Promise<InboxResponse> {
  const account = params.get("account") || "", folder = params.get("folder") || "inbox", query = (params.get("query") || "").trim();
  const unread = params.get("unread") === "1";
  // A whole project domain: every account whose address is on it.
  const domain = (params.get("domain") || "").trim().toLowerCase();
  if (domain && !DOMAIN.test(domain)) throw new InboxRequestError("invalid_filter");
  // Every inbox of one provider (the sidebar's Gmail, Outlook or IMAP group).
  const provider = params.get("provider") || "";
  if (provider && provider !== "gmail" && provider !== "imap" && provider !== "outlook" && provider !== "cloudflare") throw new InboxRequestError("invalid_filter");
  const limit = Number(params.get("limit") || 50);
  if (!INBOX_FOLDERS.includes(folder as InboxReadOptions["folder"]) || !Number.isInteger(limit) || limit < 1 || limit > 100 || query.length > 500 || account.length > 512)
    throw new InboxRequestError("invalid_filter");
  const filterScope = scope(account, folder, query, unread, domain) + (provider ? "|provider:" + provider : "") + (extra.accounts ? "|" + extra.accounts.key : ""), rawCursor = params.get("cursor");
  const before = rawCursor ? cursorDecode(rawCursor, filterScope) : undefined;
  const options: InboxReadOptions = { folder: folder as InboxReadOptions["folder"], query, limit, before, ...(unread ? { unread } : {}),
    ...(extra.ownDomains?.length ? { ownDomains: extra.ownDomains } : {}) };
  const issues: InboxIssue[] = [], accounts: InboxAccount[] = [];
  const discoveries = await Promise.allSettled([sources.cloudflareAccounts(), sources.remoteAccounts()]);
  for (const [i, result] of discoveries.entries()) {
    const provider = i === 0 ? "cloudflare" : "gmail";
    if (result.status === "rejected") issues.push({ provider, error: publicError(result.reason) });
    else accounts.push(...result.value);
  }
  accounts.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const a of accounts) {
    if (extra.hidden?.has(a.id.toLowerCase())) a.hidden = true;
    if (a.provider === "cloudflare" && extra.catchAlls?.has(a.email.toLowerCase())) a.catchAll = true;
  }
  if (account && !accounts.some(a => a.id === account) && !issues.some(i => account.startsWith(i.provider + ":")))
    throw new InboxRequestError("account_not_found", 404);
  // A domain is a set of Cloudflare addresses, as the sidebar groups it; a Gmail account on the
  // same domain is chosen on its own.
  const selected = accounts.filter(a => (!account || a.id === account) && (account || !a.hidden) && (!domain || (a.provider === "cloudflare" && a.email.toLowerCase().endsWith("@" + domain)))
    && (!provider || a.provider === provider) && (!extra.accounts || extra.accounts.accept(a)));
  const firstPage = !rawCursor;
  const messages: InboxMessage[] = [];
  // Bound concurrent DO calls and total account fan-out; never omit that limit.
  if (selected.length > 100) {
    for (const provider of ["cloudflare", "gmail", "imap", "outlook"] as const)
      if (selected.slice(100).some(a => a.provider === provider)) issues.push({ provider, error: "account_limit" });
  }
  const reading = selected.slice(0, 100);
  const readIds = new Set(reading.map(a => a.id));
  const failed = new Set<string>();
  const fail = (a: InboxAccount, error: unknown) => {
    a.error = publicError(error);
    failed.add(a.id);
    if (!issues.some(i => i.accountId === a.id)) issues.push({ accountId: a.id, provider: a.provider, error: a.error });
  };
  for (const a of reading)
    if (a.error || ["reconnect_required", "rate_limited", "error"].includes(a.status))
      issues.push({ accountId: a.id, provider: a.provider, error: a.error || a.status, ...(a.reason ? { reason: a.reason } : {}) });
  const together = sources.messagesMany ? reading.filter(batched) : [];
  const alone = reading.filter(a => !together.includes(a));
  const readTogether = async () => {
    if (!together.length) return;
    let found: Awaited<ReturnType<NonNullable<InboxSources["messagesMany"]>>>;
    try { found = await sources.messagesMany!(together, options); }
    catch (error) { for (const a of together) fail(a, error); return; }
    for (const a of together) {
      const result = found[a.id];
      if (result && "messages" in result) messages.push(...result.messages);
      else fail(a, new Error(result?.error ?? "account_unavailable"));
    }
  };
  // A pool of 8 in flight: one slow account holds back only its own slot.
  let next = 0;
  await Promise.all([readTogether(), ...Array.from({ length: Math.min(8, alone.length) }, async () => {
    while (next < alone.length) {
      const a = alone[next++];
      try { messages.push(...await sources.messages(a, options)); }
      catch (error) { fail(a, error); }
    }
  })]);
  // Unread counts for every inbox, not only the ones read, so the sidebar is never half stale.
  if (firstPage && (sources.counts || sources.unreadCount || sources.countsMany)) {
    const counting = accounts.slice(0, 100);
    // A count that cannot be read is said to be stale, never silently left as it was (P2-11).
    const stale = (a: InboxAccount, error: unknown) => {
      a.countsStale = true;
      console.warn(JSON.stringify({ event: "inbox_count_failed", provider: a.provider, error: publicError(error) }));
    };
    const apply = (a: InboxAccount, c: InboxCountsRead) => {
      a.unread = c.unread;
      if (typeof c.total === "number") a.total = c.total;
      if (c.stuck && (c.stuck.dead || c.stuck.retrying)) a.stuck = c.stuck;
    };
    const countTogether = sources.countsMany ? counting.filter(batched) : [];
    const countAlone = counting.filter(a => !countTogether.includes(a) && (sources.counts || sources.unreadCount));
    const countBatch = async () => {
      if (!countTogether.length) return;
      let found: Awaited<ReturnType<NonNullable<InboxSources["countsMany"]>>>;
      try { found = await sources.countsMany!(countTogether); }
      catch (error) { for (const a of countTogether) stale(a, error); return; }
      for (const a of countTogether) {
        const c = found[a.id];
        if (c && !("error" in c)) apply(a, c);
        else stale(a, new Error(c && "error" in c ? c.error : "account_unavailable"));
      }
    };
    let n = 0;
    await Promise.all([countBatch(), ...Array.from({ length: Math.min(8, countAlone.length) }, async () => {
      while (n < countAlone.length) {
        const a = countAlone[n++];
        if (sources.counts) await sources.counts(a).then((c) => apply(a, c)).catch((error) => stale(a, error));
        else await sources.unreadCount!(a).then(count => { a.unread = count; }).catch((error) => stale(a, error));
      }
    })]);
  }
  void readIds;
  messages.sort(compareInbox);
  // The same email in several inboxes (two of our addresses, or a Cloudflare copy forwarded to a
  // connected Gmail) is one row naming every inbox it reached.
  const merged: InboxMessage[] = [];
  const byRfc = new Map<string, InboxMessage>();
  // A copy of an email already shown on an earlier page (merged into its row there) is not shown
  // again on this one: the cursor names those emails (2026-10-01 review).
  const shown = account ? new Set<string>() : cursorSeen(rawCursor);
  for (const m of messages) {
    if (m.rfcMessageId && shown.has(seenKey(m.rfcMessageId))) continue;
    const first = !account && m.rfcMessageId ? byRfc.get(m.rfcMessageId) : undefined;
    if (first) { first.alsoIn = [...(first.alsoIn ?? []), m.accountId]; continue; }
    if (m.rfcMessageId) byRfc.set(m.rfcMessageId, m);
    merged.push(m);
  }
  // An inbox that failed on this page may hold older mail: keep "Load older" offered.
  const hasMore = merged.length > limit || (failed.size > 0 && merged.length > 0), page = merged.slice(0, limit);
  if (extra.decorate) {
    // Decoration adds meaning to a page; its failure must not hide the mail itself.
    try { await extra.decorate(page); }
    catch (error) { console.error(JSON.stringify({ event: "inbox_decorate_failed", error: (error as Error).message.slice(0, 200) })); }
  }
  return { accounts, messages: page, issues, hasMore,
    ...(hasMore ? { cursor: cursorEncode({ version: 1, scope: filterScope, position: inboxPosition(page[page.length - 1]),
      // The emails this page and the ones before showed, newest last, bounded: their older copies are skipped next.
      ...(!account ? { seen: [...new Set([...shown, ...page.filter((m) => m.rfcMessageId).map((m) => seenKey(m.rfcMessageId!))])].slice(-MAX_SEEN) } : {}) }) } : {}) };
}

export const inboxRouter = new Hono<{ Bindings: Env }>();

/** Every mailbox that keeps mail for other addresses on its domain: chosen here or set by the deployment. */
async function catchAllMailboxes(env: Env): Promise<Set<string>> {
  const set = new Set(Object.values(await storedCatchAll(env.BUCKET)).map((m) => m.toLowerCase()));
  try {
    for (const v of Object.values(JSON.parse(env.UNKNOWN_ADDRESS_POLICY || "{}") as Record<string, unknown>))
      if (typeof v === "string" && v.startsWith("catch_all:")) set.add(v.slice("catch_all:".length).trim().toLowerCase());
  } catch { /* an unreadable policy marks nothing */ }
  return set;
}

inboxRouter.get("/api/inbox/hidden", async (c) => {
  c.header("Cache-Control", "no-store");
  try { return c.json({ hidden: await readHidden(c.env.BUCKET) }); }
  catch (error) { return c.json({ error: (error as Error).message }, 503); }
});

/** Hide or show addresses (the sidebar's filter); answers the full hidden list. */
inboxRouter.put("/api/inbox/hidden", async (c) => {
  const body = await c.req.json().catch(() => null) as { hide?: unknown; show?: unknown } | null;
  const list = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  if (!body || (!list(body.hide).length && !list(body.show).length)) return c.json({ error: msg("Name the addresses to hide or show") }, 400);
  try {
    const hidden = await changeHidden(c.env.BUCKET, { hide: list(body.hide), show: list(body.show) });
    console.log(JSON.stringify({ event: "accounts_hidden_changed", hidden: hidden.length }));
    return c.json({ hidden });
  } catch (error) {
    return c.json({ error: (error as Error).message }, error instanceof HiddenConflict ? 409 : 503);
  }
});
/**
 * Refresh (P1-5): reads Gmail, IMAP and Outlook accounts now — new mail, changes and deletions — for the
 * accounts in `accounts` (feed ids, "gmail:<id>" or "imap:<id>"; every one when it is absent),
 * within about 20 s, and says what happened to each. Cloudflare mailboxes receive by push and need
 * no refresh. The accounts' regular sync is not moved.
 */
inboxRouter.post("/api/inbox/refresh", async (c) => {
  c.header("Cache-Control", "no-store");
  const body = (await c.req.json().catch(() => ({}))) as { accounts?: unknown } | null;
  const raw = body?.accounts;
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 200 || raw.some((x) => typeof x !== "string" || x.length > 512)))
    return c.json({ error: "invalid_filter" }, 400);
  const remote = raw === undefined ? undefined : (raw as string[]).filter((x) => REMOTE_ACCOUNT.test(x));
  const refreshedAt = Date.now();
  if (!c.env.GMAIL_ACCOUNTS || (remote && !remote.length)) return c.json({ accounts: [], refreshedAt });
  try {
    return c.json({ accounts: await c.env.GMAIL_ACCOUNTS.getByName("workspace").refresh(remote), refreshedAt });
  } catch (error) {
    console.error(JSON.stringify({ event: "inbox_refresh_failed", error: (error as Error)?.message?.slice(0, 200) }));
    return c.json({ error: "refresh_unavailable" }, 503);
  }
});

/** B-138: whether the reply status is shown, for the workspace, each domain and each address (off by default). */
inboxRouter.get("/api/agent-status", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await readAgentStatus(c.env.BUCKET));
});
inboxRouter.put("/api/agent-status", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const map = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, boolean | null> : undefined);
  if (!body || typeof body !== "object" || (body.enabled !== undefined && typeof body.enabled !== "boolean")
    || (body.domains !== undefined && !map(body.domains)) || (body.addresses !== undefined && !map(body.addresses)))
    return c.json({ error: msg("Give enabled (on or off), domains or addresses") }, 400);
  try {
    return c.json(await changeAgentStatus(c.env.BUCKET, { enabled: body.enabled as boolean | undefined, domains: map(body.domains), addresses: map(body.addresses) }));
  } catch (error) {
    if (error instanceof AgentStatusInvalid) return c.json({ error: error.message }, 400);
    if (error instanceof AgentStatusConflict) return c.json({ error: msg("The reply status settings changed several times at once; try again") }, 409);
    throw error;
  }
});

/** B-138: conversations by reply status, newest first, on the addresses where it is shown (or the one named). */
inboxRouter.get("/api/agent-threads", async (c) => {
  c.header("Cache-Control", "no-store");
  const params = new URL(c.req.url).searchParams;
  const states = (params.get("state") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!states.every(isAgentState)) return c.json({ error: msg("Unknown reply status") }, 400);
  const limit = Math.min(200, Math.max(1, Number(params.get("limit") || 100) || 100));
  const abandoned = params.get("abandoned");
  if (abandoned !== null && abandoned !== "1" && abandoned !== "0") return c.json({ error: msg("Unknown reply status") }, 400);
  const ownDomains = await allServedDomains(c.env).catch(() => [] as string[]);
  return c.json(await listAgentThreads(c.env, { states: states.filter(isAgentState), abandoned: abandoned === "1", address: params.get("address") || undefined, limit, ownDomains }));
});

inboxRouter.get("/api/inbox", async c => {
  c.header("Cache-Control", "no-store");
  try {
    const env = c.env;
    const params = new URL(c.req.url).searchParams;
    const categoryId = params.get("category") || "";
    if (categoryId) return c.json(await readCategory(c.env, categoryId, params, await allServedDomains(c.env).catch(() => [] as string[])));
    const reply = params.get("reply") || "";
    if (reply) return c.json(await readReplyView(c.env, reply, params, await allServedDomains(c.env).catch(() => [] as string[])));
    const [ownDomains, hidden, catchAlls] = await Promise.all([
      allServedDomains(c.env).catch(() => [] as string[]),
      readHidden(c.env.BUCKET).catch(() => [] as string[]),
      catchAllMailboxes(c.env).catch(() => new Set<string>()),
    ]);
    return c.json(await readInbox(params, inboxSources(c.env), { decorate: (page) => Promise.all([markCategories(c.env, page),
      c.env.AGENT_REGISTRY ? attachAgentRuns(page, (ids) => c.env.AGENT_REGISTRY.getByName("workspace").runsByIds(ids)) : undefined,
      attachAgentStates(c.env, page)]).then(() => undefined), ownDomains,
      hidden: new Set(hidden), catchAlls }));
  } catch (error) {
    if (error instanceof InboxRequestError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "inbox_unavailable" }, 503);
  }
});

/**
 * Category chips on a page of the feed, and raising to Important (CAT-5): one
 * call for the whole page. A message in a flagged category becomes important with
 * the category as the first reason.
 */
/**
 * Marks each Cloudflare message on the page with its reply agent's run (B-115), looked up in one call;
 * agents answer Cloudflare addresses only. A registry that cannot answer leaves the page unmarked.
 */
export async function attachAgentRuns(page: InboxMessage[], runsByIds: (ids: string[]) => Promise<AgentRun[]>) {
  const cloudflare = page.filter((m) => m.accountId.startsWith("cloudflare:"));
  if (!cloudflare.length) return;
  const ids = await Promise.all(cloudflare.map((m) => runIdFor(m.accountId.slice("cloudflare:".length), m.providerMessageId)));
  let runs: AgentRun[];
  try { runs = await runsByIds(ids); } catch { return; }
  const byId = new Map(runs.map((r) => [r.id, r]));
  cloudflare.forEach((m, i) => {
    const run = byId.get(ids[i]!);
    if (run) m.agentRun = { id: run.id, status: run.status, ...(run.agentId ? { agentId: run.agentId } : {}),
      ...(run.agentVersion ? { agentVersion: run.agentVersion } : {}), ...(run.draftId ? { draftId: run.draftId } : {}) };
  });
}

async function markCategories(env: Env, page: InboxMessage[]) {
  if (!env.CATEGORIES || !page.length) return;
  // B-178: a held message is marked, with why; its snippet is the person's to read, an agent's tool blanks it.
  const keys = page.map((m) => ({ accountId: m.accountId.toLowerCase(), messageId: m.providerMessageId }));
  const safety = await env.CATEGORIES.getByName("workspace").safetyOf(keys).catch(() => ({} as Record<string, never>));
  for (const m of page) {
    const s = (safety as Record<string, { state: string; reason: string; review: { verdict: string } | null }>)[`${m.accountId.toLowerCase()}|${m.providerMessageId}`];
    if (s && (s.state === "held" || s.state === "kept")) m.held = { reason: s.reason, verdict: s.review?.verdict ?? null };
  }
  const found = await env.CATEGORIES.getByName("workspace").membership(page.map((m) => ({ accountId: m.accountId, messageId: m.providerMessageId })));
  for (const m of page) {
    const hits = found[JSON.stringify([m.accountId, m.providerMessageId])];
    if (!hits?.length) continue;
    m.categories = hits.map((h) => ({ id: h.id, name: h.name, reason: h.reason }));
    const raised = hits.find((h) => h.promote);
    if (raised && m.triage) {
      m.triage = { ...m.triage, importance: "important", reasons: [`Category: ${raised.name}`, ...m.triage.reasons.filter((r) => !r.startsWith("Category: "))] };
    }
  }
}

/**
 * B-138: the list by reply status: `reply` is one state, or "open" for every state that waits for
 * someone. The addresses where the status is on; one address with `account`, one domain with `domain`.
 * One page (the newest 100), with every state's count for the filter's numbers.
 */
async function readReplyView(env: Env, reply: string, params: URLSearchParams, ownDomains: string[]): Promise<InboxResponse & { replyCounts: Record<string, number> }> {
  // B-170: "abandoned" is every open state, kept only past ABANDONED_AFTER_MS.
  const states = reply === "open" || reply === "abandoned" ? [...OPEN_STATES] : isAgentState(reply) ? [reply] : null;
  if (!states) throw new InboxRequestError("invalid_filter");
  const account = params.get("account") || "";
  const domain = (params.get("domain") || "").trim().toLowerCase();
  const sources = inboxSources(env);
  const issues: InboxIssue[] = [];
  // Every account, as the feed lists them, so the sidebar stays whole while the list is filtered.
  const accounts = (await Promise.allSettled([sources.cloudflareAccounts(), sources.remoteAccounts()])).flatMap((r, i) => {
    if (r.status === "rejected") { issues.push({ provider: i === 0 ? "cloudflare" : "gmail", error: publicError(r.reason) }); return []; }
    return r.value;
  });
  const found = await listAgentThreads(env, { states, abandoned: reply === "abandoned", address: account.startsWith("cloudflare:") ? account.slice(11) : parseRemoteAccount(account) ? account.toLowerCase() : undefined, ownDomains });
  for (const i of found.issues) {
    const remote = parseRemoteAccount(i.accountId);
    issues.push({ accountId: i.accountId, provider: remote ? remote.provider : "cloudflare", error: i.error });
  }
  const messages = found.messages.filter((m) => !domain || m.accountId.endsWith("@" + domain));
  await Promise.all([markCategories(env, messages),
    env.AGENT_REGISTRY ? attachAgentRuns(messages, (ids) => env.AGENT_REGISTRY.getByName("workspace").runsByIds(ids)) : undefined]);
  return { accounts, messages, issues, hasMore: false, replyCounts: { ...found.counts, abandoned: found.abandoned } as Record<string, number> };
}

/**
 * One category's view (CAT-5). A scope category is the live feed of the inboxes
 * it covers; a screened category lists its matched messages, newest first, each
 * read in its current state from its provider (a message gone to trash or deleted
 * leaves the view; its verdicts are parked, and restoring it puts it back, B-26).
 */
async function readCategory(env: Env, id: string, params: URLSearchParams, ownDomains: string[] = []): Promise<InboxResponse & { category: unknown }> {
  if (!env.CATEGORIES) throw new InboxRequestError("categories_unavailable");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) throw new InboxRequestError("invalid_filter");
  const store = env.CATEGORIES.getByName("workspace");
  const [category, projects] = await Promise.all([store.getCategory(id), store.listProjects()]);
  if (!category) throw new InboxRequestError("category_not_found", 404);
  const sources = inboxSources(env);
  if (category.kind === "scope") {
    const r = await readInbox(params, sources, {
      accounts: { key: `category:${category.id}:${category.version}`, accept: (a) => inScope(category.scope, a, projects) },
      decorate: (page) => markCategories(env, page),
      ownDomains,
    });
    return { ...r, category };
  }
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 50) || 50));
  const key = `category:${category.id}:${category.version}`;
  const raw = params.get("cursor");
  const before = raw ? cursorDecode(raw, key) : undefined;
  const rows = await store.page(id, before ? { timestamp: before.timestamp, accountId: before.accountId, messageId: before.providerMessageId } : null, limit + 1);
  const pageRows = rows.slice(0, limit);
  const issues: InboxIssue[] = [];
  const accounts = await (async () => {
    const found = await Promise.allSettled([sources.cloudflareAccounts(), sources.remoteAccounts()]);
    return found.flatMap((r, i) => {
      if (r.status === "rejected") { issues.push({ provider: i === 0 ? "cloudflare" : "gmail", error: publicError(r.reason) }); return []; }
      return r.value;
    });
  })();
  const byAccount = new Map<string, string[]>();
  for (const r of pageRows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r.messageId]);
  const messages: InboxMessage[] = [];
  const gone: { accountId: string; messageId: string }[] = [];
  await Promise.all([...byAccount.entries()].map(async ([accountId, ids]) => {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return; // an inbox that is no longer here; its rows stay until it is back or removed
    try {
      const remote = parseRemoteAccount(accountId);
      const found = remote
        ? await env.GMAIL_ACCOUNTS.getByName("workspace").inboxMessagesByIds(remote.id, ids, ownDomains)
        : await env.MAILBOX.get(env.MAILBOX.idFromName(accountId.slice(11))).inboxMessagesByIds(accountId.slice(11), ids, ownDomains);
      const have = new Set(found.map((m) => m.providerMessageId));
      for (const id of ids) if (!have.has(id)) gone.push({ accountId, messageId: id });
      messages.push(...found);
    } catch (error) {
      issues.push({ accountId, provider: account.provider, error: publicError(error) });
    }
  }));
  if (gone.length) await store.forget(gone).catch(() => undefined);
  const reasons = new Map(pageRows.map((r) => [JSON.stringify([r.accountId, r.messageId]), r.reason]));
  for (const m of messages) m.categoryReason = reasons.get(JSON.stringify([m.accountId, m.providerMessageId]));
  await markCategories(env, messages);
  messages.sort(compareInbox);
  const hasMore = rows.length > limit;
  const last = pageRows[pageRows.length - 1];
  return {
    category, accounts, messages, issues, hasMore,
    ...(hasMore && last ? { cursor: cursorEncode({ version: 1, scope: key, position: { timestamp: last.timestamp, accountId: last.accountId, providerMessageId: last.messageId } }) } : {}),
  };
}
