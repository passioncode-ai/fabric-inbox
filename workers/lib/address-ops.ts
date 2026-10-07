import type { Env } from "../types";
import { CloudflareAccounts } from "../routing/accounts";
import { DomainManager } from "../routing/domains";
import { routingClient, RoutingError, ZoneNotVisible, ROUTING_NOT_CONFIGURED, type AddressRouting, type RouteAction, type RoutingClient, type RoutingStatus } from "../routing/email-routing";
import { allowedAddresses, allServedDomains, createMailbox, deleteMailbox, readSettings, settingsKey, storedCatchAll, updateSettings } from "./mailbox-store";
import { checkLocalPart, suggestDisplayName } from "../../shared/address-name";
import { Folders } from "../../shared/folders";
import { msg } from "../../shared/i18n";

/**
 * The one way an address is created or removed (SCN-021, SCN-032, MB-1), used by
 * Settings → Addresses and by the agent protocol alike. Every check runs before
 * Cloudflare is touched; the mailbox is saved before its rule is made, so no rule is
 * ever left without a mailbox; a domain's catch-all is never removed while it is one.
 */
export type OpResult = { status: 200 | 201 | 400 | 403 | 404 | 409 | 502 | 503; body: Record<string, unknown> };

export interface CreateAddressInput {
  email: string;
  name?: string;
  agent?: "off" | { id: string };
  /** Added to mail sent from the address (SCN-062); off unless enabled with text. */
  signature?: { enabled: boolean; text: string };
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

/** One line of what creating an address did (SCN-062): the same outcomes as a domain action's steps. */
export interface AddressStep {
  id: "address" | "rule";
  label: string;
  /**
   * not_receiving: the rule was made (or was there) but the domain does not route mail here
   * (Email Routing off or misconfigured), so the address receives nothing until that is fixed.
   */
  outcome: "done" | "already" | "skipped" | "failed" | "not_receiving";
  detail: string;
  /** The one action that fixes a step that did not happen (SCN-065). */
  fix?: StepFix;
}
export interface StepFix { action: "route_here" | "connect_cloudflare" | "connect_account" | "open_domain"; label: string }

const RULE_LABEL = msg("Send its mail here");

/**
 * What several addresses created in one request share (SCN-064): the served domains read once, one
 * routing client (so the zone, Email Routing's state and the rules are read once), and the copy's
 * destination checked once. A single create makes its own.
 */
export interface CreateContext {
  served?: string[];
  /** undefined: make one; null: this server has no token. */
  client?: RoutingClient | null;
  /** The destination check for `forwardTo`, already done for this domain. */
  copy?: { warning: string | null };
}

/**
 * Whether a copy to `forwardTo` can be forwarded for `email` (MA-4): an outside address, confirmed in
 * the address's own Cloudflare account. A check Cloudflare cannot answer is a warning, not a refusal.
 */
async function checkCopy(env: Env, email: string, forwardTo: string, served: string[], accounts: CloudflareAccounts): Promise<{ error: string } | { warning: string | null }> {
  if (served.includes(domainOf(forwardTo)))
    return { error: msg("A copy to a domain served here would come straight back; choose an outside address") };
  if (!accounts.connected)
    return { warning: msg("A copy to {address} works once it is a confirmed Email Routing destination in the domain's Cloudflare account.", { address: forwardTo }) };
  try {
    const destination = (await new DomainManager(accounts, env).destinationsFor(email)).find((d) => d.email === forwardTo);
    if (!destination?.verified)
      return { error: destination
        ? msg("{address} has not confirmed yet: Cloudflare sent it a link. Confirm it, then add the address.", { address: forwardTo })
        : msg("{address} is not a forwarding destination yet. Add it under Forwarding destinations first.", { address: forwardTo }) };
    return { warning: null };
  } catch (error) {
    return { warning: msg("Could not check that {address} is a confirmed destination ({error}); a failed copy will show on the address.", { address: forwardTo, error: (error as Error).message }) };
  }
}

export async function createAddress(env: Env, input: CreateAddressInput, agentProblem: string | null, ctx: CreateContext = {}): Promise<OpResult> {
  const email = input.email.trim().toLowerCase();
  const domain = domainOf(email);
  const local = checkLocalPart(email.slice(0, email.lastIndexOf("@")));
  if (!local.valid) return { status: 400, body: { error: local.problem } };
  const served = ctx.served ?? await allServedDomains(env);
  if (!served.includes(domain)) return { status: 400, body: { error: msg("{domain} is not served here; receive its mail here first (Settings → Domains)", { domain }) } };
  if (await env.BUCKET.head(settingsKey(email))) return { status: 409, body: { error: msg("This address already exists"), email } };
  if (agentProblem) return { status: 400, body: { error: agentProblem } };
  const allowed = allowedAddresses(env);
  if (allowed.length && !allowed.includes(email)) return { status: 403, body: { error: msg("Mailbox creation is restricted to configured EMAIL_ADDRESSES") } };

  const warnings: string[] = [];
  if (input.forwardTo) {
    const copy = ctx.copy ?? await checkCopy(env, email, input.forwardTo, served, new CloudflareAccounts(env));
    if ("error" in copy) return { status: 400, body: { error: copy.error } };
    if (copy.warning) warnings.push(copy.warning);
  }
  const client = input.createRoute === false ? null : ctx.client !== undefined ? ctx.client : routingClient(env);
  if (input.createRoute === true && !client) return { status: 503, body: { error: ROUTING_NOT_CONFIGURED.detail } };

  // The mailbox is saved first, and only when no other request saved it a moment before (one
  // conditional write): a request cut off between the two steps leaves an address that says it does
  // not receive yet, never a Cloudflare rule with no mailbox; and two requests for the same address
  // cannot both go on to its rule, so neither ever takes away a rule the other relies on.
  let created: Awaited<ReturnType<typeof createMailbox>>;
  try {
    created = await createMailbox(env, email, input.name?.trim() || suggestDisplayName(local.value) || local.value, {
      agent: input.agent ?? "off",
      ...(input.forwardTo ? { forwarding: { enabled: true, email: input.forwardTo } } : {}),
      ...(input.signature ? { signature: { enabled: input.signature.enabled && !!input.signature.text.trim(), text: input.signature.text } } : {}),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "address_save_failed", domain, error: (error as Error).message }));
    return { status: 502, body: { error: msg("The address could not be saved ({error}). Nothing was created; try again.", { error: (error as Error).message }) } };
  }
  if (created.status === "exists") return { status: 409, body: { error: msg("This address already exists"), email } };
  if (created.status === "forbidden") return { status: 403, body: { error: created.reason } };

