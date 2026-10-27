import { Hono, type Context } from "hono";
import { cancelRename, renameAddress, renameStatus } from "../lib/address-rename";
import { renamesInProgress } from "../lib/rename-journal";
import { z } from "zod";
import type { Env } from "../types";
import { AGENT_TEMPLATES, readAssignment } from "../agents/definition";
import { isAccountMailbox, updateAccountSettings } from "../agents/account-settings";
import { REASONING_EFFORTS, type ReasoningEffort } from "../agents/model";
import { registryError } from "../agents/errors";
import { RUN_OUTCOMES, type RunOutcome } from "../agents/run";
import { allServedDomains, createMailbox, deleteMailbox, isDomainName, readAllSettings, readSettings, settingsKey, storedCatchAll, updateSettings } from "../lib/mailbox-store";
import { cloudflareApi, cloudflareToken } from "../routing/cloudflare-api";
import { DomainManager } from "../routing/domains";
import { knownCollections } from "./knowledge";
import { mailVolume } from "../agents/volume";
import { runSpent } from "../agents/usage";
import { actorOf } from "../lib/audit";
import type { Standing } from "../lib/members";
import type { AgentVersion } from "../agents/definition";
import { addressesByAgent, agentLearned, publishKnowledge, validatorOf } from "../agents/knowledge-events";
import { clearIncomingFailures, listIncomingFailures } from "../incoming-log";
import {
  checkAddresses, createAddress, createAddresses, removeAddress, pauseAddress, resumeAddress, pausedAddresses, routingTestStatus, sendRoutingTest, setForwardCopy, effectiveCatchAll,
} from "../lib/address-ops";
import { BATCH_MAX, checkLocalPart } from "../../shared/address-name";
import { ROUTING_NOT_CONFIGURED, routingClient, RoutingError, type RoutingStatus } from "../routing/email-routing";
import { msg } from "../../shared/i18n";
import { HookInvalid, addHook, readHooks, removeHook, type HookCursor } from "../agents/event-hooks";

/**
 * SCR-09 (project addresses) and SCR-10 (agents). Behind the same Access and
 * same-origin boundary as every /api route (workers/app.ts).
 */
export const agentsRouter = new Hono<{ Bindings: Env; Variables: { standing?: Standing } }>();
type C = Context<{ Bindings: Env; Variables: { standing?: Standing } }>;

const registry = (c: C) => c.env.AGENT_REGISTRY.getByName("workspace");

function registryFailure(c: C, error: unknown) {
  const known = registryError(error);
  if (!known) {
    console.error(JSON.stringify({ event: "agent_registry_error", error: (error as Error).message }));
    return c.json({ error: msg("Agents are unavailable right now") }, 503);
  }
  const status = known.code === "agent_conflict" ? 409 : known.code === "agent_not_found" ? 404 : 400;
  return c.json({ error: known.detail, code: known.code }, status);
}

/** Which addresses each agent answers; a mailbox without an assignment is listed as legacy. */
async function assignments(env: Env) {
  const all = await readAllSettings(env.BUCKET);
  return all.map(({ email, settings }) => ({ email, assignment: readAssignment(settings) ?? null }));
}

/** B-171: which Gmail, IMAP and Outlook accounts each agent answers (R2 `accounts/<provider>:<id>.json`). */
async function accountAssignments(env: Env): Promise<{ accountId: string; agentId: string }[]> {
  const out: { accountId: string; agentId: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "accounts/", cursor });
    const rows = await Promise.all(page.objects.map(async (o) => {
      const accountId = o.key.slice("accounts/".length).replace(/\.json$/, "");
      if (!isAccountMailbox(accountId)) return null;
      const assignment = readAssignment(await (await env.BUCKET.get(o.key))?.json<Record<string, unknown>>().catch(() => null));
      return assignment && assignment !== "off" ? { accountId, agentId: assignment.id } : null;
    }));
    out.push(...rows.filter((r): r is { accountId: string; agentId: string } => !!r));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** B-161: an agent's own knowledge text that changed goes on the events feed (workers/agents/knowledge-events.ts). */
async function knowledgeChanged(env: Env, raw: Request, email: string | undefined, saved: AgentVersion, before: string) {
  if ((saved.knowledge ?? "").trim() === before.trim() || !(saved.knowledge ?? "").trim()) return;
  const addresses = (await addressesByAgent(env).catch(() => new Map<string, string[]>())).get(saved.id) ?? [];
  await publishKnowledge(env, [agentLearned({ id: saved.id, version: saved.version, knowledge: saved.knowledge ?? "" }, addresses, new Date().toISOString(), validatorOf(actorOf(raw, email)))]);
}

