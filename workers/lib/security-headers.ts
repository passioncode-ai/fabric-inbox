/**
 * Headers on every response of the app. frame-ancestors is 'self', not 'none':
 * the mail reader renders each message in a srcdoc iframe, which inherits the
 * page's CSP — 'none' blocked our own reader and every message body came out
 * blank (found in the real app on 2026-09-28).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "same-origin",
});
export const DEFAULT_CSP = "frame-ancestors 'self'";

/** Returns a response carrying the headers; a passed-through response may have immutable headers. */
export function withSecurityHeaders(response: Response): Response {
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response;
  let out = response;
  try { out.headers.set("X-Content-Type-Options", SECURITY_HEADERS["X-Content-Type-Options"]); }
  catch { out = new Response(response.body, response); }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (!out.headers.has("Content-Security-Policy")) out.headers.set("Content-Security-Policy", DEFAULT_CSP);
  return out;
}
