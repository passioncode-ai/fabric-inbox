import { test } from "node:test";
import assert from "node:assert/strict";
import { withSecurityHeaders, DEFAULT_CSP } from "../workers/lib/security-headers";

test("our own srcdoc mail reader may be framed; other sites may not", () => {
  const r = withSecurityHeaders(new Response("x"));
  const csp = r.headers.get("Content-Security-Policy")!;
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /frame-ancestors 'none'/, "'none' is inherited by srcdoc frames and blanks every message body");
  assert.equal(r.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(DEFAULT_CSP, "frame-ancestors 'self'");
});

test("an existing policy is kept, immutable headers are handled, upgrades pass through", () => {
  const own = withSecurityHeaders(new Response("x", { headers: { "Content-Security-Policy": "default-src 'none'" } }));
  assert.equal(own.headers.get("Content-Security-Policy"), "default-src 'none'");
  const frozen = Response.redirect("https://example.com/", 302);
  assert.equal(withSecurityHeaders(frozen).headers.get("X-Content-Type-Options"), "nosniff");
});
