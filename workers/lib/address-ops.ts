import type { Env } from "../types";
import { CloudflareAccounts } from "../routing/accounts";
import { DomainManager } from "../routing/domains";
import { routingClient, RoutingError, ZoneNotVisible, ROUTING_NOT_CONFIGURED, type RoutingStatus } from "../routing/email-routing";
import { allowedAddresses, allServedDomains, createMailbox, deleteMailbox, settingsKey, storedCatchAll, updateSettings } from "./mailbox-store";

/**
 * The one way an address is created or removed (SCN-021, SCN-032, MB-1), used by
 * Settings → Addresses and by the agent protocol alike. Every check runs before
 * Cloudflare is touched; a rule this call created is taken away again when the
 * mailbox cannot be made; a domain's catch-all is never removed while it is one.
 */
export type OpResult = { status: 200 | 201 | 400 | 403 | 404 | 409 | 502 | 503; body: Record<string, unknown> };

export interface CreateAddressInput {
  email: string;
  name?: string;
  agent?: "off" | { id: string };
  /** "auto": make the rule when this server can make rules (it has a routing token), and say so when not. */
  createRoute: boolean | "auto";
  forwardTo?: string;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** The catch-all in effect for a domain and where it is set: the deployment's policy wins over the stored choice. */
export async function effectiveCatchAll(env: Env, domain: string): Promise<{ mailbox: string; source: "deployment" | "stored" } | null> {
  let policies: Record<string, unknown> = {};
  try { policies = JSON.parse(env.UNKNOWN_ADDRESS_POLICY || "{}"); } catch { policies = {}; }
  const policy = policies[domain];
  if (typeof policy === "string" && policy.startsWith("catch_all:")) {
    const mailbox = policy.slice("catch_all:".length).trim().toLowerCase();
    if (mailbox) return { mailbox, source: "deployment" };
  }
  const stored = (await storedCatchAll(env.BUCKET))[domain];
  return stored ? { mailbox: stored.toLowerCase(), source: "stored" } : null;
}

export async function createAddress(env: Env, input: CreateAddressInput, agentProblem: string | null): Promise<OpResult> {
  const email = input.email.trim().toLowerCase();
  const domain = domainOf(email);
  const served = await allServedDomains(env);
  if (!served.includes(domain)) return { status: 400, body: { error: `${domain} is not served here; receive its mail here first (Settings → Domains)` } };
  if (await env.BUCKET.head(settingsKey(email))) return { status: 409, body: { error: "This address already exists", email } };
  if (agentProblem) return { status: 400, body: { error: agentProblem } };
  const allowed = allowedAddresses(env);
  if (allowed.length && !allowed.includes(email)) return { status: 403, body: { error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" } };

  const warnings: string[] = [];
  if (input.forwardTo) {
    if (served.includes(domainOf(input.forwardTo)))
      return { status: 400, body: { error: "A copy to a domain served here would come straight back; choose an outside address" } };
    const accounts = new CloudflareAccounts(env);
    if (accounts.connected) {
      try {
        // A copy is forwarded by the address's own account, so it must be confirmed there (MA-4).
        const destination = (await new DomainManager(accounts, env).destinationsFor(email)).find((d) => d.email === input.forwardTo);
        if (!destination?.verified)
          return { status: 400, body: { error: destination
            ? `${input.forwardTo} has not confirmed yet: Cloudflare sent it a link. Confirm it, then add the address.`
            : `${input.forwardTo} is not a forwarding destination yet. Add it under Forwarding destinations first.` } };
      } catch (error) {
        warnings.push(`Could not check that ${input.forwardTo} is a confirmed destination (${(error as Error).message}); a failed copy will show on the address.`);
      }
    } else warnings.push(`A copy to ${input.forwardTo} works once it is a confirmed Email Routing destination in the domain's Cloudflare account.`);
  }

  let routing: RoutingStatus | null = null;
  let madeRule = false;
  const wantsRule = input.createRoute === "auto" ? !!routingClient(env) : input.createRoute;
  if (input.createRoute === "auto" && !wantsRule)
    warnings.push(`This server has no Cloudflare token for Email Routing, so no rule was made; mail reaches ${email} only if the domain's routing already sends it here.`);
  const client = wantsRule ? routingClient(env) : null;
  if (wantsRule) {
    if (!client) return { status: 503, body: { error: ROUTING_NOT_CONFIGURED.detail } };
    try {
      const ensured = await client.ensureRule(email);
      routing = ensured.status;
      madeRule = ensured.created;
    } catch (error) {
      // A served domain the token cannot see still receives what Cloudflare routes here.
      if (error instanceof ZoneNotVisible) warnings.push(`${error.message}, so no routing rule was made; mail reaches ${email} only if the domain's catch-all sends it here.`);
      else return { status: 502, body: { error: error instanceof RoutingError ? error.message : "Routing could not be created" } };
    }
  }

  let created: Awaited<ReturnType<typeof createMailbox>> | null = null;
  try {
    created = await createMailbox(env, email, input.name || email.split("@")[0], {
      agent: input.agent ?? "off",
      ...(input.forwardTo ? { forwarding: { enabled: true, email: input.forwardTo } } : {}),
    });
  } catch (error) {
    await undoRule(client, email, madeRule);
    return { status: 502, body: { error: `The address could not be saved (${(error as Error).message}).${madeRule ? " Its new routing rule was removed again." : ""}` } };
  }
  if (created.status !== "created") {
    await undoRule(client, email, madeRule);
    return created.status === "exists"
      ? { status: 409, body: { error: "This address already exists", email } }
      : { status: 403, body: { error: created.reason } };
  }
  console.log(JSON.stringify({ event: "address_created", domain, routed: !!routing, madeRule, copy: !!input.forwardTo }));
  return { status: 201, body: { email, settings: created.settings, routing, ...(warnings.length ? { warning: warnings.join(" ") } : {}) } };
}

/** Changes or removes an address's forwarding copy (MB-3), with the checks creating one has. */
export async function setForwardCopy(env: Env, rawEmail: string, forwardTo: string | null): Promise<OpResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!(await env.BUCKET.head(settingsKey(email)))) return { status: 404, body: { error: "Address not found" } };
  const warnings: string[] = [];
  if (forwardTo) {
    if ((await allServedDomains(env)).includes(domainOf(forwardTo)))
      return { status: 400, body: { error: "A copy to a domain served here would come straight back; choose an outside address" } };
    const accounts = new CloudflareAccounts(env);
    if (accounts.connected) {
      try {
        const destination = (await new DomainManager(accounts, env).destinationsFor(email)).find((d) => d.email === forwardTo);
        if (!destination?.verified)
          return { status: 400, body: { error: destination
            ? `${forwardTo} has not confirmed yet: Cloudflare sent it a link. Confirm it, then choose it again.`
            : `${forwardTo} is not a forwarding destination yet. Add it under Forwarding destinations first.` } };
      } catch (error) {
        warnings.push(`Could not check that ${forwardTo} is a confirmed destination (${(error as Error).message}); a failed copy will show on the address.`);
      }
    }
  }
  const next = await updateSettings(env.BUCKET, email, (s) => ({ ...s, forwarding: forwardTo ? { enabled: true, email: forwardTo } : { enabled: false, email: "" } }));
  if (!next) return { status: 404, body: { error: "Address not found" } };
  // A new target starts clean: the last failure was about the old one.
  await env.BUCKET.delete(`delivery-issues/${email}.json`).catch(() => undefined);
  console.log(JSON.stringify({ event: "address_copy_changed", domain: domainOf(email), copy: !!forwardTo }));
  return { status: 200, body: { email, forwardTo, ...(warnings.length ? { warning: warnings.join(" ") } : {}) } };
}

async function undoRule(client: ReturnType<typeof routingClient>, email: string, madeRule: boolean) {
  if (!client || !madeRule) return;
  await client.deleteRule(email).catch((error: unknown) =>
    console.error(JSON.stringify({ event: "address_rule_orphaned", email, error: (error as Error).message })));
}

export async function removeAddress(env: Env, rawEmail: string): Promise<OpResult> {
  const email = rawEmail.trim().toLowerCase();
  const domain = domainOf(email);
  if (!(await env.BUCKET.head(settingsKey(email)))) return { status: 404, body: { error: "Address not found" } };
  const catchAll = await effectiveCatchAll(env, domain);
  if (catchAll?.mailbox === email)
    return { status: 409, body: { error: catchAll.source === "deployment"
      ? `${email} keeps mail for every other address on ${domain} (set in this deployment's UNKNOWN_ADDRESS_POLICY); change it there first.`
      : `${email} keeps mail for every other address on ${domain}. Choose another catch-all (or none) first.` } };
  let routing = "Cloudflare was not changed: this server has no token. Remove the address's routing rule in the dashboard.";
  const client = routingClient(env);
  if (client) {
    try { routing = await client.deleteRule(email); }
    catch (error) {
      if (error instanceof ZoneNotVisible) routing = `${error.message}, so its routing rules were not changed.`;
      else return { status: 502, body: { error: `${error instanceof RoutingError ? error.message : "Routing could not be changed"}. Nothing was deleted.` } };
    }
  }
  try {
    await deleteMailbox(env, email);
  } catch (error) {
    return { status: 502, body: { error: `${routing} The mailbox could not be deleted (${(error as Error).message}); remove it again to finish.` } };
  }
  await env.BUCKET.delete(`delivery-issues/${email}.json`).catch(() => undefined);
  // What happens to the next message is read from Cloudflare, not assumed.
  let afterwards: string;
  const next = client ? await client.status(email).catch(() => null) : null;
  if (next?.state === "verified") afterwards = catchAll ? `New mail to ${email} goes to ${catchAll.mailbox}.` : `New mail to ${email} still arrives here and is refused; the sender is told.`;
  else if (next?.state === "missing") afterwards = `New mail to ${email} no longer comes here: ${next.detail}`;
  else afterwards = catchAll ? `New mail to ${email} goes to ${catchAll.mailbox} if Cloudflare still sends it here.` : `New mail to ${email} is refused if Cloudflare still sends it here.`;
  console.log(JSON.stringify({ event: "address_deleted", domain }));
  return { status: 200, body: { email, routing, afterwards } };
}
