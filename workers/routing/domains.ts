import type { Env } from "../types";
import { CloudflareApiError } from "./cloudflare-api";
import { CloudflareAccounts, readChoices, type Account, type Choice, type Zone, type ZoneContext } from "./accounts";
import { installRelay, type RelayInstallResult } from "../relay/install";
import type { DomainRouting, RouteAction } from "./email-routing";
import { setupFromRouting } from "./to-setup";
import { applySetup } from "../lib/apply-setup";
import {
  addServedDomains, allServedDomains, readAllSettings, removeCatchAll, removeServedDomain,
  servedDomains, setCatchAll, storedCatchAll, updateSettings,
} from "../lib/mailbox-store";
import { msg } from "../../shared/i18n";

/**
 * Settings → Domains (CF-2, SCR-02, MA-4): what each zone of the connected
 * Cloudflare accounts does with mail, and the idempotent steps that move a
 * domain's mail to this server and back. Every zone is worked on with the token
 * of its own account; a zone outside the server's account sends its mail to the
 * relay Worker in that account (workers/relay/).
 *
 * Contracts (Cloudflare API v4, read from the OpenAPI spec 2026-09-28):
 *  GET  /zones                                     zones visible to the token
 *  GET  /zones/{z}/email/routing                   {enabled, status: ready|unconfigured|misconfigured…}
 *  POST /zones/{z}/email/routing/dns               enable: adds and locks Cloudflare's MX + SPF
 *  GET|PUT /zones/{z}/email/routing/rules[/{id}|/catch_all]
 *  GET|POST /zones/{z}/email/sending/subdomains    sending on a (sub)domain; adds cf-bounce records
 *  GET|POST|DELETE /zones/{z}/dns_records          MX conflicts, DMARC
 *  GET|POST /accounts/{a}/email/routing/addresses  destinations a copy may be forwarded to
 */

export type { Zone } from "./accounts";
interface Rule {
  id?: string; tag?: string; name?: string; enabled?: boolean; priority?: number;
  matchers?: { type?: string; field?: string; value?: string }[];
  actions?: { type?: string; value?: string[] }[];
}
interface DnsRecord { id: string; type: string; name: string; content: string; priority?: number }
export interface Destination { id: string; email: string; verified: string | null; status?: string }

export interface RuleView { id: string; address: string; enabled: boolean; action: RouteAction; toThisServer: boolean }
export interface DomainDetail {
  domain: string;
  zoneId: string;
  /** The Cloudflare account the domain is in, and whether the server runs there. */
  account: { id: string; server: boolean };
  served: boolean;
  /** Served through the deployment's DOMAINS, so it cannot be released from here. */
  fixed: boolean;
  routing: { enabled: boolean; status: string };
  /** MX hosts of another provider: turning routing on replaces them. */
  foreignMx: string[];
  rules: RuleView[];
  catchAll: { enabled: boolean; action: RouteAction; toThisServer: boolean } | null;
  /** The mailbox that keeps mail for addresses without one, on this server. */
  catchAllMailbox: string | null;
  sending: { enabled: boolean };
  dmarc: string | null;
  /** Parts that could not be read, each with what to do. The rest is still true. */
  problems: string[];
}

export type StepOutcome = "done" | "already" | "skipped" | "failed";
export interface Step { id: string; label: string; outcome: StepOutcome; detail: string }
export interface ConnectResult { domain: string; steps: Step[]; needsConfirmation?: { foreignMx?: string[]; zoneNotVisible?: boolean } }

const CLOUDFLARE_MX = /(^|\.)mx\.cloudflare\.net\.?$/i;
const address = (r: Rule) => r.matchers?.find((m) => m.type === "literal" && m.field === "to" && m.value)?.value?.toLowerCase();
const actionOf = (r: Rule): RouteAction => ({ type: (r.actions?.[0]?.type ?? "drop") as RouteAction["type"], value: r.actions?.[0]?.value?.[0] });
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const errorText = (e: unknown) => (e instanceof CloudflareApiError ? e.message : msg("Unexpected error: {error}", { error: (e as Error).message }));

