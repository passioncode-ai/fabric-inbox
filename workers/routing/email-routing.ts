/**
 * Cloudflare Email Routing, read and written with a token scoped to Email
 * Routing on the project zones (SCN-021). Every answer is one of three states;
 * a failure to read is "unknown", never "verified".
 *
 * Contract (Cloudflare API v4, checked 2026-09-28 against the OpenAPI spec):
 * GET /zones?name=, GET /zones/{id}/email/routing (enabled, status),
 * GET|POST /zones/{id}/email/routing/rules, GET /zones/{id}/email/routing/rules/catch_all.
 * A rule is {matchers:[{type:"literal",field:"to",value}], actions:[{type:"worker",value:[name]}], enabled}.
 */
import { CloudflareAccounts, type AccountsEnv } from "./accounts";
import { msg } from "../../shared/i18n";

export type RoutingState = "verified" | "missing" | "unknown";
export interface RoutingStatus {
  state: RoutingState;
  detail: string;
  /** How mail for the address is routed today, when readable. */
  via?: "rule" | "catch_all";
  ruleId?: string;
}

interface Matcher { type?: string; field?: string; value?: string }
interface Action { type?: string; value?: string[] }
interface Rule { id?: string; enabled?: boolean; matchers?: Matcher[]; actions?: Action[]; name?: string; priority?: number }
type Fetcher = typeof fetch;

const API = "https://api.cloudflare.com/client/v4";
/** A failure to read routing, with the step that fixes it by hand: one sentence, so it translates (L10N-04). */
const withDashboardStep = (error: string) =>
  msg("{error}. In the Cloudflare dashboard open the domain → Email → Email Routing → Routing rules, and send this address to the Worker.", { error });

export class RoutingError extends Error {}
/** The token cannot see the domain's zone: nothing can be read or changed there. */
export class ZoneNotVisible extends RoutingError {}

export interface RouteAction { type: "forward" | "worker" | "drop"; value?: string }
export interface DomainRouting {
  domain: string;
  /** The token can see the zone. */
  visible: boolean;
  enabled: boolean;
  rules: { address: string; enabled: boolean; action: RouteAction }[];
  catchAll: { enabled: boolean; action: RouteAction } | null;
}

/** SCN-061: what Cloudflare does with some addresses of a domain, and with the rest (its catch-all). */
export interface AddressRouting {
  domain: string;
  /** A token of this server can see the zone. */
  visible: boolean;
  enabled: boolean;
  /** Email Routing's own status ("ready", "misconfigured"…); "unknown" when the zone is not visible. */
  status: string;
  rules: { address: string; enabled: boolean; toHere: boolean; action: RouteAction }[];
  catchAll: { enabled: boolean; toHere: boolean; action: RouteAction } | null;
}