agentsRouter.use("/api/agents/*", async (c, next) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  await next();
});
agentsRouter.use("/api/agents", async (c, next) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  await next();
});

agentsRouter.get("/api/agents", async (c) => {
  try {
    const [agents, served, accounts] = await Promise.all([registry(c).listAgents(), assignments(c.env), accountAssignments(c.env)]);
    return c.json({
      agents: agents.map((agent) => ({
        ...agent,
        addresses: served.filter((s) => s.assignment && s.assignment !== "off" && s.assignment.id === agent.id).map((s) => s.email),
        accounts: accounts.filter((a) => a.agentId === agent.id).map((a) => a.accountId),
      })),
      templates: AGENT_TEMPLATES,
      toolHosts: (c.env.AUTOMATION_MCP_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    });
  } catch (error) { return registryFailure(c, error); }
});

/** An agent may be granted only collections that exist (KN-3). */
async function unknownCollections(c: C, input: unknown): Promise<string | null> {
  const wanted = (input as { collections?: unknown })?.collections;
  if (!Array.isArray(wanted) || !wanted.length) return null;
  const known = await knownCollections(c.env);
  const missing = wanted.filter((id) => typeof id !== "string" || !known.has(id));
  return missing.length ? msg("No such knowledge collection: {names}", { names: missing.join(", ") }) : null;
}

agentsRouter.post("/api/agents", async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const problem = await unknownCollections(c, body?.agent ?? body);
    if (problem) return c.json({ error: problem }, 400);
    const created = await registry(c).createAgent(body?.agent ?? body);
    await knowledgeChanged(c.env, c.req.raw, c.get("standing")?.email, created, "");
    return c.json(created, 201);
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.get("/api/agents/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const [agent, versions, served, accounts] = await Promise.all([registry(c).getAgent(id), registry(c).listVersions(id), assignments(c.env), accountAssignments(c.env)]);
    if (!agent) return c.json({ error: msg("Agent not found") }, 404);
    return c.json({ agent, versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt })),
      addresses: served.filter((s) => s.assignment && s.assignment !== "off" && s.assignment.id === id).map((s) => s.email),
      accounts: accounts.filter((a) => a.agentId === id).map((a) => a.accountId) });
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.put("/api/agents/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Number.isInteger(body.expectedVersion)) return c.json({ error: "expectedVersion is required" }, 400);
  try {
    const problem = await unknownCollections(c, body.agent);
    if (problem) return c.json({ error: problem }, 400);
    // A-12: an agent that answers an account which cannot keep drafts does not turn to drafting; its answers would wait nowhere.
    if (body.agent?.replyPolicy?.mode === "draft" && c.env.GMAIL_ACCOUNTS) {
      const mine = (await accountAssignments(c.env)).filter((a) => a.agentId === c.req.param("id")).map((a) => a.accountId);
      if (mine.length) {
        const accounts = (await c.env.GMAIL_ACCOUNTS.getByName("workspace").listAccounts()).accounts;
        const blocked = accounts.filter((a) => mine.includes(`${a.provider}:${a.id}`) && !a.capabilities?.drafts).map((a) => a.email);
        if (blocked.length)
          return c.json({ error: msg("This agent answers {accounts}, which cannot keep drafts. Choose another agent there first, or keep it sending.", { accounts: blocked.join(", ") }) }, 400);
      }
    }
    const before = await registry(c).getAgent(c.req.param("id"));
    const saved = await registry(c).updateAgent(c.req.param("id"), body.agent, body.expectedVersion);
    await knowledgeChanged(c.env, c.req.raw, c.get("standing")?.email, saved, before?.knowledge ?? "");
    return c.json(saved);
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.delete("/api/agents/:id", async (c) => {
  try {
    return (await registry(c).deleteAgent(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: msg("Agent not found") }, 404);
  } catch (error) { return registryFailure(c, error); }
});

/** One run, by id (B-115: the reader's panel for a message an agent answered). */
agentsRouter.get("/api/agent-runs/:id", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  try {
    const [run] = await registry(c).runsByIds([c.req.param("id")]);
    return run ? c.json({ ...run, spent: runSpent(run) }) : c.json({ error: msg("This agent run is not kept any more") }, 404);
  } catch (error) { return registryFailure(c, error); }
});

/** Answer again: the run's message goes back to its agent as the next attempt. */
/** What an agent would answer to a message, sent nowhere (preview_agent_answer). */
agentsRouter.post("/api/agents/:id/preview", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  const body = await c.req.json().catch(() => null) as { address?: unknown; from?: unknown; subject?: unknown; text?: unknown; reasoning?: unknown } | null;
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const from = typeof body?.from === "string" ? body.from.trim() : "";
  const text = typeof body?.text === "string" ? body.text : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(address) || !/^[^\s@]+@[^\s@]+$/.test(from) || !text.trim() || text.length > 20_000)
    return c.json({ error: msg("A preview needs the address, a sender and the message text") }, 400);
  // B-174: a preview may try the writer at another reasoning effort ("default": the provider's own).
  const reasoning = body?.reasoning === undefined ? undefined : body.reasoning === "default" ? null
    : (REASONING_EFFORTS as readonly unknown[]).includes(body.reasoning) ? body.reasoning as ReasoningEffort : false;
  if (reasoning === false) return c.json({ error: msg("reasoning is one of none, minimal, low, medium, high or default") }, 400);
  try {
    return c.json(await registry(c).previewAnswer(c.req.param("id"), { address, from, subject: typeof body?.subject === "string" ? body.subject.slice(0, 500) : "", text,
      ...(reasoning !== undefined ? { reasoning } : {}) }));
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.post("/api/agent-runs/:id/again", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  try {
    const result = await registry(c).answerAgain(c.req.param("id"));
    return result.ok ? c.json(result.run) : c.json({ error: result.reason }, 409);
  } catch (error) { return registryFailure(c, error); }
});

/** The agent-events feed (B-118): what reply agents did, for other agents, by cursor. */
agentsRouter.get("/api/agent-events", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  try {
    return c.json(await registry(c).listEvents(c.req.query("after") ?? null, Number(c.req.query("limit") || 50)));
  } catch (error) { return registryFailure(c, error); }
});

