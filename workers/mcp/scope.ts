/**
 * Agent keys limited to mailboxes (AP-11). A key that names its accounts reaches those accounts
 * and nothing else. Two checks hold it, so a mistake in one still fails closed:
 *
 * - the tool list (`toolFitsScope`): a limited key sees only tools whose every route stays inside
 *   one mailbox or reads the feed. It is read from the tools' own `routes`, so a new tool that
 *   touches the whole workspace is hidden from limited keys without anyone remembering to;
 * - the API (`scopedApi`): every route a tool calls passes through it, and a path to any other
 *   mailbox, or to anything shared by the workspace, is refused before it reaches the app. The feed
 *   is narrowed to the key's mailboxes on the way in and filtered again on the way out.
 */
import { ApiError, type Api, type ApiResponse, type ToolDef } from "./protocol";
import type { Principal } from "./keys";
import { parseRemoteAccount } from "../../shared/mail/accounts";

/** "cloudflare:<address>" (a bare address counts), "gmail:<id>" or "imap:<id>", the way list_accounts names it; null otherwise. */
export function normaliseAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.startsWith("cloudflare:")) return cloudflareId(v.slice(11));
  const remote = parseRemoteAccount(v);
  if (remote) return v;
  if (/^(gmail|imap|outlook):/.test(v)) return null;
  return cloudflareId(v);
}
// No "%": the mailbox routes decode their parameter once more, so "x%40y@d.com" would name another mailbox.
// No ",": a narrowing header is a comma list, so "a,b@d.com" would name two.
const cloudflareId = (address: string) => (/^[^@\s/:%,]+@[^@\s/:%,]+\.[^@\s/:%,]+$/.test(address) ? `cloudflare:${address.toLowerCase()}` : null);

/**
 * A stored key's accounts: absent or null is the whole workspace. Anything present is a limit: its
 * valid entries, normalised and de-duplicated — and a limit with nothing valid in it reaches nothing.
 */
export function normaliseAccounts(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(normaliseAccountId).filter((a): a is string => !!a))];
}

/** How a limit reads to a person: its addresses and its Gmail and IMAP account ids. */
export const describeScope = (accounts: readonly string[]) =>
  accounts.length ? accounts.map((a) => a.replace(/^cloudflare:/, "")).join(", ") : "no mailbox";

/** The feed's routes: answered for the key's mailboxes only. */
const FEED_ROUTES = new Set(["GET /api/inbox", "GET /api/accounts", "GET /api/inbox/hidden"]);
const MAILBOX_ROUTE = /^[A-Z]+ \/api\/v1\/mailboxes\/:mailboxId(\/|$)/;
const GMAIL_ROUTE = /^[A-Z]+ \/api\/accounts\/:accountId(\/|$)/;

/** Whether every route of a tool stays inside one mailbox, or reads the feed. */
export function toolFitsScope(tool: Pick<ToolDef, "routes">): boolean {
  return tool.routes.length > 0 && tool.routes.every((r) => FEED_ROUTES.has(r) || MAILBOX_ROUTE.test(r) || GMAIL_ROUTE.test(r));
}

/**
 * The mailbox a concrete path is about, or null when it is not about exactly one. An
 * `/api/accounts/<id>` path names the account by its own id, which is unique across Gmail and
 * IMAP: it is about whichever of `gmail:<id>` and `imap:<id>` the key holds.
 */
function accountOfPath(pathname: string, allowed: ReadonlySet<string>): string | null {
  const parts = pathname.split("/");
  try {
    if (pathname.startsWith("/api/v1/mailboxes/") && parts[4]) return normaliseAccountId(`cloudflare:${decodeURIComponent(parts[4])}`);
    if (pathname.startsWith("/api/accounts/") && parts[3]) {
      const id = decodeURIComponent(parts[3]);
      const candidates = [`gmail:${id}`, `imap:${id}`].map(normaliseAccountId).filter((a): a is string => !!a);
      return candidates.find((a) => allowed.has(a)) ?? candidates[0] ?? null;
    }
  } catch { return null; }
  return null;
}

const refuse = (accounts: readonly string[]) =>
  new ApiError(403, `This key is limited to ${describeScope(accounts)}; it cannot reach that.`, null);

/** Wraps the app's API for a key limited to `accounts`. */
type Feed = { accounts?: { id?: unknown }[]; messages?: { accountId?: unknown; date?: unknown }[]; issues?: { accountId?: unknown }[]; hasMore?: boolean; cursor?: unknown };

/** The account ids a feed cursor carries (it is base64 JSON naming the last row's account). */
function cursorAccounts(cursor: unknown): string[] | null {
  if (typeof cursor !== "string") return [];
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(cursor), (c) => c.charCodeAt(0)));
    return [...text.matchAll(/"((?:cloudflare|gmail|imap|outlook):[^"]+)"/g)].map((m) => m[1]!.toLowerCase());
  } catch { return null; }
}