  // With "auto" a rule that cannot be made never costs the address: it is kept and its rule step says
  // why and how to fix it (SCN-065); with true it must be made, or the address is taken away again.
  let routing: RoutingStatus | null = null;
  let madeRule = false;
  let rule: AddressStep;
  if (input.createRoute === false) {
    rule = { id: "rule", label: RULE_LABEL, outcome: "skipped",
      detail: msg("No routing rule was asked for: mail reaches {email} only if the domain's routing already sends it here.", { email }),
      fix: { action: "route_here", label: msg("Make the rule") } };
  } else if (!client) {
    if (input.createRoute === true) return { status: 503, body: { error: ROUTING_NOT_CONFIGURED.detail } };
    const detail = msg("This server has no Cloudflare token for Email Routing, so no rule was made; mail reaches {email} only if the domain's routing already sends it here.", { email });
    warnings.push(detail);
    rule = { id: "rule", label: RULE_LABEL, outcome: "skipped", detail, fix: { action: "connect_cloudflare", label: msg("Connect Cloudflare") } };
  } else {
    try {
      const ensured = await client.ensureRule(email);
      routing = ensured.status;
      madeRule = ensured.created;
      // A rule that exists while the domain does not route mail here is not a success: say so,
      // with the fix that turns Email Routing on again (SCN-065).
      rule = { id: "rule", label: RULE_LABEL, outcome: routing.state === "missing" ? "not_receiving" : ensured.created ? "done" : "already", detail: routing.detail,
        ...(routing.state === "verified" ? {} : { fix: { action: "open_domain" as const, label: msg("Fix it") } }) };
    } catch (error) {
      if (error instanceof ZoneNotVisible) {
        // A served domain the token cannot see still receives what Cloudflare routes here.
        const detail = msg("{reason}, so no routing rule was made; mail reaches {email} only if the domain's catch-all sends it here.", { reason: error.message, email });
        warnings.push(detail);
        rule = { id: "rule", label: RULE_LABEL, outcome: "skipped", detail, fix: { action: "connect_account", label: msg("Connect its account") } };
      } else if (input.createRoute === true) {
        const reason = error instanceof RoutingError ? error.message : msg("Routing could not be created");
        return takeBack(env, email, reason);
      } else {
        const reason = error instanceof RoutingError ? error.message : msg("Routing could not be created ({error})", { error: (error as Error).message });
        const detail = msg("{reason}. The address was kept; it receives nothing until its mail is sent here.", { reason: reason.replace(/\.$/, "") });
        warnings.push(detail);
        console.error(JSON.stringify({ event: "address_rule_failed", domain, error: reason }));
        rule = { id: "rule", label: RULE_LABEL, outcome: "failed", detail, fix: { action: "route_here", label: msg("Fix it") } };
      }
    }
  }
  const address: AddressStep = { id: "address", label: msg("Create the address"), outcome: "done",
    detail: input.forwardTo
      ? msg("{email} keeps its mail here and forwards a copy to {address}.", { email, address: input.forwardTo })
      : msg("{email} keeps its mail here.", { email }) };
  console.log(JSON.stringify({ event: "address_created", domain, routed: !!routing, madeRule, rule: rule.outcome, copy: !!input.forwardTo, signature: !!input.signature?.enabled }));
  return { status: 201, body: { email, settings: created.settings, routing, steps: [address, rule], ...(warnings.length ? { warning: warnings.join(" ") } : {}) } };
}