/** B-137: webhooks that receive the agent events (the secret is shown once, when a hook is made). */
agentsRouter.get("/api/event-hooks", async (c) => {
  c.header("Cache-Control", "no-store");
  const hooks = await readHooks(c.env.BUCKET);
  const states = c.env.AGENT_REGISTRY && hooks.length ? await registry(c).hookStates(hooks.map((h) => h.id)).catch(() => ({} as Record<string, HookCursor>)) : {};
  return c.json({ hooks: hooks.map(({ secret: _secret, ...h }) => ({ ...h, delivery: states[h.id] ?? null })) });
});
agentsRouter.post("/api/event-hooks", async (c) => {
  const body = await c.req.json().catch(() => null) as { url?: unknown; kinds?: unknown } | null;
  if (!body || typeof body.url !== "string" || (body.kinds !== undefined && !(Array.isArray(body.kinds) && body.kinds.every((k) => typeof k === "string"))))
    return c.json({ error: msg("Give the https URL, and the event kinds if not the default") }, 400);
  try {
    const hook = await addHook(c.env.BUCKET, { url: body.url, kinds: body.kinds as string[] | undefined });
    if (c.env.AGENT_REGISTRY) await registry(c).wakeHooks().catch(() => undefined);
    console.log(JSON.stringify({ event: "event_hook_added", kinds: hook.kinds.length }));
    return c.json({ hook: { id: hook.id, url: hook.url, kinds: hook.kinds, createdAt: hook.createdAt }, secret: hook.secret,
      note: msg("Keep the secret now: it is not shown again. Each delivery is signed with it (X-Fabric-Signature).") }, 201);
  } catch (error) {
    if (error instanceof HookInvalid) return c.json({ error: error.message }, 400);
    throw error;
  }
});
agentsRouter.delete("/api/event-hooks/:id", async (c) => {
  const removed = await removeHook(c.env.BUCKET, c.req.param("id"));
  return removed ? c.json({ removed: true }) : c.json({ error: msg("No such hook") }, 404);
});

/** Mail volume per agent address and UTC day (B-126): counts only, for the support monitor. */
agentsRouter.get("/api/agent-volume", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  const days = Number(c.req.query("days") || 14);
  try {
    return c.json(await mailVolume(c.env, Number.isFinite(days) ? days : 14));
  } catch (error) { return registryFailure(c, error); }
});