/** Wraps the app's API for a key limited to `accounts`. */
export function scopedApi(api: Api, accounts: readonly string[]): Api {
  const allowed = new Set(accounts);
  const allowedLower = new Set(accounts.map((a) => a.toLowerCase()));
  const mine = (id: unknown) => allowed.has(String(id));
  return {
    async request(method, path, init = {}): Promise<ApiResponse> {
      const pathname = path.split("?")[0]!;
      const route = `${method} ${pathname}`;
      if (FEED_ROUTES.has(route)) return narrowFeed(route, init);
      const account = accountOfPath(pathname, allowed);
      if (!account || !allowed.has(account)) throw refuse(accounts);
      return api.request(method, path, init);
    },
  };

  /** One feed answer with every trace of another mailbox removed. */
  function clean(data: Feed): Feed {
    const cursorIds = cursorAccounts(data.cursor);
    const cursorOk = cursorIds !== null && cursorIds.every((id) => allowedLower.has(id));
    return {
      ...data,
      accounts: (data.accounts ?? []).filter((a) => mine(a.id)),
      messages: (data.messages ?? []).filter((m) => mine(m.accountId)),
      // An issue about the feed as a whole names no account; one that names another is dropped.
      issues: (data.issues ?? []).filter((i) => i.accountId === undefined || mine(i.accountId)),
      ...(cursorOk ? {} : { cursor: undefined, hasMore: false }),
    };
  }

  async function oneFeed(init: { query?: Record<string, unknown> }, account: string, named: boolean): Promise<ApiResponse> {
    const response = await api.request("GET", "/api/inbox", { ...init, query: { ...init.query, account } });
    // The key's own mailbox, chosen for it, may not exist (yet, or any more): that is an empty
    // scope with its reason, not a failure of the whole call. Named by the agent, the 404 stands.
    if (!named && response.status === 404 && (response.data as { error?: unknown } | null)?.error === "account_not_found")
      return { status: 200, contentType: "application/json", data: { accounts: [], messages: [], hasMore: false,
        issues: [{ provider: account.split(":")[0], error: `${describeScope([account])} has no mailbox on this server` }] } };
    if (response.status < 200 || response.status >= 300 || !response.data || typeof response.data !== "object") return response;
    return { ...response, data: clean(response.data as Feed) };
  }

  async function narrowFeed(route: string, init: { query?: Record<string, unknown>; body?: unknown }): Promise<ApiResponse> {
    if (route === "GET /api/inbox") {
      // A category is the workspace's, and its view reads every mailbox regardless of account.
      const category = init.query?.category;
      if (category !== undefined && category !== null && category !== "")
        throw new ApiError(403, `Categories are shared by the whole workspace; this key is limited to ${describeScope(accounts)}.`, null);
      const asked = init.query?.account;
      const named = asked !== undefined && asked !== null && asked !== "";
      if (named) {
        const account = normaliseAccountId(asked);
        if (!account || !allowed.has(account)) throw refuse(accounts);
        return oneFeed(init, account, true);
      }
      if (accounts.length === 1) return oneFeed(init, accounts[0]!, false);
      // Several mailboxes: each one's first page, merged, newest first. It cannot be paged as one.
      const pages: Feed[] = [];
      for (const account of accounts) {
        const page = await oneFeed(init, account, false);
        if (page.status < 200 || page.status >= 300) return page;
        pages.push(page.data as Feed);
      }
      const limit = Number(init.query?.limit) || 50;
      const messages = pages.flatMap((p) => p.messages ?? [])
        .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))).slice(0, limit);
      const more = pages.some((p) => p.hasMore);
      return { status: 200, contentType: "application/json", data: {
        accounts: pages.flatMap((p) => p.accounts ?? []), messages, hasMore: more,
        issues: [...pages.flatMap((p) => p.issues ?? []),
          ...(more ? [{ provider: "scope", error: `This key reaches ${accounts.length} mailboxes; page one mailbox at a time with accountId.` }] : [])],
      } };
    }
    const response = await api.request("GET", route.slice(4), init);
    const data = response.data as { accounts?: { id?: unknown; provider?: unknown }[]; hidden?: unknown[] } | null;
    if (!data || typeof data !== "object") return response;
    if (route === "GET /api/accounts") return { ...response, data: { ...data, accounts: (data.accounts ?? []).filter((a) => mine(`${a.provider ?? "gmail"}:${a.id}`)) } };
    // Hidden entries are stored as lower-cased account ids (workers/lib/hidden-accounts.ts).
    return { ...response, data: { ...data, hidden: (data.hidden ?? []).filter((h) => allowedLower.has(String(h).toLowerCase())) } };
  }
}

/**
 * The narrowing header (ADR-0115 §5 in passioncode-ai/fabric). A hub that holds one key for many
 * agents names, per call, the mailboxes the calling agent was granted; the call then reaches those
 * only. It intersects with the key's own limit, so it can narrow a key and never widen one, and a
 * header with nothing valid in it reaches nothing. No header leaves the caller as it was.
 */
export const NARROW_HEADER = "X-Fabric-Accounts";

export function narrowPrincipal(principal: Principal | null, header: string | null): Principal | null {
  if (!principal || header === null) return principal;
  const named = normaliseAccounts(header.split(",").map((s) => s.trim()).filter(Boolean)) ?? [];
  const accounts = principal.accounts ? named.filter((a) => principal.accounts!.includes(a)) : named;
  return { ...principal, accounts } as Principal;
}
