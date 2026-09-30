/**
 * The one Cloudflare API client of this server (CF-2/CF-3). The token is the
 * `CLOUDFLARE_API_TOKEN` secret; `CLOUDFLARE_EMAIL_ROUTING_TOKEN` is read as a
 * fallback so deployments made before 0.3 keep working.
 *
 * Every failure is a `CloudflareApiError` whose message a person can act on:
 * an authentication or permission refusal names the permission to add to the
 * token instead of echoing "Authentication error".
 */
const API = "https://api.cloudflare.com/client/v4";
type Fetcher = typeof fetch;

export interface TokenEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_EMAIL_ROUTING_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export function cloudflareToken(env: TokenEnv): string | undefined {
  return env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_EMAIL_ROUTING_TOKEN || undefined;
}

/**
 * What the token needs, in the dashboard's own words (Profile → API Tokens →
 * Create Custom Token). Shown on the Domains screen and in docs/desktop-mail/setup.md.
 */
export const TOKEN_PERMISSIONS = [
  // Creating and updating the server from the Mac app (desktop/cloudflare-deploy.cjs, same list; a test keeps them equal)
  { scope: "Account", name: "Workers Scripts", level: "Edit", for: "create and update the server" },
  { scope: "Account", name: "Workers R2 Storage", level: "Edit", for: "create the storage for your mail" },
  { scope: "Account", name: "Access: Apps and Policies", level: "Edit", for: "make the server open only for you" },
  { scope: "Account", name: "Access: Organizations, Identity Providers, and Groups", level: "Edit", for: "set up sign-in with a code by email" },
  { scope: "Account", name: "Access: Service Tokens", level: "Edit", for: "give agents their own keys to this server" },
  { scope: "Account", name: "Account Settings", level: "Read", for: "find your account" },
  // Domains & addresses
  { scope: "Account", name: "Email Routing Addresses", level: "Edit", for: "add the addresses a copy may be forwarded to" },
  { scope: "Account", name: "Email Routing Account Rules", level: "Read", for: "see whether an account has mail" },
  // Account level, not zone: the permission-group catalogue has "Email Sending Write" only at account level (read 2026-09-29).
  { scope: "Account", name: "Email Sending", level: "Edit", for: "send from your domains" },
  { scope: "Zone", name: "Zone", level: "Read", for: "list your domains" },
  { scope: "Zone", name: "Email Routing Rules", level: "Edit", for: "send addresses to your server" },
  { scope: "Zone", name: "Zone Settings", level: "Edit", for: "turn Email Routing on for a domain" },
  { scope: "Zone", name: "DNS", level: "Edit", for: "replace another provider's MX records and add a DMARC record" },
] as const;

/**
 * What a token for another account needs (MA-5): that account's domains and the relay that carries
 * their mail here. It makes no storage and no sign-in there; those stay in the server's account.
 */
export const ACCOUNT_TOKEN_PERMISSIONS = [
  { scope: "Account", name: "Workers Scripts", level: "Edit", for: "install the relay that carries the account's mail to your server" },
  { scope: "Account", name: "Account Settings", level: "Read", for: "find the account" },
  { scope: "Account", name: "Email Routing Addresses", level: "Edit", for: "add the addresses a copy may be forwarded to" },
  { scope: "Account", name: "Email Routing Account Rules", level: "Read", for: "see whether the account has mail" },
  { scope: "Account", name: "Email Sending", level: "Edit", for: "send from the account's domains" },
  { scope: "Zone", name: "Zone", level: "Read", for: "list the account's domains" },
  { scope: "Zone", name: "Email Routing Rules", level: "Edit", for: "send addresses to your server" },
  { scope: "Zone", name: "Zone Settings", level: "Edit", for: "turn Email Routing on for a domain" },
  { scope: "Zone", name: "DNS", level: "Edit", for: "replace another provider's MX records and add a DMARC record" },
] as const;

export class CloudflareApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) { super(message); }
  // A 403 with its own code (10042: R2 not turned on) is not about the token.
  get isPermission() { return this.status === 401 || this.code === 10000 || this.code === 9109 || (this.status === 403 && !this.code); }
}