/** A required rule that could not be made takes its address away again (createRoute true); this request made both. */
async function takeBack(env: Env, email: string, reason: string): Promise<OpResult> {
  try {
    await deleteMailbox(env, email);
    return { status: 502, body: { error: msg("{reason}. The address was not kept.", { reason: reason.replace(/\.$/, "") }) } };
  } catch (error) {
    console.error(JSON.stringify({ event: "address_take_back_failed", domain: domainOf(email), error: (error as Error).message }));
    return { status: 502, body: { error: msg("{reason}. {email} was created without its rule and could not be taken away again ({error}): remove it, or make its rule with Fix it.", { reason: reason.replace(/\.$/, ""), email, error: (error as Error).message }), email } };
  }
}

/** Changes or removes an address's forwarding copy (MB-3), with the checks creating one has. */
export async function setForwardCopy(env: Env, rawEmail: string, forwardTo: string | null): Promise<OpResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!(await env.BUCKET.head(settingsKey(email)))) return { status: 404, body: { error: msg("Address not found") } };
  const warnings: string[] = [];
  if (forwardTo) {
    if ((await allServedDomains(env)).includes(domainOf(forwardTo)))
      return { status: 400, body: { error: msg("A copy to a domain served here would come straight back; choose an outside address") } };
    const accounts = new CloudflareAccounts(env);
    if (accounts.connected) {
      try {
        const destination = (await new DomainManager(accounts, env).destinationsFor(email)).find((d) => d.email === forwardTo);
        if (!destination?.verified)
          return { status: 400, body: { error: destination
            ? msg("{address} has not confirmed yet: Cloudflare sent it a link. Confirm it, then choose it again.", { address: forwardTo })
            : msg("{address} is not a forwarding destination yet. Add it under Forwarding destinations first.", { address: forwardTo }) } };
      } catch (error) {
        warnings.push(msg("Could not check that {address} is a confirmed destination ({error}); a failed copy will show on the address.", { address: forwardTo, error: (error as Error).message }));
      }
    }
  }
  const next = await updateSettings(env.BUCKET, email, (s) => ({ ...s, forwarding: forwardTo ? { enabled: true, email: forwardTo } : { enabled: false, email: "" } }));
  if (!next) return { status: 404, body: { error: msg("Address not found") } };
  // A new target starts clean: the last failure was about the old one.
  await env.BUCKET.delete(`delivery-issues/${email}.json`).catch(() => undefined);
  console.log(JSON.stringify({ event: "address_copy_changed", domain: domainOf(email), copy: !!forwardTo }));
  return { status: 200, body: { email, forwardTo, ...(warnings.length ? { warning: warnings.join(" ") } : {}) } };
}

