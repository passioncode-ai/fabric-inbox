/**
 * A time limit for one piece of work, cleared when the work ends (services sweep 2026-10-12).
 * `AbortSignal.timeout` leaves its timer pending after the work is done, and a pending timer keeps a
 * Durable Object's invocation open: a 3 s model call held CategoriesDO for its whole 45 s limit.
 * Call `clear()` in a `finally`.
 */
export function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`The operation timed out after ${ms} ms`, "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
