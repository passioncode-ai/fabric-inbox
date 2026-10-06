import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { allServedDomains, isDomainName, listMailboxAddresses, removeCatchAll, servedDomains, setCatchAll } from "../lib/mailbox-store";
import { CloudflareApiError, TOKEN_PERMISSIONS, ACCOUNT_TOKEN_PERMISSIONS } from "../routing/cloudflare-api";
import { CloudflareAccounts, isAccountId } from "../routing/accounts";
import { currentRelay, readRelays } from "../relay/install";
import { effectiveCatchAll } from "../lib/address-ops";
import { DomainManager, type ConnectResult, type Step } from "../routing/domains";

/**
 * Domains & addresses (CF-2/CF-3, SCR-09). Behind the same Access and
 * same-origin boundary as every /api route. Without a Cloudflare token every
 * route answers what to create and where, and nothing else is claimed.
 */
export const domainsRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

/** Where a token is created; the permissions to pick are listed beside it. */
export const TOKEN_DASHBOARD_URL = "https://dash.cloudflare.com/profile/api-tokens";
const NOT_CONNECTED = "This server has no Cloudflare token yet. Create one with the permissions listed, then save it on the server as CLOUDFLARE_API_TOKEN.";

function manager(c: C): DomainManager | null {
  const accounts = new CloudflareAccounts(c.env);
  return accounts.connected ? new DomainManager(accounts, c.env) : null;
}

/** `?account=` when given: a Cloudflare account id, or a 400. */
function accountParam(c: C): string | undefined | null {
  const id = c.req.query("account");
  if (id === undefined || id === "") return undefined;
  return isAccountId(id) ? id : null;
}

function domainParam(c: C): string | null {
  const d = c.req.param("domain")?.toLowerCase() ?? "";
  return isDomainName(d) ? d : null;
}

function failure(c: C, error: unknown, event: string) {
  console.error(JSON.stringify({ event, error: (error as Error).message }));
  if (error instanceof CloudflareApiError) return c.json({ error: error.message }, error.isPermission ? 403 : 502);
  // Not every failure here is Cloudflare's: say what actually failed (audit finding 4).
  return c.json({ error: `The server could not finish this: ${(error as Error).message}. Try again.` }, 502);
}

/** Steps with a failure answer 502 and name the first failure as `error`, so the screen never shows a bare status. */
function stepsResponse(c: C, result: { domain: string; steps: Step[]; needsConfirmation?: unknown }) {
  const failed = result.steps.find((s) => s.outcome === "failed");
  if (result.needsConfirmation) return c.json({ ...result, error: failed?.detail ?? "Confirm first" }, 409);
  return failed ? c.json({ ...result, error: `${failed.label}: ${failed.detail}` }, 502) : c.json(result, 200);
}

function logSteps(event: string, result: { domain: string; steps: Step[] }) {
  console.log(JSON.stringify({ event, domain: result.domain, steps: result.steps.map((s) => `${s.id}:${s.outcome}`) }));
}

