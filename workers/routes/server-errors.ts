// B-203: the server's own error counts for one UTC day (docs/app-store/tasks/2026-11-04-server-error-counts.md):
// what the Mac app sends as usage data, and what an agent reads with get_server_errors. Codes only, never a message.
import { Hono } from "hono";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { ERROR_DAYS_KEPT, errorDay } from "../lib/error-counts";
import { capNames, closedDay, closedHour, foldDay, foldHour } from "../lib/ops-digest";
import { inboxSources } from "../lib/inbox-sources";
import { foldMonths, type SupportMonth } from "../lib/support-months";
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
      // B-213 (OD-3): an hour's names are its day's, so its line and the day's agree.
      const ofDay = async (h: string) => capNames(await ledger.opsHours(h.slice(0, 10))).filter((r) => r.hour === h);
      return c.json(foldHour(hour, await ofDay(hour), await ofDay(previous)));
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

/**
 * B-208: each Cloudflare mailbox's support work per month (threads received, answered by a reply agent, answered by a
 * person, the median minutes to the first answer), counts only, as far back as the mailbox keeps mail. `domain` or
 * `mailbox` narrows it. Gmail, Outlook and IMAP accounts are not counted: their sent mail is not this server's.
 */
serverErrorsRouter.get("/api/support-months", async (c) => {
  const env = c.env;
  const domain = c.req.query("domain")?.toLowerCase();
  const only = c.req.query("mailbox")?.toLowerCase();
  let addresses: string[];
  try {
    addresses = (await inboxSources(env).cloudflareAccounts()).map((a) => a.email.toLowerCase())
      .filter((e) => (!domain || e.endsWith(`@${domain}`)) && (!only || e === only));
  } catch (error) {
    console.error(JSON.stringify({ event: "support_months_addresses_unreadable", error: String((error as Error)?.message ?? error).slice(0, 120) }));
    return c.json({ error: msg("The addresses could not be listed right now") }, 503);
  }
  const mailboxes: { mailbox: string; domain: string; months: SupportMonth[]; error?: string }[] = [];
  for (let i = 0; i < addresses.length; i += 10) {
    mailboxes.push(...await Promise.all(addresses.slice(i, i + 10).map(async (email) => {
      const d = email.slice(email.lastIndexOf("@") + 1);
      try { return { mailbox: email, domain: d, months: foldMonths(await env.MAILBOX.get(env.MAILBOX.idFromName(email)).supportThreads()) }; }
      catch (error) { return { mailbox: email, domain: d, months: [], error: String((error as Error)?.message ?? error).slice(0, 120) }; }
    })));
  }
  return c.json({ mailboxes });
});