/** B-152: a judge comparison over one address's sent answers, a slice per call (an administrator's). */
const BENCH_MODEL = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;
const benchBody = z.object({
  address: z.string().email().max(254),
  days: z.number().int().min(1).max(90).optional(),
  runs: z.number().int().min(1).max(200).optional(),
  models: z.array(z.string().max(100).regex(BENCH_MODEL)).max(12).optional(),
  reference: z.string().max(100).regex(BENCH_MODEL).optional(),
  restart: z.boolean().optional(),
  offset: z.number().int().min(0).optional(),
});
agentsRouter.post("/api/agent-bench", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  c.header("Cache-Control", "no-store");
  const body = benchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: msg("Give the address, and optionally days, runs, models, reference, restart and offset") }, 400);
  try {
    return c.json(await registry(c).judgeBench(body.data.address, body.data));
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.get("/api/agent-runs", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured on this server") }, 503);
  const limit = Number(c.req.query("limit") || 50);
  try {
    const outcome = c.req.query("outcome");
    if (outcome && !(outcome in RUN_OUTCOMES)) return c.json({ error: `outcome is one of ${Object.keys(RUN_OUTCOMES).join(", ")}` }, 400);
    const runs = await registry(c).listRuns({
      mailboxId: c.req.query("mailbox") || undefined,
      agentId: c.req.query("agent") || undefined,
      outcome: (outcome || undefined) as RunOutcome | undefined,
      before: c.req.query("before") || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    // B-163: what each run's model calls used, the writer and the checker apart (null: no receipts kept).
    return c.json(runs.map((run) => ({ ...run, spent: runSpent(run) })));
  } catch (error) { return registryFailure(c, error); }
});

// ── Project addresses (SCR-09) ─────────────────────────────────────

/** The part before @, checked as the dialog checks it (shared/address-name.ts): a refusal says why in words. */
const LocalPart = z.string().max(320).transform((v, ctx) => {
  const check = checkLocalPart(v);
  if (!check.valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: check.problem ?? msg("Not a valid name") });
  return check.value;
});
const Assignment = z.union([z.literal("off"), z.object({ id: z.string().min(1).max(100) })]);
const Domain = z.string().trim().toLowerCase().min(3).max(253);
const Signature = z.object({ enabled: z.boolean(), text: z.string().max(2000) }).strict();
/** The settings an address is created with, one at a time or several at once. */
const AddressSettings = {
  name: z.string().trim().max(80).optional(),
  agent: Assignment.optional(),
  /** Added to mail sent from the address; off unless enabled with text. */
  signature: Signature.optional(),
  /**
   * "auto" makes the rule when the server can, and when it cannot (no token, a zone no token sees,
   * Cloudflare refused) still creates the address and says why in its steps; true requires the rule.
   */
  createRoute: z.union([z.boolean(), z.literal("auto")]).default(false),
  /** Keep forwarding a copy of each message here; must be a verified Email Routing destination. */
  forwardTo: z.string().trim().toLowerCase().email().max(90).optional(),
};
export const CreateAddress = z.object({ localPart: LocalPart, domain: Domain, ...AddressSettings }).strict();
/** Several addresses on one domain with the same settings (SCN-064); each name is checked on its own. */
export const CreateAddresses = z.object({
  domain: Domain,
  localParts: z.array(z.string().max(320)).min(1, msg("Give at least one name")).max(BATCH_MAX, msg("At most {max} addresses at once", { max: BATCH_MAX })),
  ...AddressSettings,
}).strict();

async function checkAgentExists(c: C, assignment: z.infer<typeof Assignment> | undefined) {
  if (!assignment || assignment === "off") return null;
  return (await registry(c).getAgent(assignment.id)) ? null : msg("The chosen agent does not exist");
}

/** Last forwarding failure per address (written by the email handler, cleared by the next success). */
async function deliveryIssues(bucket: R2Bucket): Promise<Map<string, { target: string; problem: string; count: number; lastAt: string }>> {
  const issues = new Map<string, { target: string; problem: string; count: number; lastAt: string }>();
  const page = await bucket.list({ prefix: "delivery-issues/" });
  await Promise.all(page.objects.slice(0, 200).map(async (o) => {
    const v = await (await bucket.get(o.key))?.json<{ mailboxId: string; target: string; problem: string; count: number; lastAt: string }>().catch(() => null);
    if (v?.mailboxId) issues.set(v.mailboxId, { target: v.target, problem: v.problem, count: v.count, lastAt: v.lastAt });
  }));
  return issues;
}

async function unknownRecipients(bucket: R2Bucket) {
  const rows: { address: string; domain: string; action: string; count: number; lastSeen: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "unknown-recipients/", cursor });
    const values = await Promise.all(page.objects.slice(0, 200 - rows.length).map(async (o) => (await bucket.get(o.key))?.json<typeof rows[number]>()));
    rows.push(...(values.filter(Boolean) as typeof rows));
    cursor = page.truncated && rows.length < 200 ? page.cursor : undefined;
  } while (cursor);
  return rows.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