export async function removeAddress(env: Env, rawEmail: string): Promise<OpResult> {
  const email = rawEmail.trim().toLowerCase();
  const domain = domainOf(email);
  if (!(await env.BUCKET.head(settingsKey(email)))) return { status: 404, body: { error: msg("Address not found") } };
  const catchAll = await effectiveCatchAll(env, domain);
  if (catchAll?.mailbox === email)
    return { status: 409, body: { error: catchAll.source === "deployment"
      ? msg("{email} keeps mail for every other address on {domain} (set in this deployment's UNKNOWN_ADDRESS_POLICY); change it there first.", { email, domain })
      : msg("{email} keeps mail for every other address on {domain}. Choose another catch-all (or none) first.", { email, domain }) } };
  let routing = msg("Cloudflare was not changed: this server has no token. Remove the address's routing rule in the dashboard.");
  const client = routingClient(env);
  if (client) {
    try { routing = await client.deleteRule(email); }
    catch (error) {
      if (error instanceof ZoneNotVisible) routing = msg("{reason}, so its routing rules were not changed.", { reason: error.message });
      else return { status: 502, body: { error: msg("{reason}. Nothing was deleted.", { reason: error instanceof RoutingError ? error.message : msg("Routing could not be changed") }) } };
    }
  }
  try {
    await deleteMailbox(env, email);
  } catch (error) {
    return { status: 502, body: { error: msg("{routing} The mailbox could not be deleted ({error}); remove it again to finish.", { routing, error: (error as Error).message }) } };
  }
  await env.BUCKET.delete(`delivery-issues/${email}.json`).catch(() => undefined);
  // What happens to the next message is read from Cloudflare, not assumed.
  let afterwards: string;
  const next = client ? await client.status(email).catch(() => null) : null;
  if (next?.state === "verified") afterwards = catchAll ? msg("New mail to {email} goes to {mailbox}.", { email, mailbox: catchAll.mailbox }) : msg("New mail to {email} still arrives here and is refused; the sender is told.", { email });
  else if (next?.state === "missing") afterwards = msg("New mail to {email} no longer comes here: {detail}", { email, detail: next.detail });
  else afterwards = catchAll ? msg("New mail to {email} goes to {mailbox} if Cloudflare still sends it here.", { email, mailbox: catchAll.mailbox }) : msg("New mail to {email} is refused if Cloudflare still sends it here.", { email });
  console.log(JSON.stringify({ event: "address_deleted", domain }));
  return { status: 200, body: { email, routing, afterwards } };
}

/* ------------------------------------------------- checking before creating */

/**
 * Where a domain stands for a new address (SCN-061, SCN-063): it receives here; it can (its zone is
 * in a connected account); it receives here but Email Routing needs fixing; no rule can be made
 * (no token, or no token sees its zone); or it cannot be used at all.
 */
export type DomainState = "receiving" | "can_receive" | "needs_fix" | "no_token" | "not_visible" | "unknown" | "unavailable";

/**
 * One name's answer: it can be created, it already exists here, a rule sends it elsewhere, it is not
 * a valid name, or this server creates only the addresses its EMAIL_ADDRESSES lists (restricted).
 */
export type NameStatus = "available" | "exists" | "elsewhere" | "invalid" | "restricted";

export interface NameCheck {
  localPart: string;
  email: string;
  status: NameStatus;
  /** Why it cannot be created (exists, elsewhere, invalid), or what is true of it today. */
  detail: string;
  /** Worth knowing before creating it: the catch-all keeps its mail, mail arrived for it, a role name. */
  notes: string[];
}

export interface AddressCheck {
  domain: string;
  served: boolean;
  state: DomainState;
  detail: string;
  /** Whether creating makes the Cloudflare rule, and if not, why. */
  rule: { canMake: boolean; detail: string };
  /** A test message is worth sending by default: a rule will be made or the catch-all already sends mail here. */
  sendTestDefault: boolean;
  catchAll: { mailbox: string; source: "deployment" | "stored" } | null;
  names: NameCheck[];
}

const describeAction = (email: string, a: RouteAction) =>
  a.type === "forward" ? (a.value ? msg("forwards {email} to {target}", { email, target: a.value }) : msg("forwards {email} to another address", { email }))
    : a.type === "worker" ? (a.value ? msg("sends {email} to the Worker {name}", { email, name: a.value }) : msg("sends {email} to the Worker of another app", { email }))
      : msg("drops mail for {email}", { email });

