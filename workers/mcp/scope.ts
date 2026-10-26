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
import { msg } from "../../shared/i18n";

/**
 * "cloudflare:<address>" (a bare address counts), "gmail:<id>" or "imap:<id>", the way list_accounts
 * names it, or "domain:<domain>": every Cloudflare address on that domain, later ones too (B-36); null otherwise.
 */
export function normaliseAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.startsWith("cloudflare:")) return cloudflareId(v.slice(11));
  if (v.startsWith("domain:")) return domainId(v.slice(7));
  const remote = parseRemoteAccount(v);
  if (remote) return v;
  if (/^(gmail|imap|outlook):/.test(v)) return null;
  return cloudflareId(v);
}
// No "%": the mailbox routes decode their parameter once more, so "x%40y@d.com" would name another mailbox.
// No ",": a narrowing header is a comma list, so "a,b@d.com" would name two.
const cloudflareId = (address: string) => (/^[^@\s/:%,]+@[^@\s/:%,]+\.[^@\s/:%,]+$/.test(address) ? `cloudflare:${address.toLowerCase()}` : null);
const domainId = (domain: string) => (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain) ? `domain:${domain.toLowerCase()}` : null);
const DOMAIN_PREFIX = "domain:";

/**
 * B-36: a limit's whole-domain entries become the Cloudflare addresses on exactly that domain now (not
 * its subdomains), so every check after this one sees concrete mailboxes only. A domain with no address
 * yet adds none; a limit that ends up naming nothing reaches nothing.
 */
export function expandDomains(accounts: readonly string[], addresses: readonly string[]): string[] {
  const domains = accounts.filter((a) => a.startsWith(DOMAIN_PREFIX)).map((a) => a.slice(DOMAIN_PREFIX.length));
  const concrete = accounts.filter((a) => !a.startsWith(DOMAIN_PREFIX));
  for (const address of addresses) {
    const id = cloudflareId(address);
    if (id && domains.includes(address.slice(address.lastIndexOf("@") + 1).toLowerCase()) && !concrete.includes(id)) concrete.push(id);
  }
  return concrete;
}
export const namesDomain = (accounts: readonly string[] | null) => !!accounts?.some((a) => a.startsWith(DOMAIN_PREFIX));

/**
 * A stored key's accounts: absent or null is the whole workspace. Anything present is a limit: its
 * valid entries, normalised and de-duplicated — and a limit with nothing valid in it reaches nothing.
 */
export function normaliseAccounts(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(normaliseAccountId).filter((a): a is string => !!a))];
}

/** How a limit reads to a person: its addresses, its domains and its Gmail and IMAP account ids. */
export const describeScope = (accounts: readonly string[]) =>
  accounts.length ? accounts.map((a) => a.startsWith(DOMAIN_PREFIX) ? `every address at ${a.slice(DOMAIN_PREFIX.length)}` : a.replace(/^cloudflare:/, "")).join(", ") : "no mailbox";

/** The feed's routes: answered for the key's mailboxes only. */
export const FEED_ROUTES = new Set(["GET /api/inbox", "GET /api/accounts", "GET /api/inbox/hidden"]);
const MAILBOX_ROUTE = /^[A-Z]+ \/api\/v1\/mailboxes\/:mailboxId(\/|$)/;
const GMAIL_ROUTE = /^[A-Z]+ \/api\/accounts\/:accountId(\/|$)/;

/** Whether every route of a tool stays inside one mailbox, or reads the feed. */
/** B-178: the safety check's routes, narrowed to a key's mailboxes by scopedApi (their accounts are in the body). */
export const SAFETY_ROUTES = new Set(["POST /api/safety/lookup", "GET /api/safety/held", "POST /api/safety/decide"]);

/**
 * A mailbox's own settings (its forwarding, reply agent, signature), deleting it, and an account's
 * connection and reply agent (B-171) are an administrator's: forwarding alone could send someone else's
 * mail away. Refused to a member (workers/lib/member-gate.ts) and to any limited or narrowed key, an
 * admin key narrowed by the header included (N-3).
 */
const ADMIN_MAILBOX_ACTIONS = [
  { methods: ["PUT", "DELETE"], path: /^\/api\/v1\/mailboxes\/[^/]+\/?$/ },
  { methods: ["POST", "PUT", "DELETE"], path: /^\/api\/accounts\/[^/]+\/(disconnect|password|agent)\/?$/ },
];
export const adminMailboxAction = (method: string, pathname: string) => ADMIN_MAILBOX_ACTIONS.some((a) => a.methods.includes(method) && a.path.test(pathname));

export function toolFitsScope(tool: Pick<ToolDef, "routes">): boolean {
  return tool.routes.length > 0 && tool.routes.every((r) => {
    const [method, path] = r.split(" ") as [string, string];
    if (adminMailboxAction(method, path)) return false;
    return FEED_ROUTES.has(r) || SAFETY_ROUTES.has(r) || MAILBOX_ROUTE.test(r) || GMAIL_ROUTE.test(r);
  });
}

/**
 * The mailbox a concrete path is about, or null when it is not about exactly one. An
 * `/api/accounts/<id>` path names the account by its own id, which is unique across Gmail and
 * IMAP: it is about whichever of `gmail:<id>` and `imap:<id>` the key holds.
 */
export function accountOfPath(pathname: string, allowed: ReadonlySet<string>): string | null {
  const parts = pathname.split("/");
  try {
    if (pathname.startsWith("/api/v1/mailboxes/") && parts[4]) return normaliseAccountId(`cloudflare:${decodeURIComponent(parts[4])}`);
    if (pathname.startsWith("/api/accounts/") && parts[3]) {
      const id = decodeURIComponent(parts[3]);
      // Outlook accounts live under /api/accounts/ too; leaving them out refused every call of a key limited to one (bug hunt 2026-10-12).
      const candidates = [`gmail:${id}`, `imap:${id}`, `outlook:${id}`].map(normaliseAccountId).filter((a): a is string => !!a);
      return candidates.find((a) => allowed.has(a)) ?? candidates[0] ?? null;
    }
  } catch { return null; }
  return null;
}

