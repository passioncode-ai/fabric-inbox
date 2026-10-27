import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";

/**
 * B-181 (SCN-089, SCN-090): outreach campaigns (docs/app-store/tasks/2026-10-27-outreach.md): prepare, add recipients,
 * preview, dry-run, the suppression list, and from step 2 launch, pause, stop and the report; the sending itself is
 * CampaignsDO's alarm, through the account's own send. Behind the same Access and
 * same-origin boundary as every /api route; a member reaches none of it (workers/lib/member-gate.ts).
 */
export const campaignsRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;
const store = (c: C) => c.env.CAMPAIGNS!.getByName("workspace");

function failure(c: C, error: unknown) {
  const text = (error as Error)?.message ?? String(error);
  const m = text.match(/(not_found|invalid|conflict): (.*)$/s);
  if (m) return c.json({ error: m[2] }, m[1] === "not_found" ? 404 : m[1] === "conflict" ? 409 : 400);
  console.error(JSON.stringify({ event: "campaigns_error", error: text.slice(0, 300) }));
  return c.json({ error: msg("Campaigns are unavailable right now. Try again.") }, 503);
}
const configured = async (c: C, next: () => Promise<void>) => {
  if (!c.env.CAMPAIGNS) return c.json({ error: msg("Campaigns are not set up on this server; update the server from the app") }, 503);
  await next();
};
for (const path of ["/api/campaigns", "/api/campaigns/*", "/api/suppression"]) campaignsRouter.use(path, configured);

/** The sender must be one of the server's connected Gmail, Outlook or IMAP accounts. */
async function senderProblem(c: C, sender: unknown): Promise<string | null> {
  if (typeof sender !== "string" || !c.env.GMAIL_ACCOUNTS) return null;
  const [provider, id] = [sender.slice(0, sender.indexOf(":")), sender.slice(sender.indexOf(":") + 1)];
  if (!["gmail", "outlook", "imap"].includes(provider)) return null; // the store says why
  const accounts = (await c.env.GMAIL_ACCOUNTS.getByName("workspace").listAccounts()).accounts as { id: string; provider?: string }[];
  return accounts.some((a) => (a.provider ?? "gmail") === provider && a.id === id) ? null : msg("{sender} is not a connected account of this server.", { sender });
}

campaignsRouter.get("/api/campaigns", async (c) => {
  try { return c.json({ campaigns: await store(c).listCampaigns() }); } catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/campaigns", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { campaign?: unknown } | null;
  try {
    const problem = await senderProblem(c, (body?.campaign as { sender?: unknown } | undefined)?.sender);
    if (problem) return c.json({ error: problem }, 400);
    return c.json(await store(c).saveCampaign(body?.campaign), 201);
  } catch (error) { return failure(c, error); }
});
campaignsRouter.get("/api/campaigns/:id", async (c) => {
  try {
    const campaign = await store(c).getCampaign(c.req.param("id"));
    return campaign ? c.json(campaign) : c.json({ error: msg("No such campaign.") }, 404);
  } catch (error) { return failure(c, error); }
});
campaignsRouter.put("/api/campaigns/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { campaign?: unknown; expectedVersion?: unknown } | null;
  try {
    const problem = await senderProblem(c, (body?.campaign as { sender?: unknown } | undefined)?.sender);
    if (problem) return c.json({ error: problem }, 400);
    const version = Number.isInteger(body?.expectedVersion) ? Number(body!.expectedVersion) : undefined;
    return c.json(await store(c).saveCampaign(body?.campaign, c.req.param("id"), version));
  } catch (error) { return failure(c, error); }
});
campaignsRouter.delete("/api/campaigns/:id", async (c) => {
  try { return (await store(c).deleteCampaign(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: msg("No such campaign.") }, 404); }
  catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/campaigns/:id/recipients", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { recipients?: unknown; remove?: unknown } | null;
  try {
    if (Array.isArray(body?.remove)) return c.json({ removed: await store(c).removeRecipients(c.req.param("id"), body!.remove.map(String)) });
    if (!Array.isArray(body?.recipients)) return c.json({ error: msg("Give the recipients as a list, each with an email and its fields.") }, 400);
    return c.json(await store(c).addRecipients(c.req.param("id"), body!.recipients as never));
  } catch (error) { return failure(c, error); }
});
campaignsRouter.get("/api/campaigns/:id/recipients", async (c) => {
  try {
    return c.json(await store(c).listRecipients(c.req.param("id"), { status: c.req.query("status") || undefined,
      limit: Number(c.req.query("limit")) || undefined, offset: Number(c.req.query("offset")) || undefined }));
  } catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/campaigns/:id/preview", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
  try { return c.json(await store(c).preview(c.req.param("id"), typeof body?.email === "string" ? body.email : undefined)); }
  catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/campaigns/:id/dry-run", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { count?: unknown } | null;
  try { return c.json(await store(c).dryRun(c.req.param("id"), Number(body?.count) || 50)); } catch (error) { return failure(c, error); }
});
campaignsRouter.get("/api/suppression", async (c) => {
  try { return c.json({ suppression: await store(c).listSuppression() }); } catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/suppression", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { add?: unknown; remove?: unknown; reason?: unknown } | null;
  try {
    const s = store(c);
    const added = Array.isArray(body?.add) ? await s.addSuppression(body!.add.map(String), typeof body?.reason === "string" ? body.reason : "") : null;
    const removed = Array.isArray(body?.remove) ? await s.removeSuppression(body!.remove.map(String)) : 0;
    if (!added && !Array.isArray(body?.remove)) return c.json({ error: msg("Say what to add to or remove from the list.") }, 400);
    return c.json({ ...(added ?? { added: [], invalid: [], removedRecipients: 0 }), removed });
  } catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/campaigns/:id/launch", async (c) => {
  try {
    const campaign = await store(c).getCampaign(c.req.param("id"));
    if (!campaign) return c.json({ error: msg("No such campaign.") }, 404);
    const problem = await senderProblem(c, campaign.sender);
    if (problem) return c.json({ error: problem }, 400);
    return c.json(await store(c).launch(c.req.param("id")));
  } catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/campaigns/:id/pause", async (c) => {
  try { return c.json(await store(c).pause(c.req.param("id"))); } catch (error) { return failure(c, error); }
});
campaignsRouter.post("/api/campaigns/:id/stop", async (c) => {
  try { return c.json(await store(c).stop(c.req.param("id"))); } catch (error) { return failure(c, error); }
});
campaignsRouter.get("/api/campaigns/:id/report", async (c) => {
  try { return c.json(await store(c).report(c.req.param("id"))); } catch (error) { return failure(c, error); }
});