/** Mail that arrived for a name before it existed: one sentence per count and fate, so each translates whole. */
const arrivedNote = (n: number, when: string, refused: boolean) =>
  n === 1
    ? refused ? msg("1 message arrived for it recently (last {when} UTC), refused.", { when }) : msg("1 message arrived for it recently (last {when} UTC), kept in the catch-all.", { when })
    : refused ? msg("{n} messages arrived for it recently (last {when} UTC), refused.", { n, when }) : msg("{n} messages arrived for it recently (last {when} UTC), kept in the catch-all.", { n, when });

/**
 * Everything the Add address dialog and check_address say before Create (SCN-061): the domain's state
 * and, for each name, whether it can be created and what happens to mail already sent to it. Reads
 * Cloudflare once for all names; Cloudflare that cannot be read leaves routing unknown, never blocks.
 */
export async function checkAddresses(env: Env, rawDomain: string, rawNames: string[]): Promise<AddressCheck> {
  const domain = rawDomain.trim().toLowerCase();
  const served = (await allServedDomains(env)).includes(domain);
  const checks = rawNames.map((n) => checkLocalPart(n));
  const emails = checks.filter((c) => c.valid).map((c) => `${c.value}@${domain}`);
  const client = routingClient(env);
  let cf: AddressRouting | null = null;
  let cfProblem: string | null = null;
  if (client) {
    try { cf = await client.routingFor(domain, emails); }
    catch (error) { cfProblem = (error as Error).message; }
  }
  const catchAll = served ? await effectiveCatchAll(env, domain) : null;

  let state: DomainState;
  let detail: string;
  if (!served) {
    if (cf?.visible) {
      state = "can_receive";
      detail = msg("{domain} does not receive mail here yet. Creating an address first receives its mail here: Email Routing on, its existing addresses brought in keeping their copies, sending on.", { domain });
    } else {
      state = "unavailable";
      detail = cfProblem
        ? msg("{domain} does not receive mail here, and Cloudflare could not be read ({problem}).", { domain, problem: cfProblem })
        : msg("{domain} does not receive mail here and none of this server's Cloudflare tokens can see it. Connect its account in Settings → Accounts.", { domain });
    }
  } else if (!client) {
    state = "no_token";
    detail = msg("{domain} receives mail here. This server has no Cloudflare token, so no routing rule can be made: an address receives only if the domain's routing already sends its mail here.", { domain });
  } else if (cfProblem) {
    state = "unknown";
    detail = msg("{domain} receives mail here, but Cloudflare could not be read ({problem}); routing is unknown.", { domain, problem: cfProblem });
  } else if (!cf?.visible) {
    state = "not_visible";
    detail = msg("{domain} receives mail here, but none of this server's Cloudflare tokens can see it, so no routing rule can be made. Connect its account in Settings → Accounts.", { domain });
  } else if (!cf.enabled || cf.status !== "ready") {
    state = "needs_fix";
    detail = cf.enabled
      ? msg("Email Routing for {domain} is {status}: no mail arrives until it is fixed. Fix it turns it on again (Receive mail here).", { domain, status: cf.status })
      : msg("Email Routing for {domain} is off: no mail arrives until it is fixed. Fix it turns it on again (Receive mail here).", { domain });
  } else {
    state = "receiving";
    detail = msg("{domain} receives mail here.", { domain });
  }
  const canMake = !!client && !!cf?.visible;
  const ruleDetail = canMake
    ? msg("A Cloudflare rule that sends the address's mail here is made with it.")
    : !client ? msg("No rule can be made: this server has no Cloudflare token yet (Settings → Domains → Connect Cloudflare).")
      : cfProblem ? msg("Cloudflare could not be read ({problem}); the rule is tried when the address is created.", { problem: cfProblem })
        : msg("No rule can be made: none of this server's Cloudflare tokens can see {domain}.", { domain });
  const catchAllHere = !!cf?.catchAll?.enabled && cf.catchAll.toHere;
  // The same rule creating applies (createAddress, createMailbox): a name the server would refuse is never shown free.
  const allowed = allowedAddresses(env);

  const exists = await Promise.all(emails.map(async (e) => [e, !!(await env.BUCKET.head(settingsKey(e)))] as const));
  const existing = new Set(exists.filter(([, yes]) => yes).map(([e]) => e));
  const recent = new Map<string, { count: number; lastSeen: string; action: string }>();
  await Promise.all(emails.map(async (e) => {
    const v = await (await env.BUCKET.get(`unknown-recipients/${domain}/${e}.json`))?.json<{ count: number; lastSeen: string; action: string }>().catch(() => null);
    if (v?.count) recent.set(e, v);
  }));

  const names = checks.map((c): NameCheck => {
    const email = `${c.value}@${domain}`;
    if (!c.valid) return { localPart: c.value, email, status: "invalid", detail: c.problem!, notes: [] };
    if (existing.has(email)) return { localPart: c.value, email, status: "exists", detail: msg("{email} already exists here.", { email }), notes: [] };
    if (allowed.length && !allowed.includes(email))
      return { localPart: c.value, email, status: "restricted", notes: [],
        detail: msg("This server creates only the addresses listed in EMAIL_ADDRESSES, and {email} is not one of them. Add it there (the server's settings), then create it.", { email }) };
    const rule = cf?.rules.find((r) => r.address === email);
    if (rule && !rule.toHere)
      return { localPart: c.value, email, status: "elsewhere", notes: [],
        detail: rule.enabled
          ? msg("A Cloudflare rule {action}. Change or delete it in Cloudflare (the domain → Email → Email Routing → Routing rules), or use Bring them here on the domain, which keeps a copy.", { action: describeAction(email, rule.action) })
          : msg("A Cloudflare rule (switched off) {action}. Change or delete it in Cloudflare (the domain → Email → Email Routing → Routing rules), or use Bring them here on the domain, which keeps a copy.", { action: describeAction(email, rule.action) }) };
    const notes: string[] = [];
    if (rule?.enabled) notes.push(catchAll
      ? msg("Cloudflare already sends it here; until it exists, its mail is kept in {mailbox}, the domain's catch-all.", { mailbox: catchAll.mailbox })
      : msg("Cloudflare already sends it here; until it exists, its mail is refused."));
    else if (rule) notes.push(msg("Its Cloudflare rule to this server is switched off; creating it switches it on."));
    else if (catchAll && catchAllHere) notes.push(msg("Today its mail is kept in {mailbox}, the domain's catch-all; once created it has its own mailbox.", { mailbox: catchAll.mailbox }));
    else if (cf?.catchAll?.enabled && !cf.catchAll.toHere) notes.push(msg("Today Cloudflare's catch-all {action}; once created, its own rule sends it here.", { action: describeAction(email, cf.catchAll.action) }));
    const seen = recent.get(email);
    if (seen) notes.push(arrivedNote(seen.count, seen.lastSeen.slice(0, 16).replace("T", " "), seen.action === "rejected"));
    if (c.note) notes.push(c.note);
    return { localPart: c.value, email, status: "available", detail: msg("{email} can be created.", { email }), notes };
  });

  console.log(JSON.stringify({ event: "address_check", domain, state, names: names.length, available: names.filter((n) => n.status === "available").length }));
  return { domain, served, state, detail, rule: { canMake, detail: ruleDetail }, sendTestDefault: canMake || catchAllHere, catchAll, names };
}

