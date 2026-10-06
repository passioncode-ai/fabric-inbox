import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { AGENT_TEMPLATES, readAssignment } from "../agents/definition";
import { registryError } from "../agents/errors";
import { RUN_OUTCOMES, type RunOutcome } from "../agents/run";
import { allServedDomains, createMailbox, deleteMailbox, readAllSettings, readSettings, settingsKey, storedCatchAll, updateSettings } from "../lib/mailbox-store";
import { cloudflareApi, cloudflareToken } from "../routing/cloudflare-api";
import { DomainManager } from "../routing/domains";
import { knownCollections } from "./knowledge";
import { createAddress, effectiveCatchAll, removeAddress, setForwardCopy } from "../lib/address-ops";
import { ROUTING_NOT_CONFIGURED, routingClient, RoutingError, type RoutingStatus } from "../routing/email-routing";

/**
 * SCR-09 (project addresses) and SCR-10 (agents). Behind the same Access and
 * same-origin boundary as every /api route (workers/app.ts).
 */
export const agentsRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const registry = (c: C) => c.env.AGENT_REGISTRY.getByName("workspace");

function registryFailure(c: C, error: unknown) {
  const known = registryError(error);
  if (!known) {
    console.error(JSON.stringify({ event: "agent_registry_error", error: (error as Error).message }));
    return c.json({ error: "Agents are unavailable right now" }, 503);
  }
  const status = known.code === "agent_conflict" ? 409 : known.code === "agent_not_found" ? 404 : 400;
  return c.json({ error: known.detail, code: known.code }, status);
}

/** Which addresses each agent answers; a mailbox without an assignment is listed as legacy. */
async function assignments(env: Env) {
  const all = await readAllSettings(env.BUCKET);
  return all.map(({ email, settings }) => ({ email, assignment: readAssignment(settings) ?? null }));
}

agentsRouter.use("/api/agents/*", async (c, next) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: "Agents are not configured on this server" }, 503);
  await next();
});
agentsRouter.use("/api/agents", async (c, next) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: "Agents are not configured on this server" }, 503);
  await next();
});