agentsRouter.get("/api/project-addresses", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const [served, unknown, agents, issues, failures, renames, paused] = await Promise.all([
      readAllSettings(c.env.BUCKET),
      unknownRecipients(c.env.BUCKET),
      c.env.AGENT_REGISTRY ? registry(c).listAgents() : Promise.resolve([]),
      deliveryIssues(c.env.BUCKET),
      listIncomingFailures(c.env.BUCKET).catch(() => []),
      // A finding of 2026-10-21: an unreadable pause list is said so (`pausedUnknown`), not shown as "nothing paused".
      // B-135: renames in progress, so the list marks both addresses of each.
      renamesInProgress(c.env.BUCKET).catch(() => []),
      pausedAddresses(c.env.BUCKET).catch((error: unknown) => {
        console.warn(JSON.stringify({ event: "paused_list_unreadable", error: (error as Error)?.message?.slice(0, 200) }));
        return null;
      }),
    ]);
    const names = new Map<string, string>(agents.map((a) => [a.id, a.name] as [string, string]));
    const domains = await allServedDomains(c.env);
    let policies: Record<string, unknown> = {};
    try { policies = JSON.parse(c.env.UNKNOWN_ADDRESS_POLICY || "{}"); } catch { policies = {}; }
    return c.json({
      // The catch-all in effect and where it is set (the deployment's policy wins), so the screen never shows a choice that does nothing.
      domains: await Promise.all(domains.map(async (domain) => ({ domain,
        unknownAddressPolicy: typeof policies[domain] === "string" ? policies[domain] : "reject",
        catchAll: await effectiveCatchAll(c.env, domain) }))),
      routingConfigured: !!cloudflareToken(c.env),
      ...(paused === null ? { pausedUnknown: true } : {}),
      addresses: served.map(({ email, settings }) => {
        const assignment = readAssignment(settings);
        return {
          email,
          domain: email.slice(email.lastIndexOf("@") + 1),
          name: typeof settings.fromName === "string" ? settings.fromName : email,
          agent: assignment === undefined ? "legacy" : assignment,
          agentName: assignment && assignment !== "off" ? names.get(assignment.id) ?? null : null,
          forwardTo: (settings.forwarding as { enabled?: boolean; email?: string } | undefined)?.enabled
            ? (settings.forwarding as { email?: string }).email ?? null : null,
          deliveryIssue: issues.get(email) ?? null,
          // B-27: since when the address is paused (an empty string when the time is unreadable), or null.
          paused: paused?.has(email) ? paused.get(email)! : null,
          renaming: (() => {
            const j = renames.find((r) => r.from === email.toLowerCase() || r.to === email.toLowerCase());
            return j ? { from: j.from, to: j.to } : null;
          })(),
        };
      }),
      unknownRecipients: unknown.filter((u) => !served.some((s) => s.email === u.address)),
      // Mail the server could neither take nor refuse (B-40): whom it was for, when, the size, why.
      incomingFailures: failures.map((f) => ({ ...f, domain: (f.to ?? "").slice((f.to ?? "").lastIndexOf("@") + 1) || null })),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "project_addresses_error", error: (error as Error).message }));
    return c.json({ error: msg("Project addresses are unavailable right now") }, 503);
  }
});

/** The owner has seen the failures (B-40): all of them, or one domain's (`?domain=`). */
agentsRouter.delete("/api/incoming-failures", async (c) => {
  const domain = c.req.query("domain")?.trim().toLowerCase();
  if (domain && !isDomainName(domain)) return c.json({ error: msg("Not a domain name") }, 400);
  return c.json({ removed: await clearIncomingFailures(c.env.BUCKET, domain || undefined) });
});