domainsRouter.get("/api/domains", async (c) => {
  c.header("Cache-Control", "no-store");
  const [served, addresses] = await Promise.all([allServedDomains(c.env), listMailboxAddresses(c.env.BUCKET)]);
  const fixed = new Set(servedDomains(c.env));
  const count = (domain: string) => addresses.filter((a) => a.endsWith("@" + domain)).length;
  const base = { permissions: TOKEN_PERMISSIONS, accountPermissions: ACCOUNT_TOKEN_PERMISSIONS, tokenUrl: TOKEN_DASHBOARD_URL };
  const m = manager(c);
  const servedOnly = (domains: string[]) => [...domains].sort().map((domain) => ({ domain, zoneId: null, account: null, served: true, fixed: fixed.has(domain), addresses: count(domain) }));
  if (!m) return c.json({ ...base, connected: false, problem: NOT_CONNECTED, accounts: [], domains: servedOnly(served) });
  try {
    const [overview, relays] = await Promise.all([m.overview(), readRelays(c.env.BUCKET)]);
    if (!overview.accounts.length) {
      const problem = overview.problems[0] ?? "The token sees no Cloudflare account.";
      return c.json({ ...base, connected: false, problem, accounts: [], domains: servedOnly(served) });
    }
    const byId = new Map(overview.accounts.map((a) => [a.id, a]));
    const shown = overview.zones.filter((z) => byId.get(z.accountId)?.shown);
    // A served domain stays listed even when its account is hidden or no token sees it.
    const listed = new Set(shown.map((z) => z.zone.name.toLowerCase()));
    const hiddenServed = overview.zones.filter((z) => !listed.has(z.zone.name.toLowerCase()) && served.includes(z.zone.name.toLowerCase()));
    const visible = [...shown, ...hiddenServed];
    const names = new Set(overview.zones.map((z) => z.zone.name.toLowerCase()));
    const domains = [
      ...visible.map(({ zone, accountId }) => {
        const domain = zone.name.toLowerCase();
        const a = byId.get(accountId);
        return { domain, zoneId: zone.id, account: { id: accountId, name: a?.name ?? accountId, server: !!a?.server },
          served: served.includes(domain), fixed: fixed.has(domain), addresses: count(domain) };
      }),
      // Served here but not visible to any token (another account, or a narrower token)
      ...servedOnly(served.filter((d) => !names.has(d))),
    ].sort((a, b) => Number(b.served) - Number(a.served) || a.domain.localeCompare(b.domain));
    const accounts = overview.accounts.map((a) => {
      const relay = currentRelay(relays, a.id);
      return { ...a, relay: relay ? { version: relay.version, installedAt: relay.installedAt } : null };
    });
    const server = overview.accounts.find((a) => a.server);
    return c.json({ ...base, connected: true, account: server?.name ?? overview.accounts[0]?.name ?? null, accounts,
      ...(overview.problems.length ? { problems: overview.problems } : {}), domains });
  } catch (error) {
    const message = error instanceof CloudflareApiError ? error.message : "Cloudflare could not be reached from the server.";
    return c.json({ ...base, connected: false, problem: message, accounts: [], domains: servedOnly(served) });
  }
});

domainsRouter.get("/api/domains/destinations", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = accountParam(c);
  if (account === null) return c.json({ error: "Not a Cloudflare account id" }, 400);
  const m = manager(c);
  if (!m) return c.json({ error: NOT_CONNECTED }, 503);
  try { return c.json({ account: account ?? await m.accounts.serverAccountId(), destinations: await m.destinations(account) }); }
  catch (error) { return failure(c, error, "destinations_read_failed"); }
});

export const DestinationInput = z.object({ email: z.string().trim().toLowerCase().email().max(90) }).strict();
domainsRouter.post("/api/domains/destinations", async (c) => {
  const parsed = DestinationInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter an email address" }, 400);
  const account = accountParam(c);
  if (account === null) return c.json({ error: "Not a Cloudflare account id" }, 400);
  if ((await allServedDomains(c.env)).includes(parsed.data.email.slice(parsed.data.email.lastIndexOf("@") + 1)))
    return c.json({ error: "That address is on a domain served here; a copy there would come straight back." }, 400);
  const m = manager(c);
  if (!m) return c.json({ error: NOT_CONNECTED }, 503);
  try {
    const existing = (await m.destinations(account)).find((d) => d.email === parsed.data.email);
    if (existing) return c.json({ destination: existing, created: false });
    const destination = await m.addDestination(parsed.data.email, account);
    console.log(JSON.stringify({ event: "destination_added", verified: !!destination.verified }));
    return c.json({ destination, created: true }, 201);
  } catch (error) { return failure(c, error, "destination_add_failed"); }
});

domainsRouter.get("/api/domains/:domain", async (c) => {
  c.header("Cache-Control", "no-store");
  const domain = domainParam(c);
  if (!domain) return c.json({ error: "Not a domain name" }, 400);
  const m = manager(c);
  if (!m) return c.json({ error: NOT_CONNECTED }, 503);
  try {
    const detail = await m.detail(domain);
    return detail ? c.json(detail) : c.json({ error: `${domain} is not visible to any Cloudflare token this server has.` }, 404);
  } catch (error) { return failure(c, error, "domain_read_failed"); }
});

