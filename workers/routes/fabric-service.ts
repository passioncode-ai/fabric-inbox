import { Hono, type Context } from "hono";
import { version } from "../../package.json";
import type { Env } from "../types";
import { BUILD_ID, SOURCE } from "../../shared/build";
import { accountIdFor, cloudflareApi } from "../routing/cloudflare-api";
import { principalFor, readAgentKeys, type AccessClaims } from "../mcp/keys";
import { ensureServiceApp, forgetServiceAudience, readServiceAccess, SERVICE_ACCESS_KEY } from "../mcp/service-access";
import type { ModelUsageRow } from "../agents/registry";
import { NARROW_HEADER } from "../mcp/scope";

/**
 * Fabric Inbox as a Fabric service in the remote placement (fabric-service/0.1, contract DEC-0015,
 * DEC-0019; B-87 part 4): the well-known document, the agent-events page and the usage report
 * (DEC-0021). Cloudflare Access is in front: a host sends the descriptor's token in one header the
 * Access application reads (`read_service_tokens_from_header`), and only a person or a registered
 * agent key passes here; anyone else gets 401 with an empty body, as the remote placement asks.
 */
export const fabricServiceRouter = new Hono<{ Bindings: Env; Variables: { access?: AccessClaims } }>();
type C = Context<{ Bindings: Env; Variables: { access?: AccessClaims } }>;

export const SERVICE_ID = "fabric-inbox";
export const WELL_KNOWN_PATH = "/.well-known/fabric-service";
export const EVENTS_PATH = "/fabric/v1/events";
export const USAGE_PATH = "/fabric/v1/usage";


/** The descriptor's instance: `default`, or FABRIC_SERVICE_INSTANCE for a second server of the same person. */
const instanceOf = (env: Env) => { const v = (env as Env & { FABRIC_SERVICE_INSTANCE?: string }).FABRIC_SERVICE_INSTANCE; return v && /^[a-z][a-z0-9-]{0,31}$/.test(v) ? v : "default"; };

// A Worker has no process id; the isolate's start stands in for the process (one isolate answers).
const STARTED_AT = new Date().toISOString();

/** A person signed in through Access, or a registered and unexpired agent key; in development (no Access) anyone. */
async function allowed(c: C): Promise<boolean> {
  if (!c.env.POLICY_AUD || !c.env.TEAM_DOMAIN) return true;
  const claims = c.get("access");
  if (!claims) return false;
  const keys = claims.common_name ? await readAgentKeys(c.env.BUCKET).catch(() => []) : [];
  return principalFor(claims, keys) !== null;
}

let provisioning: { at: number } | null = null;
/**
 * B-150: when an agent key reads these routes through the server's own Access application, the
 * routes' own application is made (once; a failure is tried again after 10 minutes), so a request
 * with no credential gets Access's 401 here instead of a 302 to the sign-in page.
 */
export async function provisionServiceAccess(env: Env, host: string, claims: AccessClaims | undefined, now = Date.now()): Promise<string> {
  if (!claims?.common_name || !env.POLICY_AUD) return "not_a_key";
  const aud: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.POLICY_AUD)) return "already";
  if (provisioning && now - provisioning.at < 600_000) return "waiting";
  provisioning = { at: now };
  const api = cloudflareApi(env);
  if (!api) return "no_token";
  try {
    const known = await readServiceAccess(env.BUCKET);
    const result = await ensureServiceApp(api, await accountIdFor(api, env), env.POLICY_AUD, host);
    if (result.state === "no_keys") return "no_keys";
    if (known?.aud !== result.access.aud) await env.BUCKET.put(SERVICE_ACCESS_KEY, JSON.stringify(result.access));
    forgetServiceAudience();
    console.log(JSON.stringify({ event: "fabric_service_access", state: result.state }));
    return result.state;
  } catch (error) {
    console.error(JSON.stringify({ event: "fabric_service_access_failed", error: (error as Error).message.slice(0, 200) }));
    return "failed";
  }
}