/* ----------------------------------------------------------- several at once */

export interface BatchInput extends Omit<CreateAddressInput, "email"> {
  domain: string;
  localParts: string[];
}

/**
 * How much of one request a batch may spend. A Worker on the free plan may make 50 subrequests per
 * request (each Cloudflare API call is one); 40 leaves room for the route's own lookups. The time
 * stays well inside the app's 30-second wait, so the answer always arrives.
 */
export const BATCH_SUBREQUESTS = 40;
export const BATCH_TIME_MS = 15_000;
/** The most Cloudflare calls one address can take once its domain is read (make or switch on its rule, its status). */
const ROW_CALLS = 4;

export interface BatchLimits { subrequests?: number; timeBudgetMs?: number; now?: () => number }

/**
 * Several addresses on one domain with the same settings (SCN-064): one after another, sharing one
 * routing client, so the domain's zone, Email Routing and rules are read once and each address then
 * costs one Cloudflare call. A failure on one never stops the next. Each row has its own status and
 * steps; the display name is each address's own unless one is given for all.
 *
 * One request does only what fits its budget (above): the names it did not start come back in
 * `remaining`, in order, and sending them again continues; `complete` is false until then. A name is
 * never both done and handed back, and each row checks what exists before acting, so sending a
 * name again is safe (an address that exists answers 409).
 */