agentsRouter.get("/api/project-addresses/:email/routing", async (c) => {
  c.header("Cache-Control", "no-store");
  const client = routingClient(c.env);
  return c.json(client ? await client.status(c.req.param("email")) : ROUTING_NOT_CONFIGURED);
});

agentsRouter.post("/api/project-addresses/:email/routing", async (c) => {
  const client = routingClient(c.env);
  if (!client) return c.json({ error: ROUTING_NOT_CONFIGURED.detail }, 503);
  const email = c.req.param("email").toLowerCase();
  if (!(await c.env.BUCKET.head(settingsKey(email)))) return c.json({ error: msg("Create the address first") }, 404);
  try {
    return c.json(await client.createRule(email));
  } catch (error) {
    return c.json({ error: error instanceof RoutingError ? error.message : msg("Routing could not be changed") }, 502);
  }
});

/**
 * Creates the address (SCN-021). When a routing rule is requested it is created
 * first, so a failed rule leaves no mailbox behind; an existing address is
 * reported, never duplicated.
 */
agentsRouter.post("/api/project-addresses", async (c) => {
  const parsed = CreateAddress.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? msg("Invalid address") }, 400);
  const input = parsed.data;
  const result = await createAddress(c.env, { email: `${input.localPart}@${input.domain}`, name: input.name, agent: input.agent,
    signature: input.signature, createRoute: input.createRoute, forwardTo: input.forwardTo }, await agentProblemOf(c, input.agent));
  return c.json(result.body, result.status);
});

const agentProblemOf = async (c: C, agent: z.infer<typeof Assignment> | undefined) =>
  c.env.AGENT_REGISTRY ? await checkAgentExists(c, agent) : agent && agent !== "off" ? msg("Agents are not configured") : null;

/** SCN-064: several addresses on one domain, each with its own result and steps. */
agentsRouter.post("/api/project-addresses/batch", async (c) => {
  const parsed = CreateAddresses.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? msg("Invalid request") }, 400);
  const { localParts, domain, ...settings } = parsed.data;
  const result = await createAddresses(c.env, { domain, localParts, ...settings }, await agentProblemOf(c, settings.agent));
  return c.json(result.body, result.status);
});

/**
 * The names of a check: a JSON array of strings (check_address; a name is never split, so one with a
 * comma is checked as the one invalid name it is), or a comma-separated list (the dialog, whose names
 * are already valid). An error, in words, when it is not a list of up to 50 names.
 */
export function checkNames(raw: string | undefined): { names: string[] } | { error: string } {
  const text = (raw ?? "").trim();
  let names: unknown;
  if (text.startsWith("[")) {
    try { names = JSON.parse(text); } catch { return { error: msg("names must be a JSON array of strings, or names separated by commas") }; }
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && n.length <= 320))
      return { error: msg("names must be a JSON array of strings (each at most 320 characters)") };
  } else names = text.split(",");
  const list = (names as string[]).map((n) => n.trim()).filter(Boolean);
  if (list.length > BATCH_MAX) return { error: msg("At most {max} names at once", { max: BATCH_MAX }) };
  return { names: list };
}

/** SCN-061: before creating, what the dialog and check_address say about a domain and some names (checkNames). Read-only. */
agentsRouter.get("/api/project-addresses/check", async (c) => {
  c.header("Cache-Control", "no-store");
  const domain = (c.req.query("domain") ?? "").trim().toLowerCase();
  if (!isDomainName(domain)) return c.json({ error: msg("Give the domain, e.g. domain=example.com") }, 400);
  const parsed = checkNames(c.req.query("names"));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  try {
    return c.json(await checkAddresses(c.env, domain, parsed.names));
  } catch (error) {
    console.error(JSON.stringify({ event: "address_check_error", domain, error: (error as Error).message }));
    return c.json({ error: msg("The address could not be checked right now. Try again.") }, 503);
  }
});

/**
 * Removes an address (SCN-032): its routing rule to this server first, then the
 * mailbox with its mail. A domain's catch-all is refused until another is chosen.
 */