/** What bringing a domain's addresses in did, one whole sentence per case so it translates (L10N-04). */
function addressesHere(n: number, created: number, updated: number): string {
  if (n === 1)
    return created ? msg("1 address here, 1 new; each keeps forwarding a copy where its mail went before.")
      : updated ? msg("1 address here, 1 updated; each keeps forwarding a copy where its mail went before.")
        : msg("1 address here; each keeps forwarding a copy where its mail went before.");
  if (created && updated) return msg("{n} addresses here, {created} new, {updated} updated; each keeps forwarding a copy where its mail went before.", { n, created, updated });
  if (created) return msg("{n} addresses here, {created} new; each keeps forwarding a copy where its mail went before.", { n, created });
  if (updated) return msg("{n} addresses here, {updated} updated; each keeps forwarding a copy where its mail went before.", { n, updated });
  return msg("{n} addresses here; each keeps forwarding a copy where its mail went before.", { n });
}

export interface AccountView extends Account {
  /** Shown on Settings → Domains: the operator's choice, else the server's account, else having mail. */
  shown: boolean;
  choice: Choice | null;
  /** null when it could not be read (then the account counts as having mail: showing is harmless). */
  hasMail: boolean | null;
  domains: number;
  served: number;
  problem?: string;
}
export interface Overview {
  accounts: AccountView[];
  zones: { zone: Zone; accountId: string }[];
  problems: string[];
}

const toWorker = (r: Pick<Rule, "actions">, worker: string) => !!r.actions?.some((a) => a.type === "worker" && a.value?.includes(worker));

export class DomainManager {
  constructor(readonly accounts: CloudflareAccounts, private env: Env) {}

  /**
   * Every account the tokens reach with its domains, whether it has mail and whether it is shown.
   * An account that cannot be read is listed with its problem; the others still list.
   */
  async overview(): Promise<Overview> {
    const problems0: string[] = [];
    const [{ accounts, problems }, choices, served] = await Promise.all([
      this.accounts.list(),
      // An unreadable choices file is no choice at all: every account falls back to its default.
      readChoices(this.env.BUCKET).then((c) => c.choices, (e) => { problems0.push(msg("Your account choices could not be read ({error}); the defaults apply.", { error: (e as Error).message })); return {} as Record<string, Choice>; }),
      allServedDomains(this.env),
    ]);
    // A copy: the listing is remembered for the request, and must not grow with each overview.
    const allProblems = [...new Set([...problems, ...problems0])];
    const zones: Overview["zones"] = [];
    const views = await Promise.all(accounts.map(async (a): Promise<AccountView> => {
      const api = await this.accounts.apiFor(a.id);
      const base = { ...a, choice: choices[a.id] ?? null, domains: 0, served: 0 };
      if (!api) return { ...base, shown: choices[a.id] !== "hidden", hasMail: null, problem: a.problem ?? msg("No token reaches this account any more.") };
      // Its token is known to be broken: nothing more to read, and it stays removable.
      if (a.problem) return { ...base, shown: choices[a.id] !== "hidden", hasMail: null };
      const [own, routes] = await Promise.all([
        this.accounts.zonesOf(a.id, api).then((z) => ({ zones: z }), (e) => ({ error: errorText(e) })),
        this.accounts.routesMail(a.id, api).then((r) => ({ routes: r }), (e) => ({ error: errorText(e) })),
      ]);
      const list = "zones" in own ? own.zones : [];
      for (const zone of list) zones.push({ zone, accountId: a.id });
      const servedHere = list.filter((z) => served.includes(z.name.toLowerCase())).length;
      const hasMail = servedHere > 0 || ("routes" in routes ? routes.routes : null);
      const shown = base.choice ? base.choice === "shown" : a.server || hasMail !== false;
      const problem = "error" in own && "error" in routes
        ? msg("Its domains could not be read: {error} Whether it has mail could not be read: {mailError}", { error: own.error, mailError: routes.error })
        : "error" in own ? msg("Its domains could not be read: {error}", { error: own.error })
          : "error" in routes ? msg("Whether it has mail could not be read: {error}", { error: routes.error }) : undefined;
      return { ...base, domains: list.length, served: servedHere, hasMail, shown, ...(problem ? { problem } : {}) };
    }));
    await this.accounts.remember(zones.map((z) => ({ name: z.zone.name, accountId: z.accountId })));
    return { accounts: views, zones, problems: allProblems };
  }