export class CloudflareApi {
  // A bare `fetch` stored on the instance throws "Illegal invocation" in workerd when called as this.fetcher.
  constructor(private token: string, private fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  async call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; what?: string; timeoutMs?: number } = {}): Promise<T> {
    let response: Response;
    try {
      // A multipart upload (a Worker script) sets its own Content-Type with the boundary.
      response = await this.fetcher(API + path, {
        method: init.method ?? "GET",
        headers: init.form ? { Authorization: `Bearer ${this.token}` } : { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(init.form ? { body: init.form } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(init.timeoutMs ?? (init.form ? 60_000 : 15_000)),
      });
    } catch (error) {
      throw new CloudflareApiError(`Cloudflare did not answer (${(error as Error).message}). Try again.`, 0);
    }
    const body = (await response.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] } | null;
    if (response.ok && body?.success) return body.result as T;
    const first = body?.errors?.[0];
    const message = body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    const error = new CloudflareApiError(message, response.status, first?.code);
    // 9109 means both "Invalid access token" and "Unauthorized to access requested resource".
    if (/invalid (access|api) token|token.*(expired|revoked)/i.test(message))
      throw new CloudflareApiError("Cloudflare no longer accepts this server's token (mistyped, expired or deleted). Create a new one and save it on the server.", response.status, first?.code);
    // A 403 that says nothing more is a refusal of the token (the Access API answers so for a
    // missing Access: Service Tokens permission); one that explains itself, like 10042, is not.
    const unexplained = response.status === 403 && !body?.errors?.some((e) => e.message);
    if (error.isPermission || unexplained)
      throw new CloudflareApiError(`The Cloudflare token is not allowed to ${init.what ?? "do this"}. Add the permission to the token and try again.${first?.code ? ` (Cloudflare code ${first.code})` : ""}`, response.status, first?.code);
    throw new CloudflareApiError(`Cloudflare: ${message}`, response.status, first?.code);
  }

  /** Follows `page` pagination up to `maxPages` pages of `perPage`. */
  async list<T>(path: string, what: string, perPage = 50, maxPages = 10): Promise<T[]> {
    const all: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.call<T[]>(`${path}${sep}per_page=${perPage}&page=${page}`, { what });
      all.push(...batch);
      if (batch.length < perPage) break;
    }
    return all;
  }
}

export function cloudflareApi(env: TokenEnv, fetcher?: Fetcher): CloudflareApi | null {
  const token = cloudflareToken(env);
  return token ? new CloudflareApi(token, fetcher) : null;
}

/**
 * The account this server runs in: CLOUDFLARE_ACCOUNT_ID when set; otherwise the only account the
 * token sees; otherwise the one whose Workers hold this server's script (a token that reaches
 * several accounts, workers/routing/accounts.ts).
 */
export async function accountIdFor(api: CloudflareApi, env: TokenEnv & { EMAIL_ROUTING_WORKER?: string }): Promise<string> {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  let ids: string[];
  try {
    ids = (await api.list<{ id: string }>("/accounts", "find your accounts (Account Settings: Read)")).map((a) => a.id);
  } catch {
    // Before 0.8 the token needed no Account Settings permission: its zones still name their account.
    ids = [...new Set((await api.call<{ account?: { id?: string } }[]>("/zones?per_page=50", { what: "list your domains (Zone: Read)" }))
      .map((z) => z.account?.id).filter((id): id is string => !!id))];
  }
  if (ids.length === 1) return ids[0]!;
  if (!ids.length) throw new CloudflareApiError("The token sees no Cloudflare account.", 400);
  const script = env.EMAIL_ROUTING_WORKER || "fabric-inbox";
  for (const id of ids) {
    const runs = await api.call(`/accounts/${id}/workers/scripts/${script}/settings`, { what: "read Workers (Workers Scripts: Edit)" }).then(() => true, () => false);
    if (runs) return id;
  }
  throw new CloudflareApiError(`The token sees ${ids.length} Cloudflare accounts and none of them runs the Worker ${script}; set CLOUDFLARE_ACCOUNT_ID on the server.`, 400);
}
