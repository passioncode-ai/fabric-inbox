import { Hono, type Context } from "hono";
import { version } from "../../package.json";
import type { Env } from "../types";
import { BUILD_ID, SOURCE } from "../../shared/build";
import { cloudflareApi } from "../routing/cloudflare-api";
import { principalFor, readAgentKeys, type AccessClaims } from "../mcp/keys";

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

const refused = () => new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });

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
  if (!env.OPENROUTER_API_KEY) out.push({ source: "models", reason: "No OpenRouter key: reply agents cannot write answers.", setup: true });
  return out;
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
  };
}

fabricServiceRouter.get(WELL_KNOWN_PATH, async (c) => {
  if (!(await allowed(c))) return refused();
  c.header("Cache-Control", "no-store");
  return c.json(await wellKnownDocument(c.env));
});

fabricServiceRouter.get(EVENTS_PATH, async (c) => {
  if (!(await allowed(c))) return refused();
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

/**
 * The DEC-0021 report from the reply agents' runs: calls per UTC day and model over the last 31 days.
 * Runs keep no tokens or price, so every call is unpriced and unmeasured (cost null, token totals a
 * lower bound of 0), which a host shows as unknown rather than free.
 */
export function usageReport(rows: { day: string; model: string; calls: number }[], instance: string, now = new Date()) {
  const byDay = new Map<string, { model: string; calls: number }[]>();
  for (const r of rows) if (r.calls > 0) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b)).slice(-31).map(([date, models]) => {
    const byModel = models.map((m) => ({ ...providerOf(m.model), model: m.model.slice(0, 128), costBasis: "unknown",
      calls: m.calls, unpricedCalls: m.calls, unmeasuredCalls: m.calls, inputTokens: 0, outputTokens: 0, costUsd: null }));
    const calls = byModel.reduce((n, m) => n + m.calls, 0);
    return { date, calls, unpricedCalls: calls, unmeasuredCalls: calls, inputTokens: 0, outputTokens: 0, costUsd: null, byModel };
  });
  return { protocol: "fabric-service/0.1", service: { id: SERVICE_ID, instance }, generatedAt: now.toISOString(), currency: "USD", days };
}

fabricServiceRouter.get(USAGE_PATH, async (c) => {
  if (!(await allowed(c))) return refused();
  c.header("Cache-Control", "no-store");
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)).toISOString();
  const rows = c.env.AGENT_REGISTRY ? await c.env.AGENT_REGISTRY.getByName("workspace").modelCallsPerDay(since) : [];
  return c.json(usageReport(rows, instanceOf(c.env), now));
});