export async function createAddresses(env: Env, input: BatchInput, agentProblem: string | null, limits: BatchLimits = {}): Promise<OpResult> {
  const now = limits.now ?? Date.now;
  const started = now();
  const domain = input.domain.trim().toLowerCase();
  const served = await allServedDomains(env);
  if (!served.includes(domain))
    return { status: 400, body: { error: msg("{domain} is not served here; receive its mail here first (Settings → Domains, or connect_domain)", { domain }) } };
  if (agentProblem) return { status: 400, body: { error: agentProblem } };
  const { domain: _domain, localParts, ...settings } = input;

  // Every Cloudflare call of this request goes through one counter.
  let calls = 0;
  const counted: typeof fetch = (request, init) => { calls++; return fetch(request, init); };
  const accounts = new CloudflareAccounts(env, counted);
  const ctx: CreateContext = { served, client: settings.createRoute === false ? null : routingClient(env, counted) };
  if (settings.forwardTo) {
    // The copy goes to the same destination for every address: checked once, against the domain's account.
    const copy = await checkCopy(env, `x@${domain}`, settings.forwardTo, served, accounts);
    if ("error" in copy) return { status: 400, body: { error: copy.error } };
    ctx.copy = copy;
  }

  const budget = limits.subrequests ?? BATCH_SUBREQUESTS;
  const timeBudget = limits.timeBudgetMs ?? BATCH_TIME_MS;
  const results: Record<string, unknown>[] = [];
  const remaining: string[] = [];
  const seen = new Set<string>();
  for (const raw of localParts) {
    const check = checkLocalPart(raw);
    const email = `${check.value}@${domain}`;
    if (seen.has(email)) continue;
    seen.add(email);
    // At least one address per request, so every call makes progress.
    if (remaining.length || (results.length && (calls + ROW_CALLS > budget || now() - started >= timeBudget))) { remaining.push(raw); continue; }
    if (!check.valid) { results.push({ email, status: 400, error: check.problem }); continue; }
    const r = await createAddress(env, { ...settings, email }, null, ctx);
    results.push({ email, status: r.status, ...r.body });
  }
  const created = results.filter((r) => r.status === 201).length;
  console.log(JSON.stringify({ event: "address_batch", domain, asked: seen.size, done: results.length, created, remaining: remaining.length, cloudflareCalls: calls }));
  return { status: 200, body: {
    domain, created, failed: results.length - created, results, remaining, complete: remaining.length === 0,
    ...(remaining.length ? { note: msg("{count} of the {all} names were not started: one request may make only so many Cloudflare calls. Send the names in remaining again to continue.", { count: remaining.length, all: seen.size }) } : {}),
  } };
}

/* ------------------------------------------------------------ test messages */

const testKey = (email: string) => `routing-tests/${email}.json`;
/** A test not arrived after this long is reported as not arrived (SCN-062). */
export const TEST_WAIT_MS = 3 * 60_000;

interface TestRecord { subject: string; sentAt: string; outboxId: string | null; sendStatus: string; errorCode: string | null }

export interface TestStatus {
  subject: string;
  sentAt: string;
  /** The provider's answer to the send: accepted, pending, sending, failed or unknown. */
  sendStatus: string;
  state: "waiting" | "arrived" | "not_arrived" | "failed";
  detail: string;
  arrivedAt?: string;
  folder?: string;
}

function testState(record: TestRecord, arrival: { date: string; folder: string } | null, now: number): TestStatus {
  const base = { subject: record.subject, sentAt: record.sentAt, sendStatus: record.sendStatus };
  if (arrival)
    return { ...base, state: "arrived", arrivedAt: arrival.date, folder: arrival.folder,
      detail: arrival.folder === Folders.INBOX
        ? msg("The test message arrived: mail sent to this address reaches it here.")
        : msg("The test message arrived in {folder}: mail sent to this address reaches it here.", { folder: arrival.folder }) };
  if (record.sendStatus === "failed")
    return { ...base, state: "failed", detail: record.errorCode
      ? msg("The provider refused the test message ({code}): sending from this domain may be off. Turn on sending on its domain, then send it again.", { code: record.errorCode })
      : msg("The provider refused the test message: sending from this domain may be off. Turn on sending on its domain, then send it again.") };
  if (now - Date.parse(record.sentAt) > TEST_WAIT_MS)
    return { ...base, state: "not_arrived", detail: msg("The test message has not arrived after 3 minutes. Cloudflare may not send this address's mail here: check its routing.") };
  return { ...base, state: "waiting", detail: record.sendStatus === "accepted"
    ? msg("The provider accepted the test message; waiting for it to arrive.")
    : msg("The test message is being sent; waiting for it to arrive.") };
}

