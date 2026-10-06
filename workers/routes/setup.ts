import { Hono } from "hono";
import type { Env } from "../types";
import { parseSetup, SETUP_FORMAT, type Setup } from "../../shared/setup";
import { readAssignment } from "../agents/definition";
import { allServedDomains, readAllSettings, storedCatchAll } from "../lib/mailbox-store";
import { applySetup } from "../lib/apply-setup";
import { ROUTING_NOT_CONFIGURED, routingClient, RoutingError, type DomainRouting } from "../routing/email-routing";
export { applySetup };
import { setupFromRouting } from "../routing/to-setup";
import { msg } from "../../shared/i18n";

/**
 * Setups (shared/setup.ts): apply one, export the current one, or derive one
 * from Cloudflare Email Routing. Behind the same Access and same-origin
 * boundary as every /api route. Applying is idempotent and never deletes.
 */
export const setupRouter = new Hono<{ Bindings: Env }>();

function accessOrigin(env: Env): string | undefined {
  try { return env.TEAM_DOMAIN ? new URL(env.TEAM_DOMAIN).origin : undefined; } catch { return undefined; }
}

setupRouter.post("/api/setup/apply", async (c) => {
  const parsed = parseSetup(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: msg("This is not a Fabric Inbox setup"), problems: parsed.problems }, 400);
  try {
    const result = await applySetup(c.env, parsed.setup);
    console.log(JSON.stringify({ event: "setup_applied", name: parsed.setup.name, domainsAdded: result.domainsAdded.length,
      mailboxes: result.mailboxes.length, refused: result.mailboxes.filter((m) => m.outcome === "refused").length }));
    return c.json(result);
  } catch (error) {
    console.error(JSON.stringify({ event: "setup_apply_failed", error: (error as Error).message }));
    return c.json({ error: msg("The setup could not be applied completely. Applying it again is safe.") }, 503);
  }
});

setupRouter.get("/api/setup/export", async (c) => {
  c.header("Cache-Control", "no-store");
  const [domains, all, catchAll] = await Promise.all([allServedDomains(c.env), readAllSettings(c.env.BUCKET), storedCatchAll(c.env.BUCKET)]);
  const served = new Set(domains);
  const setup: Setup = {
    format: SETUP_FORMAT,
    name: `Fabric Inbox at ${new URL(c.req.url).host}`,
    server: { origin: new URL(c.req.url).origin, ...(accessOrigin(c.env) ? { accessOrigin: accessOrigin(c.env) } : {}) },
    domains,
    mailboxes: all.filter(({ email }) => served.has(email.slice(email.lastIndexOf("@") + 1))).map(({ email, settings }) => {
      const f = settings.forwarding as { enabled?: boolean; email?: string } | undefined;
      const agent = readAssignment(settings);
      return {
        address: email,
        ...(typeof settings.fromName === "string" && settings.fromName ? { name: settings.fromName.slice(0, 80) } : {}),
        ...(agent ? { agent } : {}),
        ...(f?.enabled && f.email ? { forwardTo: f.email } : {}),
      };
    }),
    catchAll: Object.entries(catchAll).filter(([d]) => served.has(d)).map(([domain, mailbox]) => ({ domain, mailbox })),
    notServed: [],
  };
  c.header("Content-Disposition", 'attachment; filename="fabric-inbox-setup.json"');
  return c.json(setup);
});

/** A proposed setup from the domains' Email Routing, for review before applying. */
setupRouter.get("/api/setup/from-cloudflare", async (c) => {
  c.header("Cache-Control", "no-store");
  const client = routingClient(c.env);
  if (!client) return c.json({ error: ROUTING_NOT_CONFIGURED.detail }, 503);
  const requested = (c.req.query("domains") ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const domains = requested.length ? requested : await allServedDomains(c.env);
  if (!domains.length) return c.json({ error: msg("Name the domains to read: ?domains=example.com,other.example") }, 400);
  if (domains.length > 100) return c.json({ error: msg("At most {max} domains at a time", { max: 100 }) }, 400);
  try {
    const routings: DomainRouting[] = [];
    for (let i = 0; i < domains.length; i += 5) routings.push(...await Promise.all(domains.slice(i, i + 5).map((d) => client.inventory(d))));
    return c.json(setupFromRouting(routings, { origin: new URL(c.req.url).origin, ...(accessOrigin(c.env) ? { accessOrigin: accessOrigin(c.env) } : {}) }));
  } catch (error) {
    return c.json({ error: error instanceof RoutingError ? error.message : msg("Email Routing could not be read") }, 502);
  }
});