export const ConnectInput = z.object({ replaceMx: z.boolean().default(false), sending: z.boolean().default(true) }).strict();

domainsRouter.post("/api/domains/:domain/connect", async (c) => {
  const domain = domainParam(c);
  if (!domain) return c.json({ error: "Not a domain name" }, 400);
  const parsed = ConnectInput.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return c.json({ error: "Unknown option" }, 400);
  const m = manager(c);
  if (!m) return c.json({ error: NOT_CONNECTED }, 503);
  try {
    // The relay in another account is told where this server is: the address this request came to.
    const result: ConnectResult = await m.connect(domain, { ...parsed.data, origin: new URL(c.req.url).origin });
    logSteps("domain_connect", result);
    if (result.needsConfirmation) return c.json(result, 409);
    // Sending and DMARC failing does not stop receiving; any other failure is the answer.
    const failed = result.steps.find((s) => s.outcome === "failed" && !["sending", "dmarc"].includes(s.id));
    return failed ? c.json({ ...result, error: `${failed.label}: ${failed.detail}` }, 502) : c.json(result, 200);
  } catch (error) { return failure(c, error, "domain_connect_failed"); }
});

domainsRouter.post("/api/domains/:domain/release", async (c) => {
  const domain = domainParam(c);
  if (!domain) return c.json({ error: "Not a domain name" }, 400);
  const m = manager(c);
  if (!m) return c.json({ error: NOT_CONNECTED }, 503);
  try {
    const body = await c.req.json().catch(() => ({})) as { force?: unknown };
    const result = await m.release(domain, { force: body?.force === true });
    logSteps("domain_release", result);
    return stepsResponse(c, result);
  } catch (error) { return failure(c, error, "domain_release_failed"); }
});

domainsRouter.post("/api/domains/:domain/sending", async (c) => {
  const domain = domainParam(c);
  if (!domain) return c.json({ error: "Not a domain name" }, 400);
  const m = manager(c);
  if (!m) return c.json({ error: NOT_CONNECTED }, 503);
  try {
    const steps = await m.enableSending(domain);
    logSteps("domain_sending", { domain, steps });
    return stepsResponse(c, { domain, steps });
  } catch (error) { return failure(c, error, "domain_sending_failed"); }
});

export const CatchAllInput = z.object({ mailbox: z.string().trim().toLowerCase().email().nullable() }).strict();
domainsRouter.put("/api/domains/:domain/catch-all", async (c) => {
  const domain = domainParam(c);
  if (!domain) return c.json({ error: "Not a domain name" }, 400);
  const parsed = CatchAllInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose an address on this domain, or none" }, 400);
  const mailbox = parsed.data.mailbox;
  if (!(await allServedDomains(c.env)).includes(domain)) return c.json({ error: `${domain} is not served here` }, 400);
  if (mailbox && (!mailbox.endsWith("@" + domain) || !(await listMailboxAddresses(c.env.BUCKET)).includes(mailbox)))
    return c.json({ error: "Choose an address that exists on this domain" }, 400);
  const effective = await effectiveCatchAll(c.env, domain);
  if (effective?.source === "deployment")
    return c.json({ error: `The catch-all of ${domain} is set in this deployment (UNKNOWN_ADDRESS_POLICY → ${effective.mailbox}); change it there.` }, 409);
  const m = manager(c);
  if (!m) {
    // Without a token the server side still changes; Cloudflare's rule is the operator's step.
    if (mailbox) await setCatchAll(c.env.BUCKET, [{ domain, mailbox }]); else await removeCatchAll(c.env.BUCKET, domain);
    return c.json({ domain, steps: [{ id: "catch-all", label: "Keep mail for other addresses", outcome: "done",
      detail: mailbox ? `Kept in ${mailbox} once Cloudflare's catch-all sends mail here (${NOT_CONNECTED})` : "Other addresses are refused." }] });
  }
  try {
    const steps = await m.setCatchAllMailbox(domain, mailbox);
    logSteps("domain_catch_all", { domain, steps });
    return stepsResponse(c, { domain, steps });
  } catch (error) { return failure(c, error, "domain_catch_all_failed"); }
});