const provision = (c: C) => {
  const work = provisionServiceAccess(c.env, new URL(c.req.url).host, c.get("access"));
  try { c.executionCtx.waitUntil(work); } catch { void work; }
};

const refused = () => new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });

/**
 * fabric-service/0.1 rule 1: a request a page of another site makes is refused on every path, the
 * well-known one included, even when the browser carries the person's sign-in. A host sends no Origin.
 */
export function crossSite(url: string, origin: string | undefined, fetchSite: string | undefined): string | null {
  if (fetchSite?.toLowerCase() === "cross-site") return "A request from another site is refused.";
  if (origin && origin !== new URL(url).origin) return "A request from another origin is refused.";
  return null;
}

const foreign = (c: C): Response | null => {
  const reason = crossSite(c.req.url, c.req.header("Origin"), c.req.header("Sec-Fetch-Site"));
  return reason ? new Response(reason, { status: 403, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } }) : null;
};

async function build(): Promise<Record<string, unknown>> {
  if (SOURCE) return { commit: SOURCE.commit, dirty: SOURCE.dirty, builtAt: SOURCE.builtAt };
  // A build outside Git: its own build id stands for it, hashed into the digest form.
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BUILD_ID)));
  return { digest: `sha256:${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` };
}

/** What does not work now, as fabric-service `degraded[]` entries. */
function degradedOf(env: Env): { source: string; reason: string; setup?: true }[] {
  const out: { source: string; reason: string; setup?: true }[] = [];
  if (!cloudflareApi(env)) out.push({ source: "cloudflare", reason: "No Cloudflare token on the server: domains, addresses and self-update are off.", setup: true });
  if (!env.AGENT_REGISTRY) out.push({ source: "agents", reason: "Reply agents are not configured on this server." });
  if (!env.OPENROUTER_API_KEY) out.push({ source: "models", reason: "No OpenRouter key: reply agents write on the server's own Workers AI and no checker approves an answer before it is sent.", setup: true });
  return out;
}

/** Where the server says how its model calls are signed in, for the descriptor's `runner` (DEC-0061). */
export const RUNNER_EXTENSION = "https://passioncode.ai/fabric-inbox/runner";

/**
 * The kind of credential the reply agents' model calls use, never the credential (DEC-0061): an issued
 * OpenRouter key when the server has one (writer, fallback and checker, workers/agents/deps.ts), else
 * Workers AI under the deployment's own account. The injection scan is Workers AI either way.
 */
export function runnerOf(env: Pick<Env, "OPENROUTER_API_KEY">): { credentialKind: "key" | "platform-metered" } {
  return { credentialKind: env.OPENROUTER_API_KEY ? "key" : "platform-metered" };
}

export async function wellKnownDocument(env: Env): Promise<Record<string, unknown>> {
  const degraded = degradedOf(env);
  return {
    protocol: "fabric-service/0.1",
    service: { id: SERVICE_ID, instance: instanceOf(env), name: "Fabric Inbox", version, build: await build() },
    process: { pid: 1, startedAt: STARTED_AT },
    status: degraded.length ? "degraded" : "ready",
    degraded,
    surfaces: {
      events: { path: EVENTS_PATH },
      usage: { path: USAGE_PATH },
      // The MCP surface takes its own agent keys; a host never calls it with the descriptor token.
      mcp: { path: "/mcp", transport: "streamable-http", auth: "own" },
    },
    update: { available: null },
    extensions: { [RUNNER_EXTENSION]: runnerOf(env) },
  };
}

fabricServiceRouter.get(WELL_KNOWN_PATH, async (c) => {
  const blocked = foreign(c);
  if (blocked) return blocked;
  if (!(await allowed(c))) return refused();
  provision(c);
  c.header("Cache-Control", "no-store");
  return c.json(await wellKnownDocument(c.env));
});

/**
 * N-2: the events name every address's runs, so a key limited to some mailboxes (by its own list or by
 * the narrowing header) does not read them, as it is not offered list_agent_events either (AP-11).
 */
