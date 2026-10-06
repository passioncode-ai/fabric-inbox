import { Hono } from "hono";
import { INBOX_FOLDERS, compareInbox, inboxPosition, type InboxAccount, type InboxIssue, type InboxReadOptions, type InboxResponse, type InboxMessage, type InboxPosition } from "../../shared/mail/inbox";
import type { Env } from "../types";
import { inboxSources } from "../lib/inbox-sources";
import { inScope } from "../categories/definition";
import { allServedDomains, storedCatchAll } from "../lib/mailbox-store";
import { changeHidden, HiddenConflict, readHidden } from "../lib/hidden-accounts";
import { REMOTE_ACCOUNT, parseRemoteAccount } from "../../shared/mail/accounts";

export interface InboxSources {
  cloudflareAccounts(): Promise<InboxAccount[]>;
  /** Gmail and IMAP accounts: the accounts object's. */
  remoteAccounts(): Promise<InboxAccount[]>;
  messages(account: InboxAccount, options: InboxReadOptions): Promise<InboxMessage[]>;
  /** Unread messages in the account's inbox; optional, a failure leaves the count out. */
  unreadCount?(account: InboxAccount): Promise<number>;
  /** Unread and total mail and stuck journal events; preferred over unreadCount when present. */
  counts?(account: InboxAccount): Promise<{ unread: number; total?: number; stuck?: InboxAccount["stuck"] }>;
}
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
  // Every inbox of one provider (the sidebar's Gmail or IMAP group).
  const provider = params.get("provider") || "";
  if (provider && provider !== "gmail" && provider !== "imap" && provider !== "cloudflare") throw new InboxRequestError("invalid_filter");
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
    for (const provider of ["cloudflare", "gmail", "imap"] as const)
      if (selected.slice(100).some(a => a.provider === provider)) issues.push({ provider, error: "account_limit" });
  }
  const reading = selected.slice(0, 100);
  const readIds = new Set(reading.map(a => a.id));
  const failed = new Set<string>();
  // A pool of 8 in flight: one slow account holds back only its own slot.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, reading.length) }, async () => {
    while (next < reading.length) {
      const a = reading[next++];
      if (a.error || ["reconnect_required", "rate_limited", "error"].includes(a.status))
        issues.push({ accountId: a.id, provider: a.provider, error: a.error || a.status, ...(a.reason ? { reason: a.reason } : {}) });
      try { messages.push(...await sources.messages(a, options)); }
      catch (error) {
        a.error = publicError(error);
        failed.add(a.id);
        if (!issues.some(i => i.accountId === a.id)) issues.push({ accountId: a.id, provider: a.provider, error: a.error });
      }
    }
  }));
  // Unread counts for every inbox, not only the ones read, so the sidebar is never half stale.
  if (firstPage && (sources.counts || sources.unreadCount)) {
    const counting = accounts.slice(0, 100);
    let n = 0;
    await Promise.all(Array.from({ length: Math.min(8, counting.length) }, async () => {
      while (n < counting.length) {
        const a = counting[n++];
        // A count that cannot be read is said to be stale, never silently left as it was (P2-11).
        const stale = (error: unknown) => {
          a.countsStale = true;
          console.warn(JSON.stringify({ event: "inbox_count_failed", provider: a.provider, error: publicError(error) }));
        };
        if (sources.counts) await sources.counts(a).then((c) => {
          a.unread = c.unread;
          if (typeof c.total === "number") a.total = c.total;
          if (c.stuck && (c.stuck.dead || c.stuck.retrying)) a.stuck = c.stuck;
        }).catch(stale);
        else await sources.unreadCount!(a).then(count => { a.unread = count; }).catch(stale);
      }
    }));
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
  if (!body || (!list(body.hide).length && !list(body.show).length)) return c.json({ error: "Name the addresses to hide or show" }, 400);
  try {
    const hidden = await changeHidden(c.env.BUCKET, { hide: list(body.hide), show: list(body.show) });
    console.log(JSON.stringify({ event: "accounts_hidden_changed", hidden: hidden.length }));
    return c.json({ hidden });
  } catch (error) {
    return c.json({ error: (error as Error).message }, error instanceof HiddenConflict ? 409 : 503);
  }
});
/**
 * Refresh (P1-5): reads Gmail and IMAP accounts now — new mail, changes and deletions — for the
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

inboxRouter.get("/api/inbox", async c => {
  c.header("Cache-Control", "no-store");
  try {
    const env = c.env;
    const params = new URL(c.req.url).searchParams;
    const categoryId = params.get("category") || "";
    if (categoryId) return c.json(await readCategory(c.env, categoryId, params, await allServedDomains(c.env).catch(() => [] as string[])));
    const [ownDomains, hidden, catchAlls] = await Promise.all([
      allServedDomains(c.env).catch(() => [] as string[]),
      readHidden(c.env.BUCKET).catch(() => [] as string[]),
      catchAllMailboxes(c.env).catch(() => new Set<string>()),
    ]);
    return c.json(await readInbox(params, inboxSources(c.env), { decorate: (page) => markCategories(c.env, page), ownDomains,
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
async function markCategories(env: Env, page: InboxMessage[]) {
  if (!env.CATEGORIES || !page.length) return;
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
 * One category's view (CAT-5). A scope category is the live feed of the inboxes
 * it covers; a screened category lists its matched messages, newest first, each
 * read in its current state from its provider (a message gone to trash or deleted
 * leaves the view, and its verdict is forgotten).
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
