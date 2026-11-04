/**
 * B-203: the server counts its own errors per UTC day, class and code, so a customer's server that fails is visible to
 * its Mac app's usage data (docs/app-store/tasks/2026-11-04-server-error-counts.md). Only a code from a fixed shape
 * is kept: a message, an address or a path can never be one, and becomes `other`. Counting never throws and never
 * waits on the request it counts for.
 */

/** Days of counts the ledger keeps (workers/mcp/ledger.ts). */
export const ERROR_DAYS_KEPT = 14;

export const ERROR_CLASSES = ["http", "alarm", "incoming", "agent", "send", "sync"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
/** Any object's bindings: the Worker gives every Durable Object the same ones, typed narrower in some. */
type Counted = { EMAIL_MCP?: { getByName(name: string): { countError(cls: string, code: string): unknown; countOp?(op: string, outcome: "ok"): unknown } } };

/** The code as counted: lower case, `-` and `.` read as `_`, anything else that does not fit is `other`. */
export function errorCode(raw: unknown): string {
  const code = String(raw ?? "").trim().toLowerCase().replace(/[-.]/g, "_");
  return CODE.test(code) ? code : "other";
}

/** The route group of a failed request: the first segment after `/api/` (`v1` takes the next), else `other`. */
export function routeGroup(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return "page";
  return errorCode(parts[1] === "v1" ? `v1_${parts[2] ?? ""}` : parts[1]);
}

/** Counts one error; a ledger that cannot be reached is one log line, never a second error. */
export function countError(env: Counted, cls: ErrorClass, code: unknown, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
  const done = (async () => {
    try {
      if (!env.EMAIL_MCP) return;
      await env.EMAIL_MCP.getByName("workspace").countError(cls, errorCode(code));
    } catch (error) {
      console.warn(JSON.stringify({ event: "error_count_failed", class: cls, error: (error as Error).message?.slice(0, 120) }));
    }
  })();
  waitUntil?.(done);
  return done;
}

/**
 * B-205: one success of a low-volume operation (a message received, a reply agent's run that ended, a send accepted),
 * so the hourly digest has its `ok` beside the failures. Never on a request's path: a request is counted only when it fails.
 */
export function countOk(env: Counted, cls: ErrorClass, code: unknown, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
  const done = (async () => {
    try {
      const ledger = env.EMAIL_MCP?.getByName("workspace");
      if (ledger?.countOp) await ledger.countOp(`${cls}.${errorCode(code)}`, "ok");
    } catch (error) {
      console.warn(JSON.stringify({ event: "ok_count_failed", class: cls, error: (error as Error).message?.slice(0, 120) }));
    }
  })();
  waitUntil?.(done);
  return done;
}

/**
 * Writes a log line as `console.warn(JSON.stringify({ event, ... }))` did, and counts its `event` as the code: a drop-in
 * for the catch blocks of alarms and syncs, so the line and the count never disagree.
 */
export function countLog(env: Counted, cls: ErrorClass, line: string, level: "warn" | "error" = "warn"): void {
  (level === "error" ? console.error : console.warn)(line);
  let event: unknown = "other";
  try { event = (JSON.parse(line) as { event?: unknown }).event; } catch { /* counted as other */ }
  void countError(env, cls, event);
}

/** A UTC day the ledger still keeps, or null. Default: yesterday. */
export function errorDay(raw: string | undefined, now = Date.now()): string | null {
  const today = new Date(now).toISOString().slice(0, 10);
  const day = raw ?? new Date(now - 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  const oldest = new Date(now - ERROR_DAYS_KEPT * 86_400_000).toISOString().slice(0, 10);
  return day >= oldest && day <= today ? day : null;
}
