// B-203: the server's own error counts for one UTC day (docs/app-store/tasks/2026-11-04-server-error-counts.md):
// what the Mac app sends as usage data, and what an agent reads with get_server_errors. Codes only, never a message.
import { Hono } from "hono";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { ERROR_DAYS_KEPT, errorDay } from "../lib/error-counts";
import { closedDay, closedHour, foldDay, foldHour } from "../lib/ops-digest";

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
    return c.json(foldDay(day!, await ledger.opsHours(day!), await ledger.opsHours(before)));
  } catch (error) {
    console.error(JSON.stringify({ event: "ops_digest_unreadable", error: (error as Error).message?.slice(0, 200) }));
    return c.json({ error: msg("The error counts could not be read right now") }, 503);
  }
});
