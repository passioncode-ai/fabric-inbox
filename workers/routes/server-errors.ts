// B-203: the server's own error counts for one UTC day (docs/app-store/tasks/2026-11-04-server-error-counts.md):
// what the Mac app sends as usage data, and what an agent reads with get_server_errors. Codes only, never a message.
import { Hono } from "hono";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { ERROR_DAYS_KEPT, errorDay } from "../lib/error-counts";

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