  zone(domain: string): Promise<ZoneContext | null> {
    return this.accounts.zone(domain);
  }

  private rules(ctx: ZoneContext) {
    return ctx.api.list<Rule>(`/zones/${ctx.zone.id}/email/routing/rules`, msg("read routing rules (Email Routing Rules: Edit)"));
  }

  private async mx(ctx: ZoneContext): Promise<DnsRecord[]> {
    return ctx.api.list<DnsRecord>(`/zones/${ctx.zone.id}/dns_records?type=MX`, msg("read DNS records (DNS: Edit)"), 100, 2);
  }

  async detail(domain: string): Promise<DomainDetail | null> {
    const ctx = await this.zone(domain);
    if (!ctx) return null;
    const { zone, api } = ctx;
    const served = (await allServedDomains(this.env)).includes(domain);
    const problems: string[] = [];
    const attempt = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn(); } catch (e) { problems.push(errorText(e)); return fallback; }
    };
    const settings = await attempt(() => api.call<{ enabled?: boolean; status?: string }>(`/zones/${zone.id}/email/routing`, { what: msg("read Email Routing (Email Routing Rules: Edit)") }), {});
    const enabled = settings.enabled === true;
    const [rules, catchAll, mx, sending, dmarc, stored] = await Promise.all([
      enabled ? attempt(() => this.rules(ctx), [] as Rule[]) : Promise.resolve([] as Rule[]),
      enabled ? attempt(() => api.call<Rule>(`/zones/${zone.id}/email/routing/rules/catch_all`, { what: msg("read the catch-all rule (Email Routing Rules: Edit)") }), null) : Promise.resolve(null),
      attempt(() => this.mx(ctx), [] as DnsRecord[]),
      attempt(() => api.call<{ name: string; enabled?: boolean }[]>(`/zones/${zone.id}/email/sending/subdomains`, { what: msg("read Email Sending (Account: Email Sending: Edit)") }), []),
      attempt(() => api.call<DnsRecord[]>(`/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent("_dmarc." + domain)}`, { what: msg("read DNS records (DNS: Edit)") }), []),
      storedCatchAll(this.env.BUCKET),
    ]);
    return {
      domain, zoneId: zone.id, account: { id: ctx.accountId, server: ctx.server }, served, fixed: servedDomains(this.env).includes(domain),
      routing: { enabled, status: settings.status ?? (enabled ? "ready" : "unconfigured") },
      foreignMx: mx.filter((r) => !CLOUDFLARE_MX.test(r.content)).map((r) => r.content),
      rules: rules.flatMap((r) => {
        const a = address(r);
        return a ? [{ id: r.id ?? r.tag ?? "", address: a, enabled: r.enabled !== false, action: actionOf(r), toThisServer: toWorker(r, ctx.worker) }] : [];
      }),
      catchAll: catchAll ? { enabled: catchAll.enabled === true, action: actionOf(catchAll), toThisServer: toWorker(catchAll, ctx.worker) } : null,
      catchAllMailbox: stored[domain] ?? null,
      sending: { enabled: sending.some((s) => s.name.toLowerCase() === domain && s.enabled !== false) },
      dmarc: dmarc.find((r) => /v=DMARC1/i.test(r.content))?.content.replace(/^"|"$/g, "") ?? null,
      problems,
    };
  }

  /**
   * Moves a domain's mail here, one idempotent step at a time: routing on
   * (another provider's MX is replaced only with `replaceMx`), the domain
   * served, one mailbox per active address keeping its old destination as a
   * forwarded copy, each rule pointed at this Worker, then sending and DMARC.
   * Running it again finishes whatever a failure interrupted.
   */
  async connect(domain: string, options: { replaceMx?: boolean; sending?: boolean; origin?: string } = {}): Promise<ConnectResult> {
    const steps: Step[] = [];
    const step = (id: string, label: string, outcome: StepOutcome, detail: string) => { steps.push({ id, label, outcome, detail }); return outcome !== "failed"; };
    const ctx = await this.zone(domain).catch((e) => { step("zone", msg("Find the domain"), "failed", errorText(e)); return undefined; });
    if (ctx === undefined) return { domain, steps };
    if (!ctx) { step("zone", msg("Find the domain"), "failed", msg("{domain} is not a domain in any Cloudflare account this server has a token for.", { domain })); return { domain, steps }; }
    const { zone, api } = ctx;

    // 1. Email Routing on
    try {
      const settings = await api.call<{ enabled?: boolean; status?: string }>(`/zones/${zone.id}/email/routing`, { what: msg("read Email Routing (Email Routing Rules: Edit)") });
      if (settings.enabled && settings.status === "ready") step("routing", msg("Turn on Email Routing"), "already", msg("Email Routing is on."));
      else {
        const foreign = (await this.mx(ctx)).filter((r) => !CLOUDFLARE_MX.test(r.content));
        if (foreign.length && !options.replaceMx)
          return { domain, steps, needsConfirmation: { foreignMx: foreign.map((r) => r.content) } };
        for (const record of foreign)
          await api.call(`/zones/${zone.id}/dns_records/${record.id}`, { method: "DELETE", what: msg("remove the old MX records (DNS: Edit)") });
        // No body: the zone's own domain is the default, and `name` is accepted only for a subdomain
        // ("Invalid Input: must be a subdomains of …", seen on an owner domain 2026-09-30).
        await api.call(`/zones/${zone.id}/email/routing/dns`, { method: "POST", what: msg("turn on Email Routing (Zone Settings: Edit)") });
        step("routing", msg("Turn on Email Routing"), "done", foreign.length
          ? msg("Email Routing is on; the MX records of {hosts} were replaced.", { hosts: [...new Set(foreign.map((r) => r.content))].join(", ") })
          : msg("Email Routing is on. New MX records can take a few minutes to be seen everywhere."));
      }
    } catch (e) { step("routing", msg("Turn on Email Routing"), "failed", errorText(e)); return { domain, steps }; }

    // 1b. A zone in another account cannot send mail to a Worker here: the relay there carries it (MA-6).
    if (!ctx.server) {
      const relay = await this.relay(ctx, options.origin);
      step("relay", msg("Carry the mail from its account"), relay.outcome, relay.detail);
      if (relay.outcome === "failed") return { domain, steps };
    }

    // 2. Served here
    try {
      const added = await addServedDomains(this.env, [domain]);
      step("serve", msg("Receive for the domain here"), added.length ? "done" : "already", added.length ? msg("This server now accepts mail for {domain}.", { domain }) : msg("{domain} was already served here.", { domain }));
    } catch (e) { step("serve", msg("Receive for the domain here"), "failed", msg("The domain list could not be saved: {error}", { error: (e as Error).message })); return { domain, steps }; }

    // 3. One mailbox per active address, keeping its old destination as a copy
    let rules: Rule[]; let catchAll: Rule;
    try {
      [rules, catchAll] = await Promise.all([
        this.rules(ctx),
        api.call<Rule>(`/zones/${zone.id}/email/routing/rules/catch_all`, { what: msg("read the catch-all rule (Email Routing Rules: Edit)") }),
      ]);
    } catch (e) { step("addresses", msg("Bring the addresses in"), "failed", errorText(e)); return { domain, steps }; }
    // A rule or catch-all that sends mail to another Worker belongs to that Worker: it is
    // left as it is and gets no mailbox here (audit finding 3).
    const otherWorker = (r: Rule) => actionOf(r).type === "worker" && !toWorker(r, ctx.worker);
    const leftAlone = rules.filter((r) => r.enabled !== false && otherWorker(r)).map((r) => address(r)).filter((a): a is string => !!a);
    if (catchAll.enabled && otherWorker(catchAll)) leftAlone.push(msg("every other address on {domain}", { domain }));
    const inventory: DomainRouting = {
      domain, visible: true, enabled: true,
      rules: rules.filter((r) => !otherWorker(r)).flatMap((r) => { const a = address(r); return a ? [{ address: a, enabled: r.enabled !== false, action: actionOf(r) }] : []; }),
      catchAll: otherWorker(catchAll) ? { enabled: false, action: { type: "drop" } } : { enabled: catchAll.enabled === true, action: actionOf(catchAll) },
    };
    const setup = setupFromRouting([inventory], { origin: "https://this-server.invalid" });
    // The catch-all chosen here stays chosen: no second catch-all mailbox is made.
    const chosenCatchAll = (await storedCatchAll(this.env.BUCKET))[domain];
    if (chosenCatchAll) {
      const extra = setup.catchAll.find((c) => c.domain === domain)?.mailbox;
      if (extra && extra !== chosenCatchAll) setup.mailboxes = setup.mailboxes.filter((m) => m.address !== extra);
      setup.catchAll = setup.catchAll.filter((c) => c.domain !== domain);
    }
    // The addresses left to another Worker follow the step's own sentence: "{detail} Left as they are …".
    const aside = (detail: string) => (leftAlone.length ? msg("{detail} Left as they are (sent to another Worker): {left}.", { detail, left: leftAlone.join(", ") }) : detail);
    const allServed = new Set(await allServedDomains(this.env));
    for (const m of setup.mailboxes) if (m.forwardTo && allServed.has(domainOf(m.forwardTo))) delete m.forwardTo; // would loop
    if (!setup.mailboxes.length) step("addresses", msg("Bring the addresses in"), "skipped", aside(msg("No active address on this domain yet. Add one below.")));
    else {
      try {
        const applied = await applySetup(this.env, { ...setup, domains: [domain] });
        const created = applied.mailboxes.filter((m) => m.outcome === "created").length;
        const updated = applied.mailboxes.filter((m) => m.outcome === "updated").length;
        const refused = applied.mailboxes.filter((m) => m.outcome === "refused");
        if (refused.length) { step("addresses", msg("Bring the addresses in"), "failed", refused.map((r) => `${r.address}: ${r.reason}`).join("; ")); return { domain, steps }; }
        step("addresses", msg("Bring the addresses in"), created || updated ? "done" : "already",
          aside(addressesHere(applied.mailboxes.length, created, updated)));
      } catch (e) { step("addresses", msg("Bring the addresses in"), "failed", msg("The addresses could not be saved: {error}", { error: (e as Error).message })); return { domain, steps }; }
    }

    // 4. Rules point at this Worker (mailboxes exist first, so no message is refused in between)
    const moved: string[] = [];
    try {
      for (const r of rules) {
        const a = address(r);
        if (!a || r.enabled === false || actionOf(r).type === "worker" || actionOf(r).type === "drop") continue;
        await api.call(`/zones/${zone.id}/email/routing/rules/${r.id ?? r.tag}`, {
          method: "PUT", what: msg("change routing rules (Email Routing Rules: Edit)"),
          body: { name: r.name || `Fabric Inbox: ${a}`, enabled: true, priority: r.priority ?? 0, matchers: r.matchers, actions: [{ type: "worker", value: [ctx.worker] }] },
        });
        moved.push(a);
      }
      if (catchAll.enabled && actionOf(catchAll).type !== "drop" && actionOf(catchAll).type !== "worker") {
        await api.call(`/zones/${zone.id}/email/routing/rules/catch_all`, {
          method: "PUT", what: msg("change the catch-all rule (Email Routing Rules: Edit)"),
          body: { name: catchAll.name || "Catch-all", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [ctx.worker] }] },
        });
        moved.push(msg("every other address on {domain}", { domain }));
      }
      step("rules", msg("Send the mail here"), moved.length ? "done" : "already", moved.length ? msg("Now arriving here: {addresses}.", { addresses: moved.join(", ") }) : msg("Every active address already arrives here."));
    } catch (e) {
      step("rules", msg("Send the mail here"), "failed", moved.length
        ? msg("{error} Already moved: {moved}. Running this again continues from here.", { error: errorText(e), moved: moved.join(", ") })
        : msg("{error} Running this again continues from here.", { error: errorText(e) }));
      return { domain, steps };
    }

    // 5–6. Sending and DMARC: failures are reported, receiving already works
    if (options.sending !== false) steps.push(...await this.enableSending(domain, ctx));
    return { domain, steps };
  }

  async enableSending(domain: string, known?: ZoneContext): Promise<Step[]> {
    const steps: Step[] = [];
    const ctx = known ?? await this.zone(domain);
    if (!ctx) return [{ id: "sending", label: msg("Send from the domain"), outcome: "failed", detail: msg("{domain} is not visible to any token this server has.", { domain }) }];
    const { api } = ctx;
    const id = ctx.zone.id;
    try {
      const subs = await api.call<{ name: string; enabled?: boolean }[]>(`/zones/${id}/email/sending/subdomains`, { what: msg("read Email Sending (Account: Email Sending: Edit)") });
      if (subs.some((s) => s.name.toLowerCase() === domain && s.enabled !== false)) steps.push({ id: "sending", label: msg("Send from the domain"), outcome: "already", detail: msg("Sending is on.") });
      else {
        await api.call(`/zones/${id}/email/sending/subdomains`, { method: "POST", body: { name: domain }, what: msg("turn on Email Sending (Email Sending: Edit)") });
        steps.push({ id: "sending", label: msg("Send from the domain"), outcome: "done", detail: msg("Sending is on; Cloudflare added its bounce (cf-bounce) MX, SPF and DKIM records.") });
      }
    } catch (e) { steps.push({ id: "sending", label: msg("Send from the domain"), outcome: "failed", detail: errorText(e) }); }
    try {
      const txt = await api.call<DnsRecord[]>(`/zones/${id}/dns_records?type=TXT&name=${encodeURIComponent("_dmarc." + domain)}`, { what: msg("read DNS records (DNS: Edit)") });
      if (txt.some((r) => /v=DMARC1/i.test(r.content))) steps.push({ id: "dmarc", label: msg("DMARC record"), outcome: "already", detail: msg("The domain already has a DMARC policy; it was left as it is.") });
      else {
        await api.call(`/zones/${id}/dns_records`, { method: "POST", what: msg("add a DNS record (DNS: Edit)"),
          body: { type: "TXT", name: `_dmarc.${domain}`, content: "v=DMARC1; p=none;", ttl: 1, comment: "Added by Fabric Inbox: monitoring only, delivers everything" } });
        steps.push({ id: "dmarc", label: msg("DMARC record"), outcome: "done", detail: msg("Added a monitoring-only DMARC record (p=none); receivers want one before they trust new mail.") });
      }
    } catch (e) { steps.push({ id: "dmarc", label: msg("DMARC record"), outcome: "failed", detail: errorText(e) }); }
    return steps;
  }

  /**
   * The reverse of connect: every rule that sends mail here goes back to the
   * address's forwarded copy when it has one, or is removed; the domain stops
   * being served. Mailboxes and their mail are kept (listed as other mailboxes).
   */
  async release(domain: string, options: { force?: boolean } = {}): Promise<ConnectResult> {
    const steps: Step[] = [];
    if (servedDomains(this.env).includes(domain))
      return { domain, steps: [{ id: "serve", label: msg("Stop receiving here"), outcome: "failed", detail: msg("{domain} is set in this deployment's DOMAINS; remove it there and deploy.", { domain }) }] };
    // A lookup that failed says nothing about the rules: the domain stays served, or its mail would bounce (audit finding 2).
    let ctx: ZoneContext | null;
    try { ctx = await this.zone(domain); }
    catch (e) {
      return { domain, steps: [{ id: "rules", label: msg("Send the mail back"), outcome: "failed", detail: msg("{error} The domain is still served here, so nothing is lost; try again.", { error: errorText(e) }) }] };
    }
    if (!ctx && !options.force)
      return { domain, needsConfirmation: { zoneNotVisible: true }, steps: [{ id: "rules", label: msg("Send the mail back"), outcome: "failed",
        detail: msg("The token cannot see {domain}, so its routing rules cannot be moved back. If Cloudflare still sends its mail here, it will be refused once the domain is no longer served.", { domain }) }] };
    if (ctx) {
      const { zone, api } = ctx;
      const settings = new Map((await readAllSettings(this.env.BUCKET)).map(({ email, settings: s }) => [email, s]));
      const copyOf = (email: string) => {
        const f = settings.get(email)?.forwarding as { enabled?: boolean; email?: string } | undefined;
        return f?.enabled && f.email ? f.email : null;
      };
      const done: string[] = [];
      try {
        for (const r of await this.rules(ctx)) {
          const a = address(r);
          if (!a || !toWorker(r, ctx.worker)) continue;
          const to = copyOf(a);
          // A disabled rule stays disabled: going back must not switch on what was off.
          if (to) await api.call(`/zones/${zone.id}/email/routing/rules/${r.id ?? r.tag}`, { method: "PUT", what: msg("change routing rules (Email Routing Rules: Edit)"),
            body: { name: r.name || a, enabled: r.enabled !== false, priority: r.priority ?? 0, matchers: r.matchers, actions: [{ type: "forward", value: [to] }] } });
          else await api.call(`/zones/${zone.id}/email/routing/rules/${r.id ?? r.tag}`, { method: "DELETE", what: msg("change routing rules (Email Routing Rules: Edit)") });
          done.push(to ? `${a} → ${to}` : `${a} removed`);
        }
        const catchAll = await api.call<Rule>(`/zones/${zone.id}/email/routing/rules/catch_all`, { what: msg("read the catch-all rule (Email Routing Rules: Edit)") });
        if (toWorker(catchAll, ctx.worker)) {
          const box = (await storedCatchAll(this.env.BUCKET))[domain];
          const to = box ? copyOf(box) : null;
          await api.call(`/zones/${zone.id}/email/routing/rules/catch_all`, { method: "PUT", what: msg("change the catch-all rule (Email Routing Rules: Edit)"),
            body: { name: catchAll.name || "Catch-all", enabled: !!to, matchers: [{ type: "all" }], actions: to ? [{ type: "forward", value: [to] }] : [{ type: "drop" }] } });
          done.push(to ? `every other address → ${to}` : "the catch-all drops mail again");
        }
        steps.push({ id: "rules", label: msg("Send the mail back"), outcome: done.length ? "done" : "already", detail: done.length ? done.join("; ") + "." : msg("No rule sent mail here.") });
      } catch (e) {
        steps.push({ id: "rules", label: msg("Send the mail back"), outcome: "failed", detail: done.length
          ? msg("{error} Already changed: {changed}. The domain is still served here, so nothing is lost; try again.", { error: errorText(e), changed: done.join("; ") })
          : msg("{error} The domain is still served here, so nothing is lost; try again.", { error: errorText(e) }) });
        return { domain, steps };
      }
    } else steps.push({ id: "rules", label: msg("Send the mail back"), outcome: "skipped", detail: msg("The token cannot see this domain; its routing rules were not changed (you chose to stop receiving anyway).") });
    await removeCatchAll(this.env.BUCKET, domain);
    const removed = await removeServedDomain(this.env, domain);
    steps.push({ id: "serve", label: msg("Stop receiving here"), outcome: removed ? "done" : "already", detail: msg("Mail for this domain is no longer accepted here. Its mailboxes and their mail stay, listed as other mailboxes.") });
    return { domain, steps };
  }

  /** The domain's catch-all mailbox on this server, and Cloudflare's catch-all rule pointing here. */
  async setCatchAllMailbox(domain: string, mailbox: string | null): Promise<Step[]> {
    const steps: Step[] = [];
    if (mailbox) {
      // Cloudflare's catch-all is read first: another Worker's is left alone, and a forward
      // it did becomes the mailbox's copy, so nobody who got that mail stops getting it.
      const ctx = await this.zone(domain).catch((e) => { steps.push({ id: "catch-all-rule", label: msg("Catch-all rule"), outcome: "failed", detail: errorText(e) }); return null; });
      if (ctx) {
        const { zone, api } = ctx;
        try {
          const rule = await api.call<Rule>(`/zones/${zone.id}/email/routing/rules/catch_all`, { what: msg("read the catch-all rule (Email Routing Rules: Edit)") });
          const action = actionOf(rule);
          if (rule.enabled && action.type === "worker" && !toWorker(rule, ctx.worker)) {
            steps.push({ id: "catch-all-rule", label: msg("Catch-all rule"), outcome: "failed",
              detail: action.value
                ? msg("Cloudflare's catch-all sends other addresses on {domain} to the Worker {worker}; it was left as it is. Change it in the dashboard first if this server should keep them.", { domain, worker: action.value })
                : msg("Cloudflare's catch-all sends other addresses on {domain} to the Worker (unnamed); it was left as it is. Change it in the dashboard first if this server should keep them.", { domain }) });
            return steps;
          }
          if (rule.enabled && toWorker(rule, ctx.worker)) steps.push({ id: "catch-all-rule", label: msg("Catch-all rule"), outcome: "already", detail: msg("Cloudflare's catch-all already sends other addresses here.") });
          else {
            if (rule.enabled && action.type === "forward" && action.value) {
              const copy = action.value.toLowerCase();
              const kept = await updateSettings(this.env.BUCKET, mailbox, (s) => {
                const f = s.forwarding as { enabled?: boolean; email?: string } | undefined;
                return f?.enabled && f.email ? s : { ...s, forwarding: { enabled: true, email: copy } };
              });
              const has = (kept?.forwarding as { email?: string } | undefined)?.email;
              steps.push({ id: "catch-all-copy", label: msg("Keep the old destination"), outcome: has === copy ? "done" : "already",
                detail: has === copy ? msg("Cloudflare's catch-all forwarded to {copy}; {mailbox} keeps sending it a copy.", { copy, mailbox }) : msg("{mailbox} already sends a copy to {has}; {copy} no longer gets mail for other addresses.", { mailbox, has: String(has), copy }) });
            }
            await api.call(`/zones/${zone.id}/email/routing/rules/catch_all`, { method: "PUT", what: msg("change the catch-all rule (Email Routing Rules: Edit)"),
              body: { name: rule.name || "Catch-all", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [ctx.worker] }] } });
            steps.push({ id: "catch-all-rule", label: msg("Catch-all rule"), outcome: "done", detail: msg("Cloudflare's catch-all now sends other addresses here.") });
          }
        } catch (e) { steps.push({ id: "catch-all-rule", label: msg("Catch-all rule"), outcome: "failed", detail: errorText(e) }); }
      }
      await setCatchAll(this.env.BUCKET, [{ domain, mailbox }]);
      steps.unshift({ id: "catch-all", label: msg("Keep mail for other addresses"), outcome: "done", detail: msg("Mail for any other address on {domain} that arrives here is kept in {mailbox}.", { domain, mailbox }) });
    } else {
      await removeCatchAll(this.env.BUCKET, domain);
      steps.push({ id: "catch-all", label: msg("Keep mail for other addresses"), outcome: "done",
        detail: msg("Mail for an address that does not exist on {domain} is refused and the sender is told; each one is listed below so you can create it.", { domain }) });
    }
    return steps;
  }

  /** Installs or checks the relay in a zone's account (workers/relay/install.ts). */
  private async relay(ctx: ZoneContext, origin?: string): Promise<RelayInstallResult> {
    return installRelay({ env: this.env, accounts: this.accounts, accountId: ctx.accountId, api: ctx.api, origin });
  }

  /** The destination addresses a forwarded copy may go to, in an account (the server's by default). */
  async destinations(accountId?: string): Promise<Destination[]> {
    const { account, api } = await this.accountApi(accountId);
    const list = await api.list<Destination & { tag?: string }>(`/accounts/${account}/email/routing/addresses`, msg("list forwarding destinations (Email Routing Addresses: Edit)"));
    return list.map((d) => ({ id: d.id ?? d.tag ?? "", email: d.email.toLowerCase(), verified: d.verified ?? null, status: d.status }));
  }

  async addDestination(email: string, accountId?: string): Promise<Destination> {
    const { account, api } = await this.accountApi(accountId);
    const d = await api.call<Destination>(`/accounts/${account}/email/routing/addresses`, { method: "POST", body: { email }, what: msg("add a forwarding destination (Email Routing Addresses: Edit)") });
    return { id: d.id, email: d.email.toLowerCase(), verified: d.verified ?? null, status: d.status };
  }

  /** The destinations that apply to an address: those of its domain's account. */
  async destinationsFor(email: string): Promise<Destination[]> {
    const ctx = await this.zone(domainOf(email));
    return this.destinations(ctx?.accountId);
  }

  private async accountApi(accountId?: string) {
    const account = accountId ?? await this.accounts.serverAccountId();
    const api = await this.accounts.apiFor(account);
    if (!api) throw new CloudflareApiError(msg("No token this server has reaches the Cloudflare account {account}.", { account }), 404);
    return { account, api };
  }
}
