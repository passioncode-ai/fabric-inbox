// B-203: the server's own error counts for one UTC day (docs/app-store/tasks/2026-11-04-server-error-counts.md):
// what the Mac app sends as usage data, and what an agent reads with get_server_errors. Codes only, never a message.
import { Hono } from "hono";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { ERROR_DAYS_KEPT, errorDay } from "../lib/error-counts";
import { closedDay, closedHour, foldDay, foldHour } from "../lib/ops-digest";
import { inboxSources } from "../lib/inbox-sources";
import { objectLimitBytes, storageReport, usageOf, type ObjectUsage, type StorageReport } from "../lib/storage-usage";

export const serverErrorsRouter = new Hono<{ Bindings: Env }>();

serverErrorsRouter.get("/api/server-errors", async (c) => {
  const day = errorDay(c.req.query("day"));
  if (!day) return c.json({ error: msg("The day is a UTC date of the last {days} days, as YYYY-MM-DD", { days: ERROR_DAYS_KEPT }) }, 400);
  try {
    const counts = await c.env.EMAIL_MCP.getByName("workspace").errorCounts(day);
    return c.json({ day, counts });
  } catch (error) {
    console.error(JSON.stringify({ event: "server_errors_unreadable", error: (error as Error).message?.slice(0, 200) }));
    return c.json({ error: msg("The error counts could not be read right now") }, 503);
  }
});

/**
 * B-205: one closed UTC hour (`?hour=YYYY-MM-DDTHH`) as `ops.digest.hourly@1`, or one closed UTC day (`?day=YYYY-MM-DD`,
 * default yesterday) as `ops.digest.daily@1`, folded now from the ledger's hourly counts (get_ops_digest).
 */
serverErrorsRouter.get("/api/ops-digest", async (c) => {
  const rawHour = c.req.query("hour");
  const hour = rawHour !== undefined ? closedHour(rawHour) : null;
  const day = rawHour === undefined ? closedDay(c.req.query("day")) : null;
  if (!hour && !day) return c.json({ error: msg("Ask for a closed UTC hour as YYYY-MM-DDTHH or a closed UTC day as YYYY-MM-DD, of the last {days} days", { days: ERROR_DAYS_KEPT }) }, 400);
  try {
    const ledger = c.env.EMAIL_MCP.getByName("workspace");
    if (hour) {
      const previous = new Date(Date.parse(`${hour}:00:00Z`) - 3_600_000).toISOString().slice(0, 13);
      return c.json(foldHour(hour, await ledger.opsHours(hour), await ledger.opsHours(previous)));
    }
    const before = new Date(Date.parse(`${day}T00:00:00Z`) - 3_600_000).toISOString().slice(0, 13);
    const digest = foldDay(day!, await ledger.opsHours(day!), await ledger.opsHours(before));
    return digest ? c.json(digest) : c.json({ error: msg("Nothing was counted on {day}", { day: day! }) }, 404);
  } catch (error) {
    console.error(JSON.stringify({ event: "ops_digest_unreadable", error: (error as Error).message?.slice(0, 200) }));
    return c.json({ error: msg("The error counts could not be read right now") }, 503);
  }
});

/** B-206: how full each mailbox, shared store and automation object is against the per-object limit, and the files' size. */
serverErrorsRouter.get("/api/storage", async (c) => {
  const env = c.env;
  const limit = objectLimitBytes((env as unknown as { STORAGE_LIMIT_GB?: string }).STORAGE_LIMIT_GB);
  const failed = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 120);
  let addresses: string[];
  try {
    addresses = (await inboxSources(env).cloudflareAccounts()).map((a) => a.email);
  } catch (error) {
    console.error(JSON.stringify({ event: "storage_addresses_unreadable", error: failed(error) }));
    return c.json({ error: msg("The addresses could not be listed right now") }, 503);
  }
  const jobs: (() => Promise<ObjectUsage>)[] = [];
  for (const email of addresses) {
    jobs.push(async () => {
      try { const u = await env.MAILBOX.get(env.MAILBOX.idFromName(email)).storageUsage(); return usageOf(`mailbox:${email}`, u.bytes, limit, { folders: u.folders }); }
      catch (error) { return usageOf(`mailbox:${email}`, null, limit, { error: failed(error) }); }
    });
    jobs.push(async () => {
      try { return usageOf(`automation:${email}`, await env.AUTOMATIONS.getByName(email).storageBytes(), limit); }
      catch (error) { return usageOf(`automation:${email}`, null, limit, { error: failed(error) }); }
    });
  }
  const stores: [string, { getByName(name: string): { storageBytes(): Promise<number> } } | undefined][] = [
    ["accounts", env.GMAIL_ACCOUNTS], ["agents", env.AGENT_REGISTRY], ["knowledge", env.KNOWLEDGE],
    ["categories", env.CATEGORIES], ["campaigns", env.CAMPAIGNS], ["ledger", env.EMAIL_MCP],
  ] as never;
  for (const [name, ns] of stores) {
    if (!ns) continue;
    jobs.push(async () => {
      try { return usageOf(`store:${name}`, await ns.getByName("workspace").storageBytes(), limit); }
      catch (error) { return usageOf(`store:${name}`, null, limit, { error: failed(error) }); }
    });
  }
  const objects: ObjectUsage[] = [];
  for (let i = 0; i < jobs.length; i += 10) objects.push(...await Promise.all(jobs.slice(i, i + 10).map((job) => job())));
  let files: StorageReport["files"] = null;
  try {
    let cursor: string | undefined, count = 0, bytes = 0, partial = true;
    for (let page = 0; page < 50; page++) {
      const result = await env.BUCKET.list({ cursor, limit: 1000 });
      for (const object of result.objects) { count++; bytes += object.size; }
      if (!result.truncated) { partial = false; break; }
      cursor = result.cursor;
    }
    files = { objects: count, bytes, partial };
  } catch (error) {
    console.warn(JSON.stringify({ event: "storage_files_unreadable", error: failed(error) }));
  }
  return c.json(storageReport(objects, files, limit));
});