async function limitedKey(c: C): Promise<boolean> {
  const claims = c.get("access");
  if (!claims?.common_name) return false;
  if (c.req.header(NARROW_HEADER)) return true;
  const principal = principalFor(claims, await readAgentKeys(c.env.BUCKET).catch(() => []));
  return principal?.kind === "agent" && principal.accounts !== null;
}

fabricServiceRouter.get(EVENTS_PATH, async (c) => {
  const blocked = foreign(c);
  if (blocked) return blocked;
  if (!(await allowed(c))) return refused();
  if (await limitedKey(c)) return c.json({ error: "This key is limited to some mailboxes; the events of every mailbox are not for it." }, 403);
  provision(c);
  c.header("Cache-Control", "no-store");
  if (!c.env.AGENT_REGISTRY) return c.json({ events: [], cursor: c.req.query("after") || null });
  const after = c.req.query("after");
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 50));
  const page = await c.env.AGENT_REGISTRY.getByName("workspace").listEvents(after ?? null, limit);
  // An empty page after a cursor keeps that cursor, so a reader never goes back to the start.
  return c.json({ events: page.events, cursor: page.cursor ?? (after || null) });
});

/** OpenRouter's slugs are `vendor/model`; anything else is a model the deployment's platform runs. */
export function providerOf(model: string): { provider: string; route: "key" | "platform-metered" } {
  return model.startsWith("@cf/") || !model.includes("/") ? { provider: "workers-ai", route: "platform-metered" } : { provider: "openrouter", route: "key" };
}

/** A cost that is the sum of what was priced, or null when nothing was (DEC-0021: unknown is never 0). */
const priced = (calls: number, unpriced: number, cost: number) => (unpriced >= calls ? null : Number(cost.toFixed(8)));

/**
 * The DEC-0021 report from the reply agents' runs, per UTC day and model over the last 31 days. A call
 * with a receipt (B-147) brings its tokens and OpenRouter's charge; an older run's calls stay unpriced and
 * unmeasured, so a host shows a lower bound or unknown, never a free day.
 */
export function usageReport(rows: ModelUsageRow[], instance: string, now = new Date()) {
  const byDay = new Map<string, ModelUsageRow[]>();
  for (const r of rows) if (r.calls > 0) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b)).slice(-31).map(([date, models]) => {
    const byModel = models.map((m) => ({ ...providerOf(m.model), model: m.model.slice(0, 128),
      costBasis: m.unpricedCalls === 0 ? "provider" : m.unpricedCalls < m.calls ? "mixed" : "unknown",
      calls: m.calls, unpricedCalls: m.unpricedCalls, unmeasuredCalls: m.unmeasuredCalls,
      inputTokens: m.inputTokens, outputTokens: m.outputTokens, costUsd: priced(m.calls, m.unpricedCalls, m.costUsd) }));
    const sum = (k: "calls" | "unpricedCalls" | "unmeasuredCalls" | "inputTokens" | "outputTokens") => byModel.reduce((n, m) => n + m[k], 0);
    const known = byModel.reduce((n, m) => n + (m.costUsd ?? 0), 0);
    return { date, calls: sum("calls"), unpricedCalls: sum("unpricedCalls"), unmeasuredCalls: sum("unmeasuredCalls"),
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), costUsd: priced(sum("calls"), sum("unpricedCalls"), known), byModel };
  });
  return { protocol: "fabric-service/0.1", service: { id: SERVICE_ID, instance }, generatedAt: now.toISOString(), currency: "USD", days };
}

fabricServiceRouter.get(USAGE_PATH, async (c) => {
  const blocked = foreign(c);
  if (blocked) return blocked;
  if (!(await allowed(c))) return refused();
  provision(c);
  c.header("Cache-Control", "no-store");
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)).toISOString();
  const rows = c.env.AGENT_REGISTRY ? await c.env.AGENT_REGISTRY.getByName("workspace").modelUsagePerDay(since) : [];
  return c.json(usageReport(rows, instanceOf(c.env), now));
});
