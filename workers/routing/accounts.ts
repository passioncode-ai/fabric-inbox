import { accountIdFor, CloudflareApi, CloudflareApiError, cloudflareToken, type TokenEnv } from "./cloudflare-api";

/**
 * Several Cloudflare accounts (MA-2…MA-5, docs/app-store/tasks/2026-09-30-cloudflare-accounts.md).
 *
 * The server holds one token of its own (`CLOUDFLARE_API_TOKEN`) and one more per account a person
 * connected, each a Worker secret named `CLOUDFLARE_API_TOKEN_<account id>`. The environment is the
 * registry: what Cloudflare holds as the Worker's secrets is exactly what is read here, so there is
 * no second list to drift from it.
 *
 * Contracts (Cloudflare API v4, read from the OpenAPI spec 2026-09-30):
 *  GET  /accounts                                        accounts a token can use
 *  GET  /zones?account.id=&status=active                 an account's domains
 *  GET  /accounts/{a}/email/routing/rules?enabled=true   whether the account routes any mail
 *  GET  /accounts/{a}/workers/scripts/{s}/settings       which account runs this server
 *  PUT|DELETE /accounts/{a}/workers/scripts/{s}/secrets  keeping a connected account's token
 */
export const ACCOUNT_TOKEN_PREFIX = "CLOUDFLARE_API_TOKEN_";
/** The Worker that carries mail from another account's domains to this server (M3). */
export const RELAY_WORKER = "fabric-inbox-relay";
export const ACCOUNT_CHOICES_KEY = "config/cloudflare-accounts.json";
export const DOMAIN_ACCOUNTS_KEY = "config/domain-accounts.json";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
export const isAccountId = (id: string) => ACCOUNT_ID.test(id);
export const accountTokenName = (accountId: string) => ACCOUNT_TOKEN_PREFIX + accountId;

type Fetcher = typeof fetch;
export interface AccountsEnv extends TokenEnv {
  EMAIL_ROUTING_WORKER?: string;
  BUCKET: R2Bucket;
}

export interface TokenRef {
  /** The secret's name: which token this is, never its value. */
  name: string;
  token: string;
  /** Set for a token saved for one account. */
  accountId?: string;
}

/** The server's own token first, then every token saved for an account. */
export function tokensOf(env: TokenEnv): TokenRef[] {
  const out: TokenRef[] = [];
  const primary = cloudflareToken(env);
  if (primary) out.push({ name: env.CLOUDFLARE_API_TOKEN ? "CLOUDFLARE_API_TOKEN" : "CLOUDFLARE_EMAIL_ROUTING_TOKEN", token: primary });
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (!name.startsWith(ACCOUNT_TOKEN_PREFIX) || typeof value !== "string" || !value.trim()) continue;
    const accountId = name.slice(ACCOUNT_TOKEN_PREFIX.length);
    if (isAccountId(accountId)) out.push({ name, token: value.trim(), accountId });
  }
  return out;
}

export interface Account {
  id: string;
  name: string;
  /** The account this server runs in. */
  server: boolean;
  /** The token that reaches it: the server's own, or one saved for this account. */
  via: "server" | "account";
}

export interface Zone { id: string; name: string; status: string; account?: { id?: string; name?: string } }
export interface ZoneContext {
  zone: Zone;
  accountId: string;
  /** The token that sees this zone, as a client and as the value for a client of its own. */
  api: CloudflareApi;
  token: string;
  /** The Worker Email Routing rules on this zone send mail to. */
  worker: string;
  /** The zone is in the account this server runs in. */
  server: boolean;
}

export type Choice = "shown" | "hidden";

/** The operator's choices, read defensively: an unreadable file is no choice at all. */
export async function readChoices(bucket: R2Bucket): Promise<{ choices: Record<string, Choice>; etag: string | null }> {
  const object = await bucket.get(ACCOUNT_CHOICES_KEY);
  if (!object) return { choices: {}, etag: null };
  const raw = await object.json<{ choices?: Record<string, unknown> }>().catch(() => null);
  const choices: Record<string, Choice> = {};
  for (const [id, value] of Object.entries(raw?.choices ?? {})) if (value === "shown" || value === "hidden") choices[id] = value;
  return { choices, etag: object.etag };
}