export class EmailRoutingClient {
  // A bare `fetch` stored on the instance throws "Illegal invocation" in workerd when called as this.fetcher.
  constructor(private token: string, private worker: string, private fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(API + path, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(init.headers || {}) },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new RoutingError(msg("Cloudflare API unreachable: {error}", { error: (error as Error).message }));
    }
    const body = (await response.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message?: string }[] } | null;
    if (!response.ok || !body?.success) {
      const message = body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
      throw new RoutingError(`Cloudflare API: ${message}`);
    }
    return body.result as T;
  }

  async zoneId(domain: string): Promise<string | null> {
    const zones = await this.call<{ id: string; name: string }[]>(`/zones?name=${encodeURIComponent(domain)}&per_page=5`);
    return zones.find((z) => z.name.toLowerCase() === domain.toLowerCase())?.id ?? null;
  }

  private async rules(zone: string): Promise<Rule[]> {
    const all: Rule[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.call<Rule[]>(`/zones/${zone}/email/routing/rules?per_page=50&page=${page}`);
      all.push(...batch);
      if (batch.length < 50) return all;
    }
    return all;
  }

  private toWorker(rule: Rule): boolean {
    return !!rule.actions?.some((a) => a.type === "worker" && a.value?.includes(this.worker));
  }

  private literalRule(rules: Rule[], address: string): Rule | undefined {
    return rules.find((r) => r.matchers?.some((m) => m.type === "literal" && m.field === "to" && m.value?.toLowerCase() === address));
  }

  async status(address: string): Promise<RoutingStatus> {
    const email = address.toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    try {
      const zone = await this.zoneId(domain);
      if (!zone) return { state: "unknown", detail: msg("The token cannot see the zone {domain}. Give it Zone read and Email Routing edit on this zone.", { domain }) };
      const settings = await this.call<{ enabled?: boolean; status?: string }>(`/zones/${zone}/email/routing`);
      if (!settings.enabled) return { state: "missing", detail: msg("Email Routing is off for {domain}. Enable it in the dashboard (Email → Email Routing).", { domain }) };
      if (settings.status && settings.status !== "ready")
        return { state: "missing", detail: msg("Email Routing for {domain} is {status}: its DNS records need fixing in the dashboard.", { domain, status: settings.status }) };
      const rule = this.literalRule(await this.rules(zone), email);
      // A disabled rule matches nothing: the catch-all decides (seen on the owner's
      // contact@ addresses, whose old forward rules were switched off, 2026-09-29).
      if (rule && rule.enabled !== false) {
        if (!this.toWorker(rule)) return { state: "missing", detail: msg("A routing rule sends {email} somewhere else. Point it at the Worker {worker}.", { email, worker: this.worker }), via: "rule", ruleId: rule.id };
        return { state: "verified", detail: msg("Mail for {email} goes to {worker}.", { email, worker: this.worker }), via: "rule", ruleId: rule.id };
      }
      const catchAll = await this.call<Rule>(`/zones/${zone}/email/routing/rules/catch_all`);
      if (catchAll.enabled && this.toWorker(catchAll))
        return { state: "verified", detail: rule
          ? msg("Mail for {email} reaches {worker} through the catch-all rule (its own rule is disabled).", { email, worker: this.worker })
          : msg("Mail for {email} reaches {worker} through the catch-all rule.", { email, worker: this.worker }), via: "catch_all" };
      if (rule) return { state: "missing", detail: msg("The routing rule for {email} is disabled and the catch-all does not send mail here.", { email }), via: "rule", ruleId: rule.id };
      return { state: "missing", detail: msg("No routing rule sends {email} to {worker}. Create one here or in the dashboard.", { email, worker: this.worker }) };
    } catch (error) {
      return { state: "unknown", detail: withDashboardStep((error as Error).message) };
    }
  }

  /**
   * What Email Routing does for a domain today: literal rules and the catch-all,
   * with their action. Used to turn an existing Cloudflare setup into mailboxes.
   */
  async inventory(domain: string): Promise<DomainRouting> {
    const zone = await this.zoneId(domain);
    if (!zone) return { domain, visible: false, enabled: false, rules: [], catchAll: null };
    const settings = await this.call<{ enabled?: boolean }>(`/zones/${zone}/email/routing`);
    if (!settings.enabled) return { domain, visible: true, enabled: false, rules: [], catchAll: null };
    const action = (r: Rule) => {
      const a = r.actions?.[0];
      return { type: (a?.type ?? "drop") as RouteAction["type"], value: a?.value?.[0] };
    };
    const rules = (await this.rules(zone)).flatMap((r) => {
      const m = r.matchers?.find((x) => x.type === "literal" && x.field === "to" && x.value);
      return m ? [{ address: m.value!.toLowerCase(), enabled: r.enabled !== false, action: action(r) }] : [];
    });
    const catchAll = await this.call<Rule>(`/zones/${zone}/email/routing/rules/catch_all`);
    return { domain, visible: true, enabled: true, rules, catchAll: { enabled: catchAll.enabled === true, action: action(catchAll) } };
  }

  /**
   * What Cloudflare does today with some addresses of one domain, read once for all of them
   * (SCN-061): whether the zone is visible, Email Routing's state, each address's literal rule with
   * whether it sends mail to this server's Worker, and the catch-all. Addresses without a rule are
   * left out of `rules`. Throws RoutingError when Cloudflare cannot be read.
   */
  async routingFor(domain: string, addresses: string[]): Promise<AddressRouting> {
    const name = domain.toLowerCase();
    const zone = await this.zoneId(name);
    if (!zone) return { domain: name, visible: false, enabled: false, status: "unknown", rules: [], catchAll: null };
    const settings = await this.call<{ enabled?: boolean; status?: string }>(`/zones/${zone}/email/routing`);
    const enabled = settings.enabled === true;
    const status = settings.status ?? (enabled ? "ready" : "unconfigured");
    if (!enabled) return { domain: name, visible: true, enabled, status, rules: [], catchAll: null };
    const all = await this.rules(zone);
    const action = (r: Rule): RouteAction => ({ type: (r.actions?.[0]?.type ?? "drop") as RouteAction["type"], value: r.actions?.[0]?.value?.[0] });
    const rules = addresses.map((a) => a.toLowerCase()).flatMap((address) => {
      const rule = this.literalRule(all, address);
      return rule ? [{ address, enabled: rule.enabled !== false, toHere: this.toWorker(rule), action: action(rule) }] : [];
    });
    const catchAll = await this.call<Rule>(`/zones/${zone}/email/routing/rules/catch_all`);
    return { domain: name, visible: true, enabled, status, rules,
      catchAll: { enabled: catchAll.enabled === true, toHere: this.toWorker(catchAll), action: action(catchAll) } };
  }

  /**
   * The inverse of createRule, used when an address is removed: deletes its
   * literal rule when that rule sends mail here; a rule sending it elsewhere is
   * left alone. Returns what happened, in words.
   */
  async deleteRule(address: string): Promise<string> {
    const email = address.toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const zone = await this.zoneId(domain);
    if (!zone) throw new ZoneNotVisible(msg("The token cannot see the zone {domain}", { domain }));
    const rule = this.literalRule(await this.rules(zone), email);
    if (!rule) return msg("No routing rule named {email}.", { email });
    if (!this.toWorker(rule)) return msg("The routing rule for {email} sends mail elsewhere; it was left as it is.", { email });
    await this.call(`/zones/${zone}/email/routing/rules/${rule.id}`, { method: "DELETE" });
    return msg("The routing rule for {email} was removed.", { email });
  }

  /** Creates the literal rule unless one for the address already exists (duplicates shadow each other). */
  async createRule(address: string): Promise<RoutingStatus> {
    return (await this.ensureRule(address)).status;
  }

  /**
   * The literal rule sends the address here: an enabled one is kept, a disabled one
   * pointing here is switched on, a missing one is created. `created` says whether this
   * call made the rule, so a caller that then fails can take it away again.
   */
  async ensureRule(address: string): Promise<{ status: RoutingStatus; created: boolean; ruleId?: string }> {
    const email = address.toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const zone = await this.zoneId(domain);
    if (!zone) throw new ZoneNotVisible(msg("The token cannot see the zone {domain}", { domain }));
    const existing = this.literalRule(await this.rules(zone), email);
    if (existing) {
      if (!this.toWorker(existing))
        throw new RoutingError(msg("A routing rule for {email} already exists and sends mail elsewhere; change it in the dashboard", { email }));
      if (existing.enabled === false)
        await this.call(`/zones/${zone}/email/routing/rules/${existing.id}`, { method: "PUT", body: JSON.stringify({
          name: existing.name || `Fabric Inbox: ${email}`, enabled: true, priority: existing.priority ?? 0, matchers: existing.matchers, actions: existing.actions }) });
      return { status: await this.status(email), created: false, ruleId: existing.id };
    }
    const made = await this.call<{ id?: string }>(`/zones/${zone}/email/routing/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: `Fabric Inbox: ${email}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: email }],
        actions: [{ type: "worker", value: [this.worker] }],
      }),
    });
    return { status: await this.status(email), created: true, ruleId: made?.id };
  }
}