/**
 * Sends a message from the address to itself through the real transport (SCN-062) and keeps what
 * was sent, so its arrival can be read with routingTestStatus. The agent skips its own address.
 * Every send is its own message: a fresh idempotency key (so Send again never gets back an earlier
 * attempt's outbox row) and a nonce in the subject (so only this message's arrival counts).
 */
export async function sendRoutingTest(env: Env, rawEmail: string, now = Date.now()): Promise<OpResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!(await readSettings(env.BUCKET, email))) return { status: 404, body: { error: msg("Address not found") } };
  const id = crypto.randomUUID();
  const subject = `Fabric Inbox routing test ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC · ${id.slice(0, 8)}`;
  const result = await env.MAILBOX.get(env.MAILBOX.idFromName(email)).sendMail({
    mailboxId: email,
    idempotencyKey: `routing-test-${id}`,
    kind: "send",
    request: { from: email, to: email, subject, text: "If this message appears in the address's inbox, routing works." },
  });
  if ("error" in result) return { status: 400, body: { error: result.error } };
  const record: TestRecord = { subject, sentAt: new Date(now).toISOString(), outboxId: result.id ?? null, sendStatus: result.status, errorCode: result.errorCode ?? null };
  await env.BUCKET.put(testKey(email), JSON.stringify(record));
  console.log(JSON.stringify({ event: "routing_test_sent", domain: domainOf(email), status: result.status }));
  return { status: 200, body: { subject, status: result.status, errorCode: result.errorCode ?? null, test: testState(record, null, now) } };
}

/** The last test message of an address and whether it has arrived (SCN-062); null when none was sent. */
export async function routingTestStatus(env: Env, rawEmail: string, now = Date.now()): Promise<OpResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!(await env.BUCKET.head(settingsKey(email)))) return { status: 404, body: { error: msg("Address not found") } };
  const record = await (await env.BUCKET.get(testKey(email)))?.json<TestRecord>().catch(() => null);
  if (!record?.subject) return { status: 200, body: { email, test: null } };
  // Only the two reads used here; the full RPC type of the mailbox is too deep to infer.
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(email)) as unknown as {
    getOutboxAction(mailboxId: string, id: string): Promise<{ status: string; errorCode: string | null } | null>;
    searchEmails(options: { query: string; subject: string; date_start: string; limit: number }): Promise<{ subject?: string; folder_id?: string; date?: string }[]>;
  };
  // A send still in flight is read again from the outbox; its last answer is kept.
  if (record.outboxId && ["pending", "sending", "unknown"].includes(record.sendStatus)) {
    const entry = await stub.getOutboxAction(email, record.outboxId).catch(() => null);
    if (entry && entry.status !== record.sendStatus) {
      record.sendStatus = entry.status; record.errorCode = entry.errorCode ?? null;
      await env.BUCKET.put(testKey(email), JSON.stringify(record));
    }
  }
  // The search matches the subject anywhere (LIKE), so a reply ("Re: …") or an earlier test would
  // match too: only the exact subject, received at or after the send, is this test arriving. A
  // received message's date is the Worker's receive time (workers/index.ts), on the same clock as sentAt.
  const sentAt = Date.parse(record.sentAt);
  const rows = await stub.searchEmails({ query: "", subject: record.subject, date_start: record.sentAt, limit: 25 }).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "routing_test_read_failed", domain: domainOf(email), error: (error as Error).message }));
    return [];
  });
  const received = rows.find((r) => r.subject === record.subject && !!r.date && Date.parse(r.date) >= sentAt
    && !!r.folder_id && r.folder_id !== Folders.SENT && r.folder_id !== Folders.DRAFT);
  return { status: 200, body: { email, test: testState(record, received ? { date: received.date ?? "", folder: received.folder_id! } : null, now) } };
}
