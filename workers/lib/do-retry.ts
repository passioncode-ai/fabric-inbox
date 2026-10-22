/**
 * Durable Object failures a second attempt survives: the object was reset (a deploy restarting it, a
 * storage operation past its timeout, an internal storage error) or the instance a call reached was
 * replaced while it ran. Seen live: "storage operation exceeded timeout which caused object to be
 * reset" (2026-09-28, a minute after a deploy), and between 2026-10-15 and 2026-10-21 33 failed mailbox
 * calls, every one "Internal error … caused object to be reset" or "Connection closed: this Durable
 * Object instance is no longer active. Reconnect or retry the request", most within minutes of a
 * deploy. Only incoming mail retried them; a read of the inbox or its counts failed at once and the
 * account showed as unavailable.
 */
export const TRANSIENT_DO = /storage operation exceeded timeout|caused object to be reset|Durable Object reset|Network connection lost|Durable Object is overloaded|internal error; reference|instance is no longer active|Reconnect or retry the request/i;

/** True for an error the runtime marks retryable, or whose message is one of TRANSIENT_DO. */
export function isTransientDo(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { retryable?: unknown; overloaded?: unknown; message?: unknown };
  if (e.overloaded === true) return false;            // retrying an overloaded object only adds load
  return e.retryable === true || TRANSIENT_DO.test(String(e.message ?? ""));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a read, and once more after `delayMs` when it failed in a way a second attempt survives. Only
 * for calls that change nothing: a write that failed this way may have happened, and is not repeated.
 */
export async function retryRead<T>(read: () => Promise<T>, delayMs = 250): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isTransientDo(error)) throw error;
    console.warn(JSON.stringify({ event: "do_read_retried", error: String((error as Error).message ?? error).slice(0, 160) }));
    await sleep(delayMs);
    return read();
  }
}

/**
 * The same stub, its every call made through retryRead: for a request that only reads (GET and HEAD
 * of the mailbox routes). `then` is never a method, so the stub is not mistaken for a promise.
 */
export function readRetrying<T extends object>(stub: T, delayMs = 250): T {
  return new Proxy(stub, {
    get(target, name) {
      if (name === "then") return undefined;
      const value = (target as Record<string | symbol, unknown>)[name];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => retryRead(() => (target as Record<string | symbol, (...a: unknown[]) => Promise<unknown>>)[name](...args), delayMs);
    },
  });
}