/** What callers use: the single-token client above, or one that finds each domain's account. */
export type RoutingClient = Pick<EmailRoutingClient, "status" | "inventory" | "deleteRule" | "createRule" | "ensureRule" | "routingFor">;

/**
 * Email Routing across every account the server has a token for (MA-4): each address is worked on
 * with the token of its domain's account, and "here" means the Worker that receives in that account
 * — the server in its own, the relay in any other.
 */
export class AccountsRoutingClient implements RoutingClient {
  constructor(private accounts: CloudflareAccounts, private fetcher?: Fetcher) {}

  private async client(address: string): Promise<EmailRoutingClient | null> {
    const email = address.toLowerCase();
    const ctx = await this.accounts.zone(email.slice(email.lastIndexOf("@") + 1));
    return ctx ? new EmailRoutingClient(ctx.token, ctx.worker, this.fetcher) : null;
  }

  async status(address: string): Promise<RoutingStatus> {
    const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
    try {
      const client = await this.client(address);
      if (!client) return { state: "unknown", detail: msg("The server's tokens cannot see the zone {domain}. Connect its account in Settings → Accounts.", { domain }) };
      return client.status(address);
    } catch (error) {
      return { state: "unknown", detail: withDashboardStep((error as Error).message) };
    }
  }

  async inventory(domain: string): Promise<DomainRouting> {
    const client = await this.client(`x@${domain}`).catch((e) => { throw new RoutingError((e as Error).message); });
    return client ? client.inventory(domain) : { domain, visible: false, enabled: false, rules: [], catchAll: null };
  }

  async routingFor(domain: string, addresses: string[]): Promise<AddressRouting> {
    const client = await this.client(`x@${domain}`).catch((e) => { throw new RoutingError((e as Error).message); });
    return client ? client.routingFor(domain, addresses) : { domain: domain.toLowerCase(), visible: false, enabled: false, status: "unknown", rules: [], catchAll: null };
  }

  async deleteRule(address: string): Promise<string> {
    const client = await this.client(address).catch((e) => { throw new RoutingError((e as Error).message); });
    if (!client) throw new ZoneNotVisible(msg("The server's tokens cannot see the zone {domain}", { domain: address.slice(address.lastIndexOf("@") + 1) }));
    return client.deleteRule(address);
  }

  async createRule(address: string): Promise<RoutingStatus> {
    return (await this.ensureRule(address)).status;
  }

  async ensureRule(address: string): Promise<{ status: RoutingStatus; created: boolean; ruleId?: string }> {
    const client = await this.client(address).catch((e) => { throw new RoutingError((e as Error).message); });
    if (!client) throw new ZoneNotVisible(msg("The server's tokens cannot see the zone {domain}", { domain: address.slice(address.lastIndexOf("@") + 1) }));
    return client.ensureRule(address);
  }
}

export function routingClient(env: AccountsEnv, fetcher?: Fetcher): RoutingClient | null {
  const accounts = new CloudflareAccounts(env, fetcher);
  return accounts.connected ? new AccountsRoutingClient(accounts, fetcher) : null;
}

export const ROUTING_NOT_CONFIGURED: RoutingStatus = {
  state: "unknown",
  detail: msg("Routing cannot be read: this server has no Cloudflare token yet (Settings → Domains → Connect Cloudflare). In the Cloudflare dashboard open the domain → Email → Email Routing → Routing rules, and send this address to the Worker."),
};