agentsRouter.delete("/api/project-addresses/:email", async (c) => {
  const result = await removeAddress(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});

/** B-27: rename or move an address keeping its mail; a call continues a rename already started. */
export const RenameInput = z.object({ to: z.string().trim().toLowerCase().email().max(254) }).strict();
agentsRouter.post("/api/project-addresses/:email/rename", async (c) => {
  const parsed = RenameInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Give the new address") }, 400);
  const result = await renameAddress(c.env, c.req.param("email"), parsed.data.to);
  return c.json(result.body, result.status);
});
/** Review 2026-10-21: a rename that has not routed the new address yet can be cancelled. */
agentsRouter.delete("/api/project-addresses/:email/rename", async (c) => {
  const result = await cancelRename(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});
agentsRouter.get("/api/project-addresses/:email/rename", async (c) => {
  c.header("Cache-Control", "no-store");
  const result = await renameStatus(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});

/** B-27: pause an address keeping its mail, and resume it. */
agentsRouter.post("/api/project-addresses/:email/pause", async (c) => {
  const result = await pauseAddress(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});
agentsRouter.post("/api/project-addresses/:email/resume", async (c) => {
  const result = await resumeAddress(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});

export const CopyInput = z.object({ forwardTo: z.string().trim().toLowerCase().email().max(90).nullable() }).strict();
agentsRouter.put("/api/project-addresses/:email/copy", async (c) => {
  const parsed = CopyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Choose a forwarding destination, or no copy") }, 400);
  const result = await setForwardCopy(c.env, c.req.param("email"), parsed.data.forwardTo);
  return c.json(result.body, result.status);
});

export const AgentAssignmentInput = z.object({ agent: Assignment }).strict();
agentsRouter.put("/api/project-addresses/:email/agent", async (c) => {
  const parsed = AgentAssignmentInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Choose an agent or Off") }, 400);
  if (c.env.AGENT_REGISTRY) {
    const missing = await checkAgentExists(c, parsed.data.agent);
    if (missing) return c.json({ error: missing }, 400);
  } else if (parsed.data.agent !== "off") return c.json({ error: msg("Agents are not configured") }, 503);
  const email = c.req.param("email").toLowerCase();
  const next = await updateSettings(c.env.BUCKET, email, (s) => ({ ...s, agent: parsed.data.agent }));
  return next ? c.json({ email, agent: parsed.data.agent }) : c.json({ error: msg("Address not found") }, 404);
});

/**
 * B-171 phase 2: the reply agent of a Gmail, IMAP or Outlook account (`:accountId` as the account
 * routes take it, without its provider), or Off. Written to R2 `accounts/<provider>:<id>.json`
 * conditionally on its version. An agent that drafts is refused on an account that cannot keep
 * drafts: its answers would have nowhere to wait (decision 3 of the B-171 packet).
 */
agentsRouter.put("/api/accounts/:accountId/agent", async (c) => {
  const parsed = AgentAssignmentInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: msg("Choose an agent or Off") }, 400);
  if (!c.env.GMAIL_ACCOUNTS) return c.json({ error: msg("Mail accounts are not configured on this server") }, 503);
  const id = c.req.param("accountId");
  const account = (await c.env.GMAIL_ACCOUNTS.getByName("workspace").listAccounts()).accounts.find((a) => a.id === id);
  if (!account) return c.json({ error: msg("Account not found") }, 404);
  const agent = parsed.data.agent;
  if (agent !== "off") {
    if (!c.env.AGENT_REGISTRY) return c.json({ error: msg("Agents are not configured") }, 503);
    const chosen = await registry(c).getAgent(agent.id);
    if (!chosen) return c.json({ error: msg("The chosen agent does not exist") }, 400);
    if (chosen.replyPolicy.mode === "draft" && !account.capabilities?.drafts)
      return c.json({ error: msg("{agent} leaves its answers as drafts, and this account cannot keep drafts. Choose an agent that sends, or Off.", { agent: chosen.name }) }, 400);
  }
  const accountId = `${account.provider}:${account.id}`;
  await updateAccountSettings(c.env.BUCKET, accountId, (s) => ({ ...s, agent }));
  console.log(JSON.stringify({ event: "account_agent_set", provider: account.provider, agent: agent === "off" ? "off" : "on" }));
  return c.json({ accountId, email: account.email, agent });
});

/**
 * Sends a message from the address to itself through the real transport, so
 * the operator sees routing work end to end. The agent skips its own address.
 */
agentsRouter.post("/api/project-addresses/:email/test", async (c) => {
  const result = await sendRoutingTest(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});

/** SCN-062: the last test message of the address and whether it has arrived; the dialog asks every 5 s. */
agentsRouter.get("/api/project-addresses/:email/test", async (c) => {
  c.header("Cache-Control", "no-store");
  const result = await routingTestStatus(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});