/** Who the limit is on: an agent key (its caller reads English) or a person in the app (B-149). */
export type ScopeSubject = "key" | "person";
const refuse = (accounts: readonly string[], who: ScopeSubject = "key") =>
  new ApiError(403, who === "person"
    ? msg("You reach only {mailboxes}; this is not one of them.", { mailboxes: describeScope(accounts) })
    : `This key is limited to ${describeScope(accounts)}; it cannot reach that.`, null);

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
export function scopedApi(api: Api, accounts: readonly string[], who: ScopeSubject = "key"): Api {
  const allowed = new Set(accounts);
  const allowedLower = new Set(accounts.map((a) => a.toLowerCase()));
  const mine = (id: unknown) => allowed.has(String(id));
  return {
    async request(method, path, init = {}): Promise<ApiResponse> {
      const pathname = path.split("?")[0]!;
      const route = `${method} ${pathname}`;
      if (FEED_ROUTES.has(route)) return narrowFeed(route, init);
      // B-178: the safety check's routes name their messages' accounts in the body, or list every account's.
      if (route === "POST /api/safety/lookup" || route === "POST /api/safety/decide") {
        const b = (init.body && typeof init.body === "object" ? init.body : {}) as { keys?: { accountId?: unknown }[]; accountId?: unknown };
        const named = route === "POST /api/safety/decide" ? [b.accountId] : (b.keys ?? []).map((k) => k?.accountId);
        if (!named.length || !named.every((id) => typeof id === "string" && allowedLower.has(id.toLowerCase()))) throw refuse(accounts, who);
        return api.request(method, path, init);
      }
      if (route === "GET /api/safety/held") {
        const response = await api.request(method, path, init);
        const data = response.data as { held?: { accountId?: unknown }[] } | null;
        return data && Array.isArray(data.held) ? { ...response, data: { ...data, held: data.held.filter((h) => allowedLower.has(String(h.accountId).toLowerCase())) } } : response;
      }
      if (adminMailboxAction(method, pathname)) throw refuse(accounts, who);
      const account = accountOfPath(pathname, allowed);
      if (!account || !allowed.has(account)) throw refuse(accounts, who);
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
        throw new ApiError(403, who === "person"
          ? msg("Categories are shared by the whole workspace; you reach only {mailboxes}.", { mailboxes: describeScope(accounts) })
          : `Categories are shared by the whole workspace; this key is limited to ${describeScope(accounts)}.`, null);
      const asked = init.query?.account;
      const named = asked !== undefined && asked !== null && asked !== "";
      if (named) {
        const account = normaliseAccountId(asked);
        if (!account || !allowed.has(account)) throw refuse(accounts, who);
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
          ...(more ? [{ provider: "scope", error: who === "person"
            ? msg("You reach {count} mailboxes; open one of them to see older mail.", { count: accounts.length })
            : `This key reaches ${accounts.length} mailboxes; page one mailbox at a time with accountId.` }] : [])],
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

/**
 * B-62 (issue #26, ADR-0115): what this server's narrowing does, named from this source and announced
 * in `initialize` as `capabilities.experimental["fabric-inbox/account-narrowing"]`. A hub checks it at
 * the authenticated endpoint and fails closed when it is missing or older than the revision it needs.
 * It is a claim this code makes about itself, not an attestation of the bytes that run; the deployment
 * receipt (`scripts/deploy-receipt.mjs`) links a Worker version to a commit and a bundle digest.
 * Revision 1: the header narrows by exact intersection with the key's own accounts and never widens
 * it; an id with a comma, "%" or "/" is refused; a header naming nothing valid reaches nothing (403).
 */
export const NARROWING_CAPABILITY = "fabric-inbox/account-narrowing";
export const NARROWING = { revision: 1, header: NARROW_HEADER, intersection: "exact", commaInId: "refused", emptyScope: "refused" } as const;

/**
 * The hub's side, written down as code (B-62): whether a server's `initialize` capabilities promise
 * narrowing at `need` or later. Anything missing, malformed or older answers false, so a hub that
 * meets an older runtime (or one rolled back to it) sends it no narrowed call.
 */
export function narrowingSupported(capabilities: unknown, need: number = NARROWING.revision): boolean {
  const entry = (capabilities as { experimental?: Record<string, unknown> } | null | undefined)?.experimental?.[NARROWING_CAPABILITY] as
    { revision?: unknown; header?: unknown; intersection?: unknown; commaInId?: unknown; emptyScope?: unknown } | undefined;
  // Every promise the hub relies on is checked, the empty-scope refusal too (review 2026-10-21).
  return !!entry && typeof entry.revision === "number" && Number.isInteger(entry.revision) && entry.revision >= need
    && entry.header === NARROW_HEADER && entry.intersection === "exact" && entry.commaInId === "refused" && entry.emptyScope === "refused";
}

export function narrowPrincipal(principal: Principal | null, header: string | null, addresses: readonly string[] = []): Principal | null {
  if (!principal || header === null) return principal;
  // B-36: a domain the header names is that domain's addresses, as the key's own domains are.
  const named = expandDomains(normaliseAccounts(header.split(",").map((s) => s.trim()).filter(Boolean)) ?? [], addresses);
  const accounts = principal.accounts ? named.filter((a) => principal.accounts!.includes(a)) : named;
  return { ...principal, accounts } as Principal;
}
