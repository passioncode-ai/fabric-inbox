/**
 * B-137: the agent events pushed to a signed webhook, so a helpdesk or a support group gets a hand-off
 * in seconds instead of polling `list_agent_events` (a board finding of 2026-10-21). Each hook gets the
 * events of its kinds in order, at least once: the event's id is its idempotency key. A hook that does
 * not answer 2xx is tried again after RETRY_MS; an event it refused for MAX_ATTEMPTS tries is passed
 * over with a log line, so one broken event never holds the rest. A new hook starts from the events
 * after it was made, never the history.
 */
import type { AgentEvent } from "./events";

export const HOOKS_KEY = "config/event-hooks.json";
export const DEFAULT_HOOK_KINDS = ["agent.handoff", "agent.needs_look", "agent.waiting", "agent.abandoned"] as const;
export const HOOK_KINDS = ["agent.sent", "agent.drafted", "agent.skipped", "agent.unanswered", "agent.needs_look", "agent.not_helped",
  "agent.handoff", "agent.waiting", "agent.abandoned", "support.quality_daily"] as const;
/** Waits before the next try of a refused event: 1 min, 5 min, 30 min, 2 h, then every 6 h. */
export const RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
export const MAX_ATTEMPTS = 8;
const MAX_HOOKS = 10;
const TIMEOUT_MS = 10_000;

export interface EventHook { id: string; url: string; kinds: string[]; secret: string; createdAt: string }
/** What the registry keeps per hook: the last event delivered, and the tries of the next one. */
export interface HookCursor { after: number; attempts: number; nextAt: number; lastError?: string; lastDeliveredAt?: string }

export class HookInvalid extends Error {}

/** A hook's URL: https on a public host name; anything else is refused before it is kept. */
export function checkHookUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HookInvalid("Not a URL"); }
  if (url.protocol !== "https:") throw new HookInvalid("The URL must start with https://");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":"))
    throw new HookInvalid("The URL must name a public host");
  if (url.username || url.password) throw new HookInvalid("The URL must not carry a user name or password");
  return url.toString();
}

export async function readHooks(bucket: R2Bucket): Promise<EventHook[]> {
  const object = await bucket.get(HOOKS_KEY);
  const value = object ? await object.json<{ hooks?: unknown }>().catch(() => null) : null;
  return (Array.isArray(value?.hooks) ? value!.hooks : []).filter((h): h is EventHook =>
    !!h && typeof (h as EventHook).id === "string" && typeof (h as EventHook).url === "string" && typeof (h as EventHook).secret === "string"
    && Array.isArray((h as EventHook).kinds));
}

async function writeHooks(bucket: R2Bucket, change: (hooks: EventHook[]) => EventHook[]): Promise<EventHook[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(HOOKS_KEY);
    const current = object ? ((await object.json<{ hooks?: EventHook[] }>().catch(() => null))?.hooks ?? []) : [];
    const next = change(current);
    const written = await bucket.put(HOOKS_KEY, JSON.stringify({ hooks: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new HookInvalid("The hooks changed several times at once; try again");
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Adds a hook; answers it with its secret, which is shown only now. */
export async function addHook(bucket: R2Bucket, input: { url: string; kinds?: string[] }, now = Date.now()): Promise<EventHook> {
  const url = checkHookUrl(input.url);
  const kinds = input.kinds?.length ? [...new Set(input.kinds)] : [...DEFAULT_HOOK_KINDS];
  const unknown = kinds.filter((k) => !(HOOK_KINDS as readonly string[]).includes(k));
  if (unknown.length) throw new HookInvalid(`Unknown event kinds: ${unknown.join(", ")}`);
  const hook: EventHook = { id: `hook-${crypto.randomUUID().slice(0, 8)}`, url, kinds,
    secret: hex(crypto.getRandomValues(new Uint8Array(32)).buffer), createdAt: new Date(now).toISOString() };
  await writeHooks(bucket, (hooks) => {
    if (hooks.length >= MAX_HOOKS) throw new HookInvalid(`At most ${MAX_HOOKS} hooks`);
    return [...hooks, hook];
  });
  return hook;
}

export async function removeHook(bucket: R2Bucket, id: string): Promise<boolean> {
  let found = false;
  await writeHooks(bucket, (hooks) => { found = hooks.some((h) => h.id === id); return hooks.filter((h) => h.id !== id); });
  return found;
}

/** The signature a receiver checks: HMAC-SHA256 with the hook's secret over `<timestamp>.<body>`. */
export async function signHook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

/** One delivery: true when the receiver answered 2xx. */
export async function sendHook(hook: EventHook, event: AgentEvent & { id: string }, fetcher: typeof fetch = fetch, now = Date.now()): Promise<{ ok: boolean; error?: string }> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(now / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(hook.url, { method: "POST", signal: controller.signal, body, headers: {
      "Content-Type": "application/json", "User-Agent": "Fabric-Inbox-Hooks/1", "X-Fabric-Event-Id": event.id, "X-Fabric-Event-Kind": event.kind,
      "X-Fabric-Timestamp": String(timestamp), "X-Fabric-Signature": await signHook(hook.secret, timestamp, body) } });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300 ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).name === "AbortError" ? "no answer in 10 s" : String((error as Error).message ?? error).slice(0, 120) };
  } finally { clearTimeout(timer); }
}