/** Written conditionally on the version read, so two changes at once never lose one. */
export async function writeChoice(bucket: R2Bucket, accountId: string, choice: Choice | null): Promise<Record<string, Choice>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { choices, etag } = await readChoices(bucket);
    const next = { ...choices };
    if (choice) next[accountId] = choice; else delete next[accountId];
    const written = await bucket.put(ACCOUNT_CHOICES_KEY, JSON.stringify({ choices: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: etag ? { etagMatches: etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new Error("The account choices changed several times at once; try again");
}

/** Which account each domain was last seen in. A cache: a miss or a stale row is looked up again. */
export async function readDomainAccounts(bucket: R2Bucket): Promise<Record<string, string>> {
  const object = await bucket.get(DOMAIN_ACCOUNTS_KEY).catch(() => null);
  if (!object) return {};
  const raw = await object.json<Record<string, unknown>>().catch(() => null);
  return Object.fromEntries(Object.entries(raw ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
}

async function rememberDomainAccounts(bucket: R2Bucket, update: Record<string, string>) {
  const current = await readDomainAccounts(bucket);
  if (Object.entries(update).every(([d, a]) => current[d] === a)) return;
  // Last writer wins on a cache: the next lookup corrects anything a race left behind.
  await bucket.put(DOMAIN_ACCOUNTS_KEY, JSON.stringify({ ...current, ...update }), { httpMetadata: { contentType: "application/json" } })
    .catch((error: unknown) => console.warn(JSON.stringify({ event: "domain_accounts_unsaved", error: (error as Error).message })));
}

const errorText = (e: unknown) => (e instanceof CloudflareApiError ? e.message : (e as Error).message);

/**
 * Every account the server's tokens reach, and which token and Worker a domain uses. One instance
 * serves one request: its reads are remembered for the length of it.
 */
export class CloudflareAccounts {
  readonly tokens: TokenRef[];
  private apis = new Map<string, CloudflareApi>();
  private listing?: Promise<{ accounts: Account[]; problems: string[] }>;
  private serverId?: Promise<string>;

  constructor(readonly env: AccountsEnv, private fetcher?: Fetcher) {
    this.tokens = tokensOf(env);
  }

  get connected() { return this.tokens.length > 0; }
  get script() { return this.env.EMAIL_ROUTING_WORKER || "fabric-inbox"; }

  private apiOf(ref: TokenRef): CloudflareApi {
    let api = this.apis.get(ref.name);
    if (!api) this.apis.set(ref.name, (api = new CloudflareApi(ref.token, this.fetcher)));
    return api;
  }

  /** The server's own token. */
  primary(): CloudflareApi | null {
    const ref = this.tokens.find((t) => !t.accountId);
    return ref ? this.apiOf(ref) : null;
  }

  /** The accounts each token sees; a token saved for an account wins over the server's token there. */
  list(): Promise<{ accounts: Account[]; problems: string[] }> {
    return (this.listing ??= this.readAccounts());
  }

  private async readAccounts() {
    const problems: string[] = [];
    const found = new Map<string, { id: string; name: string; via: Account["via"] }>();
    for (const ref of this.tokens) {
      let seen: { id: string; name: string }[];
      try {
        seen = await this.apiOf(ref).list<{ id: string; name: string }>("/accounts", "find your accounts (Account Settings: Read)");
      } catch (error) {
        if (ref.accountId) { problems.push(`The token saved for account ${ref.accountId} could not be used: ${errorText(error)}`); continue; }
        // Before 0.8 the token needed no Account Settings permission: its zones still name their account.
        try {
          seen = (await this.apiOf(ref).call<Zone[]>("/zones?per_page=50", { what: "list your domains (Zone: Read)" }))
            .flatMap((z) => (z.account?.id ? [{ id: z.account.id, name: z.account.name ?? z.account.id }] : []));
        } catch (inner) { problems.push(errorText(inner)); continue; }
      }
      if (ref.accountId && !seen.some((a) => a.id === ref.accountId))
        problems.push(`The token saved for account ${ref.accountId} no longer sees that account; connect it again with a new token.`);
      for (const a of seen) {
        const via: Account["via"] = ref.accountId === a.id ? "account" : "server";
        const prior = found.get(a.id);
        if (!prior || (prior.via === "server" && via === "account")) found.set(a.id, { id: a.id, name: a.name || a.id, via });
      }
    }
    let serverId: string | null = null;
    try { serverId = await this.serverAccountId(); } catch (error) { if (found.size > 1) problems.push(errorText(error)); }
    const accounts = [...found.values()]
      .map((a) => ({ ...a, server: a.id === serverId }))
      .sort((a, b) => Number(b.server) - Number(a.server) || a.name.localeCompare(b.name));
    return { accounts, problems };
  }

  /** The token to use for an account: its own when one was saved, else the server's when that sees it. */
  async apiFor(accountId: string): Promise<CloudflareApi | null> {
    const own = this.tokens.find((t) => t.accountId === accountId);
    if (own) return this.apiOf(own);
    const { accounts } = await this.list();
    return accounts.some((a) => a.id === accountId && a.via === "server") ? this.primary() : null;
  }

  /**
   * CLOUDFLARE_ACCOUNT_ID when set; otherwise the only account the server's token sees; otherwise
   * the account whose Workers hold this server's script.
   */
  serverAccountId(): Promise<string> {
    return (this.serverId ??= (async () => {
      if (this.env.CLOUDFLARE_ACCOUNT_ID) return this.env.CLOUDFLARE_ACCOUNT_ID;
      const api = this.primary();
      if (!api) throw new CloudflareApiError("This server has no Cloudflare token of its own.", 400);
      return accountIdFor(api, this.env);
    })());
  }

  workerFor(accountId: string, serverId: string) {
    return accountId === serverId ? this.script : RELAY_WORKER;
  }

  /** An account's active domains. */
  zonesOf(accountId: string, api: CloudflareApi): Promise<Zone[]> {
    return api.list<Zone>(`/zones?status=active&account.id=${encodeURIComponent(accountId)}`, "list your domains (Zone: Read)");
  }

  /** Whether the account routes any mail: one enabled routing rule is enough. */
  async routesMail(accountId: string, api: CloudflareApi): Promise<boolean> {
    const rules = await api.call<unknown[]>(`/accounts/${accountId}/email/routing/rules?enabled=true&per_page=5`, { what: "see whether the account has mail (Account: Email Routing Account Rules: Read)" });
    return rules.length > 0;
  }

  /** Remembers where each domain lives, for sending and for the relay's check. */
  remember(zones: { name: string; accountId: string }[]) {
    return rememberDomainAccounts(this.env.BUCKET, Object.fromEntries(zones.map((z) => [z.name.toLowerCase(), z.accountId])));
  }

  /**
   * The zone of a domain, with the account, token and Worker that go with it. The account it was last
   * seen in is asked first; then every token. Null when no token sees it; a Cloudflare failure throws.
   */
  async zone(domain: string): Promise<ZoneContext | null> {
    const name = domain.toLowerCase();
    const serverId = await this.serverAccountId().catch(() => "");
    const remembered = (await readDomainAccounts(this.env.BUCKET))[name];
    const tried = new Set<string>();
    const lookUp = async (ref: TokenRef) => {
      if (tried.has(ref.name)) return null;
      tried.add(ref.name);
      const api = this.apiOf(ref);
      const found = await api.call<Zone[]>(`/zones?name=${encodeURIComponent(name)}&per_page=5`, { what: "read the domain (Zone: Read)" });
      const zone = found.find((z) => z.name.toLowerCase() === name);
      return zone ? { zone, api, token: ref.token } : null;
    };
    let hit: { zone: Zone; api: CloudflareApi; token: string } | null = null;
    let failure: unknown = null;
    if (remembered) {
      const own = this.tokens.find((t) => t.accountId === remembered);
      if (own) hit = await lookUp(own).catch((e) => { failure = e; return null; });
    }
    for (const ref of [...this.tokens].sort((a, b) => Number(!!b.accountId) - Number(!!a.accountId))) {
      if (hit) break;
      hit = await lookUp(ref).catch((e) => { failure ??= e; return null; });
    }
    if (!hit) { if (failure) throw failure; return null; }
    const accountId = hit.zone.account?.id ?? serverId;
    if (accountId) await this.remember([{ name, accountId }]);
    // A token saved for the zone's own account is preferred over one that merely sees it.
    const own = this.tokens.find((t) => t.accountId === accountId);
    return { zone: hit.zone, accountId, api: own ? this.apiOf(own) : hit.api, token: own ? own.token : hit.token,
      worker: this.workerFor(accountId, serverId), server: accountId === serverId };
  }
}