agentsRouter.get("/api/agents", async (c) => {
  try {
    const [agents, served] = await Promise.all([registry(c).listAgents(), assignments(c.env)]);
    return c.json({
      agents: agents.map((agent) => ({
        ...agent,
        addresses: served.filter((s) => s.assignment && s.assignment !== "off" && s.assignment.id === agent.id).map((s) => s.email),
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
  return missing.length ? `No such knowledge collection: ${missing.join(", ")}` : null;
}

agentsRouter.post("/api/agents", async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const problem = await unknownCollections(c, body?.agent ?? body);
    if (problem) return c.json({ error: problem }, 400);
    return c.json(await registry(c).createAgent(body?.agent ?? body), 201);
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.get("/api/agents/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const [agent, versions, served] = await Promise.all([registry(c).getAgent(id), registry(c).listVersions(id), assignments(c.env)]);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({ agent, versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt })),
      addresses: served.filter((s) => s.assignment && s.assignment !== "off" && s.assignment.id === id).map((s) => s.email) });
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.put("/api/agents/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Number.isInteger(body.expectedVersion)) return c.json({ error: "expectedVersion is required" }, 400);
  try {
    const problem = await unknownCollections(c, body.agent);
    if (problem) return c.json({ error: problem }, 400);
    return c.json(await registry(c).updateAgent(c.req.param("id"), body.agent, body.expectedVersion));
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.delete("/api/agents/:id", async (c) => {
  try {
    return (await registry(c).deleteAgent(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "Agent not found" }, 404);
  } catch (error) { return registryFailure(c, error); }
});

agentsRouter.get("/api/agent-runs", async (c) => {
  if (!c.env.AGENT_REGISTRY) return c.json({ error: "Agents are not configured on this server" }, 503);
  const limit = Number(c.req.query("limit") || 50);
  try {
    const outcome = c.req.query("outcome");
    if (outcome && !(outcome in RUN_OUTCOMES)) return c.json({ error: `outcome is one of ${Object.keys(RUN_OUTCOMES).join(", ")}` }, 400);
    return c.json(await registry(c).listRuns({
      mailboxId: c.req.query("mailbox") || undefined,
      agentId: c.req.query("agent") || undefined,
      outcome: (outcome || undefined) as RunOutcome | undefined,
      before: c.req.query("before") || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    }));
  } catch (error) { return registryFailure(c, error); }
});

// ── Project addresses (SCR-09) ─────────────────────────────────────

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const Assignment = z.union([z.literal("off"), z.object({ id: z.string().min(1).max(100) })]);
export const CreateAddress = z.object({
  localPart: z.string().trim().toLowerCase().regex(LOCAL_PART, "Use letters, digits, dots, dashes or plus"),
  domain: z.string().trim().toLowerCase().min(3).max(253),
  name: z.string().trim().max(80).optional(),
  agent: Assignment.optional(),
  /** "auto" makes the rule when the server can (it has a routing token); a zone the token cannot see gets a warning. */
  createRoute: z.union([z.boolean(), z.literal("auto")]).default(false),
  /** Keep forwarding a copy of each message here; must be a verified Email Routing destination. */
  forwardTo: z.string().trim().toLowerCase().email().max(90).optional(),
}).strict();

async function checkAgentExists(c: C, assignment: z.infer<typeof Assignment> | undefined) {
  if (!assignment || assignment === "off") return null;
  return (await registry(c).getAgent(assignment.id)) ? null : "The chosen agent does not exist";
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
    const [served, unknown, agents, issues] = await Promise.all([
      readAllSettings(c.env.BUCKET),
      unknownRecipients(c.env.BUCKET),
      c.env.AGENT_REGISTRY ? registry(c).listAgents() : Promise.resolve([]),
      deliveryIssues(c.env.BUCKET),
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
        };
      }),
      unknownRecipients: unknown.filter((u) => !served.some((s) => s.email === u.address)),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "project_addresses_error", error: (error as Error).message }));
    return c.json({ error: "Project addresses are unavailable right now" }, 503);
  }
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
  if (!(await c.env.BUCKET.head(settingsKey(email)))) return c.json({ error: "Create the address first" }, 404);
  try {
    return c.json(await client.createRule(email));
  } catch (error) {
    return c.json({ error: error instanceof RoutingError ? error.message : "Routing could not be changed" }, 502);
  }
});

/**
 * Creates the address (SCN-021). When a routing rule is requested it is created
 * first, so a failed rule leaves no mailbox behind; an existing address is
 * reported, never duplicated.
 */
agentsRouter.post("/api/project-addresses", async (c) => {
  const parsed = CreateAddress.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid address" }, 400);
  const input = parsed.data;
  const agentProblem = c.env.AGENT_REGISTRY ? await checkAgentExists(c, input.agent) : input.agent && input.agent !== "off" ? "Agents are not configured" : null;
  const result = await createAddress(c.env, { email: `${input.localPart}@${input.domain}`, name: input.name, agent: input.agent,
    createRoute: input.createRoute, forwardTo: input.forwardTo }, agentProblem);
  return c.json(result.body, result.status);
});

/**
 * Removes an address (SCN-032): its routing rule to this server first, then the
 * mailbox with its mail. A domain's catch-all is refused until another is chosen.
 */
agentsRouter.delete("/api/project-addresses/:email", async (c) => {
  const result = await removeAddress(c.env, c.req.param("email"));
  return c.json(result.body, result.status);
});

agentsRouter.put("/api/project-addresses/:email/copy", async (c) => {
  const parsed = z.object({ forwardTo: z.string().trim().toLowerCase().email().max(90).nullable() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose a forwarding destination, or no copy" }, 400);
  const result = await setForwardCopy(c.env, c.req.param("email"), parsed.data.forwardTo);
  return c.json(result.body, result.status);
});

agentsRouter.put("/api/project-addresses/:email/agent", async (c) => {
  const parsed = z.object({ agent: Assignment }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose an agent or Off" }, 400);
  if (c.env.AGENT_REGISTRY) {
    const missing = await checkAgentExists(c, parsed.data.agent);
    if (missing) return c.json({ error: missing }, 400);
  } else if (parsed.data.agent !== "off") return c.json({ error: "Agents are not configured" }, 503);
  const email = c.req.param("email").toLowerCase();
  const next = await updateSettings(c.env.BUCKET, email, (s) => ({ ...s, agent: parsed.data.agent }));
  return next ? c.json({ email, agent: parsed.data.agent }) : c.json({ error: "Address not found" }, 404);
});

/**
 * Sends a message from the address to itself through the real transport, so
 * the operator sees routing work end to end. The agent skips its own address.
 */
agentsRouter.post("/api/project-addresses/:email/test", async (c) => {
  const email = c.req.param("email").toLowerCase();
  const settings = await readSettings(c.env.BUCKET, email);
  if (!settings) return c.json({ error: "Address not found" }, 404);
  const subject = `Fabric Inbox routing test ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const result = await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email)).sendMail({
    mailboxId: email,
    idempotencyKey: `routing-test-${subject}`,
    kind: "send",
    request: { from: email, to: email, subject, text: "If this message appears in the address's inbox, routing works." },
  });
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json({ subject, status: result.status, errorCode: result.errorCode });
});
